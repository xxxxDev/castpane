// npm run diagram: docs/assets/architecture-dark.png and -light.png, drawn from the
// HTML below with Playwright and the installed Chrome.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = (dark) => `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:${dark ? '#0f1115' : '#ffffff'};--fg:${dark ? '#e8eaed' : '#1d1f23'};--muted:${dark ? '#9aa0a6' : '#5f6368'};--box:${dark ? '#1a1d23' : '#f6f7f9'};--line:${dark ? '#3a3f47' : '#c9ced6'};--mac:${dark ? '#16202b' : '#eef5fc'};--macline:${dark ? '#2f4a63' : '#9cc3e6'};--accent:#0866ff;--warn:${dark ? '#f6c768' : '#b7791f'}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
.wrap{width:1200px;padding:36px 40px;position:relative}
h1{font-size:20px;margin:0 0 22px;font-weight:650}
.row{display:flex;gap:28px;align-items:stretch}
.clients{width:250px;display:flex;flex-direction:column;gap:14px}
.box{background:var(--box);border:1.5px solid var(--line);border-radius:14px;padding:14px 16px}
.box b{display:block;font-size:15px;margin-bottom:4px}.box small{color:var(--muted);font-size:13px;line-height:1.45;display:block}
.edge{width:170px;display:flex;flex-direction:column;justify-content:center;gap:14px}
.mac{flex:1;background:var(--mac);border:1.5px solid var(--macline);border-radius:18px;padding:16px 18px}
.mac>.t{font-weight:650;margin-bottom:12px}.mac>.t span{color:var(--muted);font-weight:400;font-size:13px}
.app{border:1.5px dashed var(--macline);border-radius:14px;padding:12px 14px;margin-top:12px}
.app .t{font-weight:600;margin-bottom:8px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.arrow{color:var(--muted);font-size:13px;line-height:1.4;text-align:center}
.arrow i{display:block;font-style:normal;color:var(--accent);font-size:22px;line-height:1}
code{font:12.5px Menlo,monospace;color:var(--fg);background:rgba(127,127,127,.14);padding:1px 5px;border-radius:5px}
.note{margin-top:16px;color:var(--muted);font-size:13px}.note b{color:var(--warn);font-weight:600}
</style></head><body><div class="wrap">
<h1>Castpane: one app on the Mac, any browser as the client</h1>
<div class="row">
 <div class="clients">
  <div class="box"><b>Phone</b><small>The PWA, added to the Home Screen, or Safari. Nothing to install.</small></div>
  <div class="box"><b>Another computer</b><small>Any current Chrome, Edge or Safari.</small></div>
  <div class="box"><b>This Mac</b><small><code>http://127.0.0.1:47900</code> for account management.</small></div>
 </div>
 <div class="edge">
  <div class="arrow"><i>⇄</i>HTTPS + WebSocket<br>H.264 frames down,<br>clicks and keys up</div>
  <div class="box"><b>Connection</b><small>Cloudflare Tunnel (quick or your domain) or Tailscale, always HTTPS</small></div>
 </div>
 <div class="mac">
  <div class="t">Castpane.app <span>· menu bar, setup, settings · signed ad hoc</span></div>
  <div class="grid">
   <div class="box"><b>Node server</b><small><code>server/start.js</code> on 127.0.0.1. Sign-in, passkeys, two-step, users, devices, push, audit, the PWA, the <code>/remote</code> relay.</small></div>
   <div class="box"><b>Capture core</b><small>ScreenCaptureKit, VideoToolbox H.264, input posting. Holds Screen Recording and Accessibility.</small></div>
  </div>
  <div class="grid" style="margin-top:12px">
   <div class="arrow"><i>↕</i><code>/api/local/*</code> + <code>local.token</code><br>status · first admin · activity · end viewer</div>
   <div class="arrow"><i>↔</i><code>host.sock</code> + <code>host.token</code><br>server → core, one viewer at a time</div>
  </div>
  <div class="app"><div class="t">~/Library/Application Support/Castpane <span style="color:var(--muted);font-weight:400">(0700)</span></div>
   <small style="color:var(--muted)"><code>config.json</code> · <code>host.sock</code> · <code>host.token</code> · <code>local.token</code> · <code>data/</code> accounts, sessions, push, audit · <code>cloudflared/</code> · <code>logs/</code></small></div>
 </div>
</div>
<div class="note"><b>Trust boundary:</b> the server never starts anything; the app starts the server and listens on the socket. Any process running as the same macOS user can read the tokens.</div>
</div></body></html>`;
const browser = await chromium.launch({channel: 'chrome', headless: true});
for (const dark of [true, false]) {
  const page = await browser.newPage({viewport: {width: 1200, height: 600}, deviceScaleFactor: 2});
  await page.setContent(html(dark));
  const box = await page.locator('.wrap').boundingBox();
  const file = path.join(root, 'docs', 'assets', `architecture-${dark ? 'dark' : 'light'}.png`);
  await page.screenshot({path: file, clip: {x: 0, y: 0, width: 1200, height: Math.ceil(box.height)}});
  console.log('wrote', path.relative(root, file));
  await page.close();
}
await browser.close();
