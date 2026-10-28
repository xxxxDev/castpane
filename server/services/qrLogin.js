// Logging in by scanning a QR code with a phone already signed in. A computer's login page asks for a request and shows its id
// as a QR code; a phone the account has bound as a login key reads it, shows who
// is asking, and the owner approves or refuses. Only the page that made the request
// can collect the session: it alone holds the request's poll secret, which the QR
// code does not carry, so someone who only sees the code gets nothing.
const crypto = require('node:crypto');

const REQUEST_MS = 60_000; // a request's life while it waits for a phone
const PICKUP_MS = 60_000; // an approved request waits this long for its page
const MAX_WAITING = 200, MAX_PER_IP = 5;
// An IPv6 address counts by its /64, which one user holds whole.
function ipGroup(ip) {
  let v = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!v.includes(':')) return v;
  // Written out in full first: 2001:db8::1 and 2001:db8::2 are one /64.
  const [head, tail = ''] = v.split('::');
  const a = head ? head.split(':') : [], b = v.includes('::') && tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':');
}
// Two digits shown on the login page, to be picked on the phone from three: whoever
// only sees or is sent the code cannot approve it without the computer in front of
// them.
const twoDigits = () => String(crypto.randomInt(10, 100));
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const ID = /^[A-Za-z0-9_-]{24}$/;
const sameName = (name) => (typeof name === 'string' ? name.trim().toLowerCase().slice(0, 80) : '');

function createRequests({ now = Date.now } = {}) {
  const requests = new Map();
  function prune() {
    const t = now();
    for (const [id, r] of requests) if (r.expiresAt <= t || r.status === 'done') requests.delete(id);
  }
  // A new request from a login page: its id for the QR code, and its poll secret
  // for that page only.
  // name: the account the page was asked to sign in, when it has one.
  function start({ ip = '', ua = '', name = '' } = {}) {
    prune();
    const waiting = [...requests.values()].filter((r) => r.status === 'pending');
    if (waiting.filter((r) => ipGroup(r.ip) === ipGroup(ip)).length >= MAX_PER_IP) {
      throw Object.assign(new Error('Too many login requests, try again later'), { status: 429 });
    }
    // Full: the oldest waiting request makes room, so a flood cannot shut everyone out.
    if (waiting.length >= MAX_WAITING) requests.delete(waiting.sort((a, b) => a.createdAt - b.createdAt)[0].id);
    const id = crypto.randomBytes(18).toString('base64url');
    const poll = crypto.randomBytes(32).toString('base64url');
    const t = now();
    const code = twoDigits();
    requests.set(id, { id, pollHash: hash(poll), code, name: sameName(name), ip: String(ip).slice(0, 64), ua: String(ua).slice(0, 300), createdAt: t, expiresAt: t + REQUEST_MS, status: 'pending' });
    return { id, poll, code, expiresIn: REQUEST_MS / 1000 };
  }
  const waiting = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    const r = requests.get(id);
    return r && r.status === 'pending' && r.expiresAt > now() ? r : null;
  };
  // What the phone shows before the owner decides.
  function peek(id) {
    const r = waiting(id);
    if (!r) return null;
    // The right code among two others, in an order of their own.
    if (!r.choices) {
      const set = new Set([r.code]);
      while (set.size < 3) set.add(twoDigits());
      const list = [...set];for (let i = list.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1);[list[i], list[j]] = [list[j], list[i]]; }
      r.choices = list;
    }
    return { ip: r.ip, group: ipGroup(r.ip), ua: r.ua, choices: r.choices.slice(), createdAt: new Date(r.createdAt).toISOString(), expiresAt: new Date(r.expiresAt).toISOString() };
  }
  // approve with the code picked on the phone: a wrong pick refuses the request.
  // The approving phone is kept, so its unbinding before the page collects voids it.
  // A page that asked for one account is not signed in to another: whoever can see
  // the screen must not put their own account on it.
  function decide(id, userId, approve, { code, deviceId, name = '' } = {}) {
    const r = waiting(id);
    if (!r) return 'gone';
    if (approve && r.name && r.name !== sameName(name)) { r.status = 'denied'; return 'wrong-account'; }
    if (approve && String(code) !== r.code) { r.status = 'denied'; return 'wrong-code'; }
    if (approve) { r.status = 'approved'; r.userId = String(userId); r.deviceId = String(deviceId || ''); r.expiresAt = now() + PICKUP_MS; }
    else r.status = 'denied';
    return 'ok';
  }
  // A password change, a reset, a removal, or an unbound phone: whatever of that
  // account or phone is still waiting or approved is dropped at once.
  function revokeUser(userId) { for (const [id, r] of requests) if (r.userId === String(userId)) requests.delete(id); }
  function revokeDevice(deviceId) { for (const [id, r] of requests) if (r.deviceId && r.deviceId === String(deviceId)) requests.delete(id); }
  // The login page asking how its request stands. Approved, it is handed the account
  // once, and the request is spent.
  function collect(id, poll) {
    if (typeof id !== 'string' || !ID.test(id) || typeof poll !== 'string' || poll.length > 100) return { status: 'unknown' };
    const r = requests.get(id);
    if (!r || !sameHash(r.pollHash, hash(poll))) return { status: 'unknown' };
    if (r.expiresAt <= now()) { requests.delete(id); return { status: 'expired' }; }
    if (r.status === 'approved') { r.status = 'done'; requests.delete(id); return { status: 'approved', userId: r.userId, deviceId: r.deviceId }; }
    if (r.status === 'denied') { requests.delete(id); return { status: 'denied' }; }
    return { status: 'pending' };
  }
  return { start, peek, decide, collect, revokeUser, revokeDevice, _size: () => requests.size };
}

// The phones an account has bound as login keys: each has a secret the phone keeps
// and the server knows only by its hash.
const MAX_DEVICES = 10;
function createDevices(db) {
  const call = (method, ...args) => new Promise((ok, no) => db[method](...args, (e, r) => (e ? no(e) : ok(r))));
  // sessionHash: the session that bound it. The secret works only with that session,
  // so a copy taken from the page is useless elsewhere.
  async function bind(userId, name, sessionHash) {
    const mine = await call('find', { userId: String(userId) });
    if (mine.length >= MAX_DEVICES) throw Object.assign(new Error('Too many bound phones; remove one first'), { status: 409 });
    const secret = crypto.randomBytes(32).toString('base64url');
    const doc = await call('insert', { userId: String(userId), name: String(name || '').trim().slice(0, 40) || 'Phone', secretHash: hash(secret).toString('hex'), sessionHash: String(sessionHash || ''), createdAt: new Date().toISOString(), lastUsedAt: null });
    return { id: doc._id, name: doc.name, secret };
  }
  async function verify(userId, id, secret, sessionHash) {
    if (typeof id !== 'string' || typeof secret !== 'string' || secret.length > 100) return null;
    const doc = await call('findOne', { _id: id, userId: String(userId) });
    if (!doc || !sameHash(Buffer.from(doc.secretHash, 'hex'), hash(secret)) || !doc.sessionHash || doc.sessionHash !== String(sessionHash || '')) return null;
    await call('update', { _id: id }, { $set: { lastUsedAt: new Date().toISOString() } }, {});
    return doc;
  }
  const list = async (userId) => (await call('find', { userId: String(userId) })).map((d) => ({ id: d._id, name: d.name, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const find = (userId, id) => call('findOne', { _id: String(id), userId: String(userId) });
  const stillBound = async (userId, id) => !!id && !!(await find(userId, id));
  const remove = async (userId, id) => (await call('remove', { _id: String(id), userId: String(userId) }, {})) > 0;
  const removeAll = async (userId) => call('remove', { userId: String(userId) }, { multi: true });
  // Bound in a session that is gone (signed out, or idle past its days): it can
  // approve nothing any more, so it goes, and does not count against the ten.
  async function prune(userId, liveHashes) { await call('remove', { userId: String(userId), sessionHash: { $nin: [...liveHashes] } }, { multi: true }); }
  // The phones bound in sessions that are gone, for the caller to unbind one by one.
  const lapsed = (userId, liveHashes) => call('find', { userId: String(userId), sessionHash: { $nin: [...liveHashes] } });
  // Every phone bound in this session but the one named (two binds sent at once).
  const others = (userId, sessionHash, keepId) => call('find', { userId: String(userId), sessionHash: String(sessionHash), _id: { $ne: String(keepId) } });
  const bySession = (userId, sessionHash) => call('findOne', { userId: String(userId), sessionHash: String(sessionHash) });
  return { bind, verify, list, find, stillBound, remove, removeAll, prune, bySession, lapsed, others };
}

module.exports = { createRequests, createDevices, ipGroup, REQUEST_MS, PICKUP_MS, MAX_DEVICES };
