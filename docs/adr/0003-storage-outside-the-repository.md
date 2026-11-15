# Store sessions outside the repository, as JSON

Each session, with its threads, lives in a JSON file under `~/.local/share/claude-reviews/sessions/`, stored under its id and found by the path of its worktree;
only the server writes it, by atomic replacement.
A closed session, approved or whose worktree has disappeared, moves under `~/.local/share/claude-reviews/archive/`, stored under its id:
it remains viewable, and a new worktree at the same path opens a new session.
The brief planned the worktree's `--git-dir`, but `git worktree remove` erases `.git/worktrees/<name>/`,
and the single server, which serves all worktrees, then reads a single folder.

## Considered Options

- SQLite (`node:sqlite`, built into Node 25): rejected, a single process writes, and a few dozen files are read with no query and no schema to migrate.
