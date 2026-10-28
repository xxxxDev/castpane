#!/bin/sh
# Downloads the official Node.js build for macOS on one architecture, checks it against
# the SHASUMS256.txt nodejs.org publishes with it and the binary's own signature (the Node.js
# Foundation's Developer ID, team HX7739G8FX), and prints the path of its node binary,
# for build-app.sh to bundle (CASTPANE_NODE_BIN):
#
#   CASTPANE_ARCH=x86_64 CASTPANE_NODE_BIN=$(mac/fetch-node.sh x86_64) mac/build-app.sh
#
# The version is this Mac's Node unless a second argument names one (22.18 or later).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
arch=${1:?usage: fetch-node.sh arm64|x86_64 [version]}
case "$arch" in arm64) na=arm64 ;; x86_64) na=x64 ;; *) echo "error: arm64 or x86_64" >&2; exit 1 ;; esac
version=${2:-$(node -p process.versions.node)}
dir="$here/build/node/v$version-$na"
name="node-v$version-darwin-$na"
if [ ! -x "$dir/$name/bin/node" ]; then
  mkdir -p "$dir"
  base="https://nodejs.org/dist/v$version"
  curl -fsSL "$base/SHASUMS256.txt" -o "$dir/SHASUMS256.txt"
  curl -fsSL "$base/$name.tar.gz" -o "$dir/$name.tar.gz"
  want=$(awk -v f="$name.tar.gz" '$2 == f { print $1 }' "$dir/SHASUMS256.txt")
  got=$(shasum -a 256 "$dir/$name.tar.gz" | awk '{print $1}')
  [ -n "$want" ] && [ "$want" = "$got" ] || { echo "error: $name.tar.gz does not match SHASUMS256.txt" >&2; rm -f "$dir/$name.tar.gz"; exit 1; }
  tar -xzf "$dir/$name.tar.gz" -C "$dir"
  rm -f "$dir/$name.tar.gz"
fi
# The binary itself, fresh or kept from before: signed by the Node.js Foundation.
node="$dir/$name/bin/node"
codesign --verify --strict "$node" 2>/dev/null &&
  codesign -dv "$node" 2>&1 | grep -qx "TeamIdentifier=HX7739G8FX" ||
  { echo "error: $node is not signed by the Node.js Foundation (HX7739G8FX)" >&2; exit 1; }
echo "$node"
