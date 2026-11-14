# Photographier le working tree dans des refs cachées

Claude ne commite pas sans demande explicite :
pendant une session, l'essentiel du code relu n'est pas commité, et les fichiers qu'il crée ne sont pas suivis.
À chaque review, le serveur photographie le working tree (fichiers suivis et non suivis, hors ignorés) dans un commit caché sous `refs/claude-reviews/<session>/<n>`,
fait avec un index temporaire pour ne toucher ni à l'index ni au stash.
Ces commits fournissent la base « Since my last review » et le SHA de l'ancre d'un thread ;
ils apparaissent dans `git for-each-ref` des dépôts relus, jusqu'à l'Approve de la session, qui supprime ses refs.

## Considered Options

- Les seuls commits : le diff manque les fichiers non suivis, et « since my last review » ne voit rien tant que Claude ne commite pas.
- `git stash create` : ignore les fichiers non suivis.
