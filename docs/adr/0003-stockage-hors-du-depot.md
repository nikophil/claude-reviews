# Stocker les sessions hors du dépôt, en JSON

Chaque session, avec ses threads, vit dans un fichier JSON sous `~/.local/share/claude-reviews/sessions/`, avec le chemin du worktree comme clé ;
seul le serveur l'écrit, par remplacement atomique.
Le brief prévoyait la `--git-dir` du worktree, mais `git worktree remove` efface `.git/worktrees/<nom>/`,
et le serveur unique, qui sert tous les worktrees, lit alors un seul dossier.

## Considered Options

- SQLite (`node:sqlite`, intégré à Node 25) : écarté, un seul processus écrit et quelques dizaines de fichiers se lisent sans requête ni schéma à migrer.
