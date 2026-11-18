# claude-reviews

Local, GitHub-style review of the code that Claude Code writes in a worktree,
with discussion threads under the lines of the diff, where Claude replies.

## Language

### Sessions and reviews

**Session**:
Reviewing a worktree against its base, from its opening to its approval, or to the worktree's disappearance.
It follows the worktree, not the branch: a checkout or a rebase does not close it.
A closed session stays viewable, read-only.
_Avoid_: a review (which is one Send or Approve), PR

**Review**:
One send of a session's Pending messages: Send, or Approve.
_Avoid_: round, turn, submission

**Send**:
The review that delivers the Pending messages to Claude and wakes its Claude session.
It may carry none: it then takes a Snapshot, and wakes Claude only if threads are still waiting for it.
It may deliver only the Pending messages of one thread, from the Send button of that thread's box, which first adds the message typed there: it still takes its Snapshot, and the other threads stay Pending.
_Avoid_: Comment, Request changes

**Review message**:
The message I write for a whole Send, as the body of a review on GitHub; Claude reads it with the threads.
A Send that carries one wakes Claude even without a thread waiting for it, and Claude then answers it in its conversation.

**Readonly**:
Said of a thread Claude answers without changing any file: checked "Answer without changing code" on the thread,
or published by a Send checked "Answer without changing code", which applies to the threads of that Send and to its review message.
Unchecked by default: Claude changes the code when a thread asks for it.
_Avoid_: read-only (which says an approved session takes no message)

**Approve**:
The review that closes a session, which then becomes read-only; it sends nothing to Claude.

**Base**:
What a session compares the working tree to, chosen in the UI:
the uncommitted changes (HEAD), the Snapshot of my last Send, a branch (default, base, local or remote), or an open PR.
The diff always goes up to the working tree, uncommitted changes included.
_Avoid_: per-turn views

**Snapshot**:
The code I had in front of me at the time of a Send, kept as the "Since my last review" base.
_Avoid_: picture, review state

**Viewed**:
Said of a file of the diff that I marked as viewed; its diff collapses, and the review moves to the next file not Viewed.
It stays Viewed as long as its content, in the displayed code, is still the one I viewed, even if the base changes.
_Avoid_: read, reviewed

**Claude session**:
A Claude Code conversation running in a worktree.
_Avoid_: session (on its own, which names the Session)

**Blocked**:
Said of a Claude session that waits for my answer in its own window: a permission dialog, or a question Claude asked me.
The threads Waiting for Claude wait as long as it is Blocked; the clients say so only while a thread waits for Claude.
_Avoid_: stuck, waiting for me

**Client**:
What shows me a session and writes to it for me: the page in a browser, or an IDE (PhpStorm, VS Code).
A client talks only to the server's HTTP API; the Claude side, for its part, goes through the mod.
_Avoid_: front end, tool

### Threads

**Thread**:
A discussion between Claude and me, anchored on lines of a session's diff, or on a whole file.
_Avoid_: annotation, comment (for the whole thread)

**Anchor**:
The place of a thread: a file, a side of the diff (old or new), a range of lines and their content; no range for a thread on the whole file.
For me as for Claude, the old side is the session's base, and the new one the working tree.

**Message**:
One contribution to a thread, from me or from Claude.
A message from Claude is published as soon as Claude writes it, outside any review; only mine go through a review.
_Avoid_: comment, reply

**Pending**:
Said of a message I wrote but have not sent yet; the next review publishes it.
While it is Pending, I can edit or delete it, and a thread left with no message disappears with it.
_Avoid_: draft

**Suggestion**:
A code block in one of my messages, which proposes the code to put in place of the thread's lines, on the new side.
Claude applies it to the working tree, barring disagreement, then replies in the thread; no client applies it itself.
_Avoid_: patch, commit suggestion

**Waiting for Claude**:
A thread not Resolved whose last sent message is mine.
_Avoid_: unread, watermark

**Replied**:
Said of a thread not Resolved where Claude wrote since my last Send; before my first Send, none is.
It is a mark for finding Claude's replies, not a status of the thread.
_Avoid_: Awaiting you, unread

A thread not Resolved where Claude spoke last has no name and no displayed status: the "Claude replied in every thread" notification and Claude's message are enough.
_Avoid_: Awaiting you

**Resolved**:
A thread I closed; only I resolve it, and only my Unresolve reopens it.
It no longer waits for Claude, even if my message is the last, and a reply from Claude does not reopen it.
I no longer write in it until its Unresolve, and a Send keeps Pending the messages I had written in it before resolving it; an Approve leaves them Pending, without sending them.

**Unresolve**:
Reopen a Resolved thread: I can write in it again, and the next Send publishes its Pending messages.
_Avoid_: reopen

**Outdated**:
A thread whose anchored lines can no longer be found in the code being looked at: the displayed code for me, the session's base and the working tree for Claude.
A thread on a whole file is Outdated when its file has disappeared from that code.
