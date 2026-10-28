#!/bin/sh
# Packs mac/build/Castpane.app into a disk image for a release:
#
#   mac/build-app.sh && mac/make-dmg.sh
#
# The image holds the app and a shortcut to Applications, so it installs by dragging one
# onto the other. It is written to mac/build/Castpane-<version>-<arch>.dmg. The app inside
# keeps its ad hoc signature: the image is not signed or notarized, so on another Mac the
# first launch needs "Open Anyway" (docs/setup.md, "Install from a release").
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app="$here/build/Castpane.app"
[ -d "$app" ] || { echo "error: $app is not built yet; run mac/build-app.sh first" >&2; exit 1; }
codesign --verify --strict --deep "$app"

version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist")
arch=$(lipo -archs "$app/Contents/MacOS/Castpane" | tr ' ' '+')
dmg="$here/build/Castpane-$version-$arch.dmg"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Castpane.app"
ln -s /Applications "$stage/Applications"

rm -f "$dmg"
hdiutil create -quiet -volname "Castpane $version" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"
hdiutil verify -quiet "$dmg"
shasum -a 256 "$dmg" | sed "s#$here/build/##"
echo "built: $dmg"
