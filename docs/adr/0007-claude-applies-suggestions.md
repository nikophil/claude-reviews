# Claude applies suggestions: the server never writes to the worktree

A `suggestion` block in one of my messages proposes the code that replaces the lines of the thread, as on GitHub.
But no client has the "Commit suggestion" button of GitHub: Claude reads the suggestion with the thread, applies it to the working tree, unless it disagrees, then replies in the thread.
The server reads the repository and writes git objects and its hidden refs to it ([ADR 0002](0002-snapshots-in-hidden-refs.md)), but never a file of the worktree.

Claude works in this same working tree: a write by the server would change the code under its eyes, without its knowledge, and it could overwrite that write on the next turn.
The server also stays a reader, which limits what a process that reaches it gets ([ADR 0006](0006-one-server-and-one-token-per-account.md)).

## Considered Options

- An Apply button, which has the server rewrite the lines: rejected for the reasons above; the Send already wakes Claude, which applies the suggestion in its turn.
- A client that applies the suggestion itself, in the editor of PhpStorm or VS Code: rejected, the web page cannot do it, and Claude would not know that the code changed before rereading it.
