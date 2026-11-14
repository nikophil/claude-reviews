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
- `ui/` : page servie telle quelle, en Preact + htm sans build ni JSX.
- `ui/vendor/` : bibliothèques front copiées telles quelles, à ne pas modifier ni relire.
- `e2e/` : tests Playwright.
- Aucune dépendance npm au runtime : ce qui manque s'écrit, ou se vendorise en un fichier dans `ui/vendor/`.

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
