// Several Macs in one web app, the member's side (docs/multi-mac.md): this Mac joined
// another Mac's Castpane (the hub) and keeps one link out to it, so the hub's admins can
// see and use this screen from the hub's web app. The hub never gets this Mac's
// host.token: a session is this server's own connection to its capture core, said hello
// to here, and only its stream crosses the link (server/members.js has the protocol).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { audit } = require('./services/audit');
const { FROM_PAGE, fromPage } = require('./remote');

const SLICE = 256 * 1024;
const BACKLOG = 4 * 1024 * 1024;
// The hub not reading what this Mac sends: the session ends past this.
const UPLINK_BACKLOG = 16 * 1024 * 1024;
// After Stop Sharing Now, the hub may not open a session again for this long.
const STOPPED_MS = 5 * 60 * 1000;
// A frame from the hub is a page's message, never larger than this (remote.js).
const FRAME_MAX = 2 * 1024 * 1024;

const frame = (kind, payload) => { const h = Buffer.alloc(5); h[0] = kind; h.writeUInt32BE(payload.length, 1); return Buffer.concat([h, payload]); };

// The hub's address as given: https, or http to this Mac itself (tests and a hub on
// the same Mac); nothing but an origin.
function hubOrigin(text) {
  let u; try { u = new URL(String(text || '').trim()); } catch { return null; }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local)) || u.username || u.password) return null;
  return u.origin;
}

// home: CASTPANE_HOME. connectHost() and tokenOf(): this Mac's capture core
// (server/remote.js). running(): whether its socket is there.
function createMemberLink({ home, file = path.join(home, 'data', 'member.json'), connectHost, tokenOf, running, name = () => os.hostname().replace(/\.local$/, ''), retryMs = [1000, 60000], timeoutMs = 10000, onChange = () => {} } = {}) {
  let config = load(), ws = null, state = config ? 'connecting' : 'off', retry = null, delay = retryMs[0], session = null, poll = null, wasRunning = null, stopped = false;
  let blockedUntil = 0, joinGen = 0, auditMinute = 0, audited = 0;
  const mayAudit = () => { const m = Math.floor(Date.now() / 60000); if (m !== auditMinute) { auditMinute = m; audited = 0; } return ++audited <= 30; };
  const blocked = () => Date.now() < blockedUntil;

  function load() {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      return hubOrigin(c.hub) && /^[0-9a-f]{12}$/.test(c.id) && /^[0-9a-f]{64}$/.test(c.secret) ? { hub: hubOrigin(c.hub), id: c.id, secret: c.secret, hubName: String(c.hubName || '') } : null;
    } catch { return null; }
  }
  function save(c) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  }
  const set = (s) => { if (state !== s) { state = s; onChange(state); } };
  const memberUrl = (origin) => origin.replace(/^http/, 'ws') + '/member';
  const sendJson = (sock, o) => { if (sock?.readyState === 1) sock.send(JSON.stringify(o)); };

  function endSession(tell = true) {
    if (!session) return;
    const s = session; session = null;
    if (s.sock && mayAudit()) audit({ source: 'remote', action: 'end', username: s.by, via: config?.hub || '', reason: 'ended', seconds: Math.round((Date.now() - Date.parse(s.since)) / 1000) });
    try { s.sock?.destroy(); } catch { /* gone */ }
    if (tell) sendJson(ws, { t: 'closed', n: s.n });
  }

  async function openSession(n, by) {
    endSession();
    if (blocked()) return sendJson(ws, { t: 'failed', n });
    const s = { n, by: typeof by === 'string' ? by.slice(0, 64) : '', since: new Date().toISOString(), sock: null, pieces: [], held: 0, lastClipboard: 0 };
    session = s;
    try {
      const token = tokenOf();
      const sock = await connectHost();
      if (session !== s) { sock.destroy(); return; }
      s.sock = sock;
      sock.write(frame(1, Buffer.from(JSON.stringify({ t: 'hello', token }))));
      sendJson(ws, { t: 'opened', n });
      // In this Mac's log and Activity too: who, through which Mac.
      if (mayAudit()) audit({ source: 'remote', action: 'open', username: s.by, via: config?.hub || '', ip: config ? new URL(config.hub).hostname : '' });
      sock.on('data', (d) => {
        if (session !== s || ws?.readyState !== 1) return;
        if (ws.bufferedAmount > UPLINK_BACKLOG) return endSession();
        const head = Buffer.alloc(4); head.writeUInt32BE(n);
        for (let i = 0; i < d.length; i += SLICE) ws.send(Buffer.concat([head, d.subarray(i, i + SLICE)]), { binary: true });
      });
      sock.on('close', () => { if (session === s) endSession(); });
      sock.on('error', () => { if (session === s) endSession(); });
    } catch {
      if (session === s) { session = null; sendJson(ws, { t: 'failed', n }); }
    }
  }

  // Told to the page as the hub tells it, through the session's stream.
  function busy(s) {
    if (ws?.readyState !== 1) return;
    const head = Buffer.alloc(4); head.writeUInt32BE(s.n);
    ws.send(Buffer.concat([head, frame(1, Buffer.from('{"t":"clipboard-busy"}'))]), { binary: true });
  }

  // What the hub sends for the capture core, checked here as the hub checks a page's: the
  // same allow-list, the clipboard at most once a second and in this Mac's log too.
  function fromHub(s, chunk) {
    s.pieces.push(chunk); s.held += chunk.length;
    if (s.held > FRAME_MAX + 5) return endSession();
    let buf = s.pieces.length === 1 ? s.pieces[0] : Buffer.concat(s.pieces, s.held);
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1);
      if (buf[0] !== 1 || n > FRAME_MAX) return endSession();
      if (buf.length < 5 + n) break;
      let msg; try { msg = JSON.parse(buf.subarray(5, 5 + n).toString()); } catch { return endSession(); }
      buf = buf.subarray(5 + n);
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !FROM_PAGE.has(msg.t)) return endSession();
      const clean = fromPage(msg);
      if (!clean) continue;
      if (clean.t.startsWith('clipboard-')) {
        if (Date.now() - s.lastClipboard < 1000) { busy(s); continue; }
        s.lastClipboard = Date.now();
        if (mayAudit()) audit({ source: 'remote', action: clean.t === 'clipboard-get' ? 'clipboard-read' : 'clipboard-write', username: s.by, via: config?.hub || '', ...(clean.s ? { chars: clean.s.length } : {}) });
      }
      // The capture core not reading: the session ends rather than piling up.
      if (s.sock.writableLength > BACKLOG) return endSession();
      s.sock.write(frame(1, Buffer.from(JSON.stringify(clean))));
    }
    s.pieces = buf.length ? [buf] : []; s.held = buf.length;
  }

  function connect() {
    if (!config || stopped) return;
    clearTimeout(retry); retry = null;
    set('connecting');
    const sock = new WebSocket(memberUrl(config.hub), { handshakeTimeout: timeoutMs, maxPayload: 2 * 1024 * 1024 });
    ws = sock;
    let welcomed = false;
    sock.on('open', () => sendJson(sock, { t: 'hello', id: config.id, secret: config.secret, name: name() }));
    sock.on('message', (raw, binary) => {
      if (ws !== sock) return;
      if (binary) {
        if (raw.length < 4 || !session?.sock || raw.readUInt32BE(0) !== session.n) return;
        return fromHub(session, raw.subarray(4));
      }
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m?.t === 'welcome') { welcomed = true; delay = retryMs[0]; set('connected'); wasRunning = null; report(); return; }
      if (m?.t === 'refused') { set('removed'); stopped = true; return; }
      if (!welcomed) return;
      if (m?.t === 'open' && Number.isInteger(m.n) && m.n >= 0 && m.n <= 0xffffffff) openSession(m.n, m.by);
      else if (m?.t === 'close' && session?.n === m.n) endSession(false);
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (ws !== sock) return;
      ws = null; endSession(false);
      if (stopped || !config) return;
      set('connecting');
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, retryMs[1]);
    });
  }
  function report() {
    const now = !!running() && !blocked();
    if (now !== wasRunning) { wasRunning = now; sendJson(ws, { t: 'status', running: now }); }
  }

  if (config) { connect(); }
  poll = setInterval(() => { if (ws && state === 'connected') report(); }, 3000);
  poll.unref?.();

  return {
    status: () => ({ state, hub: config?.hub || null, hubName: config?.hubName || '' }),
    // Who is viewing this Mac through the hub, for the app's menu.
    viewer: () => (session?.sock ? { username: session.by, since: session.since, via: config?.hub || '' } : null),
    // Stop Sharing Now: the session ends, and the hub may not open another for a while
    // (this Mac shows there as not sharing).
    endViewer() {
      blockedUntil = Date.now() + STOPPED_MS; report();
      setTimeout(() => { if (ws && state === 'connected') report(); }, STOPPED_MS + 100).unref?.();
      if (!session) return false;
      endSession(); return true;
    },
    // Joins the hub at `hub` with `code`, keeps what it answers, and stays connected.
    join(hub, code) {
      const origin = hubOrigin(hub);
      if (!origin) return Promise.reject(Object.assign(new Error('The address must be https://…'), { status: 400, code: 'BAD_ADDRESS' }));
      if (typeof code !== 'string' || !/^[A-Za-z0-9\s-]{6,16}$/.test(code)) return Promise.reject(Object.assign(new Error('That is not a code'), { status: 400, code: 'BAD_CODE' }));
      const mine = ++joinGen;
      return new Promise((resolve, reject) => {
        const sock = new WebSocket(memberUrl(origin), { handshakeTimeout: timeoutMs, maxPayload: 64 * 1024 });
        let over = false;
        const done = (e, v) => { over = true; clearTimeout(timer); try { sock.close(); } catch { /* gone */ } if (e) reject(e); else resolve(v); };
        const timer = setTimeout(() => done(Object.assign(new Error('The other Mac did not answer'), { status: 504, code: 'NO_ANSWER' })), timeoutMs);
        sock.on('open', () => sendJson(sock, { t: 'join', code, name: name() }));
        sock.on('message', (raw) => {
          let m; try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m?.t === 'refused') return done(Object.assign(new Error('The code was not accepted: it is wrong, used or out of date'), { status: 403, code: 'REFUSED' }));
          // Too late (timed out, left or joined again meanwhile): not kept.
          if (over || mine !== joinGen) return;
          if (m?.t === 'joined' && typeof m.id === 'string' && typeof m.secret === 'string' && /^[0-9a-f]{12}$/.test(m.id) && /^[0-9a-f]{64}$/.test(m.secret)) {
            endSession(); stopped = true; try { ws?.close(); } catch { /* gone */ } ws = null;
            config = { hub: origin, id: m.id, secret: m.secret, hubName: new URL(origin).hostname };
            try { save(config); } catch (e) { config = null; return done(Object.assign(new Error(`Could not keep the link: ${e.message}`), { status: 500, code: 'NOT_SAVED' })); }
            stopped = false; delay = retryMs[0];
            done(null, { hub: origin });
            connect();
          }
        });
        sock.on('error', (e) => done(Object.assign(new Error(`Could not reach ${origin}: ${e.code || e.message}`), { status: 502, code: 'UNREACHABLE' })));
        sock.on('unexpected-response', (req, res) => done(Object.assign(new Error(`${origin} answered ${res.statusCode}`), { status: 502, code: 'UNREACHABLE' })));
      });
    },
    // Leaves the hub: the link closes and what it kept is deleted.
    leave() {
      joinGen++; stopped = true; clearTimeout(retry);
      endSession(); const sock = ws; ws = null; try { sock?.close(); } catch { /* gone */ }
      config = null;
      try { fs.unlinkSync(file); } catch { /* none */ }
      set('off');
    },
    close() { stopped = true; clearTimeout(retry); clearInterval(poll); endSession(); try { ws?.close(); } catch { /* gone */ } },
  };
}

module.exports = { createMemberLink, hubOrigin };
