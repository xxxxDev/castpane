# Setting up Castpane

## Install

### From a release

Each release on GitHub has a disk image, `Castpane-<version>-arm64.dmg`, for Macs with Apple
silicon and macOS 14 or later.

1. Open the image and drag **Castpane** onto **Applications**.
2. Open Castpane from Applications. The image is not signed with a Developer ID, so the first
   time macOS says it cannot check Castpane and offers only **Done** or **Move to Trash**.
   Choose **Done**, then open **System Settings › Privacy & Security**, find the line about
   Castpane near the bottom and click **Open Anyway**, then confirm with your password.
   macOS remembers this; later launches open normally.
3. The setup assistant starts. See below.

To update, quit Castpane from its menu, replace the app in Applications with the new one and
open it again. The new app needs **Open Anyway** once more and asks for the two permissions
again (see "Permissions and ad hoc signing"). Your accounts, settings and tunnel stay, since
they live in the data folder, not in the app.

To check a download, compare its SHA-256 with the one in the release notes:
`shasum -a 256 Castpane-<version>-arm64.dmg`.

### From source

Build it on the Mac it will run on (an Intel Mac included). A Mac app you build yourself is
not quarantined, so it opens without **Open Anyway**.

```sh
npm run setup            # the web tools, and the server's own packages in server/node_modules
npm run build            # the web app, in web/dist
mac/build-app.sh         # mac/build/Castpane.app
```

`mac/build-app.sh` copies the Node that `node` runs on this Mac (or `CASTPANE_NODE_BIN`),
`server/` with its `node_modules`, and `web/dist` into the bundle, and signs everything ad hoc.
Move `Castpane.app` to `/Applications` and open it. `mac/make-dmg.sh` then packs it into
the same kind of disk image a release has.

Castpane keeps everything in `~/Library/Application Support/Castpane/`, a folder only your
account can open. Deleting that folder resets Castpane: accounts, passkeys, sessions and the
tunnel's credentials go with it.

## The setup assistant

1. **Admin account.** The name and password you will sign in with. Use a long password; you
   can add a passkey and two-step sign-in later, in Settings on the web app.
2. **Permissions.** Castpane needs two, both in **System Settings › Privacy & Security**:
   - **Screen & System Audio Recording**, to capture the screen. macOS applies it only after
     the app restarts, so Castpane offers to restart itself.
   - **Accessibility**, to post your clicks and keys.

   The assistant shows each one's state live, with a button that opens the right pane.

3. **Connection.** One of the three modes below. To try Castpane from a phone, a quick tunnel
   is the simplest: HTTPS at once, with no account.
4. **Done.** The address and a QR code. Open it on your phone, sign in, then in Safari use
   **Share › Add to Home Screen**: the app opens full screen and can show notifications.

### Permissions and ad hoc signing

v0.1 is signed ad hoc, not with a Developer ID. macOS ties the permissions to the exact build,
so **after every rebuild or update, macOS asks for Screen Recording and Accessibility again**.
If Remote says Castpane has no permission although the switches look on, remove Castpane from
both lists with the minus button and add it again. Login Items may list Castpane as from an
unidentified developer.

## Connection modes

Your phone has to reach the server on your Mac, which listens on `127.0.0.1:47900`. Remote
needs HTTPS in the browser: the video decoder (WebCodecs), passkeys and the installable app
are allowed only on secure pages.

| Mode            | Address                               | HTTPS            | Works away from home | You need                           |
| --------------- | ------------------------------------- | ---------------- | -------------------- | ---------------------------------- |
| Quick tunnel    | `https://<random>.trycloudflare.com`  | Yes (Cloudflare) | Yes                  | Nothing                            |
| Your own domain | `https://remote.example.com`          | Yes (Cloudflare) | Yes                  | A domain on Cloudflare             |
| Tailscale       | `https://<your-mac>.<tailnet>.ts.net` | Yes (Tailscale)  | Yes, on your tailnet | Tailscale on the Mac and the phone |

Until you choose one, Castpane has no address and serves this Mac alone, at
`http://127.0.0.1:47900`. There is no plain-HTTP local-network mode: Remote could not work in
it, since browsers keep the video decoder and passkeys for secure pages.

### Quick tunnel

Castpane runs `cloudflared tunnel --url http://127.0.0.1:47900` and reads the
`https://….trycloudflare.com` address it is given. No Cloudflare account is needed.

- **The address changes every time the tunnel starts** (each time Castpane starts, or the
  tunnel restarts). The PWA on your Home Screen and the passkeys you made belong to the old
  address: you add the app again and sign in with your password. Castpane warns you about this.
- Cloudflare terminates TLS. Your traffic, the picture included, is decrypted at Cloudflare's
  edge and encrypted again to the tunnel. You are trusting Cloudflare with it.
- Quick tunnels are meant for trying things out and have no uptime promise.

### Your own domain

For a fixed address on a domain whose DNS is on Cloudflare (a free plan is enough):

1. Castpane runs `cloudflared tunnel login`. Your browser opens; pick the domain and authorize.
2. It creates a tunnel named `castpane-<this Mac>` and routes `remote.<your domain>` to it.
3. It writes `cloudflared/config.yml` with one rule, to `http://127.0.0.1:47900`.
4. It runs `cloudflared tunnel run` and restarts it if it stops.

The address then stays the same, so the Home Screen app and passkeys keep working. The same
Cloudflare note applies: Cloudflare terminates TLS and sees the traffic. You can put
Cloudflare Access in front of the hostname for a second gate (your own email login before the
page loads); Castpane does not set that up.

cloudflared runs with its home in Castpane's folder, so its certificate and the tunnel's
credentials stay in `cloudflared/` and do not touch `~/.cloudflared`. Castpane downloads
cloudflared from Cloudflare's GitHub releases on first use (checking its checksum and
signature), or copies one already on your `PATH` when it carries Cloudflare's signature and
runs that copy (a `brew upgrade cloudflared` does not affect it; quit and open Castpane to
pick up the new version).

### Tailscale

Castpane does not manage Tailscale; it takes the address you type. This mode has not yet been tried end to
end on real devices for v0.1; the quick tunnel and your own domain have.

1. Install Tailscale on the Mac and on the phone, and sign both in to the same tailnet.
2. On the Mac, publish the server over HTTPS on your tailnet:

   ```sh
   tailscale serve --bg 47900
   ```

3. In Castpane's Connection settings, enter the `https://<your-mac>.<tailnet>.ts.net` address
   that `tailscale serve status` shows.

Only devices on your tailnet can reach it, and TLS ends on your Mac, not at a third party. The
phone needs the Tailscale app connected whenever you use Castpane. (Do not use Tailscale
Funnel unless you mean to publish Castpane to the whole internet.)

When you switch from Tailscale to another mode, stop Tailscale from passing requests on to
Castpane:

```sh
tailscale serve reset
```

Otherwise devices on your tailnet can still reach Castpane through it, alongside the new
address.

## Changing the mode later

Castpane's **Settings › Connection** changes the mode (**Off** stops the tunnel and leaves
Castpane reachable on this Mac only), shows the address and QR code, the
tunnel's state and log, and can sign in to Cloudflare again. Passkeys are tied to the address:
after a change of address, sign in with your password and add a passkey again.

## Notifications

Every admin gets a notification when a remote session opens. To receive them on a phone, add
the app to the Home Screen (iOS sends Web Push only to installed apps), open **Settings ›
Notifications** in it and allow them. Notifications need an HTTPS mode.
