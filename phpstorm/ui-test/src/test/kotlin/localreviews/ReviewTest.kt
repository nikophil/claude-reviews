package localreviews

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.driver.client.Driver
import com.intellij.driver.model.OnDispatcher
import com.intellij.driver.sdk.invokeAction
import com.intellij.driver.sdk.ui.components.common.IdeaFrameUI
import com.intellij.driver.sdk.ui.components.common.codeEditor
import com.intellij.driver.sdk.ui.components.common.gutter
import com.intellij.driver.sdk.ui.components.common.GutterUiComponent
import com.intellij.driver.sdk.ui.components.common.ideFrame
import com.intellij.driver.sdk.ui.components.common.JEditorUiComponent
import com.intellij.driver.sdk.ui.components.elements.button
import com.intellij.driver.sdk.ui.components.elements.list
import com.intellij.driver.sdk.ui.components.elements.radioButton
import com.intellij.driver.sdk.ui.components.elements.tree
import com.intellij.driver.sdk.ui.enabled
import com.intellij.driver.sdk.ui.shouldBe
import com.intellij.driver.sdk.ui.ui
import com.intellij.driver.sdk.waitForProjectOpen
import com.intellij.ide.starter.di.di
import com.intellij.ide.starter.driver.engine.BackgroundRun
import com.intellij.ide.starter.driver.engine.runIdeWithDriver
import com.intellij.ide.starter.ide.IDETestContext
import com.intellij.ide.starter.ide.IdeDistributionFactory
import com.intellij.ide.starter.ide.IdeInstaller
import com.intellij.ide.starter.models.IdeInfo
import com.intellij.ide.starter.models.TestCase
import com.intellij.ide.starter.project.LocalProjectInfo
import com.intellij.ide.starter.runner.Starter
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import org.kodein.di.direct
import org.kodein.di.instance
import java.awt.Point
import java.awt.event.KeyEvent
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import kotlin.concurrent.thread
import kotlin.time.Duration.Companion.minutes

/**
 * The plugin in a PhpStorm that Starter runs on Xvfb, against a claude-reviews server on its own port and data directory:
 * one PhpStorm for the steps of a review, in order, on a repository whose a.php changes.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ReviewTest {
    companion object {
        // Not 7778 nor 7779, the ports of a real server and of Playwright.
        private const val PORT = "7780"
        private val repo: Path = Path.of(System.getProperty("repo"))
        private val http: HttpClient = HttpClient.newHttpClient()
        private lateinit var worktree: String
        /** The token of the server, from its endpoint file: every call of the test carries it, as the plugin's do; health needs none. */
        private var token = ""
        private lateinit var server: Process
        /** What the stand-in for the mod adds to its read every 2 s: `&blocked` while its Claude session waits for my answer. */
        @Volatile
        private var claudeQuery = ""
        private lateinit var context: IDETestContext
        private lateinit var ide: BackgroundRun
        private val driver: Driver get() = ide.driver

        @BeforeAll
        @JvmStatic
        fun start() {
            val data = Files.createTempDirectory("claude-reviews-ui-test-")
            // A gh that fails, ahead of the PATH, as for Playwright: no real login reaches the tests.
            val bin = Files.createDirectories(data.resolve("bin"))
            Files.writeString(bin.resolve("gh"), "#!/bin/sh\nexit 1\n")
            Files.setPosixFilePermissions(bin.resolve("gh"), PosixFilePermissions.fromString("rwxr-xr-x"))
            server = ProcessBuilder("node", "server/main.ts").directory(repo.toFile()).inheritIO().apply {
                environment()["CLAUDE_REVIEWS_PORT"] = PORT
                environment()["XDG_DATA_HOME"] = data.toString()
                environment()["PATH"] = "$bin:${System.getenv("PATH")}"
            }.start()
            repeat(50) { if (runCatching { get("/api/health") }.isSuccess) return@repeat else Thread.sleep(100) }
            // The server writes its port and token once it listens.
            val endpoint = data.resolve("claude-reviews/endpoint")
            repeat(50) { if (!Files.exists(endpoint)) Thread.sleep(100) }
            token = JsonParser.parseString(Files.readString(endpoint)).asJsonObject["token"].asString
            worktree = node("phpstorm/ui-test/fixture.ts")
            // As the mod of a Claude session in the worktree: without it, the plugin greys Send.
            thread(isDaemon = true) {
                while (true) {
                    runCatching { http.send(request("/api/sessions?worktree=${encode(worktree)}&claude$claudeQuery").GET().build(), HttpResponse.BodyHandlers.discarding()) }
                    Thread.sleep(2000)
                }
            }
            // The PhpStorm of run.sh, in place: Starter would copy it, 1 GB, at each run.
            val home = Path.of(System.getProperty("ide"))
            val phpStorm = IdeInfo(productCode = "PS", platformPrefix = "PhpStorm", executableFileName = "phpstorm", fullName = "PhpStorm", getInstaller = {
                object : IdeInstaller {
                    override suspend fun install(ideInfo: IdeInfo) = home.fileName.toString() to di.direct.instance<IdeDistributionFactory>().installIDE(home.parent, "phpstorm")
                }
            })
            context = Starter.newContext("review", TestCase(phpStorm, LocalProjectInfo(Path.of(worktree))))
                .apply { pluginConfigurator.installPluginFromPath(Path.of(System.getProperty("plugin"))) }
                // XDG_DATA_HOME so the plugin reads the endpoint file, port and token, the server wrote.
                .applyVMOptionsPatch {
                    withEnv("CLAUDE_REVIEWS_PORT", PORT)
                    withEnv("XDG_DATA_HOME", data.toString())
                }
            ide = context.runIdeWithDriver()
            driver.waitForProjectOpen(3.minutes)
        }

        @AfterAll
        @JvmStatic
        fun stop() {
            if (::ide.isInitialized) ide.closeIdeAndWait()
            if (::server.isInitialized) server.destroy()
        }

        private fun node(script: String): String {
            val process = ProcessBuilder("node", script).directory(repo.toFile()).redirectError(ProcessBuilder.Redirect.INHERIT).start()
            val out = process.inputStream.bufferedReader().readText().trim()
            check(process.waitFor() == 0) { "node $script failed" }
            return out
        }

        private fun encode(value: String) = URLEncoder.encode(value, Charsets.UTF_8)

        private fun request(path: String) = HttpRequest.newBuilder(URI.create("http://127.0.0.1:$PORT$path"))
            .apply { if (token.isNotEmpty()) header("Authorization", "Bearer $token") }

        private fun get(path: String): JsonObject {
            val response = http.send(request(path).GET().build(), HttpResponse.BodyHandlers.ofString())
            check(response.statusCode() == 200) { "GET $path: ${response.statusCode()} ${response.body()}" }
            return JsonParser.parseString(response.body()).asJsonObject
        }

        private fun post(path: String, body: String): JsonObject {
            val response = http.send(request(path).header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString())
            check(response.statusCode() == 200) { "POST $path: ${response.statusCode()} ${response.body()}" }
            return JsonParser.parseString(response.body()).asJsonObject
        }

        /** The open session of the worktree, as the server has it. */
        private fun session(): JsonObject = get("/api/sessions?worktree=${encode(worktree)}")

        /** Waits for the session to meet `condition`, which the plugin reaches through the server, not at once. */
        private fun awaitSession(what: String, condition: (JsonObject) -> Boolean): JsonObject {
            var last: Result<JsonObject>? = null
            repeat(100) {
                last = runCatching { session() }
                if (last!!.getOrNull()?.let(condition) == true) return last!!.getOrThrow()
                Thread.sleep(200)
            }
            throw AssertionError("$what; the session: ${last?.getOrNull() ?: last?.exceptionOrNull()}")
        }

        private fun frame(action: IdeaFrameUI.() -> Unit) = driver.ui.ideFrame { action() }

        /** Runs `action` with the tool windows hidden, whose arrows would match too, then shows the Claude Reviews one again. */
        private fun withoutToolWindows(action: IdeaFrameUI.() -> Unit) = frame {
            driver.invokeAction("HideAllWindows", component = component)
            try {
                action()
            } finally {
                driver.invokeAction("ActivateClaudeReviewsToolWindow", component = component)
            }
        }

        /** Waits for the caret that `line` reads to reach `expected`, from 0. */
        private fun caretLine(expected: Int, line: () -> Int) {
            var last = -1
            repeat(50) {
                last = line()
                if (last == expected) return
                Thread.sleep(200)
            }
            assertEquals(expected, last, "the caret on the line of the thread")
        }

        /**
         * The idea.log of the PhpStorm of the test, where an exception of the plugin lands as an IDE Internal Error:
         * decoded without failing on a character the IDE is still writing.
         */
        private fun ideaLog(): String = String(Files.readAllBytes(context.paths.testHome.resolve("log/idea.log")), Charsets.UTF_8)
    }

    @Test
    @Order(1)
    fun `the tool window starts the review of the worktree and shows its changed file`() {
        frame {
            waitForIndicators(2.minutes)
            // The Project view, which the IDE opens at its start on the same side, may still take the place of the tool window.
            val start = button("Start review")
            repeat(20) {
                if (start.present()) return@repeat
                driver.invokeAction("ActivateClaudeReviewsToolWindow", component = component)
                Thread.sleep(500)
            }
            start.click()
            awaitSession("a session opens on the worktree") { it.get("worktree").asString == worktree }
            x("//div[@class='JBLabel' and contains(@text, '1 files')]").shouldBe(enabled)
            tree("//div[@class='Tree']").waitOneText("a.php")
        }
    }

    @Test
    @Order(2)
    fun `a right click on a line number opens a thread there, whose comment waits Pending`() {
        frame {
            tree("//div[@class='Tree']").doubleClickPath("a.php", fullMatch = false)
            codeEditor().waitContainsText("echo 3;")
            gutter().waitOneText("4").rightClick()
        }
        driver.ui.x("//div[@text='Open Review Thread']").click()
        frame {
            keyboard { typeText("Why 3?") }
            button("Add pending").click()
        }
        val thread = awaitSession("a thread opens on line 4 with a Pending message") { it.getAsJsonArray("threads").size() == 1 }
            .getAsJsonArray("threads")[0].asJsonObject
        val anchor = thread.getAsJsonObject("anchor")
        assertEquals(listOf("a.php", "new", 4, 4), listOf(anchor["path"].asString, anchor["side"].asString, anchor["start"].asInt, anchor["end"].asInt))
        val message = thread.getAsJsonArray("messages")[0].asJsonObject
        assertEquals("Why 3?", message["body"].asString)
        assert(message["date"].isJsonNull) { "the message is Pending" }
    }

    @Test
    @Order(3)
    fun `Send publishes the Pending message`() {
        frame { button("Send 1 pending").shouldBe(enabled).click() }
        val session = awaitSession("the Send publishes the message") { it["sends"].asInt == 1 }
        assert(!session.getAsJsonArray("threads")[0].asJsonObject.getAsJsonArray("messages")[0].asJsonObject["date"].isJsonNull)
    }

    @Test
    @Order(4)
    fun `while a thread waits for Claude, the tool window warns that the Claude session waits for my answer, until it no longer does`() {
        val warning = "//div[@class='JBLabel' and contains(@text, 'Claude is waiting for your answer in its session')]"
        claudeQuery = "&blocked"
        frame { x(warning).shouldBe(enabled) }
        claudeQuery = ""
        frame {
            repeat(50) { if (x(warning).present()) Thread.sleep(200) }
            assert(!x(warning).present()) { "the warning is gone" }
        }
    }

    @Test
    @Order(5)
    fun `even in the Diff view, Previous Thread in the bar of the editor goes to the thread in the editor`() {
        frame { radioButton("//div[@text='Diff']").click() }
        withoutToolWindows {
            // Not the editor of the reply under the thread.
            val editor = xx("//div[@class='EditorComponentImpl']", JEditorUiComponent::class.java).list().single { "echo 3;" in it.text }
            editor.moveCaretToOffset(0)
            x("//div[contains(@myaction, 'Previous Thread')]").click()
            caretLine(3) { editor.editor.getCaretModel().getLogicalPosition().getLine() }
            // Back to the top: the caret of the diff, at the next steps, is the only one on line 4.
            editor.moveCaretToOffset(0)
        }
    }

    @Test
    @Order(6)
    fun `Viewed in the diff marks the file viewed`() {
        frame {
            radioButton("//div[@text='Diff']").click()
            tree("//div[@class='Tree']").doubleClickPath("a.php", fullMatch = false)
            x("//div[@text='Viewed']").click()
        }
        awaitSession("a.php is viewed") { it.getAsJsonObject("viewed")?.has("a.php") == true }
    }

    @Test
    @Order(7)
    fun `in the side-by-side diff, a click or a drag over the line numbers opens a thread on that side, which keeps the text typed in it`() {
        frame {
            // The two editors of the diff of step 6, left then right: the editor of a.php is in a tab behind it.
            val gutters = xx("//div[@class='EditorGutterComponentImpl']", GutterUiComponent::class.java).list()
                .filter { it.component.isShowing() }.sortedBy { it.getLocationOnScreen().x }
            assertEquals(2, gutters.size, "the gutters of the diff")
            val (left, right) = gutters
            right.waitOneText("3").click()
            keyboard { typeText("Why 1 and 3?") }
            // The new thread moves to the lines dragged over, with the text typed in it.
            right.mousePressMoveRelease(right.waitOneText("3").point, right.waitOneText("4").point)
            // Ctrl+Enter: the thread of step 2, in the diff too, has an Add pending of its own.
            keyboard { hotKey(KeyEvent.VK_CONTROL, KeyEvent.VK_ENTER) }
            awaitSession("a thread opens on the lines 3 to 4 of the new side") { it.getAsJsonArray("threads").size() == 2 }
            // The gutter of the left side lies mirrored, against the right one: Driver gives the place of its texts unmirrored.
            val four = left.waitOneText("4").point
            left.click(Point(left.component.width - four.x, four.y))
            keyboard { typeText("Why 2?"); hotKey(KeyEvent.VK_CONTROL, KeyEvent.VK_ENTER) }
        }
        val threads = awaitSession("a thread opens on the line 4 of the old side") { it.getAsJsonArray("threads").size() == 3 }.getAsJsonArray("threads")
        val anchors = (1..2).map { threads[it].asJsonObject }.map {
            val anchor = it.getAsJsonObject("anchor")
            listOf(anchor["side"].asString, anchor["start"].asInt, anchor["end"].asInt, it.getAsJsonArray("messages")[0].asJsonObject["body"].asString)
        }
        assertEquals(listOf(listOf("new", 3, 4, "Why 1 and 3?"), listOf("old", 4, 4, "Why 2?")), anchors)
        // The next steps expect the thread of step 2 alone.
        val id = session()["id"].asString
        for (n in 2..3) post("/api/sessions/$id/threads/$n/messages/0/delete", "{}")
    }

    @Test
    @Order(8)
    fun `the bar of the diff warns that the Claude session waits for my answer, and even in the Editor view, Next Thread goes to the thread in the diff`() {
        val warning = "//div[@class='JBLabel' and @text='Claude is waiting for your answer in its session']"
        claudeQuery = "&blocked"
        frame { x(warning).shouldBe(enabled) }
        claudeQuery = ""
        frame {
            repeat(50) { if (x(warning).present()) Thread.sleep(200) }
            assert(!x(warning).present()) { "the warning is gone" }
            radioButton("//div[@text='Editor']").click()
        }
        withoutToolWindows {
            x("//div[contains(@myaction, 'Next Thread')]").click()
            // The working tree, on the right of the diff still shown, its base beside it, at line 4.
            caretLine(3) {
                val editors = xx("//div[@class='EditorComponentImpl']", JEditorUiComponent::class.java).list()
                if (editors.none { "echo 2;" in it.text }) -1 else editors.maxOf { it.editor.getCaretModel().getLogicalPosition().getLine() }
            }
        }
        frame { radioButton("//div[@text='Diff']").click() }
    }

    @Test
    @Order(9)
    fun `an Outdated thread opens in its own window, the thread in a scroll pane`() {
        // Line 4 changes again: the thread of step 2 no longer finds its line.
        Files.writeString(Path.of(worktree, "a.php"), "<?php\n\necho 1;\necho 4;\n")
        frame {
            tree("//div[@class='Tree']").apply {
                // The double-click of step 4 collapsed a.php, and a collapsed file stays so.
                expandPath("a.php", fullMatch = false)
                waitOneContainsText("Outdated")
                doubleClickPath("a.php", "#1", fullMatch = false)
            }
        }
        driver.ui.x("//div[@class='JBScrollPane']//div[@class='ThreadView']").shouldBe(enabled)
        driver.ui.button("Close").click()
    }

    @Test
    @Order(10)
    fun `Resolve in the context menu of a thread of the tree resolves it`() {
        frame { tree("//div[@class='Tree']").rightClickPath("a.php", "#1", fullMatch = false) }
        driver.ui.x("//div[@class='ActionMenuItem' and @text='Resolve']").click()
        awaitSession("the thread is Resolved") { it.getAsJsonArray("threads")[0].asJsonObject["resolved"].asBoolean }
    }

    @Test
    @Order(11)
    fun `Group By › Directory lists the files under their directories, or flat once unchecked`() {
        Files.createDirectories(Path.of(worktree, "src"))
        Files.writeString(Path.of(worktree, "src/b.php"), "<?php\n")
        frame {
            tree("//div[@class='Tree']").apply {
                // The next poll reads the new file.
                waitOneText("src")
                clickPath("src", "b.php", fullMatch = false)
            }
            x("//div[@class='ActionButton' and contains(@myaction, 'Group By')]").click()
        }
        driver.ui.list("//div[@class='MyList']").clickItem("Directory", fullMatch = false)
        frame {
            tree("//div[@class='Tree']").apply {
                // At the top of the tree, followed by its directory.
                waitOneText("  src")
                clickPath("b.php", fullMatch = false)
            }
        }
    }

    @Test
    @Order(12)
    fun `in the Diff view, a click on a thread of the file shown scrolls its diff there, an added file too`() {
        Files.createDirectories(Path.of(worktree, "src"))
        Files.writeString(Path.of(worktree, "src/c.php"), "<?php\n" + (1..60).joinToString("") { "// line $it\n" })
        // As Claude does through open_thread: anchored on the base of the session and the working tree.
        post("/api/sessions/${session()["id"].asString}/threads", """{ "author": "claude", "path": "src/c.php", "side": "new", "start": 50, "end": 50, "body": "Here" }""")
        frame {
            tree("//div[@class='Tree']").apply {
                waitOneContainsText("Line +50")
                // At the top of the tree, the Group By step having listed the files flat.
                clickPath("c.php", fullMatch = false)
            }
            // The editor of the diff of c.php, beside the one of a.php that step 2 opened.
            fun diff() = xx("//div[@class='EditorComponentImpl']", JEditorUiComponent::class.java).list().singleOrNull { "// line 60" in it.text }
            repeat(50) { if (diff() == null) Thread.sleep(200) }
            tree("//div[@class='Tree']").clickPath("c.php", "Line +50", fullMatch = false)
            var line = -1
            repeat(50) {
                line = diff()!!.editor.getCaretModel().getLogicalPosition().getLine()
                if (line == 49) return@frame
                Thread.sleep(200)
            }
            assertEquals(49, line, "the caret of the diff on the line of the thread")
        }
    }

    @Test
    @Order(12)
    fun `Send in a thread adds my reply and sends the thread at once`() {
        frame {
            val thread = x("//div[@class='ThreadView' and .//div[@text='Thread #2 · Line +50']]")
            thread.x(".//div[@class='EditorTextField']").click()
            keyboard { typeText("Why here?") }
            thread.x(".//div[@class='JButton' and @text='Send']").click()
        }
        val session = awaitSession("the reply is sent") { it["sends"].asInt == 2 }
        val reply = session.getAsJsonArray("threads")[1].asJsonObject.getAsJsonArray("messages")[1].asJsonObject
        assertEquals(listOf("Why here?", 2), listOf(reply["body"].asString, reply["review"].asInt))
    }

    @Test
    @Order(13)
    fun `the diff folds the unchanged code, but not the lines of a thread`() {
        // Line 51 changes: lines 1 to 46 and 56 to 101 are unchanged, out of the 4 lines of context.
        Files.writeString(Path.of(worktree, "long.php"), "<?php\n" + (1..100).joinToString("") { if (it == 50) "// changed\n" else "// line $it\n" })
        post("/api/sessions/${session()["id"].asString}/threads", """{ "author": "claude", "path": "long.php", "side": "new", "start": 11, "end": 11, "body": "Unchanged" }""")
        frame {
            tree("//div[@class='Tree']").apply {
                waitOneContainsText("Line +11")
                clickPath("long.php", fullMatch = false)
            }
            fun diff() = xx("//div[@class='EditorComponentImpl']", JEditorUiComponent::class.java).list().singleOrNull { "// changed" in it.text }
            repeat(50) { if (diff() == null) Thread.sleep(200) }
            val editor = diff()!!.editor
            // The visual line of a line from 1, which the EDT computes: the lines of a collapsed fold share one.
            fun visual(line: Int) = driver.withContext(OnDispatcher.EDT) { editor.offsetToVisualPosition(editor.getDocument().getLineStartOffset(line - 1)).getLine() }
            var shown = ""
            repeat(50) {
                shown = "lines 56 to 101 on ${visual(101) - visual(56) + 1} visual lines, lines 10 to 12 on ${visual(12) - visual(10) + 1}"
                if (visual(101) - visual(56) < 45 && visual(12) - visual(10) == 2) return@frame
                Thread.sleep(200)
            }
            throw AssertionError("the unchanged code folds, but not the line of the thread: $shown")
        }
    }

    @Test
    @Order(14)
    fun `a double click on a Resolved thread opens it in its own window, unfolded, where Unresolve reopens it`() {
        val id = session()["id"].asString
        post("/api/sessions/$id/threads/2/resolve", "{}")
        frame {
            x("//div[@text='Show resolved']").click()
            tree("//div[@class='Tree']").apply {
                waitOneContainsText("Line +50")
                doubleClickPath("c.php", "Line +50", fullMatch = false)
            }
        }
        // The window, not the folded thread of the diff: its message shows.
        val window = "//div[@class='JBScrollPane']//div[@class='ThreadView']"
        driver.ui.x("$window//div[contains(@visible_text, 'Here')]").shouldBe(enabled)
        driver.ui.x("$window//div[@text='Unresolve']").click()
        awaitSession("the thread is no longer Resolved") { !it.getAsJsonArray("threads")[1].asJsonObject["resolved"].asBoolean }
        driver.ui.button("Close").click()
    }

    @Test
    // Last whatever steps come before it: the Approve closes the session they all use.
    @Order(Int.MAX_VALUE)
    fun `an Approve while the tree has the focus empties the tool window without an exception`() {
        frame { tree("//div[@class='Tree']").clickPath("c.php", "Line +50", fullMatch = false) }
        val before = ideaLog().length
        // As the browser would: the tree keeps the focus, and loses it once the tool window no longer shows the session.
        post("/api/sessions/${session()["id"].asString}/approve", "{}")
        frame { x("//div[@class='JBLabel' and @text='No review of this worktree yet.']").shouldBe(enabled) }
        // The tree repaints as it loses the focus, once the tool window no longer shows it: up to 5 s for an exception to reach the log.
        var logged = ""
        for (attempt in 1..25) {
            val log = ideaLog()
            // A log rolled to idea.1.log at its size limit starts again from empty.
            logged = if (log.length < before) log else log.substring(before)
            if ("at localreviews." in logged) break
            Thread.sleep(200)
        }
        assert("at localreviews." !in logged) { "an exception of the plugin after the Approve:\n$logged" }
    }
}
