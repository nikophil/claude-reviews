# claude-reviews: brief

A local code review tool that looks like GitHub's "Files changed" tab,
to review what Claude Code wrote, **without GitHub**.
The feature missing everywhere else: real **threads under the line**,
where Claude replies in the thread rather than in the conversation.

Vocabulary: [GLOSSARY.md](GLOSSARY.md).
Structural decisions: [docs/adr/](docs/adr/).

## Why

- Claude Desktop lets you comment on a line of the diff, but one way only:
  Claude replies in the conversation, not under the line, and you cannot reply to its "Review code" comments.
- Codex app, Conductor, Warp and Vibe Kanban work the same way: you send a batch of comments, and the agent makes the fixes.
- No existing tool is reasonable to fork, hence starting from scratch:
  - **wyrd-diff**: a single author, nothing since May 22, 2026, no LICENSE file, a Svelte UI without Primer;
    the agent resolves the threads there, and the diff starts from the tip of the base rather than from the merge-base.
    We take two ideas from it: untracked files in the diff, and threads delivered to the agent only when sent;
  - **tuicr**: a TUI, with flat comments, no threads;
  - **Plannotator**: comments anchored on the diff, but neither threaded replies nor a resolved state in review, and 778k lines.
    Its Claude Code mod serves as the model for waking a session (see [ADR 0001](docs/adr/0001-claude-code-mod-rather-than-mcp.md)).

## Decisions

- **Local web UI**, not a TUI.
- **GitHub look** with **Primer CSS** (GitHub's open source design system, MIT), not copied CSS;
  automatic dark theme (`data-color-mode="auto"`).
- **One session per worktree**: reviewing a worktree against a base, from its opening to its Approve or to the worktree's disappearance.
  A worktree has at most one open session, and a checkout or a rebase does not close it.
- **A review is a send**: Send delivers my Pending messages to Claude and wakes it, Approve closes the session.
  A Send without a message is still possible: it takes a Snapshot, and wakes Claude only if threads are still waiting for it.
  No Comment or Request changes verdict: Claude answers the questions, and changes the code when a thread asks for it.
- **Only the user resolves a thread.**
  Claude replies in each thread waiting for it, and opens a thread only when asked to ("review your diff and open threads").
- **Claude goes through a Claude Code mod**, not through an MCP server and a `Stop` hook ([ADR 0001](docs/adr/0001-claude-code-mod-rather-than-mcp.md)):
  a Send wakes the Claude session even when idle, at the cost of Claude Desktop, where the mod does not run;
  the wake-up is verified (see [Mod test](#mod-test)).
- **Two separate tools** for claude-reviews and gh-notif, linked by a small HTTP contract (see below).

## Architecture

1. **One local server per account**, for all its worktrees: it serves the UI and a JSON API, on an ephemeral port, behind a token ([ADR 0006](docs/adr/0006-one-server-and-one-token-per-account.md)).
   The mod starts it on demand when the `endpoint` file names no server, without a systemd service.
2. **Storage**: one JSON file per open session under `~/.local/share/claude-reviews/sessions/`, filed under its id and found by its worktree's path;
   a closed session moves under `~/.local/share/claude-reviews/archive/`, filed under its id;
   only the server writes these files, by atomic replacement ([ADR 0003](docs/adr/0003-storage-outside-the-repository.md)).
3. **Snapshots**: on each diff computation, the server writes a tree of the working tree (tracked and untracked files, ignored ones excluded) with a temporary index;
   on each Send, it commits the tree the UI was showing under `refs/claude-reviews/<session>/<n>`;
   the Approve, or the worktree's disappearance, deletes these refs ([ADR 0002](docs/adr/0002-snapshots-in-hidden-refs.md)).
4. **The Claude Code mod**, shipped as a plugin (`hooks/hooks.json` → `"modules"`):
   - it registers the tools `list_open_threads()`, which returns in full the threads not Resolved, Waiting for Claude or where Claude spoke last,
     `reply_to_thread(id, body)` and `open_thread(file, side, lines, body)`, as well as the `/review-local` command,
     which opens the worktree's session in PhpStorm, VS Code or the browser, and asks which one when one of these IDEs is installed;
   - it links the Claude session to its Session by the worktree's path (`git rev-parse --show-toplevel` on the `cwd`);
   - without an open session, `open_thread` opens one; a closed session refuses Claude's messages, and the mod then stops relaunching Claude;
   - it polls the server, and on a Send injects "N threads are waiting for you" with `$.prompt.submit`;
   - it never awaits `$.prompt.submit` in a hook, because the call resolves only once the session is idle, and a hook has only 10 s;
     a `{ drop }` (after an Esc, as long as nobody has typed) leaves the threads waiting, and the mod retries at the next prompt or turn start;
   - if Claude ends its turn while threads are still waiting for it, the mod relaunches it only once per Send:
     the relaunch counts when its prompt opens a turn, a `{ drop }` does not count, and a new Send allows another one;
   - when a Claude session starts in a worktree where threads are waiting, it adds "N threads are waiting for you" to the first message.
5. **Notification**: at the end of Claude's turn that follows a Send, or of its relaunch if there is one, `notify-send` announces "Claude replied in N threads",
   followed by "M still waiting" if any remain; Claude may have changed code after its last reply, hence the end of the turn rather than the last reply.
   The mod sees the end of the turn and calls the server, which sends the notification (`notify-send` or `osascript`).
6. **Stack**: Node 25, TypeScript run without a build (type stripping), `node:http`, no npm dependency.
   Front end in Preact + htm, with Primer CSS and marked, each vendored as a single file;
   it polls the server every 2 s, without losing a message being typed;
   the diff, however, reloads only on Refresh, which a banner offers when the working tree differs from the displayed code.

## Diff and base

- The base is chosen in the UI, and the diff always goes up to the working tree, uncommitted changes and untracked files included:
  - **Uncommitted changes**: HEAD, the default choice;
  - **Since my last review**: the Snapshot of the last Send, which replaces the "per-turn views"; grayed out before the first Send;
  - **the default branch** (origin/HEAD): from the merge-base;
  - **the base branch**: the base of the branch's PR, otherwise the closest local branch;
  - **an open PR**, by its branch on origin, to review from the PR the branch stacks on;
  - **the other branches**, local then remote, sorted by distance to the merge-base, the parent branch of a PR stack first.
- Each session keeps the last chosen base.

## Thread model

- **Anchor**: file, side (old or new), line range, content of these lines and of their neighbors,
  and the original diff excerpt (like GitHub's `diff_hunk`), without a SHA.
  It is captured on the code its author sees: the base and the displayed code for me, the session's base and the working tree for Claude.
- **Messages**: author (`me` | `claude`), markdown body, date, and for mine the review that published it; without a review, my message is Pending.
  A message from Claude is published as soon as Claude writes it, outside any review: a thread that Claude opens is published immediately, without waiting for a Send.
  A message takes its date and its place in the thread when it is published, so my Pending message goes after a reply from Claude that arrived in the meantime.
- Three independent facts, which combine:
  - **whose turn it is**, inferred from the last sent message: **Waiting for Claude** if it is mine; if it is Claude's, the thread shows no status;
  - **Resolved**, which only I change, immediately, without a review; a Resolved thread no longer waits for Claude, even if my message is the last,
    and only a message I write in it reopens it, not a reply from Claude;
  - **Outdated**, computed when the anchor can no longer be found in the code being looked at.
- **Re-anchoring, from the MVP on**: look for the lines by their exact content, as close as possible to their original position, and break ties with the neighbors;
  otherwise the thread is Outdated and is shown with its original excerpt.
  The UI re-anchors on the displayed code, and `list_open_threads()` on the session's base and the current working tree.
- **Thread outside the displayed diff** (Claude committed, or the base changed): it is shown in its file, at its line, with a few lines of context,
  as one more hunk.
- **Approve** stays grayed out as long as a thread not Resolved holds a Pending message.
  It makes the session read-only, sends nothing to Claude, and leaves commit, push and PR to the conversation.
  The approved session stays viewable at its URL, but leaves the Reviews screen.
  You can approve with open threads: the dialog counts them.
  A `/review-local` after an Approve opens a new session.
- **Worktree gone** (`git worktree remove`, or Orca cleaning it up): as soon as it notices, the server closes its session like an Approve,
  so that a new worktree at the same path does not inherit it.

## Screens (mockup)

Clickable mockup: https://claude.ai/artifact/Vx1yLU9aWnA8HujQPUSWBP
(sample content, predating these decisions: it still shows Comment / Request changes).

- **Files changed**: file tree, unified diff, threads in the diff, base selector,
  the "The code changed since it was loaded" banner and its Refresh, which highlights Since my last review after a Send, and the Send and Approve buttons.
- **Reviews**: the list of open sessions across all worktrees, sorted by who must act;
  the screen keeps the product's name, although it lists sessions.
- **gh-notif · Local reviews**: the section proposed on the gh-notif side.

## Integration with gh-notif

gh-notif: a `gh` extension, Node ESM without npm dependencies, a local web page on `:7777` with a GitHub look,
desktop notifications (`src/notify.js`, `notify-send` or `osascript`).
It also runs multi-user.
Its `CLAUDE.md` requires reading `docs/ARCHITECTURE.md` before any change, and pure functions tested on fixtures.

The point: a single "where am I needed" inbox, from the local review to the mergeable PR.
It pays off mostly with several Claude sessions in parallel; with only one, the MVP's `notify-send` is enough.

Proposed contract, after the MVP: claude-reviews exposes one entry per open session, on the port and with the token of the `endpoint` file (no fixed port since ADR 0006)

```
GET http://127.0.0.1:<port>/api/inbox
Authorization: Bearer <token>
[{ "repo": "acme/shop", "branch": "invoice-pdf-footer", "title": "…", "url": "http://127.0.0.1:<port>/s/…",
   "openThreads": 2, "awaitingMe": 2, "lastActor": "claude", "updatedAt": "…" }]
```

On the gh-notif side, a **generic** PR ("local sources": any tool that exposes this JSON):
- the feed is read in the poll loop, only if it is configured;
- a "Local reviews" section and a counter per tab;
- a new notification category ("Claude replied in N threads");
- nothing on the multi-user instance.

## Estimated effort

- Usable MVP: 4 to 6 days, more than the 2 to 4 days of the first brief,
  because it absorbs re-anchoring, snapshots, the base selector, line ranges and the mod.
- gh-notif side: half a day to a day, tests included.

## Mod test

Done on November 14, 2026 on Claude Code 2.1.325, with a throwaway mod (`wake-probe`) where a file stands in for the server:
- `$.prompt.submit` wakes an idle Claude session in 0.1 s, without anyone typing;
  the prompt arrives as a message from the plugin (`origin.kind: 'plugin'`).
- Called during a turn, it waits for the end of the turn, then opens a turn of its own; the call resolves only at that moment.
- Called from a `turn.complete` hook, it opens the next turn: the relaunch works.
- The mod reads the `cwd` (`e.cwd` at `session.start`, `$.session.cwd()`, `$.session.root()`) and runs `git` with `$.process.run`.
- Not tested, but described by Plannotator (`~/.claude/plugins/marketplaces/plannotator/docs/agent-guides/claude-code-mod.md`):
  the `{ drop }` after an Esc;
  and their wake-up that arrived only at the next keystroke came from their instance destroyed at the `session.end` of a `/clear`, not from the engine.

## Open questions

- **Two Claude sessions in the same worktree** would both reply to the same threads; the MVP accepts it, it is rare with Orca.
- Side-by-side view, whole-file threads and `suggestion` blocks: done; Claude applies a suggestion, the server never writes to the worktree ([ADR 0007](docs/adr/0007-claude-applies-suggestions.md)).

## Next steps

The MVP, the side-by-side view, the PhpStorm and VS Code clients, `/api/inbox` and one server per account are done.
What remains is the gh-notif PR, which will read `/api/inbox` as a local source.
