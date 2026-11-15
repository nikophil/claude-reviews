# Les clients et le mod ne se parlent que par l'API HTTP du serveur

Le serveur est le seul cœur : sessions, diff, ré-ancrage, Send et Approve.
Le côté Claude, c'est le mod (`hooks/`) : il démarre le serveur, sonde la session et réveille Claude.
Le côté client, c'est la page (`ui/`) dans un navigateur, et le plugin PhpStorm (`phpstorm/`), plus tard VS Code.
Un client ne parle qu'à l'API HTTP, n'importe rien de `server/` ni de `hooks/`, et ne démarre pas le serveur :
sans Claude session, il dit que le serveur ne répond pas, et un Reload le recharge.
Ainsi, un nouvel IDE ne touche ni au serveur ni au mod.

Le plugin PhpStorm est un client natif, en Swing, pas la page embarquée :
une tool window (base, Send, Approve, fichiers changés et leurs threads), les threads dans l'éditeur et dans le diff de l'IDE.
Il a d'abord embarqué la page par JCEF, avec un contrat pour ouvrir un fichier dans l'éditeur ;
mais la page, faite pour un navigateur, déborde d'une tool window étroite, et ses threads restent loin du code où l'on navigue :
on veut lire et écrire les threads sous les lignes, en gardant Ctrl+clic et le reste de l'IDE.
Pour son diff, il lit le texte d'un fichier à la base par `GET /api/sessions/<id>/file`, plutôt que par git : un client ne parle qu'à l'API.

Le plugin PhpStorm s'écrit en Java et se compile par le `javac` du PhpStorm installé, contre ses jars (`phpstorm/build.sh`) :
ni Gradle ni Kotlin, ni l'IntelliJ Platform d'environ 1 Go à télécharger, comme le reste du dépôt, sans build ni dépendance.

```
            côté Claude                    cœur                     clients
Claude session ── mod (hooks/) ──HTTP──> serveur (server/) <──HTTP── page (ui/) ── navigateur
                                                               <──HTTP── phpstorm/ (Swing), plus tard vscode/
```

## Considered Options

- Kotlin et l'IntelliJ Platform Gradle Plugin, la voie officielle : `runIde` et le plugin verifier, au prix d'un JDK à installer et d'un build d'environ 1 Go au premier lancement ;
  Gradle revient pour les seuls tests d'interface, dans Docker ([ADR 0005](0005-tests-d-interface-phpstorm-par-gradle-dans-docker.md)).
- La page embarquée par JCEF dans une tool window : essayée, puis remplacée, pour les raisons plus haut.
- Un client qui démarre le serveur : il lui faudrait trouver le dossier du plugin Claude sous `~/.claude/plugins/`, et sans Claude session, aucun thread n'avance.
- Une abstraction « agent » à la place de Claude dans le serveur : aucun autre agent n'est prévu.
