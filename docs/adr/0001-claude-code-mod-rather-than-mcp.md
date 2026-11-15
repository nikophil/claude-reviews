# A Claude Code mod rather than an MCP server and a Stop hook

Claude receives the threads through a Claude Code mod (a hooks module declared in `hooks/hooks.json`):
it registers Claude's tools, queries the server and injects a turn with `$.prompt.submit`.
A `Stop` hook fires only at the end of a turn, so a Send made while the Claude session waits would not wake it until I type something in the terminal.
The price: a mod runs only in the CLI and the VS Code panel, not in Claude Desktop.

## Considered Options

- MCP server and `Stop` hook: they work in Claude Desktop, but you have to type a message after each Send.
- Channels (research preview): a personal plugin requires `--dangerously-load-development-channels` at launch.
- `asyncRewake` hook: its timeout applies, and the docs do not say whether it is accepted on `Stop`.
