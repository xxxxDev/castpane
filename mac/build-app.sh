#!/bin/sh
# Builds Castpane.app into mac/build/. It does not install or open it.
#
#   mac/build-app.sh
#
# The app holds the Swift menu-bar app, a copy of this Mac's Node (same architecture),
# and, when they have been built, the castpane server (../server) and the web app
# (../web/dist). Everything is signed ad hoc with the hardened runtime, so no library
# can be loaded into it through DYLD_* variables. Node gets the JIT entitlements V8
# needs on its own signature; the app itself gets none. An ad hoc signature changes
# with each build, so macOS asks again for Screen Recording and Accessibility after
# every new build.
#
# CASTPANE_NODE_BIN=/path/to/node picks another Node binary (22.18 or later).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
cd "$here"

version=0.1.0
arch=$(uname -m)

echo "== swift build (release, $arch)"
swift build -c release --product Castpane
bin="$(swift build -c release --show-bin-path)/Castpane"

app="$here/build/Castpane.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
# SwiftPM with the Command Line Tools records the deployment target as the SDK version,
# and macOS then draws the app the old way (no Liquid Glass). Record the real SDK.
sdk=$(xcrun --show-sdk-version)
vtool -set-build-version macos 14.0 "$sdk" -replace -output "$app/Contents/MacOS/Castpane" "$bin" 2>/dev/null

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>CFBundleIdentifier</key><string>io.github.castpane</string>
 <key>CFBundleName</key><string>Castpane</string>
 <key>CFBundleDisplayName</key><string>Castpane</string>
 <key>CFBundleExecutable</key><string>Castpane</string>
 <key>CFBundleIconFile</key><string>AppIcon</string>
 <key>CFBundlePackageType</key><string>APPL</string>
 <key>CFBundleShortVersionString</key><string>$version</string>
 <key>CFBundleVersion</key><string>1</string>
 <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
 <key>LSMinimumSystemVersion</key><string>14.0</string>
 <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
 <key>LSUIElement</key><true/>
 <key>NSHighResolutionCapable</key><true/>
 <key>NSHumanReadableCopyright</key><string>Open source under the MIT License.</string>
 <key>NSScreenCaptureUsageDescription</key><string>Castpane shows this Mac's screen, or one window, to you in your browser.</string>
</dict></plist>
PLIST

# The icons (drawn from mac/*.svg by tools/icons.mjs).
cp "$here/Resources/AppIcon.icns" "$here/Resources/MenuIcon.png" "$here/Resources/MenuIcon@2x.png" "$app/Contents/Resources/"

echo "== node"
node_bin=${CASTPANE_NODE_BIN:-$(node -p process.execPath)}
if ! lipo -archs "$node_bin" | tr ' ' '\n' | grep -qx "$arch"; then
  echo "error: $node_bin has no $arch code ($(lipo -archs "$node_bin"))" >&2
  exit 1
fi
node_version=$("$node_bin" -p process.versions.node)
mkdir -p "$app/Contents/Resources/node/bin"
cp "$node_bin" "$app/Contents/Resources/node/bin/node"
node_license="$(dirname "$node_bin")/../LICENSE"
[ -f "$node_license" ] && cp "$node_license" "$app/Contents/Resources/node/LICENSE"
echo "node $node_version from $node_bin"

echo "== server and web"
if [ -f "$root/server/start.js" ]; then
  rsync -a --delete --exclude '.DS_Store' --exclude '*.test.*' --exclude 'test/' --exclude 'tests/' "$root/server/" "$app/Contents/Resources/server/"
  echo "server: copied"
else
  echo "note: $root/server/start.js is not there yet; the app is built without the server"
fi
if [ -f "$root/web/dist/index.html" ]; then
  rsync -a --delete --exclude '.DS_Store' "$root/web/dist/" "$app/Contents/Resources/web/"
  echo "web: copied"
else
  echo "note: $root/web/dist is not built yet; the app is built without the web app"
fi
cp "$root/LICENSE" "$app/Contents/Resources/LICENSE" 2>/dev/null || true

echo "== sign (ad hoc, hardened runtime)"
entitlements="$here/node.entitlements"
# A native addon in the server cannot be checked against an ad hoc signature, so Node
# then also needs library validation off. Without addons it keeps it on.
addons=$(find "$app/Contents/Resources" -name '*.node' -type f 2>/dev/null || true)
if [ -n "$addons" ]; then
  entitlements="$here/build/node-addons.entitlements"
  cp "$here/node.entitlements" "$entitlements"
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$entitlements"
  echo "$addons" | while IFS= read -r f; do codesign --force --sign - "$f"; done
fi
codesign --force --options runtime --sign - --identifier io.github.castpane.node \
  --entitlements "$entitlements" "$app/Contents/Resources/node/bin/node"
codesign --force --options runtime --sign - --identifier io.github.castpane "$app"
codesign --verify --strict --deep "$app"
echo "built: $app"
echo "Not installed or opened. To try it: open \"$app\" (macOS will ask for Screen Recording and Accessibility)."
