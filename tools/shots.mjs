// npm run shots: the README's screenshots (docs/assets/shot-*.png), from fixtures only.
// A scratch build is served by vite preview; every /api/** answer and the /remote socket
// are made up here, and the Mac's windows are pictures this script draws from plain HTML.
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

const browser = await chromium.launch({channel: 'chrome', headless: true});

// Made-up Mac windows, drawn from HTML: with their own title bar (a phone shows the window as
// the Mac draws it) and without (CastpaneOS's desk gives each window its own bar).
const css = (w, h) => `*{box-sizing:border-box;margin:0;font-family:-apple-system,system-ui,sans-serif}body{background:#1e1e1e;color:#e8e8e8;width:${w}px;height:${h}px;overflow:hidden}
.bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#2a2a2a;border-bottom:1px solid #333}.dot{width:12px;height:12px;border-radius:50%}.r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}.t{flex:1;text-align:center;font-size:13px;color:#aaa;margin-right:52px}`;
const bar = (t) => `<div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="t">${t}</span></div>`;
const BODY = {
  notes: `<div style="display:flex;height:722px"><div style="width:280px;background:#252525;border-right:1px solid #333;padding:10px">${['Trip ideas', 'Groceries', 'Book list', 'Meeting notes', 'Recipes'].map((n, i) => `<div style="padding:12px;border-radius:8px;margin-bottom:4px;${i === 0 ? 'background:#3a3a3c' : ''}"><div style="font-weight:600;font-size:15px">${n}</div><div style="font-size:12px;color:#888;margin-top:4px">Yesterday · A few lines…</div></div>`).join('')}</div><div style="flex:1;padding:34px 40px"><div style="font-size:28px;font-weight:700;margin-bottom:18px">Trip ideas</div>${['Mountain cabin for a long weekend', 'Train along the coast', 'Night market and street food', 'Hot springs on the way back', 'Pack light: one bag each'].map((t) => `<div style="font-size:18px;line-height:1.9">• ${t}</div>`).join('')}</div></div>`,
  mail: `<div style="display:flex;height:722px"><div style="width:360px;background:#252525;border-right:1px solid #333">${['Team · Weekly update', 'Store · Your order shipped', 'Alex · Lunch on Friday?', 'Newsletter · Five quick tips'].map((n, i) => `<div style="padding:14px 16px;border-bottom:1px solid #333;${i === 0 ? 'background:#0a5fd0' : ''}"><div style="font-weight:600;font-size:15px">${n.split(' · ')[0]}</div><div style="font-size:14px;margin-top:3px">${n.split(' · ')[1]}</div></div>`).join('')}</div><div style="flex:1;padding:30px 36px"><div style="font-size:24px;font-weight:700">Weekly update</div><div style="color:#999;margin:8px 0 22px">From Team · 9:41</div>${'<div style="height:12px;background:#3a3a3a;border-radius:6px;margin:14px 0;width:90%"></div>'.repeat(6)}</div></div>`,
  calendar: `<div style="padding:18px 24px"><div style="font-size:26px;font-weight:700;margin-bottom:14px">November</div><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px">${Array.from({length: 35}, (_, i) => `<div style="height:104px;background:#262626;border-radius:8px;padding:6px;font-size:13px">${(i % 30) + 1}${[3, 9, 12, 18, 24].includes(i) ? '<div style="margin-top:8px;background:#0a84ff;border-radius:4px;padding:3px 5px;font-size:11px">Event</div>' : ''}</div>`).join('')}</div></div>`,
};
const TITLE = {notes: 'Notes', mail: 'Inbox', calendar: 'Calendar'};
async function draw(html, w, h) {
  const p = await browser.newPage({viewport: {width: w, height: h}});
  await p.setContent(`<style>${css(w, h)}</style>${html}`);
  const png = await p.screenshot();await p.close();
  return 'data:image/png;base64,' + png.toString('base64');
}
const PIC = {}, DESK = {};
for (const k of Object.keys(BODY)) { PIC[k] = await draw(bar(TITLE[k]) + BODY[k], 1100, 760); DESK[k] = await draw(BODY[k], 1100, 722); }
PIC.notesTall = await draw(`${bar('Notes')}<div style="padding:36px 34px"><div style="font-size:56px;font-weight:700;margin-bottom:28px">Trip ideas</div>${['Mountain cabin for a long weekend', 'Train along the coast', 'Night market and street food', 'Hot springs on the way back', 'Pack light: one bag each'].map((t) => `<div style="font-size:36px;line-height:1.9">• ${t}</div>`).join('')}</div>`, 760, 1240);
PIC.desktop = await draw(`<div style="width:1512px;height:982px;background:linear-gradient(135deg,#1d2b64,#3a1c71 60%,#d76d77);position:relative"><div style="position:absolute;top:0;left:0;right:0;height:26px;background:rgba(0,0,0,.35);display:flex;align-items:center;padding:0 14px;font-size:13px;gap:18px"><b>Finder</b><span>File</span><span>Edit</span><span>View</span></div><div style="position:absolute;left:220px;top:140px;width:640px;height:420px;background:#1e1e1e;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden">${bar('Notes')}</div><div style="position:absolute;left:640px;top:300px;width:640px;height:420px;background:#1e1e1e;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden">${bar('Inbox')}</div></div>`, 1512, 982);
const icon = (letter, color) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="42" font-family="-apple-system,Helvetica" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`).toString('base64');
const ICONS = {'com.example.files': icon('F', '#0a84ff'), 'com.apple.apps.launcher': icon('⊞', '#636366'), 'com.example.notes': icon('N', '#f5b400'), 'com.example.mail': icon('M', '#1a82fb'), 'com.example.calendar': icon('C', '#ff3b30'), 'com.example.music': icon('♪', '#fc3c44'), 'com.example.maps': icon('⌖', '#34c759')};
const name = (b) => (b === 'com.apple.apps.launcher' ? 'Apps' : b.split('.').pop().replace(/^./, (c) => c.toUpperCase()));
const RUNNING = ['com.example.files', 'com.example.notes', 'com.example.mail', 'com.example.calendar'];
const DOCK = Object.keys(ICONS).map((b) => ({bundle: b, name: name(b), running: RUNNING.includes(b), kept: true}));
const APPS = Object.keys(ICONS).filter((b) => b !== 'com.apple.apps.launcher').map((b) => ({bundle: b, name: name(b), running: RUNNING.includes(b)}));
const desk = (n, current) => ({id: 10 + n, number: n, display: 0, fullscreen: false, current});
const me = {id: 'aaaaaaaaaaaaaaaa', username: 'alex', name: 'Alex', role: 'admin', language: 'en', twoStep: false};

// The Mac's picture is one of the drawings above, shown over the canvas (no video is sent); the
// link's line reads as a direct link's would (headless Chrome makes no WebRTC link here).
const PAGE_JS = () => {
  const st = document.createElement('style');
  st.textContent = '.shot-pic{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:0}.shot-has-pic .remote-notice{display:none!important}*{caret-color:transparent!important}';
  document.documentElement.appendChild(st);
  window.__pic = (src) => { const a = document.querySelector('.remote-area'); if (!a) return; let i = a.querySelector('.shot-pic'); if (!i) { i = document.createElement('img'); i.className = 'shot-pic'; a.prepend(i); } i.src = src; document.querySelector('.remote-stage')?.classList.add('shot-has-pic'); };
  const fix = () => { const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);for (let n = w.nextNode(); n; n = w.nextNode()) { const t = n.nodeValue, v = t.replace(/\d+ fps · [\d.]+ Mbps/, '60 fps · 2.4 Mbps').replace(/\d+ ms · relayed/, '38 ms · direct').replace(/(\d+) ms · /, '38 ms · ').replace(/^relayed$/, 'direct').replace(/ · relayed/, ' · direct');if (v !== t) n.nodeValue = v; } };
  new MutationObserver(fix).observe(document.documentElement, {subtree: true, childList: true, characterData: true});
};
async function open({phone}) {
  const context = await browser.newContext(phone
    ? {viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'en-US', serviceWorkers: 'block'}
    : {viewport: {width: 1440, height: 900}, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US', serviceWorkers: 'block'});
  await context.addInitScript(() => { localStorage.setItem('in_browser', '1'); localStorage.setItem('castpane-update-dialog', '0'); localStorage.setItem('castpane-theme', 'dark'); localStorage.setItem('castpane-desk-windows', '1'); });
  await context.addInitScript(() => { try { Object.defineProperty(window, 'PublicKeyCredential', {value: undefined, configurable: true}); } catch { /* kept */ } });
  const page = await context.newPage();
  const pics = phone ? {41: PIC.notes, 42: PIC.mail, 43: PIC.calendar} : {41: DESK.notes, 42: DESK.mail, 43: DESK.calendar};
  const items = [
    {kind: 'display', id: 1, title: 'Desktop', app: '', width: 3024, height: 1964, thumb: PIC.desktop},
    {kind: 'window', id: 41, title: 'Trip ideas', app: 'Notes', bundle: 'com.example.notes', width: 1100, height: 760, thumb: pics[41], here: true, desk: desk(1, true)},
    {kind: 'window', id: 42, title: 'Inbox', app: 'Mail', bundle: 'com.example.mail', width: 1100, height: 760, thumb: pics[42], here: true, desk: desk(1, true)},
    {kind: 'window', id: 43, title: 'November', app: 'Calendar', bundle: 'com.example.calendar', width: 1100, height: 760, thumb: pics[43], here: false, desk: desk(2, false)},
  ];
  let fitted = null;
  await page.route('**/api/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p === '/api/remote/machines') return r.fulfill({json: {machines: [{id: 'local', name: 'Studio', local: true, online: true, running: true}, {id: 'a1b2c3d4e5f6', name: 'Office iMac', local: false, online: true, running: true}], canAdd: true}});
    if (p === '/api/remote/pass/check') return r.fulfill({json: {ok: false}});
    if (p === '/api/remote/pass') { const b = JSON.parse(r.request().postData() || '{}'); if (b.trusted) return r.fulfill({status: 409, json: {message: 'This device is not trusted', code: 'NOT_TRUSTED'}}); return b.adminPassword ? r.fulfill({json: {pass: 'p', expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString()}}) : r.fulfill({status: 400, json: {message: 'Enter your own password to do this', code: 'NEED_PASSWORD'}}); }
    if (p.startsWith('/api/auth/')) return r.fulfill({json: {user: me}});
    return r.fulfill({json: {}});
  });
  await page.routeWebSocket(/\/live$/, () => {});
  await page.routeWebSocket(/\/remote\?/, (ws) => {
    const send = (o) => ws.send(JSON.stringify(o));
    ws.onMessage((raw) => {
      if (typeof raw !== 'string') return;
      const x = JSON.parse(raw);
      if (x.t === 'echo') setTimeout(() => send({t: 'echo', n: x.n}), 38);
      if (x.t === 'list') send({t: 'list', items});
      if (x.t === 'apps') send({t: 'apps', apps: APPS});
      if (x.t === 'dock') send({t: 'dock', apps: DOCK, others: [{name: 'Downloads', kind: 'folder'}], trash: true});
      if (x.t === 'icons') send({t: 'icons', icons: Object.fromEntries(x.bundles.filter((b) => ICONS[b]).map((b) => [b, ICONS[b]]))});
      if (x.t === 'shots') send({t: 'shots', items: x.ids.map((id) => ({id, thumb: pics[id] || PIC.desktop}))});
      if (x.t === 'fit') { fitted = x.id; send({t: 'fitted', id: x.id, ok: true, width: x.width, height: x.height}); }
      if (x.t === 'start') { send({t: 'started', kind: x.kind, id: x.id, width: 1920, height: 1246, fps: 60}); setTimeout(() => page.evaluate((s) => window.__pic(s), (phone && fitted === 41 && x.id === 41 && PIC.notesTall) || pics[x.id] || PIC.desktop).catch(() => {}), 300); }
    });
    send({t: 'status', screen: true, accessibility: true, version: '2026.11.19', host: 'Studio', windows: true});
  });
  await page.goto(base);
  await page.locator('#view-remote .remote-tile').first().waitFor();
  await page.evaluate(PAGE_JS);
  return {context, page};
}
const wait = (page, ms) => page.waitForTimeout(ms);
async function connect(page) {
  await page.locator('#view-remote .remote-tile', {hasText: 'Studio'}).first().click();
  await page.locator('.dialog input[type="password"]').fill('pass');
  await page.locator('.dialog .dialog-button').last().click();
  await page.locator('.remote-home-card').first().waitFor();
}

fs.mkdirSync(assets, {recursive: true});
const shot = async (page, file) => { await page.screenshot({path: path.join(assets, file)}); console.log('wrote docs/assets/' + file); };
{ // A phone: the Macs, a Mac's home, an app.
  const {context, page} = await open({phone: true});
  await wait(page, 500); await shot(page, 'shot-phone-remote.png');
  await connect(page); await wait(page, 2600); await shot(page, 'shot-phone-home.png');
  await page.locator('.remote-home-card').first().click(); await page.locator('.remote-keys-touch').waitFor(); await wait(page, 1800);
  await shot(page, 'shot-phone-app.png');
  await context.close();
}
{ // A computer: the home, then the whole screen with its column at the right.
  const {context, page} = await open({phone: false});
  await connect(page); await wait(page, 2000); await shot(page, 'shot-desktop-home.png');
  await page.locator('.remote-home-screen, .remote-home-desktop').filter({visible: true}).first().click(); await wait(page, 2200);
  await shot(page, 'shot-desktop-stage.png');
  await context.close();
}
{ // A computer: CastpaneOS, three windows opened from its Dock and dragged apart.
  const {context, page} = await open({phone: false});
  await connect(page); await wait(page, 1500);
  await page.locator('.remote-home-os').filter({visible: true}).first().click();
  await page.locator('.cp-dock-app[data-bundle="com.example.notes"]').first().waitFor(); await wait(page, 2500);
  // Each clicked until its window is on the desk (the desk takes the Mac's list a moment after it opens).
  for (const [i, b] of ['com.example.notes', 'com.example.mail', 'com.example.calendar'].entries()) {
    for (let k = 0; k < 20 && await page.locator('.cp-win').count() <= i; k++) { await page.locator(`.cp-dock-app[data-bundle="${b}"]`).filter({visible: true}).first().click(); await wait(page, 700); }
    await page.locator('.cp-win').nth(i).waitFor(); await wait(page, 1200);
  }
  const drag = async (id, dx, dy) => { const bb = await page.locator(`.cp-win[data-id="${id}"] .cp-win-bar b`).boundingBox(); await page.mouse.move(bb.x + 5, bb.y + 5); await page.mouse.down(); await page.mouse.move(bb.x + 5 + dx, bb.y + 5 + dy, {steps: 12}); await page.mouse.up(); await wait(page, 600); };
  await drag(41, -20, 380); await drag(42, 760, 300); await wait(page, 1500);
  await shot(page, 'shot-desktop-os.png');
  await context.close();
}
await browser.close();
stop();
