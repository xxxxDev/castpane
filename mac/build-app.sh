#!/bin/sh
# Builds Castpane.app into mac/build/. It does not install or open it.
#
#   mac/build-app.sh
#
# The app holds the Swift menu-bar app, a copy of this Mac's Node (same architecture),
# and, when they have been built, the castpane server (../server) and the web app
# (../web/dist). Everything is signed with the hardened runtime, so no library can be
# loaded into it through DYLD_* variables. Node gets the JIT entitlements V8 needs on
# its own signature; the app itself gets none.
#
# The signature is ad hoc unless a signing identity is given. An ad hoc signature
# changes with each build, so macOS asks again for Screen Recording and Accessibility
# after every new build. Signed with the same certificate each time (a self-signed one
# is enough, see docs/development.md), the permissions stay across builds.
#
# CASTPANE_ARCH=x86_64 builds for Intel Macs on an Apple silicon Mac (or arm64 the other
#   way); it needs a Node for that architecture: mac/fetch-node.sh x86_64 prints one.
# CASTPANE_NODE_BIN=/path/to/node picks another Node binary (22.18 or later).
# CASTPANE_SIGN_IDENTITY=<name or SHA-1>   the certificate to sign with
# CASTPANE_SIGN_KEYCHAIN=<path>            the keychain that holds it (optional)
# CASTPANE_SIGN_KEYCHAIN_PASSWORD_FILE=<path>  unlocks that keychain first (optional)
# CASTPANE_SIGN_TIMESTAMP=1                adds a secure timestamp (needed for notarization)
# mac/signing.env (not in git), when present, is read for these.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
cd "$here"

# The release version (tags are v$version); macOS gets its numbers alone.
version=0.1.3-beta
short=${version%%-*}
# Where the app looks for newer releases (Updater.swift): a fork names its own.
update_repo=${CASTPANE_UPDATE_REPO:-xxxxDev/castpane}

[ -f "$here/signing.env" ] && . "$here/signing.env"
identity=${CASTPANE_SIGN_IDENTITY:--}
keychain_args=""
if [ "$identity" != "-" ] && [ -n "${CASTPANE_SIGN_KEYCHAIN:-}" ]; then
  if [ -n "${CASTPANE_SIGN_KEYCHAIN_PASSWORD_FILE:-}" ]; then
    security unlock-keychain -p "$(cat "$CASTPANE_SIGN_KEYCHAIN_PASSWORD_FILE")" "$CASTPANE_SIGN_KEYCHAIN"
  fi
  keychain_args="--keychain $CASTPANE_SIGN_KEYCHAIN"
fi
if [ "$identity" != "-" ] && [ "${CASTPANE_SIGN_TIMESTAMP:-}" = "1" ]; then keychain_args="$keychain_args --timestamp"; fi
arch=${CASTPANE_ARCH:-$(uname -m)}
case "$arch" in arm64|x86_64) ;; *) echo "error: CASTPANE_ARCH must be arm64 or x86_64" >&2; exit 1 ;; esac

echo "== swift build (release, $arch)"
swift build -c release --arch "$arch" --product Castpane
bin="$(swift build -c release --arch "$arch" --show-bin-path)/Castpane"

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
 <key>CFBundleShortVersionString</key><string>$short</string>
 <key>CastpaneVersion</key><string>$version</string>
 <key>CastpaneUpdateRepo</key><string>$update_repo</string>
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

if [ "$identity" = "-" ]; then echo "== sign (ad hoc, hardened runtime)"; else echo "== sign (with the signing identity, hardened runtime)"; fi
entitlements="$here/node.entitlements"
# A native addon in the server cannot pass library validation under an ad hoc or a
# self-signed signature (no team), so Node then also needs it off. Without addons it
# keeps it on.
addons=$(find "$app/Contents/Resources" -name '*.node' -type f 2>/dev/null || true)
if [ -n "$addons" ]; then
  entitlements="$here/build/node-addons.entitlements"
  cp "$here/node.entitlements" "$entitlements"
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$entitlements"
  echo "$addons" | while IFS= read -r f; do codesign --force $keychain_args --sign "$identity" "$f"; done
fi
codesign --force --options runtime $keychain_args --sign "$identity" --identifier io.github.castpane.node \
  --entitlements "$entitlements" "$app/Contents/Resources/node/bin/node"
codesign --force --options runtime $keychain_args --sign "$identity" --identifier io.github.castpane "$app"
codesign --verify --strict --deep "$app"
echo "built: $app"
echo "Not installed or opened. To try it: open \"$app\" (macOS will ask for Screen Recording and Accessibility)."
