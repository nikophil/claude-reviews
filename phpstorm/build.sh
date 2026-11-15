#!/bin/sh
# Builds var/phpstorm/local-reviews.zip with the javac and the jars of an installed PhpStorm: nothing to download.
set -eu
IDE=${PHPSTORM_HOME:-$HOME/.local/share/JetBrains/Toolbox/apps/phpstorm}
OUT=var/phpstorm
rm -rf "$OUT"
mkdir -p "$OUT/classes/META-INF" "$OUT/local-reviews/lib"
"$IDE/jbr/bin/javac" -Xlint:all -Werror --release 21 -d "$OUT/classes" \
    -cp "$IDE/lib/*" \
    phpstorm/src/localreviews/*.java
"$IDE/jbr/bin/java" -cp "$OUT/classes:$IDE/lib/*" localreviews.PlacementCheck
rm "$OUT/classes/localreviews/PlacementCheck.class"
# A version per build, so that PhpStorm offers the new zip as an update of the plugin.
VERSION=0.1.$(date +%s)
sed "s|<version>.*</version>|<version>$VERSION</version>|" phpstorm/plugin.xml > "$OUT/classes/META-INF/plugin.xml"
# The jbr has no jar tool, and a jar is a zip.
(cd "$OUT/classes" && zip -qr ../local-reviews/lib/local-reviews.jar .)
(cd "$OUT" && zip -qr local-reviews.zip local-reviews)
# The custom plugin repository to add in Settings › Plugins › ⚙ › Manage Plugin Repositories.
cat > "$OUT/updatePlugins.xml" <<XML
<plugins>
  <plugin id="local-reviews" url="file://$PWD/$OUT/local-reviews.zip" version="$VERSION">
    <idea-version since-build="262"/>
  </plugin>
</plugins>
XML
echo "$OUT/local-reviews.zip $VERSION"
echo "file://$PWD/$OUT/updatePlugins.xml"
