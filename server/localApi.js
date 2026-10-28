// The app ⇄ server channel (docs/protocol.md): Castpane.app asks the
// server how it is doing, makes the first admin, reads recent activity and ends the
// current viewer. It answers only a request made on this Mac to 127.0.0.1 (or ::1),
// named by its loopback address, that carries `Authorization: Bearer <local.token>`.
//
// Requests a tunnel or a proxy forwards also reach the server from loopback: cloudflared
// and `tailscale serve` run on this Mac. So anything that looks forwarded or sent by a
// page (a Cloudflare or forwarding header, an Origin, the public Host) is refused as if
// the path were not there, before the token is even looked at. The token is what
// actually admits the app; these keep the path out of the public address altogether.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { isLoopback } = require('./services/clientIp');
const { AUDIT_LOG } = require('./services/audit');

const FORWARDED = ['cf-connecting-ip', 'cf-ray', 'cdn-loop', 'cf-ipcountry', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'tailscale-user-login', 'origin', 'cookie'];
const sameToken = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// local.token: the app writes a fresh one (0600) before it starts the server; when there
// is none (the server run by hand), one is made. An existing file is never replaced:
// one that is not a private regular file, or holds no usable token, is refused, so the
// app and the server never quietly disagree about it.
function ensureLocalToken(home) {
  const file = path.join(home, 'local.token');
  let st = null;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st) {
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error('local.token must be a file only this account can read (0600)');
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length < 32 || t.length > 512) throw new Error('local.token holds no usable token');
    return t;
  }
  const t = crypto.randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, `${t}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  return t;
}

// The latest remote opens and ends, clipboard reads and writes, and sign-ins, newest first, from the end of the
// audit log (the last 2 MB of it: a week's log is rotated away by logRotation.js).
function readActivity({ limit = 50, file = AUDIT_LOG } = {}) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - 2 * 1024 * 1024);
      const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8'); if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.source === 'remote' && (e.action === 'open' || e.action === 'end')) {
      out.push({ at: e.ts, kind: e.action === 'open' ? 'remote-open' : 'remote-end', username: e.username || '', ...(e.ip ? { ip: e.ip } : {}), ...(typeof e.machine === 'string' ? { machine: e.machine } : {}), ...(e.action === 'end' ? { reason: e.reason || '', seconds: e.seconds || 0 } : {}) });
    } else if (e.source === 'remote' && (e.action === 'clipboard-read' || e.action === 'clipboard-write')) {
      // A run of the same use by the same person is one row, with how many times.
      const prev = out[out.length - 1], machine = typeof e.machine === 'string' ? e.machine : '';
      if (prev?.kind === e.action && prev.username === (e.username || '') && (prev.machine || '') === machine) prev.count = (prev.count || 1) + 1;
      else out.push({ at: e.ts, kind: e.action, username: e.username || '', ...(machine ? { machine } : {}) });
    } else if (e.source === 'auth' && e.action === 'sign-in') {
      out.push({ at: e.ts, kind: 'sign-in', username: e.username || '', method: e.method || 'password', ...(e.ip ? { ip: e.ip } : {}) });
    }
  }
  return out;
}

// home: CASTPANE_HOME. remote: what installRemote returned (viewer, endViewer).
// sessionCount(): live sign-ins. version: this server's version.
// memberLink: this Mac's link to another Mac it joined (server/memberLink.js).
function createLocalRoutes({ home, remote, version, memberLink = null, auth = require('./controllers/authController'), usersDB = require('./stores').usersDB, sessionsDB = require('./stores').sessionsDB, publicOrigin = () => require('./siteConfig').publicOrigin(), loopbackHosts = () => require('./siteConfig').loopbackPorts().flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]), activity = readActivity }) {
  const token = () => ensureLocalToken(home);
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const local = isLoopback(req.socket?.remoteAddress) && loopbackHosts().includes(req.headers.host) && !FORWARDED.some((h) => req.headers[h] !== undefined);
    if (!local) return res.status(404).json({ message: 'Not found' });
    const given = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1] || '';
    let expected; try { expected = token(); } catch { return res.status(500).json({ message: 'local.token cannot be read' }); }
    if (!given || !sameToken(given, expected)) return res.status(401).json({ message: 'Bad token' });
    next();
  });
  router.use(express.json({ limit: '8kb' }));
  const count = (db, q) => new Promise((ok, no) => db.count(q, (e, n) => (e ? no(e) : ok(n))));
  const active = { lifecycleStatus: { $nin: ['disabled', 'deleted_tombstone'] } };
  router.get('/status', async (req, res, next) => {
    try {
      const [users, admins, sessions] = await Promise.all([count(usersDB, active), count(usersDB, { ...active, role: 'admin' }), count(sessionsDB, { expiresAt: { $gt: new Date() } })]);
      res.json({ version, users, admins, viewer: remote?.viewer() || null, sessions, publicOrigin: publicOrigin() || null });
    } catch (e) { next(e); }
  });
  router.post('/setup', async (req, res) => {
    try { res.status(201).json({ user: await auth.createFirstAdmin(req.body || {}) }); }
    catch (e) { res.status(e.status || 500).json({ message: e.status ? e.message : 'Error', ...(e.code ? { code: e.code } : {}) }); }
  });
  router.get('/activity', (req, res) => {
    const n = Number(req.query.limit);
    res.json({ items: activity({ limit: Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50 }) });
  });
  router.post('/end-viewer', async (req, res) => {
    try { res.json({ ended: !!(await remote?.endViewer('ended on the Mac')) }); } catch (e) { console.error('end viewer:', e.message); res.status(500).json({ message: 'Error' }); }
  });
  // Joining another Mac's Castpane, and leaving it (docs/multi-mac.md).
  router.get('/member', (req, res) => res.json(memberLink ? memberLink.status() : { state: 'off', hub: null }));
  router.post('/member/join', async (req, res) => {
    if (!memberLink) return res.status(404).json({ message: 'Not found' });
    try { res.json(await memberLink.join(req.body?.hub, req.body?.code)); } catch (e) { res.status(e.status || 500).json({ message: e.status ? e.message : 'Error', ...(e.code ? { code: e.code } : {}) }); }
  });
  router.post('/member/leave', (req, res) => { memberLink?.leave(); res.json({ ok: true }); });
  router.use((req, res) => res.status(404).json({ message: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => { console.error('local api:', err.message); res.status(err.status || 500).json({ message: err.status ? err.message : 'Error' }); });
  return router;
}

module.exports = { createLocalRoutes, ensureLocalToken, readActivity };
