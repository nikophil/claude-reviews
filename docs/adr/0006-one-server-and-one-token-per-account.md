# One server and one token per account, for a shared machine

claude-reviews was designed for a single-user laptop, with no authentication.
On a Linux server shared by several devs over SSH, each with their own Claude Code, the fixed port `7778` on `127.0.0.1` is common to all accounts:
the loopback is not partitioned by account, and only one server can bind the port.
The first server launched then served all the other accounts, git ran under its account in the worktree of another, `/api/me` gave its github.com login, and any local process could read a repository, inject a message into the Claude of another account, or stop the server.

Each account now has its own server, on an ephemeral port, with a token drawn at startup.
The server writes `{ port, token }` to `<data>/endpoint` (0600), which the mod, PhpStorm and VS Code read;
the UI receives the token through the `#token=` fragment on opening, keeps it in `localStorage`, and sends it as `Authorization: Bearer` on each call.
Every `/api/` route except `GET /api/health` requires the token: another account reaches the port, but gets nothing without it.
The data folder becomes `0700`, its files `0600`.

## Considered Options

- **A Unix socket in `$XDG_RUNTIME_DIR`**: partitioned by the OS, with no token to manage.
  Rejected: the UI is a browser, and no browser talks to a Unix socket, even locally; the server must stay on TCP.
- **A port derived from the UID**: the `EADDRINUSE` lock comes for free, and the port is known without a file.
  Rejected in favor of the ephemeral port: a modulo collision is possible, and it fails if the port is already taken.
- **The token inlined in the HTML page**: simpler for the UI.
  Rejected: another account can load `/` and retrieve the token; the token must leave the server only on proof that the caller holds it, hence the bootstrap through the `#token=` fragment.
- **A cookie set at bootstrap**: the UI would have nothing to send.
  Rejected in favor of the `Authorization` header: an explicit header avoids the automatic sending of the cookie and the CSRF ambiguity, and unifies the UI with the mod, PhpStorm and VS Code.

## A single server per account

The ephemeral port loses the natural lock of `EADDRINUSE`: two Claude sessions of one account could launch two servers on the same files.
At startup, the server reads the `endpoint` and gives up if the server it names, of its account, still answers.
A race remains if two `listen()` calls start at the same instant;
the atomic writing of sessions makes it a rare lost update, not a corruption, and an `O_EXCL` lock would close it if it became a problem.

## A port that is no longer mine

The `endpoint` outlives the server: after a reboot or a crash, it still names its old port.
Yet `/proc/net/tcp` tells any account which uid listens on which port;
another account can therefore bind this port as soon as it is freed, and answer as claude-reviews.
Without a countermeasure, my server gave way to it, and my mod asked it for its threads, then woke my Claude with its instructions.
The server, the mod, PhpStorm and VS Code therefore trust the port of the `endpoint` only if the socket listening on it belongs to their account, in `/proc/net/tcp` and `/proc/net/tcp6`.
The token is not enough to authenticate the server: a client sends it on the first call, to whoever listens.
Without `/proc` (macOS), the machine has only one account, and the clients trust the port.

## The token kept out of the argv

Any account can read an argv through `/proc/<pid>/cmdline` and `ps`.
In an SSH session, `/review-local` therefore does not launch a browser, which would not run on the server anyway, and only displays the URL with its fragment.
The terminal and the transcript remain those of the account, which already reads the token in the `endpoint`.
A single-use opening code was rejected: on a server without a browser, nobody consumes it, and whoever read it in the argv exchanges it before it expires.

## The upgrade

A server from before the token (0.6 and earlier) stays on 7778 after the upgrade, and serves the data folder to any account.
At startup, the server stops it if it belongs to its account: it recognizes it by its 404, instead of a 401, for an unknown session without a token.
