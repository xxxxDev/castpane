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
const { createDirect } = require('./directLink');

const SLICE = 256 * 1024;
const BACKLOG = 4 * 1024 * 1024;
// The hub not reading what this Mac sends: the session ends past this.
const UPLINK_BACKLOG = 16 * 1024 * 1024;
// After Stop Sharing Now, the hub may not open a session again for this long.
const STOPPED_MS = 5 * 60 * 1000;
// A frame from the hub is a page's message, never larger than this (remote.js).
const FRAME_MAX = 2 * 1024 * 1024;
// A frame from this Mac's capture core (the core's own bound; the hub takes at most 8 MiB).
const CORE_MAX = 64 * 1024 * 1024;
const LINK_MESSAGES = new Set(['rtc-offer', 'rtc-candidate', 'rtc-close', 'echo']);

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
function createMemberLink({ home, file = path.join(home, 'data', 'member.json'), connectHost, tokenOf, running, name = () => os.hostname().replace(/\.local$/, ''), retryMs = [1000, 60000], timeoutMs = 10000, heartbeatMs = 30000, onChange = () => {} } = {}) {
  let config = load(), ws = null, state = config ? 'connecting' : 'off', retry = null, delay = retryMs[0], session = null, poll = null, wasRunning = null, stopped = false;
  let blockedUntil = 0, joinGen = 0, hubNotes = false, auditMinute = 0, audited = 0;
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
    try { s.direct?.close(); } catch { /* gone */ }
    try { s.sock?.destroy(); } catch { /* gone */ }
    if (tell) sendJson(ws, { t: 'closed', n: s.n });
  }

  async function openSession(n, by) {
    endSession();
    if (blocked()) return sendJson(ws, { t: 'failed', n });
    const s = { n, by: typeof by === 'string' ? by.slice(0, 64) : '', since: new Date().toISOString(), sock: null, pieces: [], held: 0, lastClipboard: 0, direct: null, core: [], coreHeld: 0, need: 5, dropping: false, win: 0, count: 0, lastLarge: 0 };
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
      // The capture core's stream, taken a whole frame at a time: its video goes by the direct
      // link to the page while there is one open, everything else (and the video otherwise) by
      // the hub, which checks it as before.
      sock.on('data', (d) => {
        if (session !== s || ws?.readyState !== 1) return;
        if (ws.bufferedAmount > UPLINK_BACKLOG) return endSession();
        s.core.push(d); s.coreHeld += d.length;
        if (s.coreHeld < s.need) return;
        let buf = s.core.length === 1 ? s.core[0] : Buffer.concat(s.core, s.coreHeld);
        s.core = []; s.coreHeld = 0; s.need = 5;
        let toHub = [];
        while (buf.length >= 5) {
          const len = buf.readUInt32BE(1);
          if (len > CORE_MAX) return endSession();
          if (buf.length < 5 + len) { s.need = 5 + len; break; }
          const whole = buf.subarray(0, 5 + len); buf = buf.subarray(5 + len);
          if (whole[0] === 2 && s.direct?.open && len > 9) {
            const key = (whole[5] & 1) === 1;
            if (s.direct.buffered() > 4 * 1024 * 1024) { if (!s.dropping) { s.dropping = true; coreKey(s); } continue; }
            if (s.dropping && !key) continue;
            s.dropping = false;
            s.direct.send(2, whole.subarray(5));
            continue;
          }
          toHub.push(whole);
        }
        if (buf.length) { s.core = [buf]; s.coreHeld = buf.length; }
        if (toHub.length) { const out = toHub.length === 1 ? toHub[0] : Buffer.concat(toHub); upHub(s, out); }
      });
      sock.on('close', () => { if (session === s) endSession(); });
      sock.on('error', () => { if (session === s) endSession(); });
    } catch {
      if (session === s) { session = null; sendJson(ws, { t: 'failed', n }); }
    }
  }

  function upHub(s, d) {
    const head = Buffer.alloc(4); head.writeUInt32BE(s.n);
    for (let i = 0; i < d.length; i += SLICE) ws.send(Buffer.concat([head, d.subarray(i, i + SLICE)]), { binary: true });
  }
  const coreKey = (s) => { try { s.sock?.write(frame(1, Buffer.from('{"t":"key-frame"}'))); } catch { /* gone */ } };

  // The direct link to the page (server/directLink.js), asked for through the hub: the page's
  // input then comes straight here, checked as the hub's is, and the video goes straight back.
  // Echoes are answered the way they came (the hub's way, through the stream).
  function linkMessage(s, msg, via) {
    if (msg.t === 'echo') {
      if (!Number.isSafeInteger(msg.n)) return;
      const answer = JSON.stringify({ t: 'echo', n: msg.n });
      return via === 'direct' ? s.direct?.send(1, answer) : busy(s, answer);
    }
    if (via !== 'hub') return;
    if (msg.t === 'rtc-offer') {
      if (s.direct || typeof msg.sdp !== 'string' || msg.sdp.length > 16384) return;
      s.direct = createDirect({
        stun: msg.stun === 'both' ? 'both' : 'cloudflare',
        sendSignal: (o) => { if (session === s) busy(s, JSON.stringify(o)); },
        onMessage: (buf) => fromDirect(s, buf),
        onOpen: () => { s.dropping = false; coreKey(s); if (mayAudit()) audit({ source: 'remote', action: 'direct', username: s.by, via: config?.hub || '' }); },
        onClose: () => { if (session === s) coreKey(s); },
      });
      if (!s.direct) return busy(s, '{"t":"rtc-none"}');
      s.direct.offer(msg.sdp);
    } else if (msg.t === 'rtc-candidate') {
      if (typeof msg.candidate === 'string' && msg.candidate.length <= 1024 && typeof msg.mid === 'string' && msg.mid.length <= 64) s.direct?.candidate(msg.candidate, msg.mid);
    } else if (msg.t === 'rtc-close') s.direct?.close();
  }
  // A page's message by the direct link: the hub's own limits (a rate, one large message a
  // second, only the clipboard large), then the same checks as one from the hub. A bad one ends
  // the link, not the session.
  function fromDirect(s, raw) {
    if (session !== s) return;
    if (Date.now() - s.win > 1000) { s.win = Date.now(); s.count = 0; }
    if (++s.count > 600) return s.direct?.close();
    const large = raw.length > 32768;
    if (large) { if (Date.now() - s.lastLarge < 1000) return busy(s); s.lastLarge = Date.now(); }
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return s.direct?.close(); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return s.direct?.close();
    if (large && msg.t !== 'clipboard-set') return s.direct?.close();
    if (LINK_MESSAGES.has(msg.t)) return linkMessage(s, msg, 'direct');
    if (!FROM_PAGE.has(msg.t)) return s.direct?.close();
    if (deliver(s, msg, 'direct') === false) endSession();
  }

  // Told to the page as the hub tells it, through the session's stream.
  function busy(s, said = '{"t":"clipboard-busy"}') {
    if (ws?.readyState !== 1) return;
    const head = Buffer.alloc(4); head.writeUInt32BE(s.n);
    ws.send(Buffer.concat([head, frame(1, Buffer.from(said))]), { binary: true });
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
      if (msg && typeof msg === 'object' && !Array.isArray(msg) && LINK_MESSAGES.has(msg.t)) { linkMessage(s, msg, 'hub'); continue; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !FROM_PAGE.has(msg.t)) return endSession();
      if (deliver(s, msg) === false) return endSession();
    }
    s.pieces = buf.length ? [buf] : []; s.held = buf.length;
  }
  // One page message, by the hub or the direct link, checked and given to the capture core;
  // false: the session ends.
  function deliver(s, msg, via = 'hub') {
    const clean = fromPage(msg);
    if (!clean) return true;
    // By the direct link the hub never saw it: it is told what for, without the content (a hub
    // from before does not take it).
    const tell = (action) => { if (via === 'direct' && hubNotes) sendJson(ws, { t: 'used', n: s.n, action }); };
    if (clean.t === 'quit' && clean.force) tell('force-quit');
    if (clean.t === 'quit' && clean.force) audit({ source: 'remote', action: 'force-quit', bundle: clean.bundle, username: s.by, via: config?.hub || '' });
    if (clean.t.startsWith('clipboard-')) {
      if (Date.now() - s.lastClipboard < 1000) { busy(s); return true; }
      s.lastClipboard = Date.now();
      tell(clean.t === 'clipboard-get' ? 'clipboard-read' : 'clipboard-write');
      // Every one in the log (at most one a second already), not under the opens' cap.
      audit({ source: 'remote', action: clean.t === 'clipboard-get' ? 'clipboard-read' : 'clipboard-write', username: s.by, via: config?.hub || '', ...(clean.s ? { chars: clean.s.length } : {}) });
    }
    // A password try at most every 3 seconds on this Mac too, each in its log (without it).
    if (clean.t === 'unlock') {
      if (Date.now() - (s.lastUnlock || 0) < 3000) { busy(s, '{"t":"unlocked","ok":false,"busy":true}'); return true; }
      s.lastUnlock = Date.now();
      tell('unlock');
      audit({ source: 'remote', action: 'unlock', username: s.by, via: config?.hub || '' });
    }
    // The capture core not reading: the session ends rather than piling up.
    if (s.sock.writableLength > BACKLOG) return false;
    s.sock.write(frame(1, Buffer.from(JSON.stringify(clean))));
    return true;
  }

  function connect() {
    if (!config || stopped) return;
    clearTimeout(retry); retry = null;
    set('connecting');
    const sock = new WebSocket(memberUrl(config.hub), { handshakeTimeout: timeoutMs, maxPayload: 2 * 1024 * 1024 });
    ws = sock;
    let welcomed = false;
    sock.on('open', () => sendJson(sock, { t: 'hello', id: config.id, secret: config.secret, name: name(), direct: 1 }));
    // A link the hub no longer has, with nothing said about it (a restart behind a tunnel),
    // stayed "connected" here and never came back: a ping each while, and no answer by the
    // next one ends it, so it connects again.
    let alive = true;
    const beat = setInterval(() => { if (!alive) return sock.terminate(); alive = false; try { sock.ping(); } catch { /* closing */ } }, heartbeatMs);
    beat.unref?.();
    sock.on('pong', () => { alive = true; });
    sock.on('message', (raw, binary) => {
      if (ws !== sock) return;
      if (binary) {
        if (raw.length < 4 || !session?.sock || raw.readUInt32BE(0) !== session.n) return;
        return fromHub(session, raw.subarray(4));
      }
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m?.t === 'welcome') { welcomed = true; hubNotes = m.notes === 1; delay = retryMs[0]; set('connected'); wasRunning = null; report(); return; }
      if (m?.t === 'refused') { set('removed'); stopped = true; return; }
      if (!welcomed) return;
      if (m?.t === 'open' && Number.isInteger(m.n) && m.n >= 0 && m.n <= 0xffffffff) openSession(m.n, m.by);
      else if (m?.t === 'close' && session?.n === m.n) endSession(false);
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearInterval(beat);
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
        sock.on('open', () => sendJson(sock, { t: 'join', code, name: name(), direct: 1 }));
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
