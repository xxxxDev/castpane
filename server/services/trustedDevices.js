// Trusted devices: an admin's phone or computer that may open the Remote picture without
// the password or passkey each time, for a number of days that starts again each time it
// is used (30, 60, 90 or 180, chosen on the admin page). What the device keeps is a cookie
// the page's scripts cannot read (HttpOnly), its id and a secret; only the secret's hash is
// kept here. Signing out on that device, a new password, the account disabled, deleted or
// its credentials reset, or a removal on the admin page ends it at once.
const crypto = require('node:crypto');

const COOKIE = 'castpane_trust';
const DAYS = [30, 60, 90, 180];
const DEFAULT_DAYS = 30;
const MAX_PER_USER = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const SETTINGS = 'settings';

// A short name for the device from its browser's user agent: what kind and which browser.
function deviceLabel(ua) {
  const s = String(ua || '');
  const kind = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(s) ? 'Edge' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '';
  return browser ? `${kind} · ${browser}` : kind;
}

// The cookie's value: "<id>.<secret>"; anything else is no cookie.
function parse(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const m = value.match(/^([A-Za-z0-9]{8,32})\.([A-Za-z0-9_-]{43})$/);
  return m ? { id: m[1], secret: m[2] } : null;
}

function createTrustedDevices(db, { now = Date.now } = {}) {
  const call = (method, ...args) => new Promise((ok, no) => db[method](...args, (e, r) => (e ? no(e) : ok(r))));
  async function days() {
    const doc = await call('findOne', { _id: SETTINGS });
    return DAYS.includes(doc?.days) ? doc.days : DEFAULT_DAYS;
  }
  async function setDays(d) {
    if (!DAYS.includes(d)) throw Object.assign(new Error('Days must be 30, 60, 90 or 180'), { status: 400 });
    await call('update', { _id: SETTINGS }, { _id: SETTINGS, kind: SETTINGS, days: d }, { upsert: true });
    return d;
  }
  // A device trusted for this account: its cookie value and when it lapses.
  async function trust(userId, ua) {
    const mine = await call('find', { kind: 'device', userId: String(userId) });
    // The oldest goes when there are too many: trusting a new device never fails.
    for (const d of mine.sort((a, b) => a.lastUsedAt - b.lastUsedAt).slice(0, Math.max(0, mine.length - MAX_PER_USER + 1))) await call('remove', { _id: d._id }, {});
    const secret = crypto.randomBytes(32).toString('base64url');
    const t = now(), until = t + (await days()) * DAY_MS;
    const doc = await call('insert', { kind: 'device', userId: String(userId), label: deviceLabel(ua), secretHash: hash(secret).toString('hex'), createdAt: t, lastUsedAt: t, expiresAt: until });
    return { cookie: `${doc._id}.${secret}`, id: doc._id, expiresAt: until };
  }
  // The device behind a cookie, for this account and still in date, or null. Not renewed.
  async function find(userId, cookie) {
    const c = parse(cookie);
    if (!c) return null;
    const doc = await call('findOne', { _id: c.id, kind: 'device' });
    if (!doc || doc.userId !== String(userId) || !sameHash(Buffer.from(doc.secretHash, 'hex'), hash(c.secret))) return null;
    if (doc.expiresAt <= now()) { await call('remove', { _id: doc._id }, {}); return null; }
    return doc;
  }
  // Used to open the picture: in date again for the whole period from now.
  async function use(userId, cookie) {
    const doc = await find(userId, cookie);
    if (!doc) return null;
    const t = now(), until = t + (await days()) * DAY_MS;
    await call('update', { _id: doc._id }, { $set: { lastUsedAt: t, expiresAt: until } }, {});
    return { ...doc, lastUsedAt: t, expiresAt: until };
  }
  const forget = async (cookie) => { const c = parse(cookie);return c ? (await call('remove', { _id: c.id, kind: 'device' }, {})) > 0 : false; };
  const remove = async (id) => (await call('remove', { _id: String(id), kind: 'device' }, {})) > 0;
  const removeAll = (userId) => call('remove', { kind: 'device', userId: String(userId) }, { multi: true });
  const removeEvery = () => call('remove', { kind: 'device' }, { multi: true });
  async function list() {
    const t = now();
    return (await call('find', { kind: 'device' })).filter((d) => d.expiresAt > t)
      .map((d) => ({ id: d._id, userId: d.userId, label: d.label, createdAt: new Date(d.createdAt).toISOString(), lastUsedAt: new Date(d.lastUsedAt).toISOString(), expiresAt: new Date(d.expiresAt).toISOString() }))
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }
  return { days, setDays, trust, find, use, forget, remove, removeAll, removeEvery, list };
}

// The cookie's options: only to the server's own /api, never readable by the page, sent
// only on its own site's requests, over HTTPS when the page is.
const cookieOptions = (secure, maxAgeMs) => ({ httpOnly: true, sameSite: 'strict', secure: !!secure, path: '/api', ...(maxAgeMs ? { maxAge: maxAgeMs } : {}) });

let shared = null;
function sharedTrustedDevices() {
  if (!shared) shared = createTrustedDevices(require('../stores').trustedDevicesDB);
  return shared;
}

module.exports = { createTrustedDevices, sharedTrustedDevices, deviceLabel, cookieOptions, COOKIE, DAYS, DEFAULT_DAYS };
