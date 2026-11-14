# claude-reviews : brief

Un outil local de review de code au look de l'onglet « Files changed » de GitHub,
pour relire ce que Claude Code a écrit, **sans GitHub**.
La fonction qui manque partout ailleurs : de vrais **threads sous la ligne**,
où Claude répond dans le thread plutôt que dans la conversation.

Vocabulaire : [GLOSSARY.md](GLOSSARY.md).
Décisions structurantes : [docs/adr/](docs/adr/).

## Pourquoi

- Claude Desktop permet de commenter une ligne du diff, mais à sens unique :
  Claude répond dans la conversation, pas sous la ligne, et on ne peut pas répondre à ses commentaires de « Review code ».
- Codex app, Conductor, Warp et Vibe Kanban fonctionnent pareil : on envoie des commentaires groupés, l'agent corrige.
- Aucun outil existant ne se forke raisonnablement, d'où le départ de zéro :
  - **wyrd-diff** : un seul auteur, rien depuis le 22 mai 2026, pas de fichier LICENSE, UI Svelte sans Primer ;
    l'agent y résout les threads, et le diff part du bout de la base plutôt que du merge-base.
    On lui reprend deux idées : les fichiers non suivis dans le diff, et les threads livrés à l'agent seulement à l'envoi ;
  - **tuicr** : une TUI, avec des commentaires plats, sans thread ;
  - **Plannotator** : des commentaires ancrés sur le diff, mais ni réponse en thread ni état résolu en review, et 778k lignes.
    Son mod Claude Code sert de modèle pour réveiller une session (voir [ADR 0001](docs/adr/0001-mod-claude-code-plutot-que-mcp.md)).

## Décisions

- **UI web locale**, pas de TUI.
- **Look GitHub** avec **Primer CSS** (design system open source de GitHub, MIT), pas un CSS recopié ;
  thème sombre automatique (`data-color-mode="auto"`).
- **Une session par worktree** : la relecture d'un worktree (repo et branche) comparé à une base, de son ouverture à son Approve.
  Un worktree a au plus une session ouverte.
- **Une review est un envoi** : Send livre mes messages Pending à Claude et le réveille, Approve clôt la session.
  Pas de verdict Comment ou Request changes : Claude répond aux questions, et modifie le code quand un thread le demande.
- **Seul l'utilisateur résout un thread.**
  Claude répond dans chaque thread qui l'attend, et n'ouvre un thread que quand on le lui demande (« relis ton diff et ouvre des threads »).
- **Claude passe par un mod Claude Code**, pas par un serveur MCP et un hook `Stop` ([ADR 0001](docs/adr/0001-mod-claude-code-plutot-que-mcp.md)) :
  un Send réveille la Claude session même inactive, au prix de Claude Desktop, où le mod ne tourne pas ;
  le réveil est vérifié (voir [Test du mod](#test-du-mod)).
- **Deux outils séparés** pour claude-reviews et gh-notif, reliés par un petit contrat HTTP (voir plus bas).

## Architecture

1. **Un serveur local unique** sur `:7778`, pour tous les worktrees : il sert l'UI et une API JSON.
   Le mod le démarre à la demande quand le port ne répond pas, sans service systemd.
2. **Stockage** : un fichier JSON par session sous `~/.local/share/claude-reviews/sessions/`, avec le chemin du worktree comme clé ;
   seul le serveur l'écrit, par remplacement atomique ([ADR 0003](docs/adr/0003-stockage-hors-du-depot.md)).
3. **Snapshots** : à chaque review, le serveur photographie le working tree (suivis et non suivis, hors ignorés) dans un commit caché
   sous `refs/claude-reviews/<session>/<n>`, avec un index temporaire ;
   l'Approve supprime ces refs ([ADR 0002](docs/adr/0002-snapshots-dans-des-refs-cachees.md)).
4. **Le mod Claude Code**, livré en plugin (`hooks/hooks.json` → `"modules"`) :
   - il enregistre les outils `list_open_threads()`, qui renvoie en entier les threads Waiting for Claude,
     `reply_to_thread(id, body)` et `open_thread(file, side, lines, body)`, ainsi que la commande `/review-local`,
     qui ouvre la session du worktree dans le navigateur ;
   - il relie la Claude session à sa session de relecture par le chemin du worktree (`git rev-parse --show-toplevel` sur le `cwd`) ;
   - il interroge le serveur, et sur un Send injecte « N threads t'attendent » avec `$.prompt.submit` ;
   - il n'attend jamais `$.prompt.submit` dans un hook, car l'appel ne se résout qu'une fois la session inactive, et un hook n'a que 10 s ;
     un `{ drop }` (après un Esc, tant que personne n'a tapé) laisse les threads en attente, et le mod retente au prochain prompt ou début de tour ;
   - si Claude finit son tour alors que des threads l'attendent encore, il le relance une seule fois par review ;
   - au démarrage d'une Claude session dans un worktree où des threads attendent, il ajoute « N threads t'attendent » au premier message.
5. **Notification** : quand plus aucun thread d'une review n'attend Claude, le serveur appelle `notify-send` (« Claude replied in N threads »).
6. **Stack** : Node 25, TypeScript exécuté sans build (type stripping), `node:http`, aucune dépendance npm.
   Front en Preact + htm, avec Primer CSS et marked, chacun vendorisé en un fichier ;
   il interroge le serveur toutes les 2 s, sans perdre un message en cours de frappe.

## Diff et base

- La base se choisit dans l'UI, et le diff va toujours jusqu'au working tree, changements non commités et fichiers non suivis compris :
  - **Uncommitted changes** : HEAD, le choix par défaut ;
  - **Since my last review** : le snapshot de la dernière review, ce qui remplace les « vues par tour » ;
  - **origin/HEAD** : depuis le merge-base ;
  - **les autres branches**, triées par distance au merge-base, la branche parente d'une pile de PR en tête.
- Chaque session garde la dernière base choisie.

## Modèle d'un thread

- **Anchor** : fichier, côté (ancien ou nouveau), plage de lignes, contenu de ces lignes et de leurs voisines,
  SHA du snapshot, et l'extrait de diff d'origine (comme le `diff_hunk` de GitHub).
- **Messages** : auteur (`me` | `claude`), corps en markdown, date, et la review qui l'a envoyé ; sans review, le message est Pending.
- Trois faits indépendants, qui se combinent :
  - **à qui le tour**, déduit du dernier message envoyé : **Waiting for Claude** si c'est le mien, **Awaiting you** si c'est celui de Claude ;
  - **Resolved**, que moi seul change, sur-le-champ, sans review ; un nouveau message rouvre le thread ;
  - **Outdated**, calculé à l'affichage quand l'ancre ne se retrouve plus.
- **Ré-ancrage, dès le MVP** : chercher les lignes par leur contenu exact, au plus près de leur position d'origine, et départager par les voisines ;
  sinon le thread est Outdated et s'affiche avec son extrait d'origine.
- **Thread hors du diff affiché** (Claude a commité, ou la base a changé) : il s'affiche dans son fichier, à sa ligne, avec quelques lignes de contexte,
  comme un hunk de plus.
- **Approve** reste grisé tant qu'il reste des messages Pending.
  Il passe la session en lecture seule, n'envoie rien à Claude, et laisse commit, push et PR à la conversation.
  On peut approuver avec des threads ouverts : la boîte de dialogue les compte.
  Un `/review-local` après un Approve ouvre une nouvelle session.

## Écrans (maquette)

Maquette cliquable : https://claude.ai/artifact/Vx1yLU9aWnA8HujQPUSWBP
(contenu d'exemple, antérieure à ces décisions : elle montre encore Comment / Request changes).

- **Files changed** : arbre des fichiers, diff unifié, threads dans le diff, sélecteur de base,
  bandeau « Changed since your last review » qui bascule sur la base Since my last review, et boutons Send et Approve.
- **Reviews** : la liste des sessions ouvertes sur tous les worktrees, triées par qui doit agir ;
  l'écran garde le nom du produit, bien qu'il liste des sessions.
- **gh-notif · Local reviews** : la section proposée côté gh-notif.

## Intégration avec gh-notif

gh-notif : extension `gh`, Node ESM sans dépendance npm, page web locale sur `:7777` au look GitHub,
notifications bureau (`src/notify.js`, `notify-send` ou `osascript`).
Il tourne aussi en multi-utilisateur.
Son `CLAUDE.md` impose de lire `docs/ARCHITECTURE.md` avant toute modification, et des fonctions pures testées sur fixtures.

L'intérêt : une seule boîte de réception « où est-ce qu'on m'attend », de la review locale jusqu'à la PR mergeable.
Ça vaut surtout avec plusieurs Claude sessions en parallèle ; avec une seule, le `notify-send` du MVP suffit.

Contrat proposé, après le MVP : claude-reviews expose une entrée par session ouverte

```
GET http://localhost:7778/api/inbox
[{ "repo": "acme/shop", "branch": "invoice-pdf-footer", "title": "…", "url": "http://localhost:7778/s/…",
   "openThreads": 2, "awaitingMe": 2, "lastActor": "claude", "updatedAt": "…" }]
```

Côté gh-notif, une PR **générique** (« sources locales » : n'importe quel outil qui expose ce JSON) :
- le flux est lu dans la boucle de poll, seulement s'il est configuré ;
- une section « Local reviews » et un compteur par onglet ;
- une nouvelle catégorie de notification (« Claude replied in N threads ») ;
- rien sur l'instance multi-utilisateur.

## Effort estimé

- MVP utilisable : 4 à 6 jours, plus que les 2 à 4 jours du premier brief,
  car il absorbe le ré-ancrage, les snapshots, le sélecteur de base, les plages de lignes et le mod.
- Côté gh-notif : une demi-journée à une journée, tests compris.

## Test du mod

Fait le 14 novembre 2026 sur Claude Code 2.1.325, avec un mod jetable (`wake-probe`) où un fichier tient lieu de serveur :
- `$.prompt.submit` réveille une Claude session inactive en 0,1 s, sans que personne tape ;
  le prompt arrive comme un message du plugin (`origin.kind: 'plugin'`).
- Appelé pendant un tour, il attend la fin du tour, puis ouvre un tour à lui ; l'appel ne se résout qu'à ce moment.
- Appelé depuis un hook `turn.complete`, il ouvre le tour suivant : la relance marche.
- Le mod lit le `cwd` (`e.cwd` au `session.start`, `$.session.cwd()`, `$.session.root()`) et lance `git` avec `$.process.run`.
- Non testé, mais décrit par Plannotator (`~/.claude/plugins/marketplaces/plannotator/docs/agent-guides/claude-code-mod.md`) :
  le `{ drop }` après un Esc ;
  et leur réveil arrivé seulement à la frappe suivante venait de leur instance détruite au `session.end` d'un `/clear`, pas du moteur.

## Questions ouvertes

- **Deux Claude sessions dans le même worktree** répondraient toutes deux aux mêmes threads ; le MVP l'accepte, c'est rare avec Orca.
- Vue côte à côte, threads de fichier entier et blocs `suggestion` : après le MVP.

## Prochaines étapes

1. Écrire le MVP : serveur, diff avec sélecteur de base et snapshots, threads, stockage JSON et ré-ancrage ;
   puis le mod (outils, réveil, relance, premier message) ; puis `notify-send`.
2. Ensuite seulement : vue côte à côte, `/api/inbox` et la PR gh-notif.
