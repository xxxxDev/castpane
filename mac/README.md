# Castpane.app

The Mac side of castpane: a menu-bar app that runs the castpane server, captures the
screen or one window, posts a viewer's clicks and keys, and manages the tunnel. The
contract with the server is in [docs/protocol.md](../docs/protocol.md).

## Layout

| Path | What |
|---|---|
| `Sources/CastpaneCore` | Pure logic: config.json and token files, addresses, backoff, cloudflared output and releases, the tunnel state machine, the local API's answers |
| `Sources/CastpaneHost` | The capture and input core (ScreenCaptureKit, VideoToolbox H.264 or HEVC, CGEvent), listening on `host.sock` |
| `Sources/Castpane` | The SwiftUI app: menu, setup assistant, settings, server and cloudflared supervision, permissions, launch at login, keep awake, QR code; `Glass.swift` holds the look (Liquid Glass, the palette) |
| `Resources/` | The app icon (`AppIcon.icns`) and the menu bar's template image, rendered from `AppIcon.svg` and `MenuIcon.svg` by `tools/icons.mjs` |
| `build-app.sh` | Builds and signs `build/Castpane.app` |
| `make-dmg.sh` | Packs it into `build/Castpane-<version>-<arch>.dmg` for a release |
| `node.entitlements` | The JIT entitlements the bundled Node is signed with |

## Build

The Command Line Tools are enough; Xcode is not needed.

```sh
mac/build-app.sh     # build/Castpane.app, with this Mac's Node, ../server and ../web/dist
open mac/build/Castpane.app
```

`build-app.sh` builds for this Mac's architecture and copies the Node that `node` runs
(or `CASTPANE_NODE_BIN`). The server and the web app are copied when they have been
built; `server/` must hold its own `node_modules`. Everything is signed ad hoc with the
hardened runtime, so macOS asks again for Screen Recording and Accessibility after each
new build.

## Notes

- macOS 26 and later draw an app with Liquid Glass only when its binary records a recent
  SDK. SwiftPM with the Command Line Tools records the deployment target (14.0) instead, so
  `build-app.sh` rewrites it with `vtool`. On macOS 14 and 15 the same views fall back to
  materials and bordered buttons.
- A debug build draws every window to PNG files without starting anything
  (`CASTPANE_SNAPSHOT=folder`, see [docs/development.md](../docs/development.md)). The
  pictures show the layout but not the glass, which the window server adds.
- In recent SDKs `@State` is a macro whose plugin ships only with Xcode; the views use
  `ViewState`, an alias of the same property wrapper.
- cloudflared runs with its `HOME` set to `cloudflared/` in the app's folder, so its
  sign-in certificate and the tunnel's credentials stay there and do not touch
  `~/.cloudflared`. A downloaded cloudflared must match the SHA-256 sums GitHub and
  Cloudflare publish and be signed by Cloudflare. One already on PATH (or in
  `/opt/homebrew/bin`, `/usr/local/bin`) is used only if it passes the same signature
  requirement (Cloudflare's team ID); otherwise it is ignored and the download is used.
  One found there is copied to `cloudflared/bin` (0700), the copy is checked again, and only
  the copy is run, so a `brew upgrade` that removes the original does not break a restart;
  at the next launch a changed one on PATH is copied again. Before each start the app checks
  its binary is still there and finds or copies it again.
- Node and cloudflared are started with `posix_spawn`: only stdin, stdout and stderr are
  inherited, and macOS is told each child is responsible for itself
  (`responsibility_spawnattrs_setdisclaim`, looked up at run time), so it does not run
  under Castpane's Screen Recording and Accessibility grants. Each running child has a
  pid file in `children/`; at launch the app ends a child a crash left behind, but only
  if it is still exactly the recorded process, orphaned, this user's, and one of the
  app's own executables. Stopping a child never blocks the main thread; quitting waits
  for both to exit.
- The package builds in Swift 6 language mode. A viewer's session is an actor: its
  state and every use of the input poster are isolated to it, and the per-frame path
  uses only the locked video gate, capture and link.
- Launch at login uses `SMAppService.mainApp`, which works only when running from
  Castpane.app. With an ad hoc signature, Login Items may list it as from an
  unidentified developer.
- Pausing sharing closes `host.sock`; the server then treats Castpane as not running.
