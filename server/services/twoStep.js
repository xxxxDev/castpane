// Two-step sign-in: after the password, the six
// digits of an authenticator app (TOTP, RFC 6238: SHA-1, 30 seconds), or one of ten
// recovery codes that each work once. An account turns it on for itself. QR sign-in
// asks for no code: a bound phone approving it is a second step already, and it is
// how an owner who lost the authenticator still gets in.
const crypto = require('node:crypto');
const { PRODUCT } = require('../siteConfig');

const STEP_S = 30, DIGITS = 6, DRIFT = 1;
const PENDING_MS = 10 * 60_000; // a setup not confirmed within this is dropped
const TICKET_MS = 5 * 60_000, TICKET_TRIES = 5, MAX_TICKETS = 500;
const RECOVERY_CODES = 10;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function unbase32(text) {
  let bits = '';
  for (const c of String(text).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
const newSecret = () => base32(crypto.randomBytes(20));
function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** DIGITS).padStart(DIGITS, '0');
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// The time step a code matches (this one, or one either side for a clock that is
// off), or null. A step at or before lastStep is refused: a code seen once, over a
// shoulder or on the wire, signs nobody in again.
function matchStep(secret, code, { now = Date.now(), lastStep = 0 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const at = Math.floor(now / 1000 / STEP_S);
  let found = null;
  for (let d = -DRIFT; d <= DRIFT; d++) if (same(codeAt(secret, at + d), c) && at + d > lastStep) found = at + d;
  return found;
}
const uri = (secret, username, issuer = PRODUCT.twoStepIssuer) => `otpauth://totp/${encodeURIComponent(`${issuer}:${username}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

// The secret has to be read back to check a code, so it cannot be kept as a hash
// like a password: it is kept sealed with a key made from the server's own secret.
// That stops a copy of the users file alone from yielding it; someone holding the
// whole machine has the key too.
const keyOf = (serverSecret) => crypto.hkdfSync('sha256', Buffer.from(String(serverSecret)), Buffer.alloc(0), PRODUCT.twoStepKeyLabel, 32);
function seal(secret, serverSecret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyOf(serverSecret)), iv);
  const body = Buffer.concat([c.update(String(secret), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
}
function open(sealed, serverSecret) {
  try {
    const [v, iv, body, tag] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyOf(serverSecret)), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

// Recovery codes: 80 random bits each, shown once, kept only as hashes.
const tidyRecovery = (code) => String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
const hashRecovery = (code) => crypto.createHash('sha256').update(`${PRODUCT.recoveryCodeLabel}:${tidyRecovery(code)}`).digest('hex');
function newRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_CODES }, () => { return base32(crypto.randomBytes(10)).match(/.{4}/g).join('-'); });
  return { codes, hashes: codes.map(hashRecovery) };
}
const looksLikeRecovery = (code) => tidyRecovery(code).length === 16 && !/^\d{6}$/.test(String(code || '').replace(/\s/g, ''));

// A password that was right, waiting for its code: the ticket stands for it for five
// minutes and five tries, and is spent by the sign-in it leads to.
function createTickets({ now = Date.now } = {}) {
  const tickets = new Map();
  const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  function prune() { const t = now(); for (const [k, v] of tickets) if (v.expiresAt <= t) tickets.delete(k); }
  // mark: what the ticket was issued against (the password hash it was checked
  // with); markOf gives it back, so the code step can refuse a ticket whose
  // password has since changed.
  function issue(userId, mark = '') {
    prune();
    // One waiting ticket an account: a new right password replaces the old one, so
    // tickets cannot be piled up to multiply the tries.
    for (const [k, v] of tickets) if (v.userId === String(userId)) tickets.delete(k);
    if (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
    const ticket = crypto.randomBytes(32).toString('base64url');
    tickets.set(hash(ticket), { userId: String(userId), mark: String(mark), tries: 0, expiresAt: now() + TICKET_MS });
    return { ticket, expiresIn: TICKET_MS / 1000 };
  }
  const entry = (ticket) => {
    if (typeof ticket !== 'string' || !ticket || ticket.length > 100) return null;
    const v = tickets.get(hash(ticket));
    if (!v) return null;
    if (v.expiresAt <= now()) { tickets.delete(hash(ticket)); return null; }
    return v;
  };
  const userOf = (ticket) => entry(ticket)?.userId || null;
  const markOf = (ticket) => entry(ticket)?.mark ?? null;
  // A try is counted before its code is looked at, so codes sent all at once get no
  // more than five looks between them.
  // False: the ticket has had its five.
  function tryOne(ticket) { const v = entry(ticket); if (!v) return false; if (v.tries >= TICKET_TRIES) { tickets.delete(hash(ticket)); return false; } v.tries += 1; return true; }
  // That code was wrong: after the fifth the ticket is gone.
  function missed(ticket) { const v = entry(ticket); if (v && v.tries >= TICKET_TRIES) tickets.delete(hash(ticket)); }
  const spend = (ticket) => { if (typeof ticket === 'string') tickets.delete(hash(ticket)); };
  function revokeUser(userId) { for (const [k, v] of tickets) if (v.userId === String(userId)) tickets.delete(k); }
  return { issue, userOf, markOf, tryOne, missed, spend, revokeUser, _size: () => tickets.size };
}

module.exports = {
  newSecret, codeAt, matchStep, uri, seal, open, newRecoveryCodes, hashRecovery, looksLikeRecovery, createTickets,
  base32, unbase32, STEP_S, PENDING_MS, TICKET_MS, TICKET_TRIES, RECOVERY_CODES,
};
