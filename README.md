# claude-reviews

Relire ce que Claude Code a écrit dans un diff local au look de l'onglet « Files changed » de GitHub,
avec des threads sous les lignes où Claude répond, sans passer par GitHub.

![Un thread ouvert sur une ligne avec une suggestion, envoyé à Claude, qui répond dans le thread](docs/images/review.png)

## Pourquoi

Claude Desktop et les autres outils laissent commenter une ligne du diff, mais Claude répond dans la conversation, loin du code.
Ici, chaque commentaire ouvre un thread ancré sur ses lignes :
Claude y répond, modifie le code quand le thread le demande, et je résous le thread quand la question est close.
Le contexte et les décisions du projet sont dans [BRIEF.md](BRIEF.md), son vocabulaire dans [GLOSSARY.md](GLOSSARY.md).

## Ce qu'on y fait

![La page Files changed : l'arbre des fichiers, le diff, un thread où Claude a répondu, et le menu des conversations](docs/images/files-changed.png)

- Relire le diff du worktree, changements non commités et fichiers non suivis compris, contre une base au choix :
  HEAD, le code de mon dernier Send, la branche par défaut, la branche de base, une PR ouverte ou n'importe quelle branche.
- Ouvrir un thread sur une ligne, une plage (Shift+clic) ou un fichier entier, avec un message en markdown.
- Proposer un changement par un bloc `suggestion` : Claude l'applique quand il lit le thread.
- Envoyer mes messages par Send, qui réveille la Claude session du worktree, même inactive ;
  modifier ou supprimer un message tant qu'il n'est pas envoyé.
- Suivre les threads : ils restent sur leur ligne quand le code bouge, et passent Outdated quand leurs lignes disparaissent.
- Marquer un fichier Viewed, jusqu'à ce que son contenu change ;
  passer d'un thread à l'autre avec `j` et `k`, ou par le menu des conversations.
- Copier les threads en markdown, pour une description de PR, puis clore la session par Approve.

L'écran Reviews liste les sessions de tous les worktrees, celles qui attendent Claude d'abord, et les sessions closes dans un onglet à part.

![L'écran Reviews : trois sessions ouvertes, avec leur dépôt, leur branche et le nombre de threads qui attendent Claude](docs/images/reviews.png)

## Installer

Il faut Node 25 au moins, et git 2.41 au moins.

Dans Claude Code :

```
/plugin install local-reviews --marketplace nikophil/claude-reviews
```

Le plugin démarre le serveur de ton compte sur un port éphémère de `127.0.0.1` à l'ouverture d'une Claude session dans un dépôt git ;
il écrit son port et son token dans `~/.local/share/claude-reviews/endpoint`, que seul ton compte lit, et chaque client envoie ce token.
`CLAUDE_REVIEWS_PORT` fixe le port : sur une machine partagée où tu travailles en SSH, choisis le tien et forwarde le même numéro (`ssh -L <port>:127.0.0.1:<port>`).

## Utiliser

1. Dans une Claude session, lance `/review-local` : la session de relecture du worktree s'ouvre dans le navigateur, ou dans PhpStorm ou VS Code, au choix, quand ils sont installés.
2. Clique un numéro de ligne, écris, puis Add message ; le message reste Pending jusqu'au Send.
3. Send : Claude se réveille, répond dans chaque thread qui l'attend, et modifie le code quand un thread le demande.
   Une ligne de statut sous son prompt compte les threads qui l'attendent.
4. Refresh quand le bandeau dit que le code a changé, réponds, résous les threads, puis Approve.

Pour que Claude relise son propre travail, demande-lui de relire son diff et d'ouvrir des threads :
il les ouvre avec l'outil `open_thread`, et ils t'attendent dans la page.

## Plugin PhpStorm

Le plugin PhpStorm montre la même session dans une tool window « Claude Reviews », avec les threads dans l'éditeur et dans le diff de l'IDE.

![PhpStorm : la tool window Claude Reviews, et dans l'éditeur un thread où Claude a répondu, puis une suggestion qui attend Claude](docs/images/phpstorm.png)

Il se construit avec le PhpStorm installé, sans rien télécharger :

```
npm run build:phpstorm
```

La commande écrit `var/phpstorm/updatePlugins.xml` :
ajoute-le une fois dans Settings › Plugins › ⚙ › Manage Plugin Repositories (`file://…/updatePlugins.xml`), et PhpStorm proposera chaque build en mise à jour.

## Extension VS Code

L'extension VS Code montre la même session dans une vue « Claude Reviews », avec les threads dans l'éditeur et dans le diff de VS Code.

![La vue Claude Reviews de VS Code, avec les fichiers changés et leurs threads, et le diff d'un fichier où Claude a répondu dans un thread](docs/images/vscode.png)

Elle se construit avec `zip`, sans rien télécharger :

```
npm run build:vscode
code --install-extension var/vscode/local-reviews.vsix --force
```

## Sécurité

Le serveur n'écoute que sur `127.0.0.1`, refuse les autres sites (en-têtes `Host`, `Origin` et `Sec-Fetch-Site`, Content-Security-Policy) et n'a pas d'authentification.
Il est fait pour un poste où l'on est seul :
sur une machine partagée entre plusieurs comptes, en SSH par exemple, les autres comptes pourraient lire les dépôts relus et écrire dans les threads.

## Développer

```
npm ci
npm start
node --test
npx playwright test
```

`npm start` lance le serveur et écrit son port et son token dans `~/.local/share/claude-reviews/endpoint` ; ouvre `http://127.0.0.1:<port>/?worktree=<chemin absolu>#token=<token>`.
`npm run readme` refait les images de ce README, sauf la capture de PhpStorm, prise à la main dans l'IDE.
Les règles du dépôt, le contrat HTTP et le format des données sont dans [CLAUDE.md](CLAUDE.md), les décisions d'architecture dans [docs/adr/](docs/adr/).
