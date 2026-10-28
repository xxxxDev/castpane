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
// Failed joins and hellos, from anyone, before /member refuses everyone for the minute.
const FAILS_PER_MINUTE = 20;
const HELLO_MS = 10000;
const OPEN_MS = 10000;
const MEMBER_ID = /^[0-9a-f]{12}$/;
// A binary message is a slice of the capture core's stream, never more than this.
const MAX_MESSAGE = 2 * 1024 * 1024;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim().slice(0, 64) : '') || 'Mac';
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
  let failMinute = 0, failed = 0;
  const failing = () => { const m = Math.floor(now() / 60000); if (m !== failMinute) { failMinute = m; failed = 0; } return failed >= FAILS_PER_MINUTE; };
  const fail = () => { failing(); failed++; };

  function load() {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error('members.json must be a file only this account can read (0600)');
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(rows) ? rows.filter((m) => m && MEMBER_ID.test(m.id) && /^[0-9a-f]{64}$/.test(m.hash)).map((m) => ({ id: m.id, name: cleanName(m.name), hash: m.hash, pairedAt: m.pairedAt || null })) : [];
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  }
  const sweep = () => { for (const [c, exp] of codes) if (exp <= now()) codes.delete(c); };

  // The upgrade on /member: no page may open it (an Origin or a cookie closes it), and
  // none at all while too many have failed this minute.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  function upgrade(req, socket, head) {
    socket.on('error', () => {});
    const refuse = (status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (req.headers.origin !== undefined || req.headers.cookie !== undefined) return refuse(403);
    if (failing()) return refuse(429);
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, resolveClientIp(req)));
  }

  function attach(ws, ip) {
    let link = null, count = 0, windowStart = now();
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    const out = (reason) => { try { ws.close(1008, reason); } catch { /* gone */ } };
    const waiting = setTimeout(() => { fail(); out('no hello'); }, helloMs);
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(waiting);
      if (link && links.get(link.id) === link) { links.delete(link.id); link.session?.destroy(); }
    });
    ws.on('message', (raw, binary) => {
      if (now() - windowStart > 1000) { windowStart = now(); count = 0; }
      if (++count > 1000) return out('too fast');
      if (!link) return first(raw, binary);
      if (binary) return link.data(raw);
      let m; try { m = JSON.parse(raw.toString()); } catch { return out('bad message'); }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return out('bad message');
      if (m.t === 'status') { link.running = m.running === true; return; }
      if (m.t === 'opened' || m.t === 'failed' || m.t === 'closed') return link.answer(m);
      out('unknown message');
    });
    function first(raw, binary) {
      clearTimeout(waiting);
      let m = null; if (!binary) try { m = JSON.parse(raw.toString()); } catch { /* below */ }
      if (m?.t === 'join' && typeof m.code === 'string') {
        sweep();
        const code = m.code.toUpperCase().replace(/[\s-]/g, '');
        const known = codes.has(code);
        // Spent by its first use, right or wrong.
        codes.delete(code);
        if (!known || list.length >= MAX_MEMBERS) { fail(); audit({ source: 'members', action: 'join-refused', ip }); send({ t: 'refused' }); return out('refused'); }
        const id = crypto.randomBytes(6).toString('hex'), secret = crypto.randomBytes(32).toString('hex');
        list.push({ id, name: cleanName(m.name), hash: sha(secret), pairedAt: new Date(now()).toISOString() });
        save();
        audit({ source: 'members', action: 'join', member: id, name: cleanName(m.name), ip });
        send({ t: 'joined', id, secret });
        return welcome(id, m.name);
      }
      if (m?.t === 'hello' && typeof m.id === 'string' && typeof m.secret === 'string') {
        const member = list.find((x) => x.id === m.id);
        if (!member || !sameHash(member.hash, sha(m.secret))) { fail(); audit({ source: 'members', action: 'hello-refused', ip }); send({ t: 'refused' }); return out('refused'); }
        send({ t: 'welcome' });
        return welcome(member.id, m.name);
      }
      fail(); out('no hello');
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
    let gen = 0, pending = null;
    const link = {
      id, running: false, session: null,
      close: (reason) => out(reason),
      // A session: a stream that remote.js uses as it uses the capture core's socket.
      open(by) {
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
        const s = link.session;
        if (!s || m.n !== s.n) return;
        if (m.t === 'opened' && pending?.n === s.n) { clearTimeout(pending.timer); const p = pending; pending = null; p.resolve(); return; }
        s.destroy();
      },
      data(raw) {
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
    remove(id) {
      const before = list.length;
      list = list.filter((m) => m.id !== id);
      if (list.length === before) return false;
      save();
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
// another machine: a JSON object of a known type, thumbnails only as image data.
const FROM_MEMBER = new Set(['status', 'list', 'started', 'config', 'stopped', 'focus', 'caret', 'probe', 'error', 'clipboard', 'clipboard-set']);
const THUMB = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]*$/;
function vetFromMember(text) {
  let m; try { m = JSON.parse(text); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || !FROM_MEMBER.has(m.t)) return null;
  if (m.t === 'list') {
    if (!Array.isArray(m.items)) return null;
    m.items = m.items.slice(0, 500).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => ({ ...x, thumb: typeof x.thumb === 'string' && THUMB.test(x.thumb) ? x.thumb : '' }));
  }
  return JSON.stringify(m);
}

module.exports = { createMembers, vetFromMember, MEMBER_ID, cleanName, CODE_ALPHABET };
