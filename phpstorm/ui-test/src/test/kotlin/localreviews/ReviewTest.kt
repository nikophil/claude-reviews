package localreviews

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.driver.client.Driver
import com.intellij.driver.model.OnDispatcher
import com.intellij.driver.sdk.invokeAction
import com.intellij.driver.sdk.ui.components.common.IdeaFrameUI
import com.intellij.driver.sdk.ui.components.common.codeEditor
import com.intellij.driver.sdk.ui.components.common.editorTabs
import com.intellij.driver.sdk.ui.components.common.gutter
import com.intellij.driver.sdk.ui.components.common.GutterUiComponent
import com.intellij.driver.sdk.ui.components.common.ideFrame
import com.intellij.driver.sdk.ui.components.common.JEditorUiComponent
import com.intellij.driver.sdk.ui.components.elements.button
import com.intellij.driver.sdk.ui.components.elements.checkBox
import com.intellij.driver.sdk.ui.components.elements.list
import com.intellij.driver.sdk.ui.components.elements.radioButton
import com.intellij.driver.sdk.ui.components.elements.tree
import com.intellij.driver.sdk.ui.enabled
import com.intellij.driver.sdk.ui.notEnabled
import com.intellij.driver.sdk.ui.notPresent
import com.intellij.driver.sdk.ui.present
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
        private const val READONLY = "//div[@class='JBCheckBox' and @text='Answer without changing code']"
        private val repo: Path = Path.of(System.getProperty("repo"))
        private val http: HttpClient = HttpClient.newHttpClient()
        private lateinit var worktree: String
        /** The token of the server, from its endpoint file: every call of the test carries it, as the plugin's do; health needs none. */
        private var token = ""
        private lateinit var server: Process
        /** What the stand-in for the mod adds to its read every 2 s: `&blocked` while its Claude session waits for my answer. */
        @Volatile
        private var claudeQuery = ""
        /** Whether the stand-in for the mod reads at all: without it, the server says no Claude session runs in the worktree. */
        @Volatile
        private var claudeOn = true
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
                    if (claudeOn) runCatching { http.send(request("/api/sessions?worktree=${encode(worktree)}&claude$claudeQuery").GET().build(), HttpResponse.BodyHandlers.discarding()) }
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

        private fun IdeaFrameUI.editors() = xx("//div[@class='EditorComponentImpl']", JEditorUiComponent::class.java).list()

        /** The editor showing the text `text`, out of those of the tabs behind. */
        private fun IdeaFrameUI.shown(text: String) = editors().singleOrNull { it.component.isShowing() && text in it.text }

        private fun git(vararg args: String) {
            val process = ProcessBuilder("git", "-c", "user.name=test", "-c", "user.email=test@example.com", *args).directory(Path.of(worktree).toFile()).inheritIO().start()
            check(process.waitFor() == 0) { "git ${args.joinToString(" ")} failed" }
        }

        /** The name of the file selected in the tree of the tool window, its row's text up to the first space. */
        private fun IdeaFrameUI.selected() = tree("//div[@class='Tree']").collectSelectedPaths().singleOrNull()?.path?.last()?.substringBefore(' ')

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
    fun `Answer without changing code on a thread makes it readonly`() {
        frame { checkBox(READONLY).click() }
        awaitSession("the thread is readonly") { it.getAsJsonArray("threads")[0].asJsonObject["readonly"]?.asBoolean == true }
    }

    @Test
    @Order(4)
    fun `Send asks for a review message and its readonly, then publishes the Pending message, the thread readonly by that Send`() {
        frame { button("Send 1 pending").shouldBe(enabled).click() }
        driver.ui.x("//div[@class='JBTextArea']").click()
        driver.ui.keyboard { typeText("Only explain") }
        driver.ui.checkBox("//div[@class='MyDialog']$READONLY").click()
        driver.ui.x("//div[@class='MyDialog']//div[@class='JButton' and @text='Send']").click()
        val session = awaitSession("the Send publishes the message") { it["sends"].asInt == 1 }
        assert(!session.getAsJsonArray("threads")[0].asJsonObject.getAsJsonArray("messages")[0].asJsonObject["date"].isJsonNull)
        val review = session.getAsJsonArray("reviews")[0].asJsonObject
        assertEquals(listOf(1, "Only explain", true), listOf(review["review"].asInt, review["body"].asString, review["readonly"].asBoolean))
        // Unticking the thread would not undo the readonly of the Send: its checkbox says so, greyed.
        frame { checkBox(READONLY).shouldBe(notEnabled) }
    }

    @Test
    @Order(5)
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
    @Order(6)
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
    @Order(7)
    fun `Viewed in the diff marks the file viewed`() {
        frame {
            radioButton("//div[@text='Diff']").click()
            tree("//div[@class='Tree']").doubleClickPath("a.php", fullMatch = false)
            x("//div[@text='Viewed']").click()
        }
        awaitSession("a.php is viewed") { it.getAsJsonObject("viewed")?.has("a.php") == true }
    }

    @Test
    @Order(8)
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
    @Order(9)
    fun `Viewed in the diff unmarks the file in place, then marks it and shows in its tab the next file not viewed, selected in the tree, though Claude wrote a file since`() {
        Files.writeString(Path.of(worktree, "next.php"), "<?php\necho 'next';\n")
        frame {
            val opened = editorTabs().getTabs().size
            tree("//div[@class='Tree']").apply {
                // The next poll reads the new file.
                waitOneContainsText("next.php")
                // The diff of step 7 opened before next.php, which it does not have: a diff of a.php that has it.
                clickPath("a.php", fullMatch = false)
            }
            // Enter: a.php may already be the selection, which a click leaves as is.
            keyboard { enter() }
            // The diff of other files takes the place of the tab of step 7, rather than opening beside it.
            repeat(15) {
                Thread.sleep(200)
                assert(editorTabs().getTabs().size <= opened) { "the new diff replaces the tab of the old one" }
            }
            // a.php, Viewed at step 7, when it was the last file.
            x("//div[@text='Viewed']").click()
        }
        awaitSession("a.php is no longer viewed") { it.getAsJsonObject("viewed")?.has("a.php") == false }
        // A file Claude writes meanwhile: the diff of the session now has other files than the tab.
        Files.writeString(Path.of(worktree, "z.php"), "<?php\n")
        lateinit var before: List<String>
        frame {
            tree("//div[@class='Tree']").waitOneContainsText("z.php")
            assert(editors().any { "echo 2;" in it.text }) { "the diff still shows a.php" }
            before = editorTabs().getTabs().map { it.text }
            x("//div[@text='Viewed']").click()
        }
        awaitSession("a.php is viewed") { it.getAsJsonObject("viewed")?.has("a.php") == true }
        frame {
            fun shown() = editors().any { "echo 'next';" in it.text }
            repeat(50) { if (!shown()) Thread.sleep(200) }
            assert(shown()) { "the diff shows next.php" }
            // The tab of the diff is named after the file it shows.
            val after = editorTabs().getTabs().map { it.text }
            assert(after.size == before.size && "next.php" in after) { "the tab of the diff of a.php shows next.php, no other opens: $before, then $after" }
            assertEquals("next.php", selected())
        }
    }

    @Test
    @Order(10)
    fun `Space on a file of the tree unmarks it Viewed and stays there, then marks it and selects the next file not viewed`() {
        frame {
            tree("//div[@class='Tree']").clickPath("a.php", fullMatch = false)
            keyboard { space() }
            awaitSession("a.php is no longer viewed") { it.getAsJsonObject("viewed")?.has("a.php") == false }
            assertEquals("a.php", selected())
            keyboard { space() }
            awaitSession("a.php is viewed") { it.getAsJsonObject("viewed")?.has("a.php") == true }
            repeat(50) { if (selected() != "next.php") Thread.sleep(200) }
            assertEquals("next.php", selected())
        }
    }

    @Test
    @Order(11)
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
    @Order(12)
    fun `an Outdated thread opens in its own window, the thread in a scroll pane`() {
        // Line 4 changes again: the thread of step 2 no longer finds its line.
        Files.writeString(Path.of(worktree, "a.php"), "<?php\n\necho 1;\necho 4;\n")
        frame {
            tree("//div[@class='Tree']").apply {
                // The double-click of step 7 opened a.php, without folding it.
                waitOneContainsText("Outdated")
                doubleClickPath("a.php", "#1", fullMatch = false)
            }
        }
        driver.ui.x("//div[@class='JBScrollPane']//div[@class='ThreadView']").shouldBe(enabled)
        driver.ui.button("Close").click()
    }

    @Test
    @Order(13)
    fun `Resolve in the context menu of a thread of the tree resolves it`() {
        frame { tree("//div[@class='Tree']").rightClickPath("a.php", "#1", fullMatch = false) }
        driver.ui.x("//div[@class='ActionMenuItem' and @text='Resolve']").click()
        awaitSession("the thread is Resolved") { it.getAsJsonArray("threads")[0].asJsonObject["resolved"].asBoolean }
    }

    @Test
    @Order(14)
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
    @Order(15)
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
    @Order(16)
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
    @Order(17)
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
    @Order(18)
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
    @Order(19)
    fun `Replied marks a thread where Claude wrote after my last sent message in it, whatever the Send of another thread since`() {
        val id = session()["id"].asString
        post("/api/sessions/$id/threads/2/messages", """{ "author": "claude", "body": "Because" }""")
        // Each part of a row of the tree is a text of its own: the only Replied is that of #2.
        frame { tree("//div[@class='Tree']").waitOneContainsText(" · Replied") }
        post("/api/sessions/$id/threads/3/messages", """{ "author": "me", "body": "Why unchanged?" }""")
        val tree = get("/api/sessions/$id/tree")["tree"].asString
        post("/api/sessions/$id/send", """{ "tree": "$tree", "threads": [3] }""")
        frame {
            tree("//div[@class='Tree']").apply {
                waitOneContainsText(" · Waiting for Claude")
                waitOneContainsText(" · Replied")
            }
        }
    }

    @Test
    @Order(20)
    fun `with Show threads off, Next Thread opens the thread it goes to, file by file in the order of the tree, by line, around after the last one`() {
        post("/api/sessions/${session()["id"].asString}/threads", """{ "author": "claude", "path": "src/c.php", "side": "new", "start": 10, "end": 10, "body": "Above" }""")
        frame {
            x("//div[@text='Show threads']").click()
            val tree = tree("//div[@class='Tree']")
            tree.waitOneContainsText("Line +10")
            tree.clickPath("c.php", fullMatch = false)
            // Thread #1 of a.php is Resolved, #3 of long.php comes first, the threads of c.php by line: #4 on line 10, #2 on line 50.
            for (expected in listOf("#4", "#2", "#3")) {
                // Its shortcut, the tree keeping the focus.
                keyboard { hotKey(KeyEvent.VK_ALT, KeyEvent.VK_SHIFT, KeyEvent.VK_PAGE_DOWN) }
                repeat(50) { if (selected() != expected) Thread.sleep(200) }
                assertEquals(expected, selected())
                if (expected == "#4") x("//div[@class='ThreadView' and .//div[@text='Thread #4 · Line +10']]").shouldBe(present)
            }
            x("//div[@text='Show threads']").click()
        }
    }

    @Test
    @Order(21)
    fun `in the Editor view, a click on a file goes to its first thread shown, not to a hidden Resolved one, and Space leaves Viewed alone`() {
        post("/api/sessions/${session()["id"].asString}/threads/4/resolve", "{}")
        frame {
            // Once the tool window reads it: a.php and c.php each have a Resolved thread.
            val tree = tree("//div[@class='Tree']")
            repeat(50) { if (tree.getAllTexts().count { "1 resolved" in it.text } < 2) Thread.sleep(200) }
            // Shown since step 18.
            x("//div[@text='Show resolved']").click()
            radioButton("//div[@text='Editor']").click()
            tree("//div[@class='Tree']").clickPath("c.php", fullMatch = false)
            caretLine(49) { shown("// line 60")?.editor?.getCaretModel()?.getLogicalPosition()?.getLine() ?: -1 }
            keyboard { space() }
            Thread.sleep(3000)
            assertEquals("c.php", selected())
        }
        assert(session().getAsJsonObject("viewed")?.has("src/c.php") != true) { "Space marks no file Viewed in the Editor view" }
        frame { x("//div[@text='Show resolved']").click() }
    }

    @Test
    @Order(22)
    fun `a new thread keeps its text when Show threads changes and when a commit moves the base, then opens on its lines`() {
        frame {
            val editor = shown("// line 60")!!
            editor.moveCaretToOffset(editor.text.lines().take(19).sumOf { it.length + 1 })
            driver.invokeAction("localreviews.OpenThread", component = editor.component)
            keyboard { typeText("Kept") }
            fun kept() = editors().any { it.text == "Kept" }
            repeat(2) {
                x("//div[@text='Show threads']").click()
                repeat(10) { if (!kept()) Thread.sleep(200) }
                assert(kept()) { "the text of the new thread once Show threads changes" }
            }
            // Under HEAD, a commit moves the id of the base, which the next polls read.
            git("commit", "-q", "--allow-empty", "-m", "empty")
            Thread.sleep(5000)
            assert(kept()) { "the text of the new thread once the base moves" }
            x("//div[@class='ThreadView' and .//div[@text='New thread']]//div[@class='EditorTextField']").click()
            keyboard { hotKey(KeyEvent.VK_CONTROL, KeyEvent.VK_ENTER) }
        }
        val thread = awaitSession("the new thread opens") { session -> session.getAsJsonArray("threads").any { it.asJsonObject.getAsJsonArray("messages")[0].asJsonObject["body"].asString == "Kept" } }
            .getAsJsonArray("threads").map { it.asJsonObject }.single { it.getAsJsonArray("messages")[0].asJsonObject["body"].asString == "Kept" }
        val anchor = thread.getAsJsonObject("anchor")
        assertEquals(listOf("src/c.php", "new", 20, 20), listOf(anchor["path"].asString, anchor["side"].asString, anchor["start"].asInt, anchor["end"].asInt))
        post("/api/sessions/${session()["id"].asString}/threads/${thread["id"].asInt}/messages/0/delete", "{}")
        frame { radioButton("//div[@text='Diff']").click() }
    }

    @Test
    @Order(23)
    fun `without a Claude session, Send goes, with the command that starts one`() {
        val notice = "//div[@class='JBLabel' and contains(@text, 'No Claude session in this worktree')]"
        val id = session()["id"].asString
        post("/api/sessions/$id/threads/2/messages", """{ "author": "me", "body": "And?" }""")
        val sends = session()["sends"].asInt
        claudeOn = false
        try {
            frame {
                // The server forgets the Claude session 10 s after its last read.
                repeat(100) { if (!x(notice).present()) Thread.sleep(200) }
                x(notice).shouldBe(present)
                button("Send 1 pending").shouldBe(enabled).click()
            }
            driver.ui.x("//div[@class='MyDialog']//div[@class='JButton' and @text='Send']").click()
            awaitSession("the Send goes without a Claude session") { it["sends"].asInt == sends + 1 }
        } finally {
            claudeOn = true
        }
        frame { x(notice).shouldBe(notPresent) }
    }

    @Test
    // Last whatever steps come before it: the Approve closes the session they all use.
    @Order(Int.MAX_VALUE)
    fun `an Approve while the tree has the focus empties the tool window without an exception, closes the window of a thread, and leaves the diff read-only`() {
        // The window of the Resolved thread of step 21.
        frame { tree("//div[@class='Tree']").doubleClickPath("c.php", "Line +10", fullMatch = false) }
        val window = "//div[@class='JBScrollPane']//div[@class='ThreadView']"
        driver.ui.x(window).shouldBe(present)
        frame { tree("//div[@class='Tree']").clickPath("c.php", "Line +50", fullMatch = false) }
        val thread = "//div[@class='ThreadView' and .//div[@text='Thread #2 · Line +50']]"
        frame { x(thread).shouldBe(present) }
        val before = ideaLog().length
        // As the browser would: the tree keeps the focus, and loses it once the tool window no longer shows the session.
        post("/api/sessions/${session()["id"].asString}/approve", "{}")
        frame { x("//div[@class='JBLabel' and @text='The review of this worktree is closed.']").shouldBe(enabled) }
        driver.ui.x(window).shouldBe(notPresent)
        frame {
            // The diff still shows the thread, without a field nor a button to write: the session takes no write.
            fun writable() = xx("$thread//div[@class='JButton']").list().any { it.component.isShowing() }
            repeat(50) { if (writable()) Thread.sleep(200) }
            assert(!writable()) { "the thread of the diff takes no write after the Approve" }
            x(thread).shouldBe(present)
            x("//div[@text='Viewed']").shouldBe(notEnabled)
        }
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
