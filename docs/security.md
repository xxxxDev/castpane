# Security

Castpane hands control of your Mac, as your macOS user, to whoever opens Remote. This page says
what protects that, where the secrets are, and what Castpane cannot stop.

## Who can do what

- **Signed out:** the sign-in page only. Every API request needs a session, except signing in.
- **The Castpane account:** there is one. The setup assistant makes it on the Mac, over the
  app's channel (below), and nothing makes another: the server has no route that creates an
  account, changes a role or enables one. Signed in, it has everything, and Remote. Opening
  Remote asks again: a passkey of the account's that may stand for the password and code
  (below), or the password and, with two-step on, a code. That gives a pass for 8 hours, for
  that sign-in only, kept in the server's memory (a restart ends every pass).
- **Accounts left from an earlier version,** which allowed several: a member account is deleted
  by the server when it starts, and the Activity tab says so; only while an admin account is
  active, so a database cut short or edited by hand is left alone (and logged). A delete stopped
  part-way is finished at the next start. With more than one admin
  account, the server cannot tell which is yours: the Mac app asks which one to keep (whoever uses this Mac, in person or through Remote)
  (the setup assistant's is chosen first when the audit log still says which it was), and
  deletes every other over the app's channel. Until then they sign in and can open Remote. A keep stopped part-way finishes the accounts it
  had started on at the next start; for the rest the Mac app asks again.
  Nothing on the web lists or deletes accounts. A deleted account stays as a record that signs
  nothing in and keeps its name taken.
  The account may trust a device (**Settings › This device › Trust this device**, which asks again
  once): from it, a pass is given with no password or passkey for 30, 60, 90 or 180 days (set
  in **Settings › Trusted devices**, and a shorter setting counts at once) from its last use. The device keeps an HttpOnly, SameSite=Strict
  cookie for `/api`, its id and a 256-bit secret; the server keeps only the secret's SHA-256.
  Signing out on that device, a new password, the account deleted, turning
  it off or removing it under **Settings › Trusted devices** ends it at once; turning it off or removing it also ends
  the passes that account already has, and a picture open with one. Signing a device out from
  another one does not end its trust: remove it under **Settings › Trusted devices** as well. Each pass given this way is in the
  audit log. Whoever holds that signed-in, trusted device can open Remote: trust only a device
  you keep with you.
- **Unlocking from Remote:** a Mac at its lock screen asks the viewer for its login password,
  which the capture core types into the lock screen, as the viewer could on the whole screen.
  The password goes from the page to the Mac once; it is not kept, logged or shown, and only the
  try is in the audit log and the Mac's Activity. One try at a time and one every 3 seconds at
  most on each Mac, and macOS's own delays after wrong ones still apply. Each key is typed only
  while the Mac is still locked, so a Mac unlocked meanwhile at its keyboard never gets the
  password in the app in front. A Mac unlocked from Remote, or whose lock screen a viewer used,
  is locked again when that viewer leaves (a page that stops answering is dropped within about
  30 seconds; a Mac joined to another waits up to about a minute when that other Mac itself
  goes silent) and when Castpane quits; one a person unlocked at the Mac itself is left alone.
  If Castpane crashes, the Mac stays as it was.

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
- Changes are limited per address too. That table keeps at most 5,000 addresses at a time,
  the oldest let go first, so filling it does not lock new visitors out; past 16 IPv6 /64s
  under one /48, the rest of that /48 shares one bucket. Someone with more than 5,000
  addresses can get past the per-address limit; the per-account sign-in lockout still holds.
- **Settings › Sign-in defence** shows what was tried, from where, and which addresses are
  blocked, and can block or unblock an address (but not your own).
- Passkeys are bound to the public HTTPS address. A key cannot be used from another origin, and
  the server checks the signature counter. Adding one always takes the password again (and the
  two-step code when that is on), however recently the session signed in, and only a page on
  the public HTTPS address may add one: this Mac's own loopback page is refused
  (`PASSKEY_ORIGIN`). QR sign-in needs a phone already bound as a login
  key and a matching number chosen on it.
- Where you are asked again (opening Remote, trusting a device), a passkey stands for the
  password and code, one answer for one action. A challenge answers only that: one asked for
  signing in does not open Remote. With
  two-step on, only a key added while two-step was on counts (the code was asked when it was
  added), even if two-step was turned off and on since; a key added while it was off does
  not. A key kept from before this rule never
  counts, with two-step on or off: add it again. Refused answers count as wrong passwords
  do.

**Remote**

- The `/remote` WebSocket needs a live session, the admin role and a valid pass for that
  session. The server checks all three again every 5 seconds and cuts the stream when one
  fails: an account signed out or deleted loses the picture within seconds.
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
- Every pass, every session opened and ended (with its length), and every app force-quit (who,
  and which app) is in the audit log. Every active admin account (yours, and any left from an earlier version) gets a push notification when a session
  opens, naming who and from where.
- The server never starts the capture core or any other program. It connects to `host.sock` in
  Castpane's folder and proves itself with `host.token`; if the socket is not there, it says
  Castpane is not running.

**The app's channel**

`/api/local/*` (status, making the account, listing the admin accounts and keeping one, activity, ending the viewer) answers only a
request from `127.0.0.1` or `::1`, addressed to the loopback host, with no `Origin`, cookie or
forwarding header (Cloudflare's, `X-Forwarded-For`, `Forwarded`, Tailscale's), and with
`Authorization: Bearer <local.token>`. Anything else gets 404 or 401. Making the account works only
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
| `data/audit/`            | 0700 / 0600 | The API audit log (a week or 100 MB per file, a year and at most 2 GB kept; requests nobody signed in for at most 60 a minute)                  | The server                                               |
| `data/security-log.json` | 0600        | Sign-in attempts, blocks                                                                                                                        | The server                                               |
| `cloudflared/`           | 0700        | Your Cloudflare certificate and the tunnel's credentials (own-domain mode)                                                                      | The app, cloudflared                                     |
| `logs/`                  | 0700        | `server.log`, `cloudflared.log`                                                                                                                 | The app                                                  |
| `children/`              | 0700 / 0600 | Pid files of the Node and cloudflared runs, so a run left behind by a crash is ended at the next start                                          | The app                                                  |

Losing `data/secrets.json` while the accounts remain would make every two-step secret
unreadable, so the server refuses to start in that state instead of making a new one.

**The direct link** (Settings › Remote › Direct link, on by default)

- Offered only over the signed-in `/remote` socket, for this Mac, one per session. The
  channel's DTLS identity is the one in that offer, so only the page that signed in can reach
  it; everything sent on it is checked as on the socket.
- While a session has one, the Mac listens on a UDP port (each network interface) for that
  session; before, it only made outgoing connections. Only STUN from unknown addresses is
  looked at there, and it closes with the session.
- To find a way through each side's router, the Mac and the page ask public STUN servers
  (Cloudflare's, and Google's unless the device is set to Cloudflare only) what address the
  internet sees. They see both sides' public IP addresses and when a session starts, never
  what is sent. The Mac's local addresses (LAN, IPv6, VPN) go to the page as candidates over
  the socket, so through the tunnel too. Set it to off to keep everything in the tunnel.
- Its native part, node-datachannel (libdatachannel, with its own OpenSSL), is a library
  loaded by the bundled Node, which is therefore signed without library validation. Its
  OpenSSL is built to read settings and load modules from a Homebrew folder you can write to;
  the app starts the server with `OPENSSL_CONF=/dev/null` and module and engine paths that do
  not exist, so none is read. Its fixes come with node-datachannel's releases.

## What Castpane cannot stop

- **Other programs running as you.** Any process under your macOS account that is not
  sandboxed can read `host.token` and connect to `host.sock`, which lets it watch your screen
  and post clicks and keys through the capture core, which holds your Screen Recording and
  Accessibility permissions (and, if you allowed them, the Dock's folders under Files and
  Folders, which it opens only by their place in the Dock). It can also read `local.token` and Castpane's databases. The
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
  **Settings › Devices** on another device. Remote still needs your passkey or password
  again, unless that device was trusted: remove it in **Settings › Trusted devices** too.
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
- **No Developer ID.** Releases are signed with the project's own certificate, not an Apple
  Developer ID, and are not notarized, so macOS cannot tell you who built them. A build of your
  own is signed ad hoc unless you give it a certificate, and then macOS asks for the
  permissions again after each rebuild.
- **The browser and the phone.** Castpane trusts the browser to keep its cookies and passkeys.
  A compromised phone or browser is a compromised session.

## Reporting a problem

See [SECURITY.md](../SECURITY.md) for how to report a vulnerability privately.
