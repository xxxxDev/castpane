# Protocol

Three links make Castpane work:

```
browser ──HTTPS / WebSocket /remote──▶ server (Node, 127.0.0.1:47900) ──host.sock──▶ capture core (in Castpane.app)
                                          ▲
                Castpane.app ──/api/local/* + local.token──┘
```

The server relays between the page and the capture core. It reads the JSON the page sends,
checks its type against an allow-list and its fields against that type's (below), and passes on
a message rebuilt from the checked fields alone. Video comes back untouched.

## Process contract

Castpane.app starts the server with its bundled Node on `Contents/Resources/server/start.js`
and this environment:

| Variable                     | Meaning                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CASTPANE_HOME`              | `~/Library/Application Support/Castpane`. The server keeps its data in `data/` there.                                                                                                                                                                                                                                                          |
| `CASTPANE_PORT`              | The loopback port, `47900` by default.                                                                                                                                                                                                                                                                                                         |
| `CASTPANE_PUBLIC_ORIGIN`     | The address people open: `https://…` (tunnel, own domain, Tailscale), or empty for this Mac only. The server refuses to start on anything else, plain `http://` included.                                                                                                                                                                                         |
| `CASTPANE_WEB_DIST`          | The built PWA (`Contents/Resources/web`).                                                                                                                                                                                                                                                                                                      |
| `NODE_ENV`                   | `production`.                                                                                                                                                                                                                                                                                                                                  |
| `CASTPANE_EXIT_ON_STDIN_EOF` | `1`: stop when stdin closes (below). Without it the server ignores stdin.                                                                                                                                                                                                                                                                      |
| `CASTPANE_CONNECTION`        | Optional: `none`, `quick`, `domain` or `tailscale`. When it is not set the server reads `connection` from `config.json` in `CASTPANE_HOME`, again whenever that file changes. Only `quick` and `domain` (a Cloudflare tunnel) make the server take `CF-Connecting-IP` as the client's address; a missing or unreadable mode trusts no header. |

`CASTPANE_DEV=1` (with `NODE_ENV` other than `production`) also trusts the development ports
47901 and 47902 as origins; the app never sets it.

The server listens on `127.0.0.1` only. It writes one line when it is listening,
`Castpane <version>: http://127.0.0.1:<port>`, and exits on `SIGTERM` after closing the viewer
and its sockets (within 3 seconds). One server runs per folder (`data/server.lock`). The app
restarts it with backoff if it exits.

**stdin.** The app starts the server with a pipe as its stdin, keeps the write end open
without writing to it, and sets `CASTPANE_EXIT_ON_STDIN_EOF=1`. When the pipe closes (the app
quit or crashed and the system closed its end), the server writes `stdin closed (the app is
gone): stopping`, stops as on `SIGTERM` and exits 0, so it never outlives the app. Without
that setting, or when stdin is not a pipe or a socket (a terminal, `/dev/null`), the server
ignores stdin, so a tool that starts it with a pipe it has already closed does not stop it.

The app writes a fresh `host.token` and `local.token` (64 hex characters, mode `0600`) before
it starts the server. The server reads `host.token` at each remote connection and `local.token`
at each local request; it makes a `local.token` only when there is none, and never replaces one.

## The page ⇄ the server: `/remote`

1. `POST /api/remote/pass/passkey` → `{challenge, allow}` when the admin has a passkey, else
   `{challenge: null}`.
2. `POST /api/remote/pass` with `{passkey: {id, clientDataJSON, authenticatorData, signature}}`,
   or `{adminPassword, adminCode?}` → `{pass, expiresAt}`. Without either, the answer is 400
   with `code: "NEED_PASSWORD"`. Wrong password: `WRONG_PASSWORD`; wrong code: `WRONG_CODE`;
   passkey refused: `PASSKEY_REFUSED`.
3. `GET /api/remote/machines` → `{machines: [{id: "local", name, local: true, running}]}`.
   `running` is whether `host.sock` exists.
4. Open `wss://<host>/remote?pass=<pass>` with the session cookie. Refusals are plain HTTP
   answers before the upgrade: 401 (no or bad session), 403 (not an admin, bad pass, or a
   page from another origin).

On the socket, text frames are JSON in both directions, and binary frames are video from the
capture core. `POST /api/remote/pass/end` ends the admin's passes.

The server adds two messages of its own:

| Message                                                                | When                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{t:"error", where:"host", code:"NOT_RUNNING", message:"not-running"}` | No capture core on `host.sock`, or no `host.token`.                                                                                                                                                                                                                                   |
| `{t:"closed", reason}`                                                 | The session ended. `reason` is one of `replaced` (another page took over), `ended on the Mac`, `page left`, `signed out`, `pass ended`, `host closed`, `no host`, `unknown message`, `binary from page`, `too fast`, `bad message`, `host backed up`, `bad frame`, `server stopping`. |

## The server ⇄ the capture core: `host.sock`

A Unix socket in Castpane's folder. Frames are

```
[kind: 1 byte][length: 4 bytes, big-endian][payload]
```

- kind `1`: a UTF-8 JSON object, at most a few kilobytes;
- kind `2`: video, `[flags: 1][timestamp µs: 8, big-endian][H.264 Annex B]`; `flags & 1` marks a
  key frame.

The server's first message is `{t:"hello", token}` with the contents of `host.token`. Anything
else, or a wrong token, closes the connection. The capture core serves one connection at a
time. The server accepts frames up to 8 MB.

### From the page (allow-listed)

Coordinates `x`, `y` are numbers from 0 to 1, fractions of the picture. A type not in this
table closes the session (`unknown message`). A message of a listed type is passed on as `t`
plus the fields below and nothing else; one whose fields fail these checks is dropped without
closing the session.

| `t`           | Fields                                                                                                                                                                                                     | Meaning                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `status`      |                                                                                                                                                                                                            | Ask for the permissions state again.                        |
| `permissions` |                                                                                                                                                                                                            | Show macOS's permission prompts on the Mac.                 |
| `list`        |                                                                                                                                                                                                            | List what can be shown.                                     |
| `start`       | `kind` (`display`/`window`), `id` (integer, 0 to 2³²−1); optional `maxWidth` (integer, 320 to 3840), `fps` (integer, 10 to 60), `bitrate` (integer, 500 000 to 40 000 000)                                 | Show one display or window.                                 |
| `stop`        |                                                                                                                                                                                                            | Stop the picture.                                           |
| `ack`         |                                                                                                                                                                                                            | One frame was shown (the core keeps at most three unshown). |
| `key-frame`   |                                                                                                                                                                                                            | Send a key frame next.                                      |
| `move`        | `x`, `y`                                                                                                                                                                                                   | Move the pointer.                                           |
| `button`      | `b` (0 left, 1 right, 2 middle), `down` (boolean), `x`, `y`                                                                                                                                                | Press or release a button.                                  |
| `scroll`      | `dx`, `dy` (finite pixels, at most 10 000 either way), `x`, `y`                                                                                                                                            | Scroll at a point.                                          |
| `key`         | `code` (a `KeyboardEvent.code`: a capital letter, then 1 to 31 letters or digits), `down` (boolean), `mods` (optional; each of `shift`, `ctrl`, `alt`, `meta` at most once; passed on as `[]` when absent) | Press or release a key.                                     |
| `text`        | `s` (1 to 4000 UTF-16 units; the page sends longer text in pieces)                                                                                                                                         | Type text (any script, emoji included).                     |
| `probe`       | `x`, `y`, `n` (integer, 0 to 2³¹−1)                                                                                                                                                                        | Is there a text field at this point?                        |

### From the capture core

| `t`       | Fields                                                                                                          | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `status`  | `screen`, `accessibility`, `version`                                                                            | Which permissions it has. Sent after the hello.                             |
| `list`    | `items: [{kind, id, title, app, width, height, thumb, here, desk: {id, number, display, fullscreen, current}}]` | Displays and windows, by desktop.                                           |
| `started` | `kind`, `id`, `width`, `height`, `fps`                                                                          | The picture started.                                                        |
| `config`  | `codec`, `width`, `height`                                                                                      | The decoder configuration, before the first key frame.                      |
| `stopped` | `reason`                                                                                                        | The picture stopped (the window closed, …).                                 |
| `focus`   | `editable`, `caret?`, `initial?`                                                                                | After a click: whether a text field has the focus, and where its caret is.  |
| `caret`   | `caret: [x, y, w, h]`                                                                                           | The text caret moved.                                                       |
| `probe`   | `editable`, `n`                                                                                                 | The answer to a `probe`.                                                    |
| `error`   | `where`, `message`                                                                                              | Something failed (`where: "start"`, `message: "gone"` for a closed window). |

## The app ⇄ the server: `/api/local/*`

Answered only from `127.0.0.1`/`::1`, to Host `127.0.0.1:<port>` or `localhost:<port>`, with no
`Origin`, cookie or forwarding header, and with `Authorization: Bearer <local.token>`. Otherwise
404 (not local) or 401 (bad token).

| Request                                        | Answer                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/local/status`                        | `{version, users, admins, viewer: {username, since} \| null, sessions, publicOrigin \| null}`. `users` and `admins` count active accounts; `sessions` counts live sign-ins.                                                                                                         |
| `POST /api/local/setup` `{username, password}` | 201 `{user}`: the first admin. 409 `{code: "ALREADY_SET_UP"}` once any account exists. 400 for a name with `< > "` or a password under 8 characters.                                                                                                                                |
| `GET /api/local/activity?limit=50`             | `{items: [{at, kind, username, ip?, method?, reason?, seconds?}]}`, newest first, at most 200. `kind` is `remote-open`, `remote-end` or `sign-in`.                                                                                                                                  |
| `POST /api/local/end-viewer`                   | `{ended: true \| false}`: the viewer is disconnected (`closed`, reason `ended on the Mac`), every pass ends, and the sign-in the viewer used is signed out; also when their connection had already closed. The app calls it, then stops the capture core (Stop sharing now, Pause). |

## Notifications

When a viewer is let in, every active admin's devices get a Web Push notification:
"Castpane: remote session opened", "_name_ is viewing this Mac from _address_". A tap opens the
app. Turning notifications off in **Settings** on a device stops them there; the account-wide
`remote` preference (`PUT /api/push/preferences`) stops them on every device.
