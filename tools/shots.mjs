// npm run shots: the README's screenshots (docs/assets/shot-*.png), from fixtures only.
// A scratch build is served by vite preview; every /api/** answer and the /remote socket
// are made up here, and the "Mac screen" on the stage is a picture drawn by this script.
// Nothing real is captured. The preview is stopped by its own pid.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'docs', 'assets');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'castpane-shots-'));
const outDir = path.join(scratch, 'dist');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const config = path.join(root, 'web', 'vite.config.js');
if (spawnSync(process.execPath, [vite, 'build', '--config', config, '--outDir', outDir, '--logLevel', 'warn'], {cwd: root, stdio: 'inherit'}).status !== 0) process.exit(1);
const port = await new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const preview = spawn(process.execPath, [vite, 'preview', '--config', config, '--outDir', outDir, '--port', String(port), '--strictPort'], {cwd: root, stdio: 'ignore'});
const stop = () => { try { process.kill(preview.pid, 'SIGTERM'); } catch { /* gone */ } };
process.on('exit', () => { stop(); fs.rmSync(scratch, {recursive: true, force: true}); });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) { try { if ((await fetch(base)).ok) break; } catch { /* not yet */ } if (i > 100) throw new Error('preview did not start'); await new Promise((r) => setTimeout(r, 100)); }

const me = {id: 'aaaaaaaaaaaaaaaa', username: 'alex', name: 'Alex', role: 'admin', language: 'en', twoStep: true};
const USERS = [me, {id: 'bbbbbbbbbbbbbbbb', username: 'sam', name: 'Sam', role: 'user', language: 'en', lifecycleStatus: 'active', online: false}];
const ITEMS = [
  {kind: 'display', id: 1, title: 'Desktop', width: 2560, height: 1600},
  {kind: 'window', id: 42, title: 'Notes', app: 'Notes', width: 900, height: 700, here: true, desk: {id: 11, number: 1, display: 0, fullscreen: false, current: true}},
  {kind: 'window', id: 43, title: 'Terminal', app: 'Terminal', width: 900, height: 600, here: true, desk: {id: 11, number: 1, display: 0, fullscreen: false, current: true}},
  {kind: 'window', id: 44, title: 'Inbox', app: 'Mail', width: 900, height: 700, here: false, desk: {id: 12, number: 2, display: 0, fullscreen: false, current: false}},
];
// A made-up desktop: wallpaper, two windows, a dock.
const paint = () => {
  const c = document.querySelector('.remote-canvas'); c.width = 2560; c.height = 1600;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 2560, 1600); sky.addColorStop(0, '#1d3b5f'); sky.addColorStop(0.55, '#3d6e8f'); sky.addColorStop(1, '#d9a36b');
  g.fillStyle = sky; g.fillRect(0, 0, 2560, 1600);
  g.fillStyle = 'rgba(20,20,24,.55)'; g.fillRect(0, 0, 2560, 48);
  const win = (x, y, w, h, title, lines, dark) => {
    g.save(); g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 60; g.fillStyle = dark ? '#1e1f22' : '#f7f7f5'; g.beginPath(); g.roundRect(x, y, w, h, 22); g.fill(); g.restore();
    g.fillStyle = dark ? '#2b2d31' : '#e9e8e4'; g.beginPath(); g.roundRect(x, y, w, 64, [22, 22, 0, 0]); g.fill();
    ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => { g.fillStyle = col; g.beginPath(); g.arc(x + 34 + i * 34, y + 32, 11, 0, 7); g.fill(); });
    g.fillStyle = dark ? '#ccc' : '#444'; g.font = '600 26px -apple-system, Helvetica'; g.fillText(title, x + w / 2 - g.measureText(title).width / 2, y + 41);
    g.font = (dark ? '28px Menlo, monospace' : '30px -apple-system, Helvetica'); g.fillStyle = dark ? '#8fe388' : '#222';
    lines.forEach((t, i) => g.fillText(t, x + 40, y + 130 + i * 50));
  };
  win(260, 200, 1180, 820, 'Notes', ['Groceries', '— oat milk', '— lemons', '— coffee beans', '', 'Call the plumber on Thursday'], false);
  win(1260, 520, 1080, 700, 'Terminal', ['$ npm test', '✔ 191 tests passed', '$ git status', 'nothing to commit, working tree clean', '$ █'], true);
  g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.roundRect(860, 1460, 840, 112, 30); g.fill();
  ['#5ac8fa', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#64d2ff'].forEach((col, i) => { g.fillStyle = col; g.beginPath(); g.roundRect(894 + i * 132, 1478, 96, 76, 20); g.fill(); });
};

const browser = await chromium.launch({channel: 'chrome', headless: true});
async function open({viewport, mobile, scheme = 'dark', signedIn = true}) {
  const context = await browser.newContext({viewport, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block', colorScheme: scheme, deviceScaleFactor: 2});
  await context.addInitScript((theme) => { localStorage.setItem('in_browser', '1'); localStorage.setItem('castpane-theme', theme); localStorage.setItem('activeTab', 'view-remote'); }, scheme);
  const page = await context.newPage();
  await page.route('**/api/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p === '/api/auth/verify' || p === '/api/auth/me') return signedIn ? r.fulfill({json: {user: me}}) : r.fulfill({status: 401, json: {message: 'No token provided'}});
    if (p === '/api/auth/users') return r.fulfill({json: {users: USERS}});
    if (p === '/api/remote/machines') return r.fulfill({json: {machines: [{id: 'local', name: 'Studio', local: true, running: true}]}});
    if (p === '/api/remote/pass') return r.fulfill({json: {pass: 'p', expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString()}});
    if (p === '/api/auth/qr/start') return r.fulfill({json: {id: 'Qq0Qq0Qq0Qq0Qq0Qq0Qq0Qq0', secret: 's'.repeat(43), code: '42', expiresAt: new Date(Date.now() + 60e3).toISOString()}});
    return r.fulfill({json: {}});
  });
  await page.routeWebSocket(/\/live$/, () => {});
  await page.routeWebSocket(/\/remote\?/, (ws) => {
    ws.onMessage((m) => { const x = JSON.parse(m); if (x.t === 'list') ws.send(JSON.stringify({t: 'list', items: ITEMS})); if (x.t === 'start') { ws.send(JSON.stringify({t: 'started', kind: x.kind, id: x.id, width: 2560, height: 1600})); ws.send(JSON.stringify({t: 'config', codec: 'avc1.640028', width: 2560, height: 1600})); } });
    ws.send(JSON.stringify({t: 'status', screen: true, accessibility: true}));
  });
  await page.goto(base);
  return {context, page};
}
async function stage(page) {
  await page.locator('#view-remote .remote-tile').click();
  await page.locator('.remote-stage').waitFor();
  await page.locator('.remote-canvas:not(.hidden)').waitFor();
  await page.evaluate(paint);
  await page.waitForTimeout(300);
}

fs.mkdirSync(assets, {recursive: true});
const shot = async (page, name) => { await page.screenshot({path: path.join(assets, name)}); console.log('wrote docs/assets/' + name); };
{ // The phone: the Remote tab, then the stage.
  const {context, page} = await open({viewport: {width: 390, height: 844}, mobile: true});
  await page.locator('#view-remote .remote-tile').waitFor(); await page.waitForTimeout(300);
  await shot(page, 'shot-phone-remote.png');
  await stage(page); await shot(page, 'shot-phone-stage.png');
  await context.close();
}
{ // A computer: the stage with the windows bar.
  const {context, page} = await open({viewport: {width: 1280, height: 800}, mobile: false});
  await stage(page); await shot(page, 'shot-desktop-stage.png');
  await context.close();
}
{ // Sign-in, light.
  const {context, page} = await open({viewport: {width: 390, height: 844}, mobile: true, scheme: 'light', signedIn: false});
  await page.locator('.login-screen').waitFor(); await page.waitForTimeout(500);
  await shot(page, 'shot-phone-signin.png');
  await context.close();
}
{ // Admin: the accounts.
  const {context, page} = await open({viewport: {width: 390, height: 844}, mobile: true});
  await page.locator('a.tab-link[data-tab="#view-admin"]').filter({visible: true}).first().click();
  await page.locator('#view-admin .users-row').filter({visible: true}).first().click(); await page.waitForTimeout(800);
  await shot(page, 'shot-phone-users.png');
  await context.close();
}
await browser.close();
stop();
