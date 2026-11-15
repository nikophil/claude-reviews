package localreviews

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.driver.client.Driver
import com.intellij.driver.sdk.invokeAction
import com.intellij.driver.sdk.ui.components.common.IdeaFrameUI
import com.intellij.driver.sdk.ui.components.common.codeEditor
import com.intellij.driver.sdk.ui.components.common.gutter
import com.intellij.driver.sdk.ui.components.common.ideFrame
import com.intellij.driver.sdk.ui.components.elements.button
import com.intellij.driver.sdk.ui.components.elements.radioButton
import com.intellij.driver.sdk.ui.components.elements.tree
import com.intellij.driver.sdk.ui.enabled
import com.intellij.driver.sdk.ui.shouldBe
import com.intellij.driver.sdk.ui.ui
import com.intellij.driver.sdk.waitForProjectOpen
import com.intellij.ide.starter.di.di
import com.intellij.ide.starter.driver.engine.BackgroundRun
import com.intellij.ide.starter.driver.engine.runIdeWithDriver
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
 * one PhpStorm for the four steps of a review, in order, on a repository whose a.php changes.
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
                    runCatching { http.send(request("/api/sessions?worktree=${encode(worktree)}&claude").GET().build(), HttpResponse.BodyHandlers.discarding()) }
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
            ide = Starter.newContext("review", TestCase(phpStorm, LocalProjectInfo(Path.of(worktree))))
                .apply { pluginConfigurator.installPluginFromPath(Path.of(System.getProperty("plugin"))) }
                // XDG_DATA_HOME so the plugin reads the endpoint file, port and token, the server wrote.
                .applyVMOptionsPatch {
                    withEnv("CLAUDE_REVIEWS_PORT", PORT)
                    withEnv("XDG_DATA_HOME", data.toString())
                }
                .runIdeWithDriver()
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
    fun `Viewed in the diff marks the file viewed`() {
        frame {
            radioButton("//div[@text='Diff']").click()
            tree("//div[@class='Tree']").doubleClickPath("a.php", fullMatch = false)
            x("//div[@text='Viewed']").click()
        }
        awaitSession("a.php is viewed") { it.getAsJsonObject("viewed")?.has("a.php") == true }
    }
}
