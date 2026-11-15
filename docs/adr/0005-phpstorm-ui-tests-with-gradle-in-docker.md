# PhpStorm plugin UI tests with Starter and Driver, with Gradle in Docker

The PhpStorm plugin is tested end to end in CI: a real PhpStorm, on Xvfb, with the plugin installed, facing a claude-reviews server.
The tests are written with Starter and Driver, the integration test framework of JetBrains, in Kotlin and on JUnit 5, which only Gradle can assemble.
Gradle serves only these tests, in `phpstorm/ui-test/`: `build.sh` remains the build of the plugin, and the tests install its zip.
Gradle, the JDK, Node and Xvfb live in a Docker image (`docker-compose.yml`), and nothing but Docker gets installed on the machine or on the runner.
This choice replaces, for the tests only, the rejection of Gradle in [ADR 0004](0004-clients-and-mod-separated-by-the-api.md): its cost, a heavy build on the first run, stays in a Docker volume.

`run.sh` downloads PhpStorm once, in the version the script pins, into the `phpstorm-cache` volume;
`build.sh` compiles against its jars, the Plugin Verifier checks the zip against it, and the tests launch it as is, without the copy Starter would make of it.
Starter and Driver come from the Maven repository of JetBrains, without the IntelliJ Platform Gradle plugin, which would download a second IDE to compile.
PhpStorm starts in trial mode in the fresh config folder of each test: no license and no secret in CI.

## Considered Options

- The IntelliJ Platform Gradle plugin to build the plugin too, the official way: rejected, `build.sh` is enough, and two builds of the same plugin would diverge.
- Remote Robot: rejected, Starter and Driver replace it, and launch the IDE and Xvfb themselves.
- IntelliJ IDEA rather than PhpStorm, for lack of a license: unnecessary, the PhpStorm trial starts without a window.
- A license key as a secret (`IDETestContext.setLicense`): to revisit if JetBrains withdraws the trial without an account.
- Gradle installed on the machine: rejected, Docker is enough, and the CI runs the same command as the workstation.
