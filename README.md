<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo/castpane-lockup-on-dark.svg">
    <img src="docs/assets/logo/castpane-lockup-primary.svg" alt="Castpane" width="420">
  </picture>
</p>

<p align="center">English · <a href="README.zh-TW.md">繁體中文</a></p>

# Castpane

Castpane lets you see and control your own Mac from a phone or another computer. You open it
in a browser, or install it on the phone's Home Screen as an app. The Mac runs one app,
**Castpane.app**. The phone or the other computer needs nothing installed.

The picture is the Mac's own hardware H.264, decoded by the browser's hardware decoder, so a
whole screen or a single window stays sharp and current on a phone. You click, scroll and type
back, with touch modes made for a small screen.

> [!WARNING]
> Castpane gives whoever signs in as an admin full control of your Mac, as you. Use a strong
> password, turn on two-step sign-in or a passkey, and read [docs/security.md](docs/security.md)
> before you open it to the internet. It cannot protect you from other programs that already
> run on your Mac under your account.

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.png"><img src="docs/assets/architecture-light.png" alt="Phones and computers reach Castpane.app over HTTPS and a WebSocket, through a Cloudflare Tunnel or Tailscale. Inside the app, a Node server on 127.0.0.1 handles sign-in and relays to the capture core over host.sock; the app talks to the server over /api/local with local.token. Everything is kept in ~/Library/Application Support/Castpane."></picture>
</p>

## Two halves

|                                    | What                                                                                                                                                                                                                                                          | Where                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Castpane.app** (the server side) | A menu-bar app. It captures the screen with ScreenCaptureKit, encodes it with VideoToolbox and posts your clicks and keys. It runs the web server, keeps it running, and manages the connection (a Cloudflare tunnel, or the address you give for Tailscale). | [`mac/`](mac/) and [`server/`](server/) |
| **The PWA** (the client)           | A web app in Vue and Framework7: sign-in, the Remote page, settings and account management. Any current Chrome, Edge or Safari, on a phone or a computer.                                                                                                     | [`web/`](web/)                          |

## Features

- **Your screen or one window.** Pick a whole display, a desktop (Space), a full-screen app or a
  single window. The list is grouped by desktop, with thumbnails.
- **Made for a phone.** Three touch modes: tap where you want (direct), a trackpad, or a
  pointer you drag by a ring below it, so your finger never hides what it points at. Pinch to
  zoom; when you tap a text field the keyboard comes up and the field is zoomed into view. A
  row of keys a phone lacks (esc, tab, arrows, ⌘ ⌥ ⌃ ⇧), a key panel in the keyboard's place
  (editing keys, the Mac's shortcuts, a number pad, F1–F12), and a field to write a line,
  input method and all, and send it to the Mac's cursor. Held sideways, the tabs move to a
  rail on the right.
- **Several Macs, one web app.** Other Macs join this one with a one-time code and show up
  beside it on the Remote page. They need no address or account of their own
  ([docs/multi-mac.md](docs/multi-mac.md)).
- **The clipboard both ways.** Copy the Mac's clipboard to the phone, or put the phone's on
  the Mac. What a password manager marks hidden is never sent; each use is in Activity.
- **Stays current.** Each frame shown is acknowledged; the Mac skips frames while three are
  unshown, so a slow network gives fewer frames, not old ones. Quality, resolution and 30 or
  60 fps are yours to choose.
- **Sign-in that holds up.** Passwords, passkeys (Face ID, Touch ID, Windows Hello), two-step
  codes with recovery codes, and QR sign-in from a phone that is already signed in. Failed
  sign-ins lock an address out for longer each time; an admin sees what was tried and from
  where.
- **Asked again before control.** Opening Remote needs the admin's passkey, or their password
  and code, again. The pass lasts 8 hours, for that sign-in only.
- **One viewer at a time.** A second page takes over from the first. The Mac's menu shows who
  is watching and can stop it at once. Every admin gets a notification when a session
  opens, with who and from where.
- **Users and devices.** Admins and members, disabled and deleted accounts, every signed-in
  device with a way to sign it out. Only admins can open Remote.
- **An installable app.** Add it to the Home Screen for a full-screen app with notifications.
  It offers each new version as it arrives.
- **English and Traditional Chinese** in the web app.

## What it looks like

<p align="center">
  <img src="docs/assets/shot-phone-remote.png" alt="The Remote tab on a phone: this Mac, another Mac that joined it, and Add another Mac" width="200">
  <img src="docs/assets/shot-phone-stage.png" alt="A phone showing the Mac's desktop, with the desktops and windows above" width="200">
  <img src="docs/assets/shot-phone-keys.png" alt="The key panel in the phone keyboard's place: copy, paste, undo, Spotlight, Mission Control and more" width="200">
  <img src="docs/assets/shot-phone-users.png" alt="Manage Users on a phone: an admin and a member" width="200">
</p>

<p align="center"><img src="docs/assets/shot-desktop-stage.png" alt="Remote in a computer's browser: the desktops and windows across the top, the Mac's screen below" width="820"></p>

On the Mac, the setup assistant and Settings:

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/shot-mac-role-dark.png"><img src="docs/assets/shot-mac-role-light.png" alt="The setup assistant's first step: the Mac you connect to, or one to show in another Mac's Castpane" width="400"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/shot-mac-setup-dark.png"><img src="docs/assets/shot-mac-setup-light.png" alt="The setup assistant's Connection step: the ways to connect, with the quick tunnel's address and QR code beside them" width="400"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/shot-mac-activity-dark.png"><img src="docs/assets/shot-mac-activity-light.png" alt="Settings, Activity: who signed in and who viewed this Mac, and when" width="400"></picture>
</p>

These pictures come from fixtures: the web app's from `npm run shots`, where the "Mac screen"
is drawn by the script, and the Mac app's from a debug build's snapshots, with a made-up
address. No real screen was captured. On macOS 26 and later the app's panels and buttons are
Liquid Glass, which the snapshots do not draw.

## Requirements

- **The Mac:** macOS 14 or later, Apple silicon or Intel (one release image for each).
  Screen Recording and Accessibility permission for Castpane.
- **To build it:** the Command Line Tools (Swift 6) and Node.js 22.18 or later.
- **The viewer:** a browser with WebCodecs (current Chrome, Edge, Safari 17 and later), over
  **HTTPS**. Browsers allow the video decoder, passkeys and the installable app only on HTTPS
  (or on the Mac itself, at `127.0.0.1`).

## Quick start

On a Mac with Apple silicon or Intel, with [Homebrew](https://brew.sh):

```sh
brew install --cask xxxxDev/tap/castpane     # Castpane then updates itself
```

Or download `Castpane-<version>-arm64.dmg` (or `-x86_64.dmg` for Intel) from the releases
page, drag Castpane to Applications and open it. Castpane then keeps itself up to date: it
checks GitHub once a day and installs a new version when you say so. The app is not notarized by Apple, so a downloaded copy's first
launch needs **System Settings › Privacy & Security › Open Anyway**;
[docs/setup.md](docs/setup.md#install) has the steps and what the Homebrew way skips.

Or build it from source (any Mac, Apple silicon or Intel):

```sh
git clone https://github.com/xxxxDev/castpane.git castpane && cd castpane
npm run setup            # installs the web tools and the server's packages
npm run build            # web/dist
mac/build-app.sh         # mac/build/Castpane.app, with this Mac's Node, server/ and web/dist
open mac/build/Castpane.app
```

The setup assistant first asks what this Mac is for. For the Mac you connect to, it then:

1. makes your admin account;
2. asks for Screen Recording and Accessibility (Castpane offers to restart after the first);
3. asks how to connect: a quick tunnel, your own domain or Tailscale;
4. shows the address and a QR code. Open it on the phone, sign in, and use **Share › Add to
   Home Screen** for the app.

[docs/setup.md](docs/setup.md) explains each connection mode and its trade-offs.

## Documentation

- [docs/setup.md](docs/setup.md): installing, permissions, the three connection modes.
- [docs/multi-mac.md](docs/multi-mac.md): several Macs in one web app.
- [docs/security.md](docs/security.md): what Castpane guarantees, where its secrets are, and
  what it cannot stop.
- [docs/protocol.md](docs/protocol.md): the remote protocol, the app's local API, and the
  process contract.
- [docs/development.md](docs/development.md): layout, running from source, checking a change.
- [mac/README.md](mac/README.md): building the Mac app.
- [BRAND.md](BRAND.md): the logo, which the MIT License does not cover.

## Not yet

Developer ID signing and notarization (releases are signed with the project's own
certificate instead), and audio.

## License

MIT. See [LICENSE](LICENSE). `server/` and `web/` grew from an MIT-licensed shared PWA base
whose notice is kept in the license file.

The Castpane logo (in this README, the app and web icons) belongs to [V-AX](https://v-ax.com)
and is **not** covered by the MIT License. See [BRAND.md](BRAND.md).
