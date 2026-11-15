# Clients and the mod talk only through the server's HTTP API

The server is the only core: sessions, diff, reanchoring, Send and Approve.
The Claude side is the mod (`hooks/`): it starts the server, polls the session and wakes Claude.
The client side is the page (`ui/`) in a browser, the PhpStorm plugin (`phpstorm/`) and the VS Code extension (`vscode/`).
A client talks only to the HTTP API, imports nothing from `server/` or `hooks/`, and does not start the server:
without a Claude session, it says that the server does not answer, and a Reload reloads it.
This way, a new IDE touches neither the server nor the mod.

The PhpStorm plugin is a native client, in Swing, not the embedded page:
a tool window (base, Send, Approve, changed files and their threads), the threads in the editor and in the IDE's diff.
It first embedded the page through JCEF, with a contract to open a file in the editor;
but the page, made for a browser, overflows a narrow tool window, and its threads stay far from the code you navigate in:
you want to read and write the threads under the lines, while keeping Ctrl+click and the rest of the IDE.
For its diff, it reads the text of a file at the base through `GET /api/sessions/<id>/file`, rather than through git: a client talks only to the API.

The PhpStorm plugin is written in Java and compiled by the `javac` of the installed PhpStorm, against its jars (`phpstorm/build.sh`):
neither Gradle nor Kotlin, nor the IntelliJ Platform of about 1 GB to download, like the rest of the repository, with no build and no dependency.

The VS Code extension is a native client too, but VS Code provides what the PhpStorm plugin draws itself:
the threads go through its Comments API (Pending through the label of a message, Resolved through the state of the thread), the session through a tree view with a Viewed checkbox per file, the diff through its own diff editor.
It is written in CommonJS JS checked by `// @ts-check`, with no build, and `vscode/build.sh` makes a `.vsix` of it with `zip`, a `.vsix` being only a zip and two manifests;
`@types/vscode` is only a development dependency.
Its tests run in openvscode-server, VS Code served as a web page, which Playwright drives like the page.

```
            Claude side                    core                     clients
Claude session ── mod (hooks/) ──HTTP──> server (server/)  <──HTTP── page (ui/) ── browser
                                                               <──HTTP── phpstorm/ (Swing), vscode/ (extension API)
```

## Considered Options

- Kotlin and the IntelliJ Platform Gradle Plugin, the official way: `runIde` and the plugin verifier, at the price of a JDK to install and a build of about 1 GB on the first run;
  Gradle comes back for the UI tests only, in Docker ([ADR 0005](0005-phpstorm-ui-tests-with-gradle-in-docker.md)).
- The page embedded through JCEF in a tool window: tried, then replaced, for the reasons above.
- A client that starts the server: it would have to find the folder of the Claude plugin under `~/.claude/plugins/`, and without a Claude session, no thread moves forward.
- An "agent" abstraction in place of Claude in the server: no other agent is planned.
