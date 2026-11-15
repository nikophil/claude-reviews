#!/bin/sh
# In the container of docker-compose.yml: builds the plugin with build.sh, checks it with the Plugin Verifier, then runs the UI tests,
# all against one PhpStorm, downloaded once into the cache volume.
set -eu
VERSION=2026.2.5
IDE=/cache/ide/$VERSION
if [ ! -d "$IDE" ]; then
    mkdir -p "$IDE.part"
    curl -fsSL "https://download.jetbrains.com/webide/PhpStorm-$VERSION.tar.gz" | tar -xz -C "$IDE.part"
    mv "$IDE.part" "$IDE"
fi
# Starter writes its .vmoptions next to the PhpStorm directory.
HOME_DIR=$(find "$IDE" -mindepth 1 -maxdepth 1 -type d)
PHPSTORM_HOME=$HOME_DIR sh phpstorm/build.sh

VERIFIER=/cache/verifier-cli-1.411-all.jar
if [ ! -f "$VERIFIER" ]; then
    curl -fsSL -o "$VERIFIER.part" https://repo1.maven.org/maven2/org/jetbrains/intellij/plugins/verifier-cli/1.411/verifier-cli-1.411-all.jar
    mv "$VERIFIER.part" "$VERIFIER"
fi
rm -rf var/phpstorm/verifier
java -jar "$VERIFIER" check-plugin var/phpstorm/local-reviews.zip "$HOME_DIR" -offline -verification-reports-dir var/phpstorm/verifier > var/phpstorm/verifier.log
# The verifier answers 0 whatever its verdict: "Compatible", with usages of experimental or internal API, passes; anything else fails.
VERDICT=$(cat var/phpstorm/verifier/*/plugins/local-reviews/*/verification-verdict.txt)
echo "Plugin Verifier: $VERDICT"
case $VERDICT in Compatible*) ;; *) exit 1 ;; esac

cd phpstorm/ui-test
gradle test --no-daemon --console=plain -Pide="$HOME_DIR" -Pplugin=/w/var/phpstorm/local-reviews.zip "$@"
