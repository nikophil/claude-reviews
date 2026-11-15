# Claude applique les suggestions : le serveur n'écrit jamais dans le worktree

Un bloc `suggestion` dans un de mes messages propose le code qui remplace les lignes du thread, comme sur GitHub.
Mais aucun client n'a le bouton « Commit suggestion » de GitHub : Claude lit la suggestion avec le thread, l'applique au working tree, sauf désaccord, puis répond dans le thread.
Le serveur lit le dépôt et y écrit des objets git et ses refs cachées ([ADR 0002](0002-snapshots-dans-des-refs-cachees.md)), mais jamais un fichier du worktree.

Claude travaille dans ce même working tree : une écriture du serveur changerait le code sous ses yeux, sans qu'il le sache, et il pourrait l'écraser au tour suivant.
Le serveur reste aussi un lecteur, ce qui limite ce qu'obtient un process qui le joint ([ADR 0006](0006-un-serveur-et-un-token-par-compte.md)).

## Considered Options

- Un bouton Apply, qui fait réécrire les lignes par le serveur : écarté pour les raisons plus haut ; le Send réveille déjà Claude, qui applique la suggestion dans son tour.
- Un client qui applique la suggestion lui-même, dans l'éditeur de PhpStorm ou de VS Code : écarté, la page web ne le peut pas, et Claude ne saurait pas que le code a changé avant de le relire.
