// Several Macs in one web app, the hub's side (docs/multi-mac.md; the owner's request,
// 2026-10-29). Another Mac (a member) joins once with a one-time code and keeps one
// link out to this server on /member; a remote session on it runs over that link, with
// every check the hub makes for its own screen (server/remote.js).
//
// Member → hub, text: {t:'join', code, name} or {t:'hello', id, secret, name} first, then
// {t:'status', running}, {t:'opened', n}, {t:'failed', n}, {t:'closed', n}.
// Hub → member, text: {t:'joined', id, secret}, {t:'welcome'}, {t:'refused'}, {t:'open', n,
// by}, {t:'close', n}. Binary both ways: [n: 4 bytes][the capture core's stream].
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Duplex } = require('node:stream');
const { WebSocketServer } = require('ws');
const { audit } = require('./services/audit');
const { resolveClientIp } = require('./services/clientIp');

const CODE_MS = 10 * 60 * 1000;
// 32 letters and digits, without I, O, 0 and 1: 8 of them are 40 bits.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_CODES = 5;
const MAX_MEMBERS = 32;
// Failed joins in a minute, in all and from one address, before joins are refused for the
// rest of it. Hellos are not limited: a secret is 256 bits, and a member that knows its
// own must always get back in.
const JOIN_FAILS_PER_MINUTE = 20;
const JOIN_FAILS_PER_ADDRESS = 5;
// Connections that have not said hello yet, in all and from one address.
const WAITING_MAX = 64;
const WAITING_PER_ADDRESS = 8;
// What one link may send a second, in bytes (video at the highest bitrate is 5 MB).
const BYTES_PER_SECOND = 64 * 1024 * 1024;
const HELLO_MS = 10000;
const OPEN_MS = 10000;
const MEMBER_ID = /^[0-9a-f]{12}$/;
// A binary message is a slice of the capture core's stream, never more than this.
const MAX_MESSAGE = 2 * 1024 * 1024;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// A Mac's name as shown: no control or direction-changing characters, 64 at most.
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '').trim().slice(0, 64) : '') || 'Mac';
const notRunning = () => Object.assign(new Error('Castpane is not running there'), { status: 503, code: 'NOT_RUNNING' });

function newCode() {
  let s = '';
  for (const b of crypto.randomBytes(CODE_LENGTH)) s += CODE_ALPHABET[b % 32];
  return s;
}

// file: data/members.json, [{id, name, hash, pairedAt}], this account's alone (0600).
function createMembers({ file, now = () => Date.now(), helloMs = HELLO_MS, openMs = OPEN_MS } = {}) {
  let list = load();
  const codes = new Map();
  const links = new Map();
  const waiting = new Map();
  let failMinute = 0, joinFails = new Map();
  const minute = () => { const m = Math.floor(now() / 60000); if (m !== failMinute) { failMinute = m; joinFails = new Map(); } };
  const joinsBlocked = (ip) => { minute(); let all = 0; for (const n of joinFails.values()) all += n; return all >= JOIN_FAILS_PER_MINUTE || (joinFails.get(ip) || 0) >= JOIN_FAILS_PER_ADDRESS; };
  const joinFailed = (ip) => { minute(); joinFails.set(ip, (joinFails.get(ip) || 0) + 1); };
  let auditMinute = 0, audited = 0;
  const mayAudit = () => { const m = Math.floor(now() / 60000); if (m !== auditMinute) { auditMinute = m; audited = 0; } return ++audited <= 30; };

  // A file that is not this account's private list (a link, readable by others, another
  // owner's, cut short) is set aside, not trusted: the Macs in it join again.
  function load() {
    let st;
    try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    try {
      if (!st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw new Error('not a private file');
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(rows)) throw new Error('not a list');
      return rows.filter((m) => m && MEMBER_ID.test(m.id) && /^[0-9a-f]{64}$/.test(m.hash)).map((m) => ({ id: m.id, name: cleanName(m.name), hash: m.hash, pairedAt: m.pairedAt || null }));
    } catch (e) {
      const aside = `${file}.bad-${now()}`;
      console.error(`members: ${file} set aside as ${path.basename(aside)} (${e.message})`);
      try { fs.renameSync(file, aside); } catch { /* left */ }
      return [];
    }
  }
  // Written whole and flushed before it replaces the old; false when it could not be.
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify(list, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      console.error('members: not saved:', e.message);
      return false;
    }
  }
  const sweep = () => { for (const [c, exp] of codes) if (exp <= now()) codes.delete(c); };

  // The upgrade on /member: no page may open it (an Origin or a cookie closes it), and only
  // so many may wait at once before saying hello.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  function upgrade(req, socket, head) {
    socket.on('error', () => {});
    const refuse = (status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (req.headers.origin !== undefined || req.headers.cookie !== undefined) return refuse(403);
    const ip = resolveClientIp(req);
    let all = 0; for (const n of waiting.values()) all += n;
    if (all >= WAITING_MAX || (waiting.get(ip) || 0) >= WAITING_PER_ADDRESS) return refuse(429);
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, ip));
  }

  function attach(ws, ip) {
    let link = null, count = 0, windowStart = now(), counted = true;
    waiting.set(ip, (waiting.get(ip) || 0) + 1);
    const said = () => { if (!counted) return; counted = false; const n = (waiting.get(ip) || 1) - 1; if (n > 0) waiting.set(ip, n); else waiting.delete(ip); };
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    const out = (reason) => { try { ws.close(1008, reason); } catch { /* gone */ } setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 2000).unref?.(); };
    const timer = setTimeout(() => out('no hello'), helloMs);
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(timer); said();
      if (link) { link.end(); if (links.get(link.id) === link) links.delete(link.id); }
    });
    ws.on('message', (raw, binary) => {
      if (now() - windowStart > 1000) { windowStart = now(); count = 0; }
      if (++count > 1000) return out('too fast');
      if (!link) return first(raw, binary);
      if (binary) return link.data(raw);
      let m; try { m = JSON.parse(raw.toString()); } catch { return out('bad message'); }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return out('bad message');
      if (m.t === 'status') { if (!link.ended) link.running = m.running === true; return; }
      if (m.t === 'opened' || m.t === 'failed' || m.t === 'closed') return link.answer(m);
      out('unknown message');
    });
    function first(raw, binary) {
      clearTimeout(timer); said();
      let m = null; if (!binary) try { m = JSON.parse(raw.toString()); } catch { /* below */ }
      const refused = (action) => { if (mayAudit()) audit({ source: 'members', action, ip }); send({ t: 'refused' }); out('refused'); };
      if (m?.t === 'join' && typeof m.code === 'string') {
        if (joinsBlocked(ip)) return refused('join-refused');
        sweep();
        const code = m.code.toUpperCase().replace(/[\s-]/g, '');
        const known = codes.has(code);
        // Spent by its first use, right or wrong.
        codes.delete(code);
        if (!known || list.length >= MAX_MEMBERS) { joinFailed(ip); return refused('join-refused'); }
        const id = crypto.randomBytes(6).toString('hex'), secret = crypto.randomBytes(32).toString('hex');
        const member = { id, name: cleanName(m.name), hash: sha(secret), pairedAt: new Date(now()).toISOString() };
        list.push(member);
        if (!save()) { list = list.filter((x) => x !== member); return refused('join-not-saved'); }
        audit({ source: 'members', action: 'join', member: id, name: member.name, ip });
        send({ t: 'joined', id, secret });
        return welcome(id, m.name);
      }
      if (m?.t === 'hello' && typeof m.id === 'string' && typeof m.secret === 'string') {
        const member = list.find((x) => x.id === m.id);
        if (!member || !sameHash(member.hash, sha(m.secret))) return refused('hello-refused');
        send({ t: 'welcome' });
        return welcome(member.id, m.name);
      }
      out('no hello');
    }
    function welcome(id, name) {
      const member = list.find((x) => x.id === id);
      if (name !== undefined && cleanName(name) !== member.name) { member.name = cleanName(name); save(); }
      links.get(id)?.close('replaced');
      link = makeLink(id, ws, send, out);
      links.set(id, link);
    }
  }

  // One member's link: whether its capture core is there, and the session on it.
  function makeLink(id, ws, send, out) {
    let gen = 0, pending = null, closed = false, bytes = 0, bytesStart = now();
    const link = {
      id, running: false, session: null,
      // Ended: its session too, and nothing it sends counts any more.
      end() { if (closed) return; closed = true; link.ended = true; link.running = false; link.session?.destroy(); },
      close(reason) { link.end(); out(reason); },
      // A session: a stream that remote.js uses as it uses the capture core's socket.
      open(by) {
        if (closed) return Promise.reject(notRunning());
        link.session?.destroy();
        const n = (gen = (gen + 1) >>> 0);
        return new Promise((resolve, reject) => {
          const session = new Duplex({
            read() {},
            write(chunk, enc, cb) {
              if (ws.readyState !== 1) return cb(new Error('the link closed'));
              const head = Buffer.alloc(4); head.writeUInt32BE(n);
              ws.send(Buffer.concat([head, chunk]), { binary: true }, (e) => cb(e || null));
            },
            destroy(err, cb) {
              if (link.session === session) { link.session = null; send({ t: 'close', n }); }
              if (pending?.n === n) { clearTimeout(pending.timer); pending = null; reject(notRunning()); }
              cb(err);
            },
          });
          session.n = n;
          link.session = session;
          pending = { n, resolve: () => resolve(session), timer: setTimeout(() => session.destroy(), openMs) };
          send({ t: 'open', n, by: String(by || '') });
        });
      },
      answer(m) {
        if (closed) return;
        const s = link.session;
        if (!s || m.n !== s.n) return;
        if (m.t === 'opened' && pending?.n === s.n) { clearTimeout(pending.timer); const p = pending; pending = null; p.resolve(); return; }
        s.destroy();
      },
      data(raw) {
        if (closed) return;
        if (now() - bytesStart > 1000) { bytesStart = now(); bytes = 0; }
        if ((bytes += raw.length) > BYTES_PER_SECOND) return link.close('too much');
        const s = link.session;
        if (raw.length < 4 || !s) return;
        if (raw.readUInt32BE(0) !== s.n || pending?.n === s.n) return;
        s.push(raw.subarray(4));
      },
    };
    return link;
  }

  return {
    upgrade,
    // A new code, valid for ten minutes and one use; at most five at once.
    code() {
      sweep();
      while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value);
      const code = newCode();
      codes.set(code, now() + CODE_MS);
      return { code, expiresAt: new Date(now() + CODE_MS).toISOString() };
    },
    list: () => list.map((m) => ({ id: m.id, name: m.name, local: false, online: links.has(m.id), running: !!links.get(m.id)?.running })),
    has: (id) => list.some((m) => m.id === id),
    name: (id) => list.find((m) => m.id === id)?.name || '',
    // false: no such Mac. Throws when the list could not be saved (nothing changes then).
    remove(id) {
      const old = list;
      list = list.filter((m) => m.id !== id);
      if (list.length === old.length) return false;
      if (!save()) { list = old; throw Object.assign(new Error('The list of Macs could not be saved'), { status: 500 }); }
      links.get(id)?.close('removed');
      links.delete(id);
      return true;
    },
    // The session stream for a remote session on member `id`; by: who is viewing.
    connect(id, by) {
      const link = links.get(id);
      if (!link || !link.running) return Promise.reject(notRunning());
      return link.open(by);
    },
    close() { for (const l of links.values()) l.close('server stopping'); wss.close(); },
  };
}

// What a member's capture core may say to the page, checked here because the member is
// another machine: each message rebuilt from its known fields, of the right types and
// sizes, as the page's are (remote.js); anything else is dropped. Never throws.
const THUMB = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]*$/;
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const int = (v) => (Number.isInteger(v) && Math.abs(v) <= 0xffffffff ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const rect = (v) => (Array.isArray(v) && v.length === 4 && v.every((x) => num(x) !== undefined) ? v : undefined);
const pick = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
function item(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || (x.kind !== 'display' && x.kind !== 'window') || int(x.id) === undefined) return null;
  const d = x.desk && typeof x.desk === 'object' && !Array.isArray(x.desk) ? x.desk : {};
  return pick({
    kind: x.kind, id: x.id, title: str(x.title, 300) ?? '', app: str(x.app, 200) ?? '', bundle: str(x.bundle, 200),
    width: int(x.width) ?? 0, height: int(x.height) ?? 0, here: bool(x.here), all: bool(x.all),
    thumb: typeof x.thumb === 'string' && x.thumb.length <= 512 * 1024 && THUMB.test(x.thumb) ? x.thumb : '',
    desk: pick({ id: int(d.id), number: int(d.number), display: int(d.display), fullscreen: bool(d.fullscreen), current: bool(d.current) }),
  });
}
const SHAPES = {
  status: (m) => pick({ screen: bool(m.screen) ?? false, accessibility: bool(m.accessibility) ?? false, version: str(m.version, 64), host: str(m.host, 64) }),
  list: (m) => (Array.isArray(m.items) ? { items: m.items.slice(0, 500).map(item).filter(Boolean) } : null),
  started: (m) => (m.kind === 'display' || m.kind === 'window') && int(m.id) !== undefined ? pick({ kind: m.kind, id: m.id, width: int(m.width) ?? 0, height: int(m.height) ?? 0, fps: int(m.fps) }) : null,
  config: (m) => (str(m.codec, 64) ? pick({ codec: m.codec, width: int(m.width) ?? 0, height: int(m.height) ?? 0 }) : null),
  stopped: (m) => ({ reason: str(m.reason, 100) ?? '' }),
  focus: (m) => pick({ editable: bool(m.editable) ?? false, caret: rect(m.caret), initial: bool(m.initial) }),
  caret: (m) => (rect(m.caret) ? { caret: m.caret } : null),
  probe: (m) => pick({ editable: bool(m.editable) ?? false, n: int(m.n) ?? 0 }),
  error: (m) => pick({ where: str(m.where, 32) ?? '', message: str(m.message, 200) ?? '', code: str(m.code, 32) }),
  clipboard: (m) => pick({ s: str(m.s, 100000), truncated: bool(m.truncated), empty: bool(m.empty), concealed: bool(m.concealed), notAllowed: bool(m.notAllowed), denied: bool(m.denied), error: bool(m.error) }),
  'clipboard-set': () => ({}),
};
function vetFromMember(text) {
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string' || !Object.hasOwn(SHAPES, m.t)) return null;
    const fields = SHAPES[m.t](m);
    return fields ? JSON.stringify({ t: m.t, ...fields }) : null;
  } catch { return null; }
}

module.exports = { createMembers, vetFromMember, MEMBER_ID, cleanName, CODE_ALPHABET };
