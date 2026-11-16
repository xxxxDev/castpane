// The app ⇄ server channel (docs/protocol.md): Castpane.app asks the
// server how it is doing, makes the first admin, keeps the one account (the others are
// deleted), reads recent activity and ends the current viewer. It answers only a request made on this Mac to 127.0.0.1 (or ::1),
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
const { activeUserQuery, normalizeUsername } = require('./services/userLifecycle');

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

// The latest remote opens and ends, clipboard reads and writes, sign-ins and accounts the
// server removed (reason 'not-an-admin', authController.removeMembers, or 'one-account',
// keepOneAccount), newest first, from the end of the
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
    } else if (e.source === 'remote' && (e.action === 'clipboard-read' || e.action === 'clipboard-write' || e.action === 'unlock')) {
      // A run of the same use by the same person is one row, with how many times.
      const prev = out[out.length - 1], machine = typeof e.machine === 'string' ? e.machine : '';
      if (prev?.kind === e.action && prev.username === (e.username || '') && (prev.machine || '') === machine) prev.count = (prev.count || 1) + 1;
      else out.push({ at: e.ts, kind: e.action, username: e.username || '', ...(machine ? { machine } : {}) });
    } else if (e.source === 'auth' && e.action === 'sign-in') {
      out.push({ at: e.ts, kind: 'sign-in', username: e.username || '', method: e.method || 'password', ...(e.ip ? { ip: e.ip } : {}) });
    } else if (e.source === 'users' && e.action === 'account-removed') {
      out.push({ at: e.ts, kind: 'account-removed', username: e.username || '', reason: e.reason || '' });
    }
  }
  return out;
}

// The name the setup assistant gave the first administrator: the newest
// {source:'users', action:'first-admin'} line (authController.createFirstAdmin), from the
// audit log and then its rotated segments (services/logRotation.js: archive/<name>-<stamp>.log
// beside it, kept a year), newest first. Each file is read from its end, so the newest line
// ends the search; at most SCAN_MAX bytes are read in all; null when none is found. Only
// lines whose text holds the action's name are parsed, and a line longer than LINE_MAX is
// passed over. Links and anything not a regular file are not read. The local API asks
// once per process (createLocalRoutes).
const FIRST_ADMIN = Buffer.from('"first-admin"');
const SCAN_MAX = 512 * 1024 * 1024, CHUNK = 1024 * 1024, LINE_MAX = 64 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
function firstAdminOf(line) {
  let e; try { e = JSON.parse(line.toString('utf8')); } catch { return null; }
  return e && e.source === 'users' && e.action === 'first-admin' && typeof e.username === 'string' && e.username ? e.username : null;
}
async function lastFirstAdminIn(file, budget) {
  let fh;
  try { fh = await fs.promises.open(file, fs.constants.O_RDONLY | NOFOLLOW); } catch { return { name: null, read: 0 }; }
  let read = 0;
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { name: null, read: 0 };
    // carry: the end of a line that begins before pos, up to and with its line end.
    let pos = st.size, carry = Buffer.alloc(0), skipping = false;
    while (pos > 0 && read < budget) {
      const n = Math.min(CHUNK, pos, budget - read);
      pos -= n;
      const chunk = Buffer.alloc(n);
      const { bytesRead } = await fh.read(chunk, 0, n, pos);
      read += bytesRead;
      if (bytesRead < n) break; // cut short meanwhile (rotated): what is left is not this file
      let buf;
      if (skipping) {
        // Still inside a line too long to be one of these: up to its start is passed over.
        const nl = chunk.lastIndexOf(10);
        if (nl === -1) continue;
        buf = chunk.subarray(0, nl + 1); skipping = false;
      } else buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // The lines wholly read: those after the first line end, or all at the file's start.
      const nl = buf.indexOf(10);
      if (pos > 0 && nl === -1) {
        if (buf.length > LINE_MAX) { carry = Buffer.alloc(0); skipping = true; } else carry = Buffer.from(buf);
        continue;
      }
      const from = pos === 0 ? 0 : nl + 1;
      for (let at = buf.lastIndexOf(FIRST_ADMIN); at >= from;) {
        const lineStart = buf.lastIndexOf(10, at) + 1, lineEnd = buf.indexOf(10, at);
        const name = firstAdminOf(buf.subarray(lineStart, lineEnd === -1 ? buf.length : lineEnd));
        if (name) return { name, read };
        if (lineStart === 0) break;
        at = buf.lastIndexOf(FIRST_ADMIN, lineStart - 1);
      }
      carry = Buffer.from(buf.subarray(0, from));
      if (carry.length > LINE_MAX) { carry = Buffer.alloc(0); skipping = true; }
    }
  } finally { await fh.close().catch(() => {}); }
  return { name: null, read };
}
async function findWizardName({ file = AUDIT_LOG, budget = SCAN_MAX } = {}) {
  const files = [file];
  const archive = path.join(path.dirname(file), 'archive'), base = path.basename(file, path.extname(file));
  try {
    const dir = await fs.promises.lstat(archive);
    if (dir.isDirectory() && !dir.isSymbolicLink()) {
      const segments = [];
      for (const name of await fs.promises.readdir(archive)) {
        if (!name.startsWith(`${base}-`) || !name.endsWith('.log')) continue;
        const full = path.join(archive, name);
        try { const st = await fs.promises.lstat(full); if (st.isFile()) segments.push({ full, name, at: st.mtimeMs }); } catch { /* gone meanwhile */ }
      }
      segments.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
      files.push(...segments.map((x) => x.full));
    }
  } catch { /* no archive yet */ }
  let left = budget;
  for (const f of files) {
    if (left <= 0) break;
    const { name, read } = await lastFirstAdminIn(f, left);
    if (name) return name;
    left -= read;
  }
  return null;
}

// home: CASTPANE_HOME. remote: what installRemote returned (viewer, endViewer).
// sessionCount(): live sign-ins. version: this server's version.
// memberLink: this Mac's link to another Mac it joined (server/memberLink.js).
function createLocalRoutes({ home, remote, version, memberLink = null, auth = require('./controllers/authController'), usersDB = require('./stores').usersDB, sessionsDB = require('./stores').sessionsDB, publicOrigin = () => require('./siteConfig').publicOrigin(), loopbackHosts = () => require('./siteConfig').loopbackPorts().flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]), activity = readActivity, wizardName = findWizardName }) {
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
  // users: active accounts, by the rule createFirstAdmin is held to (services/userLifecycle.js),
  // so the setup assistant opens on 0. admins: the administrators GET /accounts lists
  // (auth.activeAdmins: active, nothing pending), so the app offers the choice (admins > 1)
  // only with a list to choose from.
  const active = activeUserQuery();
  router.get('/status', async (req, res, next) => {
    try {
      const [users, admins, sessions] = await Promise.all([count(usersDB, active), auth.activeAdmins().then((a) => a.length), count(sessionsDB, { expiresAt: { $gt: new Date() } })]);
      res.json({ version, users, admins, viewer: remote?.viewer() || null, sessions, publicOrigin: publicOrigin() || null });
    } catch (e) { next(e); }
  });
  // The setup assistant's name in the audit log (wizardName), looked for once per process:
  // a scan reads up to SCAN_MAX. Looked for again after a setup or a keep; a scan that
  // fails is not kept.
  let wizardScan = null;
  const wizardOnce = () => {
    if (!wizardScan) {
      const scan = Promise.resolve().then(() => wizardName());
      wizardScan = scan;
      scan.catch(() => { if (wizardScan === scan) wizardScan = null; });
    }
    return wizardScan.catch(() => null);
  };
  const forgetWizard = () => { wizardScan = null; };
  router.post('/setup', async (req, res) => {
    try { const user = await auth.createFirstAdmin(req.body || {}); forgetWizard(); res.status(201).json({ user }); }
    catch (e) { res.status(e.status || 500).json({ message: e.status ? e.message : 'Error', ...(e.code ? { code: e.code } : {}) }); }
  });
  // One account (docs/protocol.md): the active administrators to choose from, when there
  // is more than one (status.admins), and the choice. wizard marks the one the setup
  // assistant made, when the audit log still says which (findWizardName); never a hash or
  // a secret. deletes: what keeping one of them deletes, the other listed ones (listed)
  // and every other account not a tombstone (others: members, disabled ones, ones with
  // something pending, other roles), from the same read as the list.
  const sayError = (res, e) => res.status(e.status || 500).json({ message: e.status ? e.message : 'Error', ...(e.code ? { code: e.code } : {}) });
  router.get('/accounts', async (req, res) => {
    try {
      const { admins, others } = await auth.keepChoice();
      // The setup assistant marks its account (madeBySetup) from this version; for one made
      // before, its audit line, as above, looked for only then.
      const marked = admins.filter((a) => a.madeBySetup);
      const wizard = !marked.length && admins.length ? await wizardOnce() : null;
      const key = (v) => { try { return normalizeUsername(v); } catch { return null; } };
      const wanted = wizard ? key(wizard) : null;
      // Only a name that is one account's: two that fold the same mark neither.
      const matching = wanted ? admins.filter((a) => key(a.username) === wanted) : [];
      res.json({
        accounts: admins.map((a) => ({ id: a.id, username: a.username, name: a.name, wizard: marked.length ? marked.length === 1 && marked[0] === a : matching.length === 1 && matching[0] === a })),
        deletes: { listed: Math.max(0, admins.length - 1), others },
      });
    } catch (e) { console.error('local accounts:', e.message); sayError(res, e); }
  });
  router.post('/accounts/keep', async (req, res) => {
    try { res.json(await auth.keepOneAccount(req.body?.id)); }
    catch (e) { if (!e.status) console.error('keep account:', e.message); sayError(res, e); }
    finally { forgetWizard(); }
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

module.exports = { createLocalRoutes, ensureLocalToken, readActivity, findWizardName };
