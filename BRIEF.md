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
- **Une session par worktree** : la relecture d'un worktree comparé à une base, de son ouverture à son Approve ou à la disparition du worktree.
  Un worktree a au plus une session ouverte, et un checkout ou un rebase ne la clôt pas.
- **Une review est un envoi** : Send livre mes messages Pending à Claude et le réveille, Approve clôt la session.
  Un Send sans message reste possible : il prend un Snapshot, et ne réveille Claude que si des threads l'attendent encore.
  Pas de verdict Comment ou Request changes : Claude répond aux questions, et modifie le code quand un thread le demande.
- **Seul l'utilisateur résout un thread.**
  Claude répond dans chaque thread qui l'attend, et n'ouvre un thread que quand on le lui demande (« relis ton diff et ouvre des threads »).
- **Claude passe par un mod Claude Code**, pas par un serveur MCP et un hook `Stop` ([ADR 0001](docs/adr/0001-mod-claude-code-plutot-que-mcp.md)) :
  un Send réveille la Claude session même inactive, au prix de Claude Desktop, où le mod ne tourne pas ;
  le réveil est vérifié (voir [Test du mod](#test-du-mod)).
- **Deux outils séparés** pour claude-reviews et gh-notif, reliés par un petit contrat HTTP (voir plus bas).

## Architecture

1. **Un serveur local par compte**, pour tous ses worktrees : il sert l'UI et une API JSON, sur un port éphémère, derrière un token ([ADR 0005](docs/adr/0005-un-serveur-et-un-token-par-compte.md)).
   Le mod le démarre à la demande quand le fichier `endpoint` ne nomme aucun serveur, sans service systemd.
2. **Stockage** : un fichier JSON par session ouverte sous `~/.local/share/claude-reviews/sessions/`, avec le chemin du worktree comme clé ;
   une session close part sous `~/.local/share/claude-reviews/archive/`, rangée sous son id ;
   seul le serveur écrit ces fichiers, par remplacement atomique ([ADR 0003](docs/adr/0003-stockage-hors-du-depot.md)).
3. **Snapshots** : à chaque calcul du diff, le serveur écrit un tree du working tree (suivis et non suivis, hors ignorés) avec un index temporaire ;
   à chaque Send, il commite le tree que l'UI affichait sous `refs/claude-reviews/<session>/<n>` ;
   l'Approve, ou la disparition du worktree, supprime ces refs ([ADR 0002](docs/adr/0002-snapshots-dans-des-refs-cachees.md)).
4. **Le mod Claude Code**, livré en plugin (`hooks/hooks.json` → `"modules"`) :
   - il enregistre les outils `list_open_threads()`, qui renvoie en entier les threads non Resolved, Waiting for Claude ou où Claude a parlé en dernier,
     `reply_to_thread(id, body)` et `open_thread(file, side, lines, body)`, ainsi que la commande `/review-local`,
     qui ouvre la session du worktree dans PhpStorm, VS Code ou le navigateur, et demande lequel quand un de ces IDE est installé ;
   - il relie la Claude session à sa session de relecture par le chemin du worktree (`git rev-parse --show-toplevel` sur le `cwd`) ;
   - sans session ouverte, `open_thread` en ouvre une ; une session close refuse les messages de Claude, et le mod cesse alors de le relancer ;
   - il interroge le serveur, et sur un Send injecte « N threads t'attendent » avec `$.prompt.submit` ;
   - il n'attend jamais `$.prompt.submit` dans un hook, car l'appel ne se résout qu'une fois la session inactive, et un hook n'a que 10 s ;
     un `{ drop }` (après un Esc, tant que personne n'a tapé) laisse les threads en attente, et le mod retente au prochain prompt ou début de tour ;
   - si Claude finit son tour alors que des threads l'attendent encore, il le relance une seule fois par Send :
     la relance compte quand son prompt ouvre un tour, un `{ drop }` ne compte pas, et un nouveau Send en permet une autre ;
   - au démarrage d'une Claude session dans un worktree où des threads attendent, il ajoute « N threads t'attendent » au premier message.
5. **Notification** : à la fin du tour de Claude qui suit un Send, ou sa relance s'il y en a une, `notify-send` annonce « Claude replied in N threads »,
   suivi de « M still waiting » s'il en reste ; Claude a pu modifier du code après sa dernière réponse, d'où la fin du tour plutôt que la dernière réponse.
   Le mod voit la fin du tour et appelle le serveur, qui envoie la notification (`notify-send` ou `osascript`).
6. **Stack** : Node 25, TypeScript exécuté sans build (type stripping), `node:http`, aucune dépendance npm.
   Front en Preact + htm, avec Primer CSS et marked, chacun vendorisé en un fichier ;
   il interroge le serveur toutes les 2 s, sans perdre un message en cours de frappe ;
   le diff, lui, ne se recharge qu'au Refresh, que propose un bandeau quand le working tree diffère du code affiché.

## Diff et base

- La base se choisit dans l'UI, et le diff va toujours jusqu'au working tree, changements non commités et fichiers non suivis compris :
  - **Uncommitted changes** : HEAD, le choix par défaut ;
  - **Since my last review** : le Snapshot du dernier Send, ce qui remplace les « vues par tour » ; grisée avant le premier Send ;
  - **la branche par défaut** (origin/HEAD) : depuis le merge-base ;
  - **la branche de base** : la base de la PR de la branche, sinon la branche locale la plus proche ;
  - **une PR ouverte**, par sa branche sur origin, pour relire depuis la PR sur laquelle la branche s'empile ;
  - **les autres branches**, locales puis distantes, triées par distance au merge-base, la branche parente d'une pile de PR en tête.
- Chaque session garde la dernière base choisie.

## Modèle d'un thread

- **Anchor** : fichier, côté (ancien ou nouveau), plage de lignes, contenu de ces lignes et de leurs voisines,
  et l'extrait de diff d'origine (comme le `diff_hunk` de GitHub), sans SHA.
  Elle se capture sur le code que voit son auteur : la base et le code affiché pour moi, la base de la session et le working tree pour Claude.
- **Messages** : auteur (`me` | `claude`), corps en markdown, date, et pour les miens la review qui l'a publié ; sans review, mon message est Pending.
  Un message de Claude est publié dès qu'il l'écrit, hors de toute review : un thread que Claude ouvre est publié sur-le-champ, sans attendre de Send.
  Un message prend sa date et sa place dans le thread à sa publication, donc mon message Pending passe après une réponse de Claude arrivée entre-temps.
- Trois faits indépendants, qui se combinent :
  - **à qui le tour**, déduit du dernier message envoyé : **Waiting for Claude** si c'est le mien ; si c'est celui de Claude, le thread n'affiche pas de statut ;
  - **Resolved**, que moi seul change, sur-le-champ, sans review ; un thread Resolved n'attend plus Claude, même si mon message est le dernier,
    et seul un message que j'y écris le rouvre, pas une réponse de Claude ;
  - **Outdated**, calculé quand l'ancre ne se retrouve plus dans le code qu'on regarde.
- **Ré-ancrage, dès le MVP** : chercher les lignes par leur contenu exact, au plus près de leur position d'origine, et départager par les voisines ;
  sinon le thread est Outdated et s'affiche avec son extrait d'origine.
  L'UI ré-ancre sur le code affiché, et `list_open_threads()` sur la base de la session et le working tree courant.
- **Thread hors du diff affiché** (Claude a commité, ou la base a changé) : il s'affiche dans son fichier, à sa ligne, avec quelques lignes de contexte,
  comme un hunk de plus.
- **Approve** reste grisé tant qu'un thread non Resolved porte un message Pending.
  Il passe la session en lecture seule, n'envoie rien à Claude, et laisse commit, push et PR à la conversation.
  La session approuvée reste consultable à son URL, mais quitte l'écran Reviews.
  On peut approuver avec des threads ouverts : la boîte de dialogue les compte.
  Un `/review-local` après un Approve ouvre une nouvelle session.
- **Worktree disparu** (`git worktree remove`, ou Orca qui le nettoie) : dès qu'il le constate, le serveur clôt sa session comme un Approve,
  pour qu'un nouveau worktree au même chemin n'en hérite pas.

## Écrans (maquette)

Maquette cliquable : https://claude.ai/artifact/Vx1yLU9aWnA8HujQPUSWBP
(contenu d'exemple, antérieure à ces décisions : elle montre encore Comment / Request changes).

- **Files changed** : arbre des fichiers, diff unifié, threads dans le diff, sélecteur de base,
  bandeau « The code changed since it was loaded » et son Refresh, qui met en avant Since my last review après un Send, et boutons Send et Approve.
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

Contrat proposé, après le MVP : claude-reviews expose une entrée par session ouverte, sur le port et avec le token du fichier `endpoint` (plus de port fixe depuis l'ADR 0005)

```
GET http://127.0.0.1:<port>/api/inbox
Authorization: Bearer <token>
[{ "repo": "acme/shop", "branch": "invoice-pdf-footer", "title": "…", "url": "http://127.0.0.1:<port>/s/…",
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
- Vue côte à côte, threads de fichier entier et blocs `suggestion` : faits ; Claude applique une suggestion, le serveur n'écrit jamais dans le worktree.

## Prochaines étapes

1. Écrire le MVP : serveur, diff avec sélecteur de base et snapshots, threads, stockage JSON et ré-ancrage ;
   puis le mod (outils, réveil, relance, premier message) ; puis `notify-send`.
2. Ensuite seulement : vue côte à côte et `/api/inbox` (faits), puis la PR gh-notif.
