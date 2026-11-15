# Un mod Claude Code plutôt qu'un serveur MCP et un hook Stop

Claude reçoit les threads par un mod Claude Code (module de hooks déclaré dans `hooks/hooks.json`) :
il enregistre les outils de Claude, interroge le serveur et injecte un tour avec `$.prompt.submit`.
Un hook `Stop` ne se déclenche qu'en fin de tour, donc un Send fait pendant que la Claude session attend ne la réveillerait pas tant que je ne tape rien dans le terminal.
Le prix : un mod ne tourne que dans la CLI et le panneau VS Code, pas dans Claude Desktop.

## Considered Options

- Serveur MCP et hook `Stop` : marchent dans Claude Desktop, mais il faut taper un message après chaque Send.
- Channels (research preview) : un plugin personnel exige `--dangerously-load-development-channels` au lancement.
- Hook `asyncRewake` : son timeout s'applique, et la doc ne dit pas s'il est accepté sur `Stop`.
