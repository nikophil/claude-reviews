# claude-reviews

Lire `BRIEF.md`, `GLOSSARY.md` et `docs/adr/` avant de modifier le code, et nommer les choses avec les mots du glossaire.

## Prérequis

- Node 25 au moins.
- git 2.41 au moins : la liste des bases trie les branches par `%(ahead-behind:HEAD)` de `git for-each-ref`.

## Commandes

- `npm ci` : installe `@playwright/test`, la seule dépendance, de développement.
- `npm start` (`node server/main.ts`) : lance le serveur sur `127.0.0.1:7778`, puis ouvrir `http://127.0.0.1:7778/?worktree=<chemin absolu>`, qui ouvre la session du worktree et redirige vers `/s/<id>`.
- `CLAUDE_REVIEWS_PORT=<port>` change le port.
- `node --test` : tests du serveur, des fonctions pures et du mod, ce dernier sous un `$` factice.
- `npm run test:mod` : `claude plugin test` sur une copie du mod dans `var/mod/`, car il lancerait aussi les `*.test.ts` de `node --test` ; ses tests sont des `*.test.tsx`, que `node --test` ignore.
- `claude --plugin-dir .` : une Claude session avec le mod de ce dossier.
- `/plugin install local-reviews --marketplace nikophil/claude-reviews` : installe le mod ; il lance le serveur avec le `node` du `PATH`, en version 25 au moins.
- `npx playwright install chromium` une fois, puis `npx playwright test` : tests de l'UI, sur un serveur lancé sur le port 7779, avec un `XDG_DATA_HOME` temporaire.
- `npm run build:phpstorm` : construit `var/phpstorm/local-reviews.zip` avec le `javac` et les jars du PhpStorm installé (`PHPSTORM_HOME`, sinon celui de Toolbox) et `zip`, avec une version `0.1.<epoch>` par build, et écrit `var/phpstorm/updatePlugins.xml` ;
  ce dépôt de plugins, ajouté une fois par Settings › Plugins › ⚙ › Manage Plugin Repositories (`file://…/updatePlugins.xml`), propose ensuite chaque build en mise à jour.

## Structure

- `server/` : serveur `node:http` en TypeScript, exécuté par Node 25 sans build (type stripping) ; les imports portent l'extension `.ts`.
- `server/diff.ts` : écrit le tree du working tree avec un index temporaire, puis calcule et parse `git diff <base> <tree>`.
- `server/sessions.ts` : sessions, threads, messages, Send et Approve, stockés en JSON sous le dossier de données.
- `server/reanchor.ts` : `reanchor(anchor, lignes)`, la fonction pure qui retrouve la plage d'une Anchor dans un fichier, ou rend `null` quand le thread est Outdated (#8).
- `ui/` : page servie telle quelle, en Preact + htm sans build ni JSX.
- `ui/vendor/` : bibliothèques front copiées telles quelles, à ne pas modifier ni relire.
- `e2e/` : tests Playwright.
- `.claude-plugin/` : le plugin `local-reviews` (le préfixe `claude-` est réservé à Anthropic) et la marketplace de ce dépôt ; la version du plugin est celle du serveur.
- `hooks/register.ts` : le mod, qui enregistre les outils et `/review-local`, démarre le serveur, sonde la session toutes les 2 s et réveille Claude ; `$` n'y passe qu'à des fonctions déclarées en tête de fichier.
- `hooks/watch.ts` : les décisions du mod (réveiller, relancer, se taire, reprendre après un `{ drop }`), en fonctions pures.
- `phpstorm/` : le plugin PhpStorm, en Java et Swing : la tool window « Claude Reviews » (base, Send, Approve, fichiers changés et leurs threads), les threads dans l'éditeur et dans le diff de l'IDE ; il ne parle qu'à l'API, comme tout client ([ADR 0004](docs/adr/0004-clients-et-mod-separes-par-l-api.md)).
- Aucune dépendance npm au runtime : ce qui manque s'écrit, ou se vendorise en un fichier dans `ui/vendor/`.

## Contrat HTTP

Le serveur sert l'UI et une API JSON, pour l'UI et le mod.

- `GET /` sert l'écran Reviews : les sessions ouvertes de `GET /api/sessions`, chacune un lien vers `/s/<id>`.
- `GET /s/<id>` sert la page de la session `<id>`, ouverte ou approuvée ; celle d'une session approuvée dont le worktree a disparu montre ses threads sur leur Anchor, sans diff, et « Closed » et son bandeau seulement si `closedBecause` le dit.
- `GET /?worktree=<chemin>` sert la même page, qui ouvre la session du worktree par `POST /api/sessions`, puis remplace son URL par `/s/<id>`.
- La page lit la session et `/tree` toutes les 2 s, et ne recharge le diff qu'à son ouverture, au Refresh et au changement de base.
- Le bandeau « The code changed since it was loaded » paraît quand `/tree` diffère du diff affiché : par son `tree`, ou par sa `base` hors Since my last review, qu'un Send déplace sans changer le code.

- Toute requête dont le `Host` n'est ni `127.0.0.1:<port>` ni `localhost:<port>` reçoit 403.
- Une requête `/api/` dont le `Sec-Fetch-Site` n'est ni `same-origin` ni `none` reçoit 403.
- Une écriture (toute méthode sauf `GET` et `HEAD`) exige `Content-Type: application/json` (sinon 415) et un `Origin` absent ou égal à `http://<Host>` (sinon 403) : l'UI envoie le sien, le mod aucun.
- Aucune réponse ne porte d'en-tête CORS.
- Une erreur répond `{ "error": "<message>" }` : 400 pour une entrée invalide, 404 pour une session, un thread ou une route inconnus, 409 pour une écriture refusée, 413 pour un corps de plus de 1 Mo.

| Route | Rôle |
| --- | --- |
| `GET /api/health` | `{ app: "claude-reviews", version }`, la version de `.claude-plugin/plugin.json`. |
| `GET /api/me` | `{ login, name }`, pour les avatars de mes messages : mon login sur github.com (`gh api --hostname github.com user --jq .login`) et `git config --global --includes user.name`, chacun `null` en échec ou au-delà de 2 s. |
| `POST /api/shutdown` `{}` | Arrête le serveur : il cesse d'écouter avant de répondre. |
| `GET /api/sessions` | Les sessions ouvertes, pour Reviews : `[{ id, worktree, repo, branch, awaitingYou, waitingForClaude, updatedAt }]`, Awaiting you d'abord, puis Waiting for Claude, puis le reste, la plus récemment active d'abord à égalité. |
| `GET /api/sessions?worktree=<chemin>` | La session ouverte du worktree, sans en créer : 404 sans session ouverte. |
| `POST /api/sessions` `{ worktree }` | Renvoie la session ouverte du worktree, ou en crée une. |
| `GET /api/sessions/<id>` | La session, ouverte ou approuvée. |
| `GET /api/sessions/<id>/diff[?base=&tree=][&w=1]` | Le diff du working tree de la session contre sa base : `{ ref, base, tree, files }`, où `ref` est la base choisie, ou `HEAD` quand elle ne désigne plus rien, et `base` et `tree` les ids de la base et du tree affichés ; avec `?base=&tree=`, `{ base, tree, files }`, le diff de ces ids ; avec `w=1` (Hide whitespace), `git diff -w`. |
| `GET /api/sessions/<id>/tree` | `{ ref, base, tree }` comme `/diff`, sans calculer le diff : le poll de l'UI le compare au diff affiché. |
| `GET /api/sessions/<id>/lines?path=<chemin>&tree=<id>&from=<n>&to=<m>` | `{ lines }`, les lignes `from` à `to` du fichier dans le tree affiché, que le diff cache et qu'« Expand » montre. |
| `GET /api/sessions/<id>/file?object=<id>&path=<chemin>` | `{ text }`, le texte de `path` dans le commit ou le tree `object` du dépôt de la session : 404 sans ce fichier, 400 pour un objet que le dépôt n'a pas. |
| `GET /api/sessions/<id>/bases` | Les bases du sélecteur, dans son ordre : `[{ ref, name, disabled? }]`. |
| `POST /api/sessions/<id>/base` `{ base }` | Choisit la base de la session parmi les `ref` non grisées de `/bases`. |
| `POST /api/sessions/<id>/threads` `{ author, path, side, start, end, body, base?, tree? }` | Ouvre un thread avec son premier message (`open_thread` pour Claude). |
| `POST /api/sessions/<id>/threads/<n>/messages` `{ author, body }` | Ajoute un message (`reply_to_thread` pour Claude). |
| `POST /api/sessions/<id>/threads/<n>/resolve` `{}` | Résout le thread. |
| `POST /api/sessions/<id>/viewed` `{ path, tree, viewed }` | Marque le fichier Viewed sur le tree affiché, ou le démarque. |
| `POST /api/sessions/<id>/threads/<n>/unresolve` `{}` | Rouvre le thread Resolved. |
| `POST /api/sessions/<id>/send` `{ tree }` | Send : Snapshot du tree affiché, puis publication des messages Pending. |
| `POST /api/sessions/<id>/approve` `{}` | Approve : archive la session, puis supprime ses refs. |
| `POST /api/sessions/<id>/turn-complete` `{}` | Notifie « Claude replied in N threads », suivi de « , M still waiting » s'il en reste, par `notify-send` (Linux) ou `osascript` (macOS). |

- Lire les sessions (`GET /api/sessions`, avec ou sans `worktree`) clôt d'abord comme un Approve chaque session ouverte dont le worktree n'existe plus, même avec des messages Pending.
- Un worktree n'existe plus quand son `stat` répond ENOENT, que son dossier parent existe encore, et que son `commonDir`, s'il est hors du worktree, existe encore ; toute autre erreur, ou un parent ou un `commonDir` disparu lui aussi (disque démonté), laisse la session ouverte.
- Lire ou ouvrir la session d'un worktree clôt aussi la session à son chemin qui porte un autre `commonDir` : un autre dépôt ne reprend pas la session.
- Une lecture n'attend la file des écritures que pour clore une session ; un fichier de session illisible est ignoré, avec une ligne dans le log du serveur, sans être supprimé ni réécrit.
- La notification compte les threads où Claude a écrit depuis le dernier Send, et les threads Waiting for Claude ; `start(port, notify)` reçoit la commande à lancer, que les tests enregistrent sans la lancer.
- Hors `/diff`, `/tree`, `/lines`, `/bases` et la liste des sessions, chaque route d'une session renvoie la session entière, au format du fichier, et chaque thread y porte en plus son `status` : `resolved`, `waiting-for-claude`, `awaiting-you`, ou `null` tant qu'aucun message n'est publié.
- Une route qui renvoie la session et reçoit `?base=<id>&tree=<id>` (le code affiché par l'UI), ou `?reanchor` (HEAD et le working tree, pour le mod), ré-ancre chaque thread sur ce code : il y porte aussi `at`, `null` s'il est Outdated, sinon `{ start, end, context }`.
- Avec `?reanchor`, `at` vaut `{ start, end }`, sans `context` ni calcul du diff, et un thread Resolved n'a pas d'`at`.
- Une `base` ou un `tree` mal formés dans la query, ou un `w` autre que `1`, reçoivent 400 avant toute écriture ; une écriture enregistrée répond 200, avec ses threads sans `at` si leur ré-ancrage échoue.
- Avec `?w=1` en plus de `?base=&tree=`, `context` se calcule sur le diff qui cache les espaces : un thread sur une ligne qui ne change que par ses espaces sort du diff, et reçoit ses lignes de contexte.
- `context` liste, quand aucun hunk du diff de ce code ne montre la dernière ligne de la plage, les lignes de 3 au-dessus à 3 au-dessous de la plage, hors celles des hunks, inchangées et numérotées des deux côtés ; l'UI les affiche comme un hunk de plus.
- Placée par `?base=&tree=`, la session ne garde dans `viewed` que les fichiers dont le contenu dans `tree` a toujours l'id enregistré : un fichier qui change n'est plus vu, un changement de base qui ne le touche pas le laisse vu.
- Le serveur garde en mémoire `login` et `name` de `/api/me` dès qu'ils répondent ; un échec, il le garde 60 s, puis l'appel suivant relance sa commande ; le mod n'appelle pas `/api/me`.
- `author` vaut `me` ou `claude` : un message de `me` naît Pending, un message de `claude` est publié sur-le-champ.
- Un thread Resolved refuse un message de `me` avec 409 jusqu'à son Unresolve ; il accepte un message de `claude`, qui ne le rouvre pas.
- Un Send ne publie pas les messages Pending d'un thread Resolved : ils attendent son Unresolve.
- Les bases sont `HEAD` (Uncommitted changes), `last-review` (Since my last review, le Snapshot du dernier Send, grisé avant le premier), `origin/HEAD`, puis les branches locales `refs/heads/<nom>` hors celle du worktree, de la plus proche du merge-base à la plus lointaine.
- Une branche et `origin/HEAD` comparent depuis leur merge-base avec HEAD.
- Le diff se garde en mémoire par paire (`base`, `tree`) et par `?w=1` : le redemander sans changement ne relance pas `git diff`.
- `side` vaut `old` ou `new`, et `start` et `end` sont les numéros de la première et de la dernière ligne de la plage, de ce côté.
- L'Anchor se capture sur le code que voit l'auteur : pour `me`, la `base` et le `tree` affichés, obligatoires ; pour `claude`, HEAD et le working tree au moment de l'appel.
- `path` est le chemin du fichier depuis la racine du worktree, sous sa forme canonique : ni `./`, ni `/` en tête, ni segment vide ou `.`.
- `base` et `tree` sont des ids de 40 ou 64 caractères hexadécimaux, d'un commit ou d'un tree pour `base`, d'un tree pour `tree`.
- `/lines` refuse avec 400 un chemin non canonique, un `tree` qui n'est pas un tree du dépôt de la session, et une plage hors de `1 ≤ from ≤ to` ou de plus de 1000 lignes.
- Dans `/diff`, chaque fichier modifié porte `lineCount`, son nombre de lignes dans le tree, pour savoir où s'arrêtent les lignes cachées après son dernier hunk ; 0 pour les autres fichiers, et pour tous quand `git grep` échoue, sans faire échouer le diff.
- Le diff garde 3 lignes de contexte autour des changements, quelles que soient les configs `diff.context` et `diff.interHunkContext`.
- Une session approuvée refuse toute écriture avec 409 et `{ "error": "session approuvée" }`.
- L'Approve refuse avec 409 tant qu'il reste un message Pending.
- Un message de `claude` dans un thread sans message publié reçoit 409 : publié sur-le-champ, il passerait avant mon message Pending au Send.
- Le mod ouvre un thread sans session connue par `POST /api/sessions`, puis `POST /api/sessions/<id>/threads` ; s'il garde l'id d'une session approuvée, il reçoit « session approuvée ».
- Après un Approve, `POST /api/sessions` sur le même worktree ouvre une nouvelle session : seul un appel qui porte l'ancien id reçoit « session approuvée ».

## Mod

- Au `session.start`, le mod relie la Claude session au worktree par `git rev-parse --show-toplevel` sur le `cwd`, enregistre ses outils, puis démarre le serveur.
- Sans réponse sur le port, il lance `node <racine du plugin>/server/main.ts` détaché par `nohup`, depuis la racine du plugin, ses sorties dans `<données>/server.log`.
- Une version plus ancienne de claude-reviews, il l'arrête par `POST /api/shutdown` puis la relance ; une version plus récente, il l'utilise telle quelle, pour que deux Claude sessions de versions différentes n'arrêtent pas le serveur l'une de l'autre.
- Un port qui répond autre chose que claude-reviews, ou qui ne répond pas en 2 s, ne lance rien : le mod le signale par `$.ui.log`, une ligne du transcript que le modèle ne lit pas, et sonde quand même.
- Le mod lit `CLAUDE_REVIEWS_PORT` comme le serveur.
- `list_open_threads()` rend, hors Resolved et hors threads sans message publié, l'id, le statut, `outdated`, le fichier, le côté, la plage ré-ancrée sur HEAD et le working tree (celle de l'Anchor s'il est Outdated), les lignes de l'Anchor et les messages publiés.
- Un thread Outdated y porte en plus `hunk`, l'extrait de diff d'origine en diff unifié, `null` si l'Anchor était hors du diff.
- Il sonde `GET /api/sessions?worktree=` toutes les 2 s ; un Send qui laisse des threads Waiting for Claude le fait réveiller Claude par `$.prompt.submit`, jamais attendu dans un hook.
- Seul un 404 vaut « aucune session ouverte » ; un sondage en échec laisse l'état tel quel, et le mod garde par session le dernier Send vu et la relance faite.
- Il relance Claude une fois par Send, à la fin d'un tour fini sur une réponse, ni interrompu ni en erreur, qui laisse des threads en attente ; un `{ drop }` attend le prochain prompt ou début de tour, et ne compte pas.
- À la fin du tour ouvert par un réveil ou une relance, s'il ne doit pas relancer, il appelle une fois `POST /api/sessions/<id>/turn-complete`, sans l'attendre.
- Le premier prompt d'une Claude session porte, dans le `context` de `prompt.submit`, le nombre de threads qui l'attendent : `prompt.context` atteindrait aussi les subagents, et `cc-plugin-sec-default` le court-circuite sur les comptes Team ou Enterprise.
- Après un Approve, `open_thread` refait `POST /api/sessions` et ouvre une nouvelle session ; `reply_to_thread` répond « session approuvée ».
- Tout appel au serveur abandonne au bout de 2 s : sans réponse, les outils répondent `{ deny }`, `/review-local` le dit, et un sondage laisse l'état tel quel.

## Données

Le dossier de données est `$XDG_DATA_HOME/claude-reviews`, sinon `~/.local/share/claude-reviews` ; les tests le placent dans un dossier temporaire avec `dataHome()` de `server/fixture.ts`.

- Une session ouverte vit dans `sessions/<id>.json`, une session approuvée dans `archive/<id>.json`.
- Le serveur seul écrit ces fichiers, en écrivant `<id>.json.tmp` dans le même dossier, puis en le renommant.
- Un Send commite le tree affiché sous `refs/claude-reviews/<id>/<n>`, où `n` est le numéro du Send.
- L'Approve écrit la session approuvée, la déplace sous `archive/`, puis supprime ses refs dans `commonDir` ; une suppression ratée laisse les refs, pas la session ouverte.
- Un worktree disparu clôt sa session de la même façon : `approvedAt` daté, `closedBecause` à `worktree-gone`, archive, refs supprimées dans `commonDir`.

```json
{
  "id": "9f2c4e1a7b3d5e60",
  "worktree": "/home/me/src/app",
  "commonDir": "/home/me/src/app/.git",
  "createdAt": "2026-11-14T10:00:00.000Z",
  "approvedAt": null,
  "base": "HEAD",
  "sends": 1,
  "sentAt": "2026-11-14T10:05:00.000Z",
  "viewed": { "src/b.ts": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" },
  "threads": [{
    "id": 1,
    "anchor": {
      "path": "src/a.ts", "side": "new", "start": 2, "end": 3,
      "lines": ["…", "…"], "before": ["…"], "after": ["…", "…", "…"],
      "hunk": { "header": "@@ -1,6 +1,6 @@", "lines": [{ "type": "add", "oldNo": null, "newNo": 2, "text": "…" }] }
    },
    "resolved": false,
    "messages": [
      { "author": "me", "body": "Pourquoi ?", "date": "2026-11-14T10:05:00.000Z", "review": 1 },
      { "author": "claude", "body": "Parce que…", "date": "2026-11-14T10:06:00.000Z" },
      { "author": "me", "body": "OK", "date": null }
    ]
  }]
}
```

- `id` : 16 caractères hexadécimaux, distinct du chemin du worktree ; un thread a pour id son rang dans la session, à partir de 1.
- `worktree` : la racine du worktree (`git rev-parse --show-toplevel`).
- `commonDir` : le dépôt commun aux worktrees (`git rev-parse --git-common-dir`), où restent les refs quand le worktree disparaît ; absent des sessions plus anciennes.
- `base` : la dernière base choisie, une `ref` de `/bases`, `HEAD` à la création.
- `sends` : le nombre de Send, donc le numéro de la dernière ref.
- `sentAt` : la date du dernier Send, absente avant le premier.
- `viewed` : chaque fichier marqué Viewed, avec l'id de son contenu dans le tree affiché quand je l'ai coché, `deleted` pour un fichier absent de ce tree ; absent des sessions plus anciennes.
- `closedBecause` : `worktree-gone` pour une session close parce que son worktree a disparu, absent sinon, même après un Approve.
- `anchor` : jusqu'à 3 voisines dans `before` et `after`, et `hunk`, l'extrait du diff jusqu'à la fin de la plage, `null` hors du diff ; aucun SHA.
- Un message sans `date` est Pending ; un Send le date, lui donne son numéro dans `review`, et le place après les messages déjà publiés.

## Fichiers vendorisés

| Fichier                    | Source                                                    |
| -------------------------- | --------------------------------------------------------- |
| `ui/vendor/primer.css`     | `@primer/css@21.5.1/dist/primer.css`                      |
| `ui/vendor/preact-htm.js`  | `htm@3.1.1/preact/standalone.module.js` (Preact 10 inclus) |
| `ui/vendor/highlight.js`   | `@highlightjs/cdn-assets@11.12.0/es/highlight.min.js`     |
| `ui/vendor/marked.js`      | `marked@18.1.2/lib/marked.esm.js`                         |

Primer 21.5.1 nomme ses variables de diff `--diffBlob-addition-bgColor-line` et non `--diffBlob-additionLine-bgColor` comme en 22.
Le markdown des messages passe par marked, avec le HTML brut échappé, les images remplacées par leur texte, et seuls les liens `http`, `https` et `mailto` cliquables (`ui/app.js`).
Mes messages montrent `https://github.com/<login>.png`, et sans login, ou une fois l'image en échec sur la page, mes initiales tirées de `name` ; ceux de Claude, son étoile en SVG inline, carrée comme l'avatar d'une app GitHub.
La page relit `/api/me` à chaque poll tant qu'il ne donne pas de `login`.
La coloration syntaxique passe par les variables `--color-prettylights-syntax-*` de Primer (`ui/app.css`), pas par un thème highlight.js.

## Langues

- Code, commentaires, messages de commit et titres de PR en anglais ; un titre de PR commence par son scope, par exemple `[Server] Compute the diff against HEAD`.
- Issues, corps de PR et docs en français.
- Dans un `.md`, une phrase par ligne.

## Code

- Le minimum qui résout l'issue : pas d'abstraction à usage unique, pas de configuration non demandée.
- Commentaires rares, pour un pourquoi qui ne se lit pas dans le code.
- Un raccourci délibéré porte un commentaire `ponytail:` qui nomme sa limite.

## Tests

- Chaque critère d'acceptation d'une issue a son test, écrit avant le code (rouge, puis vert).
- `node --test` couvre le serveur et les fonctions pures, dans des fichiers `*.test.ts` à côté du code.
- Les dépôts de test se créent avec `repo()` et `write()` de `server/fixture.ts`, dans un dossier temporaire, à l'abri de la config git globale ; `removeRepos()` les supprime en fin de fichier de test.
- Playwright (Chromium) couvre l'UI, dans `e2e/*.spec.ts`, sur les mêmes fixtures ; chaque test ouvre `/?worktree=<fixture>`.
- Le serveur de Playwright a un `gh` qui échoue en tête du `PATH`, pour que mon vrai login n'atteigne pas les tests ; un test qui en a besoin répond lui-même à `/api/me`.
- La CI (`.github/workflows/ci.yml`) lance les deux suites sur chaque PR, sous Node 25.
- Une PR ajoute au plus 1000 lignes, hors lockfile et fichiers vendorisés.
