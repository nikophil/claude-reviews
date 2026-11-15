# Snapshot the displayed code in hidden refs

Claude does not commit without an explicit request:
during a session, most of the reviewed code is not committed, and the files it creates are not tracked.
On each computation of the diff, the server writes a tree of the working tree (tracked and untracked files, ignored ones excluded),
with a temporary index so as to touch neither the index nor the stash;
on each Send, it commits the tree the UI was displaying under `refs/claude-reviews/<session>/<n>`.
These commits provide the "Since my last review" base;
they appear in `git for-each-ref` of the reviewed repositories, until the session's Approve, which deletes its refs.

## Considered Options

- Commits alone: the diff misses untracked files, and "since my last review" sees nothing as long as Claude does not commit.
- `git stash create`: ignores untracked files.
- The working tree at the time of the Send: it contains what Claude changed since the last display,
  which the "Since my last review" base would then hide without my having seen it.
