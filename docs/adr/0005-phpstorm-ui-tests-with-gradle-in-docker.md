# Tester l'interface du plugin PhpStorm par Starter et Driver, avec Gradle dans Docker

Le plugin PhpStorm se teste en CI de bout en bout : un vrai PhpStorm, sur Xvfb, avec le plugin installé, face à un serveur claude-reviews.
Les tests s'écrivent avec Starter et Driver, le framework de tests d'intégration de JetBrains, en Kotlin et sous JUnit 5, que seul Gradle sait assembler.
Gradle ne sert qu'à ces tests, dans `phpstorm/ui-test/` : `build.sh` reste le build du plugin, et les tests installent son zip.
Gradle, le JDK, Node et Xvfb vivent dans une image Docker (`docker-compose.yml`), et rien d'autre que Docker ne s'installe sur la machine ni sur le runner.
Ce choix remplace, pour les tests seulement, le refus de Gradle de l'[ADR 0004](0004-clients-et-mod-separes-par-l-api.md) : son coût, un build lourd au premier lancement, reste dans un volume Docker.

`run.sh` télécharge une fois PhpStorm, dans la version que fixe le script, dans le volume `phpstorm-cache` ;
`build.sh` compile contre ses jars, le Plugin Verifier vérifie le zip contre lui, et les tests le lancent tel quel, sans la copie qu'en ferait Starter.
Starter et Driver viennent du Maven de JetBrains, sans le plugin Gradle IntelliJ Platform, qui téléchargerait un second IDE pour compiler.
PhpStorm démarre en période d'essai dans le dossier de config neuf de chaque test : ni licence ni secret en CI.

## Considered Options

- Le plugin Gradle IntelliJ Platform pour builder aussi le plugin, la voie officielle : écarté, `build.sh` suffit, et deux builds du même plugin divergeraient.
- Remote Robot : écarté, Starter et Driver le remplacent, et lancent l'IDE et Xvfb eux-mêmes.
- IntelliJ IDEA plutôt que PhpStorm, faute de licence : inutile, la période d'essai de PhpStorm démarre sans fenêtre.
- Une clé de licence en secret (`IDETestContext.setLicense`) : à reprendre si JetBrains retire la période d'essai sans compte.
- Gradle installé sur la machine : écarté, Docker suffit, et la CI lance la même commande que le poste.
