# Security

Castpane hands control of your Mac, as your macOS user, to whoever opens Remote. This page says
what protects that, where the secrets are, and what Castpane cannot stop.

## Who can do what

- **Signed out:** the sign-in page only. Every API request needs a session, except signing in.
- **A member:** their own settings, devices, passkeys and two-step sign-in. No Remote, no
  account management.
- **An admin:** everything, and Remote. Opening Remote asks again: the admin's own passkey, or
  their password and, with two-step on, a code. That gives a pass for 8 hours, for that admin
  and that sign-in only, kept in the server's memory (a restart ends every pass).

## What Castpane guarantees

**The server**

- Listens on `127.0.0.1` only, in every mode. A tunnel or `tailscale serve` on the Mac brings
  the public address to it. A public address must be HTTPS; the server refuses to start on a
  plain-HTTP one.
- Answers only requests whose `Host` is the configured public address or the loopback address
  of its own port. Anything else, a LAN address included, gets 403.
- Refuses every request that changes something unless its `Origin` is the public address or
  this Mac's loopback on Castpane's port, and unless it carries the CSRF token (a
  double-submitted cookie). A missing `Origin` is refused, never waved through. Bodies must be
  JSON and are limited to 100 KB. The same two origins, and no others, get CORS answers and may
  open the `/live` and `/remote` sockets. The development ports (47901 for a throwaway test
  instance, 47902 for the Vite dev server) count only when the server runs with
  `CASTPANE_DEV=1` and `NODE_ENV` other than `production`; Castpane.app always starts it with
  `NODE_ENV=production` and a clean environment, so never there.
- Sends a Content-Security-Policy that allows scripts from its own origin only (plus the exact
  hashes of its own inline scripts), forbids framing, and sends HSTS on the public HTTPS
  address. Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS.
- Stores passwords as bcrypt hashes and sessions as hashes of their tokens. Two-step secrets
  are sealed with a key derived from the server's secret. Push subscriptions are encrypted.
  Sessions slide on use and end after 15 idle days.

**Sign-in defence**

- Wrong passwords lock an address out, for longer each time it happens again. Twenty failures
  on one account name in an hour protect that name from every address except those it signed
  in from before. Ten wrong codes in a day stop taking authenticator codes for the account
  (recovery codes still work). Every sign-in step has its own rate limit.
- Admins see what was tried, from where, and which addresses are blocked, and can block or
  unblock an address (but not their own).
- Passkeys are bound to the public HTTPS address. A key cannot be used from another origin, and
  the server checks the signature counter. Adding one always takes the password again (and the
  two-step code when that is on), however recently the session signed in, and only a page on
  the public HTTPS address may add one: this Mac's own loopback page is refused
  (`PASSKEY_ORIGIN`). QR sign-in needs a phone already bound as a login
  key and a matching number chosen on it.

**Remote**

- The `/remote` WebSocket needs a live session, the admin role and a valid pass for that
  session. The server checks all three again every 5 seconds and cuts the stream when one
  fails: an admin made a member, signed out or disabled loses the picture within seconds.
- One viewer at a time. A new page takes over from the last one; the Mac's menu shows who is
  watching and can end it (**Stop sharing now**: the viewer is cut off, their passes end and the
  sign-in they watched from is signed out, so that page cannot simply open the stream again),
  and **Pause sharing** does the same and closes the capture core's socket altogether. The app
  asks the server first and lets the capture core go after (waiting 2 seconds at most), and the
  server remembers the last viewer, so their pass and sign-in end even when the capture core's
  close reaches it first.
- The page may send only the known requests (`list`, `start`, `move`, `button`, `key`, `text`,
  and so on; see [protocol.md](protocol.md)). Anything else, any binary frame, or more than 600
  messages a second closes the session. Each request's fields are checked (types, finite
  numbers, ranges: coordinates 0 to 1, button 0 to 2, frame rate, width, bitrate, a
  `KeyboardEvent.code`-shaped key, known modifiers, text length) and the request is passed on
  rebuilt from those fields alone; one that fails a check is dropped. The server never runs
  anything a page asks for.
- When the page falls behind, video is dropped up to the next key frame, so input does not
  queue behind a backlog. Input stops if the capture core stops reading.
- Every pass, every session opened and ended (with its length) is in the audit log. Every admin
  gets a push notification when a session opens, naming who and from where.
- The server never starts the capture core or any other program. It connects to `host.sock` in
  Castpane's folder and proves itself with `host.token`; if the socket is not there, it says
  Castpane is not running.

**The app's channel**

`/api/local/*` (status, making the first admin, activity, ending the viewer) answers only a
request from `127.0.0.1` or `::1`, addressed to the loopback host, with no `Origin`, cookie or
forwarding header (Cloudflare's, `X-Forwarded-For`, `Forwarded`, Tailscale's), and with
`Authorization: Bearer <local.token>`. Anything else gets 404 or 401. Making an admin works only
while there is no account at all.

## Secrets and files

Everything lives in `~/Library/Application Support/Castpane/` (mode `0700`).

| Path                     | Mode        | Holds                                                                                                                                           | Written by                                               |
| ------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `host.token`             | 0600        | The token the server sends to the capture core                                                                                                  | The app, at each start                                   |
| `local.token`            | 0600        | The token the app sends to `/api/local/*`                                                                                                       | The app, at each start (the server makes one if missing) |
| `host.sock`              | 0600        | The capture core's socket                                                                                                                       | The app                                                  |
| `data/secrets.json`      | 0600        | The key that signs sessions and seals two-step secrets                                                                                          | The server, once                                         |
| `data/push-keys.json`    | 0600        | The Web Push (VAPID) private key and the keys that encrypt stored subscriptions                                                                 | The server, once                                         |
| `data/db/*.db`           | 0600        | Accounts (bcrypt hashes), sessions (token hashes), passkeys (public keys), sealed two-step secrets, devices, push subscriptions and preferences | The server                                               |
| `data/audit/`            | 0700 / 0600 | The API audit log (a week per file, a year kept)                                                                                                | The server                                               |
| `data/security-log.json` | 0600        | Sign-in attempts, blocks                                                                                                                        | The server                                               |
| `cloudflared/`           | 0700        | Your Cloudflare certificate and the tunnel's credentials (own-domain mode)                                                                      | The app, cloudflared                                     |
| `logs/`                  | 0700        | `server.log`, `cloudflared.log`                                                                                                                 | The app                                                  |
| `children/`              | 0700 / 0600 | Pid files of the Node and cloudflared runs, so a run left behind by a crash is ended at the next start                                          | The app                                                  |

Losing `data/secrets.json` while the accounts remain would make every two-step secret
unreadable, so the server refuses to start in that state instead of making a new one.

## What Castpane cannot stop

- **Other programs running as you.** Any process under your macOS account that is not
  sandboxed can read `host.token` and connect to `host.sock`, which lets it watch your screen
  and post clicks and keys through the capture core, which holds your Screen Recording and
  Accessibility permissions. It can also read `local.token` and Castpane's databases. The
  token files keep out other users and sandboxed apps, not code you already run. Only run
  software you trust, and keep untrusted tools in a sandbox that denies access to this folder.
  The same boundary holds Castpane's own parts: the bundled Node that runs the server,
  cloudflared, and the server's and web app's JavaScript in the app bundle's `Resources` all run
  as you or can be changed by you, and anything that can change them can do what Castpane does.

  Castpane.app starts Node and cloudflared with `posix_spawn` and
  `responsibility_spawnattrs_setdisclaim`, so macOS holds each one responsible for itself:
  they do not inherit Castpane's Screen Recording or Accessibility grants, and any privacy
  prompt names them. On a system without that call they stay attributed to Castpane, and the
  log says so. Only stdin, stdout and stderr are passed on. A cloudflared found on `PATH`,
  `/opt/homebrew/bin` or `/usr/local/bin` is used only if the file it points to passes the same
  Cloudflare team signature requirement as a download; otherwise the verified download is used.
  Either way, what runs is Castpane's own copy in `cloudflared/bin` (a 0700 folder): one found
  elsewhere is copied there and the copy is checked again, so an upgrade or removal of the
  original cannot change what runs or stop the next restart.

- **The connection's operator.** In the quick-tunnel and own-domain modes, Cloudflare
  terminates TLS: your password, session and the picture are decrypted at Cloudflare's edge.
  With Tailscale, TLS ends on your Mac.
- **A signed-in device you lose.** Its session works until it is signed out. Sign it out from
  **Settings › Devices** on another device. Remote still needs the admin's passkey or password
  again.
- **Everyone behind one address.** Behind `tailscale serve`, every request reaches the server
  from `127.0.0.1`, so the sign-in defence sees one address. An address block then shuts out
  your own devices too, until it runs out or you sign in on the Mac at `127.0.0.1` and lift it.
  `tailscale serve` does pass the address on: it sets `X-Forwarded-For` to the tailnet device's
  address (replacing whatever the client sent) and, for a signed-in tailnet user,
  `Tailscale-User-Login` and `Tailscale-User-Name` (removing any copies the client sent).
  Castpane does not use them yet: they are only as trustworthy as the loopback connection they
  arrive on (next item).
- **Who may claim an address.** The server takes Cloudflare's `CF-Connecting-IP` as the
  client's address only from a loopback peer, and only when the connection is a Cloudflare one
  (`quick` or `domain` in the app's `config.json`, or `CASTPANE_CONNECTION`). Under Tailscale, before a
  connection is chosen, or when the mode is unknown, it is ignored, since there the client
  itself could set it. It is also ignored when the request carries `Tailscale-User-*` headers,
  or an `X-Forwarded-For` whose last entry is not that address (Cloudflare appends the address
  it was reached from; another proxy, such as a `tailscale serve` left from the Tailscale
  mode, appends its own peer after it). In the Cloudflare modes, a program on this Mac (any
  user's) that connects to `127.0.0.1` directly can still set it, and so choose the address its
  own attempts are counted, blocked and logged under.
- **Ad hoc signing.** v0.1 is not signed with a Developer ID or notarized. macOS cannot tell you
  who built it, and asks for the permissions again after each rebuild.
- **The browser and the phone.** Castpane trusts the browser to keep its cookies and passkeys.
  A compromised phone or browser is a compromised session.

## Reporting a problem

Please report security problems privately to the maintainers rather than in a public issue,
with steps to reproduce.
