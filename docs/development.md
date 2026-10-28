# Development

## Layout

| Path                                                         | What                                                                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/`                                                    | The web service (Node ≥ 22.18, CommonJS, Express). Its own `package.json` and lockfile, so Castpane.app can bundle it with only its runtime packages. |
| `server/start.js`                                            | The entry point Castpane.app runs. Sets up `$CASTPANE_HOME/data`, then starts the service.                                                            |
| `server/app.js`                                              | The Express app: Host, Origin and CSRF guards, the API, the PWA.                                                                                      |
| `server/remote.js`                                           | The `/remote` relay to the capture core, and the remote pass.                                                                                         |
| `server/localApi.js`                                         | `/api/local/*`, the app's channel.                                                                                                                    |
| `server/siteConfig.js`                                       | The `CASTPANE_*` settings and every Host and Origin rule, in one place.                                                                               |
| `server/controllers`, `routes`, `services`, `middlewares`    | Sign-in, passkeys, two-step, QR sign-in, users and their lifecycle, devices and sessions, push, the sign-in defence, the audit log.                   |
| `web/`                                                       | The PWA: Vue 3 and Framework7, built by Vite into `web/dist`.                                                                                         |
| `web/src/pages/RemotePage.vue`, `web/src/js/remoteStream.js` | The Remote page: WebCodecs decoding, touch modes, keyboard, zoom.                                                                                     |
| `mac/`                                                       | Castpane.app (see [mac/README.md](../mac/README.md)).                                                                                                 |
| `tools/`                                                     | The screenshot and diagram scripts, the icon renderer.                                                                                                |

`server/` and `web/` grew from an MIT-licensed shared PWA base. Everything that base had for
AI agents (chats, groups, schedules, terminals, attachments, checklists, the peer link,
command agents, usage meters) is left out; `server/productAccountHooks.js` and
`server/pushEvents.js` are where a product plugs into the account and push code.

## Setup

```sh
npm run setup      # npm ci at the root (web, tools) and in server/
```

`.npmrc` holds `min-release-age=14` and `save-exact=true`: new dependency versions are taken
only once they are two weeks old, and pinned.

## Running from source

The server needs a folder of its own. Keep it out of `~/Library/Application Support/Castpane`
while developing:

```sh
npm run build
CASTPANE_HOME=$PWD/.castpane CASTPANE_PORT=47910 npm run server
```

`.castpane/` is ignored by git. The server prints its address and makes `.castpane/local.token`.
Make the first admin through the local API:

```sh
curl -s -X POST http://127.0.0.1:47910/api/local/setup \
  -H "Authorization: Bearer $(cat .castpane/local.token)" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"choose a long one"}'
```

then open `http://127.0.0.1:47910`. Remote needs a capture core on `.castpane/host.sock`: run
Castpane.app with `CASTPANE_HOME` pointing there, or a fake one that speaks the protocol in
[protocol.md](protocol.md).

For the web app with hot reload, run the server on its default port (47900) with the
development ports turned on, and `npm run dev`:

```sh
NODE_ENV=development CASTPANE_DEV=1 CASTPANE_HOME=$PWD/.castpane npm run server
npm run dev
```

Vite serves the page on `127.0.0.1:47902` and passes `/api`, `/live` and `/remote` on to the
server. Without both settings the server trusts no page on 47901 or 47902 (docs/security.md);
the app never sets them. Passkeys cannot be added there: only the public HTTPS address may add
one.

`CASTPANE_PUBLIC_ORIGIN` sets the public address; leave it empty for this Mac only.

## Checking a change

```sh
npm run lint           # oxlint
```

The project's test suites are maintained separately and are not part of this repository. In a
pull request, describe how you checked the change: what you ran, on which Mac and macOS, and
what you saw. Never capture a screen or post input you have not meant to, and keep checks away
from a Castpane you use.

## Screenshots, the diagram and the icons

```sh
npm run shots          # docs/assets/shot-phone-*.png and shot-desktop-*.png, from fixtures
npm run diagram        # docs/assets/architecture-{dark,light}.png
node tools/icons.mjs   # web/public/castpane-*.png and mac/Resources (app and menu bar icons), from the SVGs
```

The web app's screenshots are fixtures only: the "Mac screen" in them is drawn by
`tools/shots.mjs`. The Mac app's (`docs/assets/shot-mac-*.png`) are the setup assistant's
first step and Connection step and Settings › Activity, taken from a debug build's snapshots
(see Packaging), which use a made-up address and sample entries: copy `{dark,light}-wizard-0.png`,
`{dark,light}-wizard-3.png` and `{dark,light}-settings-activity.png` to
`shot-mac-role-*.png`, `shot-mac-setup-*.png` and `shot-mac-activity-*.png`.

## Builds for checking

`npm run build` writes `web/dist`, which a running server serves. To check that a change builds
without touching it, build into a scratch folder:

```sh
npx vite build --config web/vite.config.js --outDir /tmp/castpane-check
```

The build id (`web/buildId.js`) is `git describe` of the last commit that touched `web/` or
what it reads; the running app compares it with `/version.json` to offer an update.

## Packaging

`mac/build-app.sh` copies `server/` (with its `node_modules`, without tests) to
`Contents/Resources/server` and `web/dist` to `Contents/Resources/web`. Run `npm run setup`
and `npm run build` first.

The app's windows can be checked without opening the real app. A debug build draws the setup
assistant and Settings to PNG files and quits, without starting the server, the capture core
or a tunnel (the pictures show the layout, not the glass, which the window server adds):

```sh
cd mac && swift build && CASTPANE_SNAPSHOT=/tmp/castpane-shots "$(swift build --show-bin-path)/Castpane"
```

## Signing

`mac/build-app.sh` signs ad hoc unless it is given a certificate. With an ad hoc signature
macOS asks again for Screen Recording and Accessibility after every build, because each
build is a different app to it. Signed with the same certificate every time, the app keeps
one identity (`identifier "io.github.castpane" and certificate root = …`) and the
permissions stay. A self-signed code-signing certificate is enough for that; it does not
remove **Open Anyway** for a downloaded app, which needs a Developer ID and notarization.

To use one, put it in a keychain of its own and tell the script where it is, in
`mac/signing.env` (not in git) or the environment:

```sh
CASTPANE_SIGN_IDENTITY=<the certificate's SHA-1 or name>
CASTPANE_SIGN_KEYCHAIN=<path to the keychain>
CASTPANE_SIGN_KEYCHAIN_PASSWORD_FILE=<a file holding its password>
```

For a Developer ID build that will be notarized, also set `CASTPANE_SIGN_TIMESTAMP=1`:
notarization needs a secure timestamp on every signature. The app has no provisioning
profile, iCloud or APNs (notifications are Web Push), and no native addons.

Keep a backup of the certificate and its key: a release signed with another one is a new
app again, and every user grants the permissions once more.

## Releasing

1. Set the version in `package.json`, `server/package.json` and `mac/build-app.sh`
   (`version=`, such as `0.1.3` or `0.1.3-beta`; the tag is `v` and the same).
2. Build and pack both kinds of Mac from a clean checkout, signed with the release certificate
   (see Signing; the app updates itself only to a version signed with the same one):

   ```sh
   npm run setup && npm run lint && BUILD_ID=v<version> npm run build
   mac/build-app.sh && mac/make-dmg.sh
   CASTPANE_ARCH=x86_64 CASTPANE_NODE_BIN=$(mac/fetch-node.sh x86_64) mac/build-app.sh && mac/make-dmg.sh
   ```

   `BUILD_ID` names the web app after the release. Without it the web app is named by
   `git describe` of its last change, which comes before the release's own tag, so phones
   would show an older version's name.
3. Install from an image on a Mac and go through the setup assistant once.
4. Tag the commit and make a GitHub release from the tag (a pre-release for a beta) with both
   images and the SHA-256 that `make-dmg.sh` prints. Running copies find it within a day: the
   app reads `CastpaneUpdateRepo` from its Info.plist (`CASTPANE_UPDATE_REPO` when building)
   and takes the image named `Castpane-*-<arch>.dmg`.
5. Update the cask in the Homebrew tap (version and both SHA-256s).

The images are not notarized: a downloaded copy's first launch needs **Open Anyway**; the
Homebrew cask and the app's own updates do not.

## Conventions

- Comments say why, in plain English. The Remote page's comments record what was found on a
  real iPhone; keep them when you change the code they explain.
- One place for each rule: Host and Origin in `server/siteConfig.js`, product names and
  storage keys in `server/siteConfig.js` (`PRODUCT`), `web/src/js/productConfig.js` and
  `web/public/push-config.js`.
- The page's words are written in Traditional Chinese where they are used (`ct('…')`) with
  their English in `web/src/js/text.js`, or as keys in `web/src/js/i18n.js`.
