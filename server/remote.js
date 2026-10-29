// Remote: this Mac's screen in the web app, and the admin's clicks and keys back to it.
// Castpane.app's capture core captures and encodes the screen and posts the input; it
// alone holds Screen Recording and Accessibility, never this server. It listens on a
// Unix socket in the app's folder ($CASTPANE_HOME/host.sock, 0600 in a 0700 folder),
// and only a connection that first sends the token in host.token (0600) beside it gets
// anything. This server never starts the capture core: when the socket is not there,
// the page is told Castpane is not running. It signs the admin in, asks for their
// passkey, or their password (and two-step code), once for a pass that lasts a few
// hours, and relays between the page and the capture core.
//
// Page ⇄ server, over /remote: text frames are JSON both ways, binary frames are video
// from the capture core ([flags][timestamp µs: 8 bytes][H.264 or HEVC Annex B]) passed on
// untouched. Server ⇄ capture core: [kind][length: 4 bytes BE][payload], kind 1 JSON,
// kind 2 video (docs/protocol.md).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { resolveLivePrincipal } = require('./services/livePrincipal');
const { audit } = require('./services/audit');
const { resolveClientIp } = require('./services/clientIp');
const { sessionCookie } = require('./services/sessionCookie');
const { vetFromMember } = require('./members');

const HOME = () => process.env.CASTPANE_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'Castpane');
const PASS_MS = 8 * 60 * 60 * 1000;
// What the page may ask of the capture core, and the fields each may carry
// (docs/protocol.md). A type not here closes the connection. A message of a known type
// is passed on rebuilt from its checked fields alone, anything else in it left behind;
// one whose fields are wrong (a type, a range, a key that is not a key) is dropped.
const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const bool = (v) => typeof v === 'boolean';
// Pixels a scroll may move at once, either way: a fast flick, a page of a wheel.
const SCROLL_MAX = 10000;
// A KeyboardEvent.code: KeyA, Digit1, ArrowLeft, F12, NumpadEnter, IntlBackslash, …
const KEY_CODE = /^[A-Z][A-Za-z0-9]{1,31}$/;
const MODS = new Set(['shift', 'ctrl', 'alt', 'meta']);
// The longest text typed at once, in UTF-16 units (the capture core takes 4000
// characters; the page sends text in pieces well below this).
const TEXT_MAX = 4000;
// The longest text put on the Mac's clipboard, in UTF-16 units (the capture core's limit).
const CLIPBOARD_MAX = 100000;
const at = (m) => (unit(m.x) && unit(m.y) ? { x: m.x, y: m.y } : null);
const none = () => ({});
const MESSAGES = {
  status: none, permissions: none, list: none, stop: none, ack: none, 'key-frame': none,
  start(m) {
    if ((m.kind !== 'display' && m.kind !== 'window') || !int(m.id, 0, 0xffffffff)) return null;
    const out = { kind: m.kind, id: m.id };
    // Each optional: the capture core has its own default.
    for (const [k, lo, hi] of [['maxWidth', 320, 3840], ['fps', 10, 60], ['bitrate', 500_000, 40_000_000]]) {
      if (m[k] === undefined) continue;
      if (!int(m[k], lo, hi)) return null;
      out[k] = m[k];
    }
    if (m.codec !== undefined) {
      if (m.codec !== 'h264' && m.codec !== 'hevc') return null;
      out.codec = m.codec;
    }
    return out;
  },
  move: (m) => at(m),
  button(m) { const p = at(m); return p && int(m.b, 0, 2) && bool(m.down) ? { b: m.b, down: m.down, ...p } : null; },
  scroll(m) {
    const p = at(m), fine = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= SCROLL_MAX;
    return p && fine(m.dx) && fine(m.dy) ? { dx: m.dx, dy: m.dy, ...p } : null;
  },
  key(m) {
    if (typeof m.code !== 'string' || !KEY_CODE.test(m.code) || !bool(m.down)) return null;
    const mods = m.mods === undefined ? [] : m.mods;
    if (!Array.isArray(mods) || mods.length > MODS.size || !mods.every((x) => MODS.has(x)) || new Set(mods).size !== mods.length) return null;
    return { code: m.code, down: m.down, mods };
  },
  // Well-formed only: a lone surrogate cannot be written as JSON the capture core reads.
  text: (m) => (typeof m.s === 'string' && m.s.length >= 1 && m.s.length <= TEXT_MAX && m.s.isWellFormed() ? { s: m.s } : null),
  probe(m) { const p = at(m); return p && int(m.n, 0, 2 ** 31 - 1) ? { ...p, n: m.n } : null; },
  'clipboard-get': none,
  'clipboard-set': (m) => (typeof m.s === 'string' && m.s.length >= 1 && m.s.length <= CLIPBOARD_MAX && m.s.isWellFormed() ? { s: m.s } : null),
};
const FROM_PAGE = new Set(Object.keys(MESSAGES));
// The message as passed on to the capture core: {t, …its checked fields}, or null when
// it is to be dropped. Only for a type in FROM_PAGE.
function fromPage(msg) {
  const fields = MESSAGES[msg.t](msg);
  return fields ? { t: msg.t, ...fields } : null;
}
// The largest frame accepted from the capture core.
const MAX_FRAME = 8 * 1024 * 1024;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// The same cookie parser as the rest of the app (services/sessionCookie.js).
const sessionToken = (req) => sessionCookie(req);
const notRunning = () => Object.assign(new Error('Castpane is not running'), { status: 503, code: 'NOT_RUNNING' });

// The token the capture core expects, read at each connection: the app writes it
// (0600) and may replace it when it restarts. Refused unless it is a plain file that
// only this account can read.
function readHostToken(home = HOME()) {
  const file = path.join(home, 'host.token');
  let st;
  try { st = fs.lstatSync(file); } catch { throw notRunning(); }
  if (!st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw Object.assign(new Error('host.token must be a file only this account can read (0600)'), { status: 503, code: 'TOKEN_UNSAFE' });
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!token || token.length > 512) throw Object.assign(new Error('host.token is empty'), { status: 503, code: 'TOKEN_UNSAFE' });
  return token;
}

// Whether the capture core's socket is there (the app is running and sharing).
function hostRunning(home = HOME()) {
  try { return fs.lstatSync(path.join(home, 'host.sock')).isSocket(); } catch { return false; }
}

// Passes: one per password or passkey check, for this admin and this sign-in only, in
// memory.
function createPasses({ ttl = PASS_MS, now = () => Date.now() } = {}) {
  const passes = new Map();
  const sweep = () => { for (const [k, p] of passes) if (p.expires <= now()) passes.delete(k); };
  return {
    issue(userId, token) { sweep(); for (const [k, p] of passes) if (p.userId === userId) passes.delete(k); const id = crypto.randomBytes(24).toString('hex'); passes.set(id, { userId, session: sha(token), expires: now() + ttl }); return { pass: id, expiresAt: new Date(now() + ttl).toISOString() }; },
    check(id, userId, token) { sweep(); const p = passes.get(String(id || '')); return !!p && p.userId === userId && p.session === sha(token) && p.expires > now(); },
    end(userId) { for (const [k, p] of passes) if (p.userId === userId) passes.delete(k); },
    endAll() { passes.clear(); },
    size: () => passes.size,
  };
}

function frame(kind, payload) { const h = Buffer.alloc(5); h[0] = kind; h.writeUInt32BE(payload.length, 1); return Buffer.concat([h, payload]); }

// A connection to the capture core. Nothing is started: no socket, not running.
function connectHost({ home = HOME() } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.connect(path.join(home, 'host.sock'));
    c.once('connect', () => { c.removeAllListeners('error'); resolve(c); });
    c.once('error', () => reject(notRunning()));
  });
}

// The passes the routes issue and the socket checks, shared by both.
const sharedPasses = createPasses();

// members: server/members.js, the other Macs (docs/multi-mac.md), or null for this Mac alone.
function installRemoteRoutes(app, { verifyToken, auth = require('./controllers/authController'), passes = sharedPasses, home = HOME, members = null, publicOrigin = () => require('./siteConfig').publicOrigin() } = {}) {
  const adminOnly = (req, res, next) => (req.role === 'admin' ? next() : res.status(403).json({ message: 'Admin only' }));
  const chain = [verifyToken, adminOnly, (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); }];
  // The machines the page lists: this Mac, then the others that joined it.
  app.get('/api/remote/machines', ...chain, (req, res) => {
    res.json({ machines: [{ id: 'local', name: os.hostname().replace(/\.local$/, ''), local: true, online: true, running: hostRunning(home()) }, ...(members ? members.list() : [])], canAdd: !!members });
  });
  if (members) {
    // A one-time code for another Mac to join with, and this hub's address for it. Only
    // with a stable HTTPS address: a member keeps it.
    app.post('/api/remote/members/code', ...chain, (req, res) => {
      const origin = publicOrigin();
      if (!origin.startsWith('https://')) return res.status(409).json({ message: 'This Mac needs its own HTTPS address first', code: 'NO_PUBLIC_ADDRESS' });
      const issued = members.code();
      audit({ source: 'members', action: 'code', username: req.username, ip: resolveClientIp(req) });
      res.json({ ...issued, hub: origin });
    });
    app.delete('/api/remote/members/:id', ...chain, (req, res) => {
      const id = String(req.params.id);
      const name = members.name(id);
      let removed; try { removed = members.remove(id); } catch (e) { return res.status(e.status || 500).json({ message: e.message }); }
      if (!removed) return res.status(404).json({ message: 'No such Mac' });
      audit({ source: 'members', action: 'remove', member: id, name, username: req.username, ip: resolveClientIp(req) });
      res.json({ ok: true });
    });
  }
  // The admin's own passkey instead of the password and code, when they have one.
  app.post('/api/remote/pass/passkey', ...chain, async (req, res, next) => { try { res.json((await auth.adminPasskeyStart(req)) || { challenge: null }); } catch (e) { next(e); } });
  // A pass to open the stream: the admin's passkey, or their password and two-step code.
  app.post('/api/remote/pass', ...chain, async (req, res, next) => {
    try {
      if (req.body?.passkey) {
        try { await auth.adminPasskeyAgain(req, req.body.passkey); } catch (e) { return res.status(e.status || 400).json({ message: 'Passkey not accepted', code: 'PASSKEY_REFUSED' }); }
      } else {
        if (!(await auth.adminAgain(req, res, 'remote-open', 'remote'))) return;
        auth.adminGranted(req, 'remote');
      }
      const issued = passes.issue(req.userId, sessionToken(req) || req.headers.authorization || '');
      audit({ source: 'remote', action: 'pass', username: req.username, via: req.body?.passkey ? 'passkey' : 'password', ip: resolveClientIp(req) });
      res.json(issued);
    } catch (e) { try { auth.adminKept(req); } catch { /* nothing granted */ } next(e); }
  });
  app.post('/api/remote/pass/end', ...chain, (req, res) => { passes.end(req.userId); res.json({ ok: true }); });
}

// onOpen({username, ip}): a viewer was let in (server/start.js tells the admins).
// signOut(userId, token): that sign-in ends, as when it is signed out from the
// account's device list (the app's "Stop sharing now").
function installRemote(server, { passes = sharedPasses, connect = connectHost, members = null, tokenOf = readHostToken, onOpen = () => {}, tickMs = 5000, secret = () => process.env.JWT_SECRET, principalOf = resolveLivePrincipal, allowedSocket = (req) => require('./siteConfig').isAllowedSocket(req), signOut = (userId, token) => require('./controllers/authController').endSession(userId, token) } = {}) {
  // A page's message is small, but for clipboard-set: 100 000 UTF-16 units, at most six
  // bytes each as JSON (\u0000), well within the capture core's 1 MiB frame.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let auditMinute = 0, audited = 0; const mayAudit = () => { const m = Math.floor(Date.now() / 60000); if (m !== auditMinute) { auditMinute = m; audited = 0; } return ++audited <= 30; };
  let current = null;
  // The last viewer let in, kept after their page or the capture core has gone: the
  // app's "Stop sharing now" and Pause close the capture core's side, which can reach
  // this server before the app's end-viewer call does, and the sign-in they watched
  // from must still be signed out then.
  let last = null;
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/member' && members) return members.upgrade(req, socket, head);
    if (url.pathname !== '/remote') return;
    socket.on('error', () => {});
    let who;
    const reject = (status) => { if (who || mayAudit()) audit({ source: 'remote', path: '/remote', status, username: who?.username }); socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    try {
      if (!allowedSocket(req)) return reject(403);
      const token = sessionToken(req); if (!token) return reject(401);
      let decoded; try { decoded = jwt.verify(token, secret()); } catch { return reject(401); }
      const principal = await principalOf(token, decoded.id); if (!principal) return reject(401);
      who = principal;
      if (principal.role !== 'admin') return reject(403);
      const pass = url.searchParams.get('pass');
      if (!passes.check(pass, principal.id, token)) return reject(403);
      // This Mac, or another that joined it.
      const machine = url.searchParams.get('machine') || 'local';
      if (machine !== 'local' && !members?.has(machine)) return reject(404);
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (ws) => serve(ws, { principal, token, pass, machine, ip: resolveClientIp(req) }));
    } catch (e) { reject(e.status || 500); }
  });

  async function serve(ws, { principal, token, pass, machine = 'local', ip }) {
    // One viewer at a time: a new page takes over from the last one.
    if (current) current.close('replaced');
    let host = null, closed = false, timer = null, dropping = false, video = 0, checking = false;
    const started = Date.now();
    const member = machine !== 'local';
    const me = { close: (reason) => close(reason), username: principal.username, userId: principal.id, token, since: new Date(started).toISOString(), ...(member ? { machine: members.name(machine) } : {}) };
    const seen = { userId: principal.id, token };
    current = me; last = seen;
    const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    function close(reason = 'closed') {
      if (closed) return;
      closed = true; clearInterval(timer); if (current === me) current = null;
      // A viewer who left by themselves is not signed out by a later Pause.
      if (reason.startsWith('page') && last === seen) last = null;
      try { host?.destroy(); } catch { /* gone */ }
      sendJson({ t: 'closed', reason }); try { ws.close(); } catch { /* gone */ }
      audit({ source: 'remote', action: 'end', username: principal.username, reason, seconds: Math.round((Date.now() - started) / 1000), frames: video, ...(member ? { member: machine, machine: me.machine } : {}) });
    }
    audit({ source: 'remote', action: 'open', username: principal.username, ip, ...(member ? { member: machine, machine: me.machine } : {}) });
    try { onOpen({ username: principal.username, userId: principal.id, ip, at: started }); } catch (e) { console.error('remote: the open was not announced:', e.message); }
    ws.on('close', () => close('page left')); ws.on('error', () => close('page error'));
    try {
      if (member) {
        // The member says hello to its own capture core with its own token.
        host = await members.connect(machine, principal.username);
        if (closed) { host.destroy(); return; }
      } else {
        const secretToken = tokenOf();
        host = await connect();
        if (closed) { host.destroy(); return; }
        host.write(frame(1, Buffer.from(JSON.stringify({ t: 'hello', token: secretToken }))));
      }
    } catch (e) {
      sendJson({ t: 'error', where: 'host', code: e.code || '', message: e.code === 'NOT_RUNNING' ? 'not-running' : 'host-unavailable' });
      return close('no host');
    }
    // The capture core's stream, kept in pieces until a whole frame is there, so a large
    // frame arriving in many pieces is joined once.
    let buf = Buffer.alloc(0), pieces = [], held = 0, need = 5;
    host.on('data', (d) => {
      pieces.push(d); held += d.length;
      if (held < need) return;
      buf = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, held); pieces = []; held = 0;
      need = 5;
      while (buf.length >= 5) {
        const n = buf.readUInt32BE(1); if (n > MAX_FRAME) return close('bad frame');
        if (buf.length < 5 + n) { need = 5 + n; break; }
        const kind = buf[0], payload = buf.subarray(5, 5 + n); buf = buf.subarray(5 + n);
        if (kind === 1) {
          // Another Mac's words are checked before the page sees them (server/members.js),
          // and it cannot pile them up behind a page that is not reading.
          if (member && ws.bufferedAmount > 16 * 1024 * 1024) return close('page behind');
          const text = member ? vetFromMember(payload.toString('utf8')) : payload.toString('utf8');
          if (text !== null && ws.readyState === 1) ws.send(text);
        }
        else if (kind === 2 && payload.length > 9) {
          // Behind on the page's side: drop until the next key frame, and ask for one, so
          // the picture never decodes from a frame it is missing.
          const key = (payload[0] & 1) === 1;
          if (ws.bufferedAmount > 4 * 1024 * 1024) { if (!dropping) { dropping = true; host.write(frame(1, Buffer.from('{"t":"key-frame"}'))); } continue; }
          if (dropping && !key) continue;
          dropping = false; video++;
          if (ws.readyState === 1) ws.send(payload, { binary: true });
        }
      }
      if (buf.length) { pieces = [buf]; held = buf.length; buf = Buffer.alloc(0); }
    });
    host.on('close', () => close('host closed')); host.on('error', () => close('host error'));
    let windowStart = Date.now(), count = 0, lastClipboard = 0, lastLarge = 0;
    ws.on('message', (raw, binary) => {
      if (closed) return;
      if (binary) return close('binary from page');
      if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; }
      if (++count > 600) return close('too fast');
      // Only clipboard-set is ever large (text is at most 4000 units, 24 KB as JSON): a
      // large message is parsed at most once a second, and one too soon is answered busy.
      const large = raw.length > 32768;
      if (large) {
        const tooSoon = Date.now() - lastLarge < 1000;
        lastLarge = Date.now();
        if (tooSoon) return raw.subarray(0, 24).toString().startsWith('{"t":"clipboard-set"') ? sendJson({ t: 'clipboard-busy' }) : close('too large');
      }
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return close('bad message'); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string' || !Object.hasOwn(MESSAGES, msg.t)) return close('unknown message');
      if (large && msg.t !== 'clipboard-set') return close('too large');
      const clean = fromPage(msg);
      if (!clean) return;
      const clipboard = clean.t.startsWith('clipboard-');
      // The clipboard: at most one use a second; the page is told when it was too soon.
      if (clipboard) {
        if (Date.now() - lastClipboard < 1000) return sendJson({ t: 'clipboard-busy' });
        lastClipboard = Date.now();
      }
      // The capture core not reading: a page cannot pile up input behind it.
      if (host.writableLength > 1024 * 1024) return close('host backed up');
      host.write(frame(1, Buffer.from(JSON.stringify(clean))));
      // Each use in the log and the Mac's Activity, without its text.
      if (clipboard) audit({ source: 'remote', action: clean.t === 'clipboard-get' ? 'clipboard-read' : 'clipboard-write', username: principal.username, ...(clean.s ? { chars: clean.s.length } : {}), ...(member ? { member: machine, machine: me.machine } : {}) });
    });
    // Still an active admin, still this sign-in, pass not run out.
    timer = setInterval(async () => {
      if (checking || closed) return; checking = true;
      try { const p = await principalOf(token, principal.id); if (!p || p.role !== 'admin') close('signed out'); else if (!passes.check(pass, principal.id, token)) close('pass ended'); }
      catch { close('check failed'); } finally { checking = false; }
    }, tickMs);
  }
  return {
    wss,
    // Who is watching now, for the app's menu (server/localApi.js).
    viewer: () => (current ? { username: current.username, since: current.since, ...(current.machine ? { machine: current.machine } : {}) } : null),
    // The app's "Stop sharing now" and Pause: the viewer is let go, every pass ends,
    // and the sign-in the last viewer watched from is signed out, so the same page
    // cannot simply open the stream again. That holds when the viewer's connection has
    // already closed (the app stops its capture core too). Resolves to whether there
    // was a viewer to end.
    async endViewer(reason = 'ended on the Mac') {
      const target = current ? { userId: current.userId, token: current.token } : last;
      current?.close(reason);
      passes.endAll();
      last = null;
      if (!target) return false;
      await signOut(target.userId, target.token);
      return true;
    },
    close() { current?.close('server stopping'); wss.close(); },
  };
}

module.exports = { installRemoteRoutes, installRemote, createPasses, readHostToken, hostRunning, connectHost, FROM_PAGE, fromPage, HOME };
