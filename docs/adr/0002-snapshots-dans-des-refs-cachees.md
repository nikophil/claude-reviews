# Photographier le code affiché dans des refs cachées

Claude ne commite pas sans demande explicite :
pendant une session, l'essentiel du code relu n'est pas commité, et les fichiers qu'il crée ne sont pas suivis.
À chaque calcul du diff, le serveur écrit un tree du working tree (fichiers suivis et non suivis, hors ignorés),
avec un index temporaire pour ne toucher ni à l'index ni au stash ;
à chaque Send, il commite le tree que l'UI affichait sous `refs/claude-reviews/<session>/<n>`.
Ces commits fournissent la base « Since my last review » ;
ils apparaissent dans `git for-each-ref` des dépôts relus, jusqu'à l'Approve de la session, qui supprime ses refs.

## Considered Options

- Les seuls commits : le diff manque les fichiers non suivis, et « since my last review » ne voit rien tant que Claude ne commite pas.
- `git stash create` : ignore les fichiers non suivis.
- Le working tree au moment du Send : il contient ce que Claude a modifié depuis le dernier affichage,
  que la base « Since my last review » cacherait ensuite sans que je l'aie vu.
