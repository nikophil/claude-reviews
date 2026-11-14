# claude-reviews

Lire `BRIEF.md`, `GLOSSARY.md` et `docs/adr/` avant de modifier le code, et nommer les choses avec les mots du glossaire.

## Commandes

- `npm ci` : installe `@playwright/test`, la seule dépendance, de développement.
- `npm start` (`node server/main.ts`) : lance le serveur sur `127.0.0.1:7778`, puis ouvrir `http://127.0.0.1:7778/?worktree=<chemin absolu>`.
- `CLAUDE_REVIEWS_PORT=<port>` change le port.
- `node --test` : tests du serveur et des fonctions pures.
- `npx playwright install chromium` une fois, puis `npx playwright test` : tests de l'UI, sur un serveur lancé sur le port 7779.

## Structure

- `server/` : serveur `node:http` en TypeScript, exécuté par Node 25 sans build (type stripping) ; les imports portent l'extension `.ts`.
- `server/diff.ts` : écrit le tree du working tree avec un index temporaire, puis calcule et parse `git diff HEAD <tree>`.
- `server/sessions.ts` : sessions, threads, messages, Send et Approve, stockés en JSON sous le dossier de données.
- `ui/` : page servie telle quelle, en Preact + htm sans build ni JSX.
- `ui/vendor/` : bibliothèques front copiées telles quelles, à ne pas modifier ni relire.
- `e2e/` : tests Playwright.
- Aucune dépendance npm au runtime : ce qui manque s'écrit, ou se vendorise en un fichier dans `ui/vendor/`.

## Contrat HTTP

Le serveur sert l'UI et une API JSON, pour l'UI et le mod.

- Toute requête dont le `Host` n'est ni `127.0.0.1:<port>` ni `localhost:<port>` reçoit 403.
- Une requête `/api/` dont le `Sec-Fetch-Site` n'est ni `same-origin` ni `none` reçoit 403.
- Une écriture (toute méthode sauf `GET` et `HEAD`) exige `Content-Type: application/json` (sinon 415) et un `Origin` absent ou égal à `http://<Host>` (sinon 403) : l'UI envoie le sien, le mod aucun.
- Aucune réponse ne porte d'en-tête CORS.
- Une erreur répond `{ "error": "<message>" }` : 400 pour une entrée invalide, 404 pour une session, un thread ou une route inconnus, 409 pour une écriture refusée, 413 pour un corps de plus de 1 Mo.

| Route | Rôle |
| --- | --- |
| `GET /api/diff?worktree=<chemin>` | Le diff du working tree contre HEAD : `{ base, tree, files }`, où `base` et `tree` sont les ids de la base et du tree affichés. |
| `POST /api/sessions` `{ worktree }` | Renvoie la session ouverte du worktree, ou en crée une. |
| `GET /api/sessions/<id>` | La session, ouverte ou approuvée. |
| `GET /api/sessions/<id>/diff` | Le diff du worktree de la session, comme `/api/diff`. |
| `POST /api/sessions/<id>/threads` `{ author, path, side, start, end, body, base?, tree? }` | Ouvre un thread avec son premier message (`open_thread` pour Claude). |
| `POST /api/sessions/<id>/threads/<n>/messages` `{ author, body }` | Ajoute un message (`reply_to_thread` pour Claude). |
| `POST /api/sessions/<id>/threads/<n>/resolve` `{}` | Résout le thread. |
| `POST /api/sessions/<id>/send` `{ tree }` | Send : Snapshot du tree affiché, puis publication des messages Pending. |
| `POST /api/sessions/<id>/approve` `{}` | Approve : archive la session, puis supprime ses refs. |

- Chaque route d'une session renvoie la session entière, au format du fichier, et chaque thread y porte en plus son `status` : `resolved`, `waiting-for-claude`, `awaiting-you`, ou `null` tant qu'aucun message n'est publié.
- `author` vaut `me` ou `claude` : un message de `me` naît Pending, un message de `claude` est publié sur-le-champ.
- Un message de `me` rouvre un thread Resolved au Send qui le publie, pas un message de `claude`.
- `side` vaut `old` ou `new`, et `start` et `end` sont les numéros de la première et de la dernière ligne de la plage, de ce côté.
- L'Anchor se capture sur le code que voit l'auteur : pour `me`, la `base` et le `tree` affichés, obligatoires ; pour `claude`, HEAD et le working tree au moment de l'appel.
- `path` est le chemin du fichier depuis la racine du worktree, sous sa forme canonique : ni `./`, ni `/` en tête, ni segment vide ou `.`.
- `base` et `tree` sont des ids de 40 ou 64 caractères hexadécimaux, d'un commit ou d'un tree pour `base`, d'un tree pour `tree`.
- Une session approuvée refuse toute écriture avec 409 et `{ "error": "session approuvée" }`.
- L'Approve refuse avec 409 tant qu'il reste un message Pending.
- Le mod ouvre un thread sans session connue par `POST /api/sessions`, puis `POST /api/sessions/<id>/threads` ; s'il garde l'id d'une session approuvée, il reçoit « session approuvée ».
- Après un Approve, `POST /api/sessions` sur le même worktree ouvre une nouvelle session : seul un appel qui porte l'ancien id reçoit « session approuvée ».

## Données

Le dossier de données est `$XDG_DATA_HOME/claude-reviews`, sinon `~/.local/share/claude-reviews` ; les tests le placent dans un dossier temporaire avec `dataHome()` de `server/fixture.ts`.

- Une session ouverte vit dans `sessions/<id>.json`, une session approuvée dans `archive/<id>.json`.
- Le serveur seul écrit ces fichiers, en écrivant `<id>.json.tmp` dans le même dossier, puis en le renommant.
- Un Send commite le tree affiché sous `refs/claude-reviews/<id>/<n>`, où `n` est le numéro du Send.
- L'Approve écrit la session approuvée, la déplace sous `archive/`, puis supprime ses refs ; une suppression ratée laisse les refs, pas la session ouverte.

```json
{
  "id": "9f2c4e1a7b3d5e60",
  "worktree": "/home/me/src/app",
  "createdAt": "2026-11-14T10:00:00.000Z",
  "approvedAt": null,
  "sends": 1,
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
- `sends` : le nombre de Send, donc le numéro de la dernière ref.
- `anchor` : jusqu'à 3 voisines dans `before` et `after`, et `hunk`, l'extrait du diff jusqu'à la fin de la plage, `null` hors du diff ; aucun SHA.
- Un message sans `date` est Pending ; un Send le date, lui donne son numéro dans `review`, et le place après les messages déjà publiés.

## Fichiers vendorisés

| Fichier                    | Source                                                    |
| -------------------------- | --------------------------------------------------------- |
| `ui/vendor/primer.css`     | `@primer/css@21.5.1/dist/primer.css`                      |
| `ui/vendor/preact-htm.js`  | `htm@3.1.1/preact/standalone.module.js` (Preact 10 inclus) |
| `ui/vendor/highlight.js`   | `@highlightjs/cdn-assets@11.12.0/es/highlight.min.js`     |

Primer 21.5.1 nomme ses variables de diff `--diffBlob-addition-bgColor-line` et non `--diffBlob-additionLine-bgColor` comme en 22.
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
- La CI (`.github/workflows/ci.yml`) lance les deux suites sur chaque PR, sous Node 25.
- Une PR ajoute au plus 1000 lignes, hors lockfile et fichiers vendorisés.
