#!/bin/sh
# Builds var/vscode/local-reviews.vsix with zip: a .vsix is a zip of the extension and two manifests, nothing to download.
set -eu
OUT=var/vscode
rm -rf "$OUT"
mkdir -p "$OUT/vsix/extension/media"
cp vscode/package.json vscode/extension.js vscode/review.js vscode/diff.js vscode/threads.js "$OUT/vsix/extension/"
cp vscode/media/*.svg "$OUT/vsix/extension/media/"
VERSION=$(node -p 'require("./vscode/package.json").version')
ENGINE=$(node -p 'require("./vscode/package.json").engines.vscode')
cat > "$OUT/vsix/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="local-reviews" Version="$VERSION" Publisher="nikophil"/>
    <DisplayName>Local Reviews</DisplayName>
    <Description xml:space="preserve">Reviews with Claude the changes of the worktree.</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$ENGINE"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
XML
cat > "$OUT/vsix/[Content_Types].xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
XML
(cd "$OUT/vsix" && zip -qr ../local-reviews.vsix .)
echo "$OUT/local-reviews.vsix"
