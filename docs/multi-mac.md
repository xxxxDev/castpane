# Several Macs in one web app

One Castpane, the **hub**, lists other Macs beside its own on the Remote page. Each other Mac,
a **member**, runs Castpane too, joins the hub once with a one-time code, and from then on
keeps one connection *out* to the hub. A member needs no address, tunnel or account of its
own; it shows its screen only through the hub, to the hub's admins.

## Joining

1. On the hub's Remote page an admin taps **Add a Mac**. The hub makes a code: 8 characters,
   for 10 minutes, used once. It is shown with the hub's address.
2. On the member, Castpane › Settings › **Other Macs** takes the address and the code. The
   member's server opens `wss://<hub>/member`, sends `{t:"join", code, name}`, and the hub
   answers `{t:"joined", id, secret}`: a 32-byte secret it keeps only as a SHA-256 hash
   (`data/members.json`, 0600). The member keeps the secret in its own `data/member.json`
   (0600).
3. From then on the member connects with `{t:"hello", id, secret, name}`, and reconnects by
   itself, with back-off, when the link drops.

The hub needs a stable HTTPS address (own domain or Tailscale): a quick tunnel's address
changes at every start. Removing a Mac on the hub (or **Leave** on the member) ends it: the
hash or the secret is deleted and the link closed.

## A session on a member

The page opens `/remote?pass=…&machine=<id>`. The pass and every check are the hub's, as for
its own screen. The hub sends `{t:"open", n}` on the member's link; the member connects its
own capture core, says hello with its own `host.token` (which never leaves the member), and
answers `{t:"opened", n}`. From then on binary messages carry the capture core's stream both
ways, each prefixed with `n` (4 bytes), so nothing from an earlier session is mixed in;
`{t:"close", n}` ends it.

- The page's messages go through the same allow-list as for the hub's own capture core.
- What comes from a member is checked before it reaches the page: JSON objects of the
  capture core's known types only, and thumbnails only as `data:image/…;base64` URLs.
- One viewer at a time, across all Macs.
- The member's menu shows the viewer. **Stop Sharing Now** ends the session, and the hub may
  not open another for five minutes; **Pause** stops sharing until it resumes. Either way the
  hub shows the member as not sharing.
- The member checks what the hub sends too: the same allow-list as for a page, the clipboard
  at most once a second, and each clipboard use in its own log.
- Sessions are in both Macs' logs and Activity: on the hub with the member's name, on the
  member with the hub's address.

## Limits on the hub's side

- `/member` takes no cookies or pages: a message that is not the member protocol closes it.
- Joins: at most 20 wrong codes a minute in all and 5 from one address, then joins are refused
  for the rest of the minute; a code is spent by its first use, right or wrong. A member that
  knows its secret always gets back in.
- At most 64 connections, and 8 from one address, may wait to say hello.
- At most 32 members. A member's messages are limited in number (1000 a second), size (2 MiB)
  and bytes (64 MB a second); what it says reaches a page only rebuilt from known fields, and
  never faster than the page reads it.
- A `members.json` that is not this account's private file is set aside and not trusted.
