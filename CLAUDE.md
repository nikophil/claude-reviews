# claude-reviews

Read `BRIEF.md`, `GLOSSARY.md` and `docs/adr/` before changing the code, and name things with the words of the glossary.

## Prerequisites

- Node 25 or later.
- git 2.41 or later: the list of bases sorts the branches by `%(ahead-behind:HEAD)` of `git for-each-ref`.

## Commands

- `npm ci`: installs `@playwright/test` and `@types/vscode`, the only dependencies, both development ones.
- `npm start` (`node server/main.ts`): starts the server on an ephemeral port of `127.0.0.1`, and writes its port and its token to `<data>/endpoint`.
  Then open `http://127.0.0.1:<port>/?worktree=<absolute path>#token=<token>`, which opens the session of the worktree and redirects to `/s/<id>` without the token in the URL.
- `CLAUDE_REVIEWS_PORT=<port>` sets the port instead of picking an ephemeral one.
  Over SSH, each user picks their own in their shell profile and forwards the same number on both sides (`ssh -L <port>:127.0.0.1:<port>`):
  the `Host` guard expects this number, and an ephemeral port changes on every restart of the server.
- `node --test`: tests of the server, of the pure functions and of the mod, the latter under a fake `$`.
- `npm run test:mod`: `claude plugin test` on a copy of the mod in `var/mod/`, because it would also run the `*.test.ts` of `node --test`; its tests are `*.test.tsx`, which `node --test` ignores.
- `claude --plugin-dir .`: a Claude session with the mod of this folder.
- `/plugin install local-reviews --marketplace nikophil/claude-reviews`: installs the mod; it starts the server with the `node` of the `PATH`, version 25 or later.
- `npx playwright install chromium` once, then `npx playwright test`: tests of the UI, on a server started on port 7779, with a temporary `XDG_DATA_HOME`.
- `npm run readme`: remakes the images of `README.md` (`docs/images/`) with Playwright, on example repositories (`e2e/readme.ts`), the VS Code one in openvscode-server like `npm run test:vscode`, except `phpstorm.png`, taken by hand in the IDE;
  the animation is an animated PNG, assembled without any tool to install.
- `npm run build:phpstorm`: builds `var/phpstorm/local-reviews.zip` with the `javac` and the jars of the installed PhpStorm (`PHPSTORM_HOME`, otherwise the Toolbox one) and `zip`, with the version of `.claude-plugin/plugin.json` followed by the epoch of the build, and writes `var/phpstorm/updatePlugins.xml`;
  this plugin repository, added once through Settings › Plugins › ⚙ › Manage Plugin Repositories (`file://…/updatePlugins.xml`), then offers each build as an update.
- `npm run test:phpstorm`: in the container of `docker-compose.yml`, builds the plugin against PhpStorm 2026.2.5, runs it through the Plugin Verifier, then runs its UI tests;
  PhpStorm, the Gradle dependencies and the Plugin Verifier are downloaded once into the `phpstorm-cache` volume, or into the folder that `PHPSTORM_CACHE` names.
- `npm run build:vscode`: builds `var/vscode/local-reviews.vsix` with `zip`, at the version of `.claude-plugin/plugin.json` (the one of `vscode/package.json` is not used), to install with `code --install-extension var/vscode/local-reviews.vsix --force`.
- A release: merge a PR that bumps `.claude-plugin/plugin.json`.
  On each push to main, `.github/workflows/release.yml` publishes the version of `plugin.json` that has no tag `v<version>` yet: it builds the PhpStorm zip (Plugin Verifier and UI tests included) and the `.vsix` at this version,
  then creates the tag on the merged commit and its GitHub release, with the zip, the `.vsix` and the `updatePlugins.xml` that points to this zip;
  PhpStorm reads the one of the latest release (`releases/latest/download/updatePlugins.xml`) to offer the update.
  A release that fails leaves no tag: a re-run of the job, or the next push to main, tries again.
- `npm run test:vscode`: tests of the VS Code extension, `e2e/vscode.spec.ts`, in openvscode-server 1.109.5 (`~/.cache/claude-reviews/openvscode-server-v1.109.5-linux-x64`, otherwise `OPENVSCODE_SERVER`), on a server started on port 7781;
  openvscode-server is downloaded once from the releases of `gitpod-io/openvscode-server`, as the CI does.

## Structure

- `server/`: `node:http` server in TypeScript, run by Node 25 without a build (type stripping); the imports carry the `.ts` extension.
- `server/diff.ts`: writes the tree of the working tree with a temporary index, then computes and parses `git diff <base> <tree>`.
- `server/sessions.ts`: sessions, threads, messages, Send and Approve, stored as JSON under the data folder.
- `server/reanchor.ts`: `reanchor(anchor, lines)`, the pure function that finds the range of an Anchor in a file, or returns `null` when the thread is Outdated.
- `ui/`: page served as is, in Preact + htm without a build or JSX.
- `ui/vendor/`: front-end libraries copied as is, not to be modified or reviewed.
- `e2e/`: Playwright tests.
- `.claude-plugin/`: the `local-reviews` plugin (the `claude-` prefix is reserved for Anthropic) and the marketplace of this repository; the version of the plugin is the one of the server, of the PhpStorm plugin and of the VS Code extension.
  Any change to `server/` or `ui/` bumps it, and its merge releases it: the mod keeps an already running server of the same version.
- `hooks/register.ts`: the mod, which registers the tools and `/review-local`, starts the server, polls the session every 2 s and wakes Claude; `$` is only passed there to functions declared at the top of the file.
- `hooks/watch.ts`: the decisions of the mod (wake, relaunch, stay silent, resume after a `{ drop }`), and the sockets listening on a port read from `/proc/net/tcp`, as pure functions.
- `phpstorm/`: the PhpStorm plugin, in Java and Swing: the "Claude Reviews" tool window (base, Send, Approve, changed files and their threads), the threads in the editor and in the diff of the IDE;
  its Editor view opens a file in the editor, its Diff view in the diff of the IDE, with the Viewed checkbox of each file in the tree and in the bar of the diff;
  this diff has a place of its own (`localreviews.Review`), which folds the unchanged code by default, once, then keeps the Collapse Unchanged Fragments setting of the IDE, and unfolds the lines of a thread;
  it edits and deletes my Pending messages, moves from one thread not Resolved to the next (Next Thread and Previous Thread, Alt+Shift+Page Down and Page Up, also in the bar of the diff and at the top right of the editor), marks "Replied" those, not Resolved, where Claude replied since my last Send,
  resolves or reopens a thread from its context menu in the tree, opens an Outdated thread in a window of its own, scrolled when long,
  groups its files under their directories, or lists them flat each followed by its directory (Group By › Directory, as in the Commit tool window),
  and offers Suggest Change, Comment on File and Copy Threads as Markdown, in the same format as the web UI; it only talks to the API, like any client ([ADR 0004](docs/adr/0004-clients-and-mod-separated-by-the-api.md)).
- `phpstorm/ui-test/`: the UI tests of the plugin, in Kotlin, with JetBrains' Starter and Driver, under Gradle in Docker ([ADR 0005](docs/adr/0005-phpstorm-ui-tests-with-gradle-in-docker.md));
  there, `run.sh` runs in sequence `build.sh`, the Plugin Verifier, which fails on any verdict other than "Compatible", and `gradle test`.
- `vscode/`: the VS Code extension, in CommonJS JS checked by `// @ts-check`, without a build: the "Claude Reviews" view (base, Send, Approve, changed files with their Viewed checkbox and their threads), the threads through the Comments API in the editor and in the diff of VS Code;
  a click on a file opens its diff, the Viewed checkbox is also in the bar of the diff, Next Thread and Previous Thread in the bar of the editor and of the diff, and an Outdated thread opens on its diff excerpt; `vscode/review.js` holds the pure functions, tested by `node --test`.
- No npm dependency at runtime: what is missing gets written, or vendored as a single file in `ui/vendor/`.

## HTTP contract

The server serves the UI and a JSON API, for the UI and the mod.

- `GET /` serves the Reviews screen: the open sessions of `GET /api/sessions`, each a link to `/s/<id>`.
- `GET /s/<id>` serves the page of the session `<id>`, open or approved; the page of an approved session whose worktree is gone, or closed by `closedBecause`, shows all its threads on their Anchor, without diff or Outdated, and "Closed" and its banner only if `closedBecause` says so.
- `GET /?worktree=<path>` serves the same page, which opens the session of the worktree through `POST /api/sessions`, then replaces its URL with `/s/<id>`.
- The page reads the session and `/tree` every 2 s, and only reloads the diff when it opens, on Refresh, on a change of base and on Hide whitespace.
- The banner "The code changed since it was loaded" appears when `/tree` differs from the displayed diff: by its `tree`, or by its `base` outside Since my last review, which a Send moves without changing the code.

- The server listens on an ephemeral port of `127.0.0.1`, and writes `{ port, token }` to `<data>/endpoint` (0600): each account has its own server, and the clients read there where to reach it and its token.
- A client only trusts the port of the `endpoint` if the socket that listens on it belongs to its account, read from `/proc/net/tcp` and `/proc/net/tcp6`, which any account can read:
  another account that takes the port of a dead server and answers like claude-reviews gets neither calls nor trust. Without `/proc` (macOS), the client trusts.
- Every `/api/` route except `GET /api/health` requires the token in `Authorization: Bearer <token>`, otherwise 401 `{ "error": "unauthorized" }`: another account reaches the port on the loopback, but gets nothing without the token, and can neither read a repository, nor write a message, nor stop the server.
- The token is compared in constant time; it guards `/api/me`, so the github.com login of the account does not leak.
- The UI receives the token through the fragment `#token=<token>` on opening, keeps it in `localStorage`, which only its own scripts read, removes it from the URL, then sends it on each call;
  on a 401, it asks to reopen the review through `/review-local`. The mod, PhpStorm and VS Code read it from the `endpoint` file.
- Any request whose `Host` is neither `127.0.0.1:<port>` nor `localhost:<port>` gets 403.
- `/?worktree=` gets 403 when its `Sec-Fetch-Site` is neither absent, nor `same-origin`, nor `none`: the page would open the session and run git on a path chosen by another site.
- The HTML carries `Content-Security-Policy: script-src 'self'; object-src 'none'; frame-ancestors 'none'`.
- An `/api/` request whose `Sec-Fetch-Site` is neither `same-origin` nor `none` gets 403.
- A write (any method except `GET` and `HEAD`) requires `Content-Type: application/json` (otherwise 415) and an `Origin` that is absent or equal to `http://<Host>` (otherwise 403): the UI sends its own, the mod none; these guards and the CSP protect the browser, the token protects against local processes.
- No response carries a CORS header.
- An error answers `{ "error": "<message>" }`: 400 for an invalid input, 404 for an unknown session, thread or route, 409 for a refused write, 413 for a body over 1 MB.

| Route | Role |
| --- | --- |
| `GET /api/health` | `{ app: "claude-reviews", version }`, the version of `.claude-plugin/plugin.json`; the only route without a token, for the liveness check. |
| `GET /api/me` | `{ login, name }`, for the avatars of my messages: my login on github.com (`gh api --hostname github.com user --jq .login`) and `git config --global --includes user.name`, each `null` on failure or beyond 2 s. |
| `POST /api/shutdown` `{}` | Stops the server: it stops listening before answering. |
| `GET /api/sessions` | The open sessions, for Reviews: `[{ id, worktree, repo, branch, waitingForClaude, updatedAt }]`, Waiting for Claude first, then the rest, the most recently active first on a tie. |
| `GET /api/sessions?worktree=<path>[&claude[&blocked]]` | The open session of the worktree, without creating one: 404 without an open session; `&claude` comes from the mod, and says that a Claude session runs in this worktree, even without an open session; `&blocked`, that this Claude session is Blocked. |
| `GET /api/sessions?closed` | The closed sessions, for the Closed tab of Reviews: `[{ id, worktree, repo, approvedAt, closedBecause }]`, the most recently closed first. |
| `GET /api/inbox` | One entry per open session, for the local sources of gh-notif: `[{ repo, branch, title, url, openThreads, awaitingMe, lastActor, updatedAt }]`, where `awaitingMe` counts the threads where Claude spoke last; gh-notif calls it with the port and the token of the `endpoint` file, like any client. |
| `POST /api/sessions` `{ worktree }` | Returns the open session of the worktree, or creates one. |
| `GET /api/sessions/<id>` | The session, open or approved. |
| `GET /api/sessions/<id>/diff[?base=&tree=][&w=1]` | The diff of the working tree of the session against its base: `{ ref, base, tree, files }`, where `ref` is the chosen base, or `HEAD` when it no longer points to anything, and `base` and `tree` the ids of the displayed base and tree; with `?base=&tree=`, `{ base, tree, files }`, the diff of these ids; with `w=1` (Hide whitespace), `git diff -w`. |
| `GET /api/sessions/<id>/tree` | `{ ref, base, tree }` like `/diff`, without computing the diff: the poll of the UI compares it with the displayed diff. |
| `GET /api/sessions/<id>/lines?path=<path>&tree=<id>&from=<n>&to=<m>` | `{ lines }`, the lines `from` to `to` of the file in the displayed tree, which the diff hides and "Expand" shows. |
| `GET /api/sessions/<id>/file?object=<id>&path=<path>` | `{ text }`, the text of `path` in the commit or the tree `object` of the repository of the session: 404 without this file, 400 for an object that the repository does not have. |
| `GET /api/sessions/<id>/bases` | The bases of the selector, in its order: `[{ ref, name, disabled?, group? }]`, `group` absent for the quick choices. |
| `POST /api/sessions/<id>/base` `{ base }` | Chooses the base of the session among the `ref`s of `/bases` that are not grayed out. |
| `POST /api/sessions/<id>/threads` `{ author, path, side, start, end, body, base?, tree? }` | Opens a thread with its first message (`open_thread` for Claude). |
| `POST /api/sessions/<id>/threads/<n>/messages` `{ author, body }` | Adds a message (`reply_to_thread` for Claude). |
| `POST /api/sessions/<id>/threads/<n>/messages/<i>` `{ body }` | Edits my Pending message at index `i`, counted from 0, in the thread. |
| `POST /api/sessions/<id>/threads/<n>/messages/<i>/delete` `{}` | Deletes my Pending message at index `i`; a thread that has no message left goes with it. |
| `POST /api/sessions/<id>/threads/<n>/resolve` `{}` | Resolves the thread. |
| `POST /api/sessions/<id>/viewed` `{ path, tree, viewed }` | Marks the file Viewed on the displayed tree, or unmarks it. |
| `POST /api/sessions/<id>/threads/<n>/unresolve` `{}` | Reopens the Resolved thread. |
| `POST /api/sessions/<id>/send` `{ tree, threads? }` | Send: Snapshot of the displayed tree, then publication of the Pending messages, only those of the threads in `threads` when it is given. |
| `POST /api/sessions/<id>/approve` `{}` | Approve: archives the session, then deletes its refs. |
| `POST /api/sessions/<id>/show` `{}` | Asks the IDE clients to show the session: it then carries `showRequestedAt`, the date of the request, kept in memory. |
| `POST /api/sessions/<id>/turn-complete` `{}` | Notifies "Claude replied in N threads", followed by ", M still waiting" if some remain, through `notify-send` (Linux) or `osascript` (macOS). |

- Reading the sessions (`GET /api/sessions`, with or without `worktree`) first closes, like an Approve, each open session whose worktree no longer exists, even with Pending messages; reading a session (`GET /api/sessions/<id>`) closes that one the same way, and an approved session whose placement fails answers without `at`.
- A worktree no longer exists when its `stat` answers ENOENT, its parent folder still exists, and its `commonDir`, if it is outside the worktree, still exists; any other error, or a parent or a `commonDir` gone as well (unmounted disk), leaves the session open.
- Reading or opening the session of a worktree also closes the session at its path that carries another `commonDir`: another repository does not take over the session.
- A read only waits for the write queue to close a session; an unreadable session file is ignored, with a line in the server log, without being deleted or rewritten.
- Each returned session carries `claudeSession`, true when the mod read its worktree with `&claude` in the last 10 seconds, kept in memory; without it, the PhpStorm plugin grays out its Sends, the VS Code extension refuses them, and both show, instead of waiting for Claude, the command that starts a Claude session.
- It also carries `claudeBlocked`, true when that last read also carried `&blocked` and a thread is Waiting for Claude;
  the page, the PhpStorm tool window and the bar of its diff, the VS Code view and the bar of its diff then warn that Claude is waiting for my answer in its session.
- The notification counts the threads where Claude wrote since the last Send, and the Waiting for Claude threads; `start(port, notify)` receives the command to run, which the tests record without running it.
- Except for `/diff`, `/tree`, `/lines`, `/bases` and the list of sessions, each route of a session returns the whole session, in the file format, and each thread there also carries its `status`: `resolved`, `waiting-for-claude` when my message is the last published one, `open` when it is Claude's, or `null` as long as no message is published; the clients do not display `open`.
- A route that returns the session and receives `?base=<id>&tree=<id>` (the code displayed by the UI), or `?reanchor` (the base of the session and the working tree, for the mod), re-anchors each thread on this code: each thread then also carries `at`, `null` if it is Outdated, otherwise `{ start, end, context }`.
- With `?reanchor`, `at` is `{ start, end }`, without `context` or diff computation, a Resolved thread has no `at`, and the session carries `reanchoredOn: { base, tree }`, the ids of this code.
- A malformed `base` or `tree` in the query, or a `w` other than `1`, gets 400 before any write; a recorded write answers 200, with its threads without `at` if their re-anchoring fails.
- With `?w=1` on top of `?base=&tree=`, `context` is computed on the diff that hides whitespace: a thread on a line that only changes by its whitespace leaves the diff, and receives its context lines.
- `context` lists, when no hunk of the diff of this code shows the last line of the range, the lines from 3 above to 3 below the range, except those of the hunks, unchanged and numbered on both sides; the UI displays them as one more hunk.
- Placed by `?base=&tree=`, the session keeps in `viewed` only the files whose content in `tree` still has the recorded id: a file that changes is no longer viewed, a change of base that does not touch it leaves it viewed.
- The server keeps `login` and `name` of `/api/me` in memory as soon as they answer; it keeps a failure for 60 s, then the next call reruns its command; the mod does not call `/api/me`.
- `author` is `me` or `claude`: a message from `me` starts Pending, a message from `claude` is published immediately.
- A Resolved thread refuses a message from `me` with 409 until its Unresolve; it accepts a message from `claude`, which does not reopen it.
- A Send does not publish the Pending messages of a Resolved thread: they wait for its Unresolve.
- The bases are `HEAD` (Uncommitted changes), `last-review` (Since my last review, the Snapshot of the last Send, grayed out before the first one), `origin/HEAD` ("main (default branch)"), the base branch ("<name> (base branch)"), then, each in its `group`: the open PRs (`Pull requests`), the local branches `refs/heads/<name>` except the one of the worktree (`Local branches`), and the remote branches `refs/remotes/<remote>/<name>` (`Remote branches`), from the closest to the merge-base to the farthest.
- The base branch is the base of the PR of the branch of the worktree, on origin if it has it, otherwise the closest local branch other than one that holds HEAD and commits of its own (the next branch of a stack), none on the default branch; when it bears the name of the default branch, the two are one entry ("main (default and base branch)").
- A PR from a fork is the branch's when a remote whose URL names the fork's owner (`/<login>/` or `:<login>/`) carries a branch of that name: another fork's PR, from a branch of the same name, does not count.
- An open PR is chosen by its branch on origin, `refs/remotes/origin/<head>`: a PR from a fork, or whose branch is not fetched, is not offered; a ref already offered higher up is not repeated.
- The PRs come from `gh pr list` in the worktree, kept 60 s; a `gh` that fails or takes more than 2 s gives none, and the base branch is then the closest local branch.
- A branch, a PR and `origin/HEAD` compare from their merge-base with HEAD.
- The diff is kept in memory per pair (`base`, `tree`) and per `?w=1`: asking for it again without a change does not rerun `git diff`.
- `side` is `old` or `new`, and `start` and `end` are the numbers of the first and of the last line of the range, on that side;
  0 and 0 for a thread on the whole file, whose Anchor has no lines, placed (`at` set to `{ start: 0, end: 0 }`) as long as the file exists on that side.
- Only a Pending message from `me` can be edited or deleted: any other gets 409.
- The Anchor is captured on the code the author sees: for `me`, the displayed `base` and `tree`, required; for `claude`, the base of the session and the working tree at the time of the call.
- `path` is the path of the file from the root of the worktree, in its canonical form: no leading `./` or `/`, no empty or `.` segment.
- `base` and `tree` are ids of 40 or 64 hexadecimal characters, of a commit or a tree for `base`, of a tree for `tree`.
- `/lines` refuses with 400 a non-canonical path, a `tree` that is not a tree of the repository of the session, and a range outside `1 ≤ from ≤ to` or of more than 1000 lines.
- In `/diff`, each modified file carries `lineCount`, its number of lines in the tree, to know where the hidden lines after its last hunk end; 0 for the other files, and for all of them when `git grep` fails, without failing the diff.
- The diff keeps 3 lines of context around the changes, whatever the `diff.context` and `diff.interHunkContext` configs.
- An approved session refuses any write with 409 and `{ "error": "session approved" }`.
- The Approve refuses with 409 as long as a thread not Resolved carries a Pending message; those of a Resolved thread stay Pending in the archive, as a Send leaves them there.
- A message from `claude` in a thread without a published message gets 409: published immediately, it would come before my Pending message at the Send.
- The mod opens a thread without a known session through `POST /api/sessions`, then `POST /api/sessions/<id>/threads`; if it keeps the id of an approved session, it gets "session approved".
- After an Approve, `POST /api/sessions` on the same worktree opens a new session: only a call that carries the old id gets "session approved".

## Mod

- On `session.start`, the mod links the Claude session to the worktree through `git rev-parse --show-toplevel` on the `cwd`, registers its tools, then starts the server.
- It then follows `$.session.root()`, which `/cd` and EnterWorktree move: another worktree starts again from a fresh state, like a Claude session that starts there.
- It finds the server through `<data>/endpoint`, from which it reads the port and the token; without a file, with a corrupt file, if another account listens on its port, or if the server it names does not answer, it starts one.
- A call that gets no answer reads the `endpoint` again: when it names another server, which a newer mod of another Claude session started, the mod adopts it and makes the call once more.
- It runs `node <plugin root>/server/main.ts` detached by `nohup`, under `umask 077`, from the root of the plugin, its output in `<data>/server.log`;
  then it waits for the server to rewrite `endpoint` and answer, for 5 s, and on failure writes through `$.ui.log` the path of `server.log` and its last lines.
- Each call to the server carries the token in `Authorization: Bearer <token>`; a server of another account, which has another token, rejects it.
  It no longer calls a port that another account has taken since: the tools say so, and a new Claude session starts a server of its own.
- It stops an older version of claude-reviews through `POST /api/shutdown` then starts it again; it uses a newer version as is, so that two Claude sessions of different versions do not stop each other's server.
- When the port of the `endpoint`, held by its account, answers something other than claude-reviews, or does not answer within 2 s, nothing starts: the mod reports it through `$.ui.log`, a line of the transcript that the model does not read, and polls anyway.
- `list_open_threads()` returns `base`, the commit of the base of the session, and, except for Resolved threads and threads without a published message, the id, the status, `outdated`, the file, the side, the range re-anchored on this base on the `old` side and on the working tree on the `new` side (the one of the Anchor if it is Outdated), the lines of the Anchor and the published messages.
- An Outdated thread also carries `hunk` there, the original diff excerpt as a unified diff, `null` if the Anchor was outside the diff.
- A thread on the whole file has `start` and `end` at 0 there and no lines; `open_thread` without `lines` opens one.
- A ```` ```suggestion ```` block in one of my messages is the code I propose in place of the lines of the thread, on the `new` side: the descriptions of the tools ask Claude to apply it to the working tree unless it disagrees, then to reply.
- The poll keeps a status line through `$.ui.status`: "claude-reviews · N threads waiting for Claude", followed by "· wake held until the next prompt" when a wake waits after a `{ drop }`, and nothing without a thread waiting for Claude.
- It polls `GET /api/sessions?worktree=<path>&claude` every 2 s; a Send that leaves Waiting for Claude threads makes it wake Claude through `$.prompt.submit`, never awaited in a hook.
- Each of its reads adds `&blocked` while a loop of its Claude session, the main one or a subagent's, is Blocked:
  from a `classic.PermissionRequest` that no settings hook answers, or a `tool.call` of `AskUserQuestion`, until a tool call of that loop ends.
  The `next` of `classic.PermissionRequest` resolves once the settings hooks answered, not the person, hence the end of the tool call, run or refused, as the end of the wait.
- Only a 404 means "no open session"; a failed poll leaves the state as is, and the mod keeps per session the last Send seen and the relaunch made.
- It relaunches Claude once per Send, at the end of a turn that ended on an answer, neither interrupted nor in error, that leaves threads waiting; a `{ drop }` waits for the next prompt or turn start, and does not count.
- At the end of the turn opened by a wake or a relaunch, if it must not relaunch, it calls `POST /api/sessions/<id>/turn-complete` once, without awaiting it, only if this turn ended on an answer: after an Esc or an error, nothing.
- The first prompt of a Claude session carries, in the `context` of `prompt.submit`, the number of threads waiting for it: `prompt.context` would also reach the subagents, and `cc-plugin-sec-default` short-circuits it on Team or Enterprise accounts.
- After an Approve, `open_thread` calls `POST /api/sessions` again and opens a new session; `reply_to_thread` answers "session approved".
- `/review-local phpstorm`, `/review-local vscode` or `/review-local browser` opens the session in PhpStorm, VS Code or the browser;
  without an argument, it asks where through `$.ui.ask` among the IDEs whose launcher it finds (`phpstorm` from the `PATH`, otherwise the JetBrains Toolbox script; `code` from the `PATH`) and the browser, the browser without a question if it finds none;
  an IDE without a launcher opens the browser and says so. The launchers and the browser start from the root of the plugin, detached by `nohup`.
- In an SSH session (`SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY`), it does not start a browser and only displays the URL:
  no browser runs on this machine, and the argv of the launcher would show the token to any account (`/proc/<pid>/cmdline`, `ps`).
- For an IDE, it calls `POST /show`, then runs its launcher on the worktree; the PhpStorm plugin activates its tool window, and the VS Code extension its view, when `showRequestedAt` changes and is less than 30 s old.
- Any call to the server gives up after 2 s: without an answer, or on a 200 without `threads`, the tools answer `{ deny }` "does not answer", `/review-local` says so, and a poll leaves the state as is;
  an error of the server reaches the tools with its message.

## Data

The data folder is `$XDG_DATA_HOME/claude-reviews`, otherwise `~/.local/share/claude-reviews`; the tests place it in a temporary folder with `dataHome()` from `server/fixture.ts`.

- The data folder is `0700`, the `endpoint` file and the session files `0600`: another account reads neither the threads, nor the token, nor the log.
- `endpoint` carries `{ port, token }` of the server, rewritten at each start; the server draws a 32-byte token, listens on an ephemeral port (or `CLAUDE_REVIEWS_PORT`), then writes it.
- At startup, the server gives up if the `endpoint` names a live server of its account: an account has only one server, even with two Claude sessions; a corrupt `endpoint` names no server.
- It then stops a server from before the token (0.6 and earlier) left on `CLAUDE_REVIEWS_PORT`, otherwise 7778, if it belongs to its account:
  that server serves the data folder to any account, and is recognized by its 404, instead of a 401, for an unknown session without a token.
- An open session lives in `sessions/<id>.json`, an approved session in `archive/<id>.json`.
- Only the server writes these files, by writing `<id>.json.tmp` in the same folder, then renaming it.
- A Send commits the displayed tree under `refs/claude-reviews/<id>/<n>`, where `n` is the number of the Send.
- The Approve writes the approved session, moves it under `archive/`, then deletes its refs in `commonDir`; a failed deletion leaves the refs, not the open session.
- A vanished worktree closes its session the same way: `approvedAt` dated, `closedBecause` set to `worktree-gone`, archive, refs deleted in `commonDir`.

```json
{
  "id": "9f2c4e1a7b3d5e60",
  "worktree": "/home/me/src/app",
  "commonDir": "/home/me/src/app/.git",
  "createdAt": "2026-11-14T10:00:00.000Z",
  "approvedAt": null,
  "base": "HEAD",
  "sends": 1,
  "sentAt": "2026-11-14T10:05:00.000Z",
  "viewed": { "src/b.ts": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" },
  "threads": [{
    "id": 1,
    "anchor": {
      "path": "src/a.ts", "side": "new", "start": 2, "end": 3,
      "lines": ["…", "…"], "before": ["…"], "after": ["…", "…", "…"],
      "hunk": { "header": "@@ -1,6 +1,6 @@", "lines": [{ "type": "add", "oldNo": null, "newNo": 2, "text": "…" }] }
    },
    "resolved": false,
    "messages": [
      { "author": "me", "body": "Why?", "date": "2026-11-14T10:05:00.000Z", "review": 1 },
      { "author": "claude", "body": "Because…", "date": "2026-11-14T10:06:00.000Z" },
      { "author": "me", "body": "OK", "date": null }
    ]
  }]
}
```

- `id`: 16 hexadecimal characters, distinct from the path of the worktree; a thread has as its id the largest id of the session plus 1, starting from 1.
- `worktree`: the root of the worktree (`git rev-parse --show-toplevel`).
- `commonDir`: the repository shared by the worktrees (`git rev-parse --git-common-dir`), where the refs remain when the worktree disappears; absent from older sessions.
- `base`: the last chosen base, a `ref` of `/bases`, `HEAD` at creation.
- `sends`: the number of Sends, hence the number of the last ref.
- `sentAt`: the date of the last Send, absent before the first one.
- `viewed`: each file marked Viewed, with the id of its content in the displayed tree when I checked it, `deleted` for a file absent from this tree; absent from older sessions.
- `closedBecause`: `worktree-gone` for a session closed because its worktree disappeared, absent otherwise, even after an Approve.
- `anchor`: up to 3 neighboring lines in `before` and `after`, and `hunk`, the excerpt of the diff up to the end of the range, `null` outside the diff; no SHA.
- A message without `date` is Pending; a Send dates it, gives it its number in `review`, and places it after the messages already published.

## Vendored files

| File                      | Source                                                       |
| ------------------------- | ------------------------------------------------------------ |
| `ui/vendor/primer.css`    | `@primer/css@21.5.1/dist/primer.css`                         |
| `ui/vendor/preact-htm.js` | `htm@3.1.1/preact/standalone.module.js` (Preact 10 included) |
| `ui/vendor/highlight.js`  | `@highlightjs/cdn-assets@11.12.0/es/highlight.min.js`        |
| `ui/vendor/marked.js`     | `marked@18.1.2/lib/marked.esm.js`                            |

Primer 21.5.1 names its diff variables `--diffBlob-addition-bgColor-line` and not `--diffBlob-additionLine-bgColor` as in 22.
The markdown of the messages goes through marked, with line breaks kept as on GitHub, raw HTML escaped, images replaced by their text, and only `http`, `https` and `mailto` links clickable (`ui/app.js`).
My messages show `https://github.com/<login>.png`, and without a login, or once the image has failed on the page, my initials taken from `name`; Claude's show its star in inline SVG, square like the avatar of a GitHub app.
The page rereads `/api/me` at each poll as long as it gives no `login`.
Syntax highlighting goes through the `--color-prettylights-syntax-*` variables of Primer (`ui/app.css`), not through a highlight.js theme.

## Language

- Everything in the repository is in English: code, comments, commit messages, PR titles and bodies, issues and docs.
- Claude answers the user in the user's language.
- A PR title starts with its scope, for example `[Server] Compute the diff against HEAD`.
- In a `.md`, one sentence per line.

## Code

- The minimum that solves the issue: no single-use abstraction, no unrequested configuration.
- Rare comments, for a why that cannot be read in the code.
- A deliberate shortcut carries a `ponytail:` comment that names its limit.

## Tests

- Each acceptance criterion of an issue has its test, written before the code (red, then green).
- `node --test` covers the server and the pure functions, in `*.test.ts` files next to the code; under Node 25, `node --test <folder>` fails ("Cannot find module"): run `node --test` alone, or name the files.
- The tests of the mod register the same module several times: its state (the targeted server, a `serve()` loop still running) carries over from one test to the next, which a slower CI reveals; everything a loop reads is frozen when it starts.
- A test server is stopped by its PID: `pkill -f server/main.ts` also stops the real server of the machine.
- The test repositories are created with `repo()` and `write()` from `server/fixture.ts`, in a temporary folder, sheltered from the global git config; `removeRepos()` deletes them at the end of the test file.
- Playwright (Chromium) covers the UI, in `e2e/*.spec.ts`, on the same fixtures; each test opens `/?worktree=<fixture>`.
- `e2e/vscode.spec.ts` covers the VS Code extension in openvscode-server, through `playwright.vscode.config.ts`; `playwright.config.ts` ignores it.
- The Playwright server, like the one of `server/sessions.test.ts`, has a failing `gh` at the head of the `PATH`, so that my real login does not reach the tests; a test that needs it answers `/api/me` itself, or puts its own `gh` in front.
- Starter and Driver cover the PhpStorm plugin, in `phpstorm/ui-test/`, on the same fixtures (`fixture.ts`): a single PhpStorm for the steps of a review, in order, against a server on port 7780, with a temporary `XDG_DATA_HOME`, the same fake `gh`, and a `&claude` poll that stands in for a Claude session.
- The CI (`.github/workflows/ci.yml`) runs both suites on each PR, under Node 25, the VS Code extension one in the `vscode` job, with openvscode-server cached, and the tests of the PhpStorm plugin in the `phpstorm` job, with the `PHPSTORM_CACHE` folder kept by `actions/cache` and the IDE logs as an artifact on a failure.
- A PR adds at most 1000 lines, excluding the lockfile and vendored files.
