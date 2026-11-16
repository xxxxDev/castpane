const path = require('path');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { usersDB, sessionsDB, userLifecycleTransitionsDB, loginDevicesDB, passkeysDB } = require('../stores');
const qrLogin = require('../services/qrLogin');
const twoStep = require('../services/twoStep');
const passkeys = require('../services/passkeys');
const { audit } = require('../services/audit');
const { resolveClientIp, isLoopback, trustsCloudflare } = require('../services/clientIp');
const { security, accountKey } = require('../services/securityLog');
const { hashSessionToken } = require('../services/sessionTokens');
const { compactQuietly } = require('../services/compactQuietly');
const { isHttpsRequest, isPasskeyOrigin } = require('../middlewares/requestGuards');
const TRUST = require('../services/trustedDevices');
// A device trusted to open Remote goes with the account's other credentials (a new password,
// the account disabled, deleted or reset): every loginDevices.removeAll here removes these too.
const trustedDevices = () => TRUST.sharedTrustedDevices();
const {
  LIFECYCLE_STATUS,
  SYSTEM_ACTOR,
  SYSTEM_DELETE_REASONS,
  effectiveLifecycleStatus,
  isActiveUser,
  normalizeUsername,
  findPendingLifecycleTransition,
  activeUserQuery,
} = require('../services/userLifecycle');

// Session model: a sliding 15-day idle window. The JWT + cookie carry
// a long absolute backstop (~400d, near the browser cookie cap); the REAL logout
// gate is sessionsDB.expiresAt, which verifyToken/verifySession check and
// touchActivity() slides forward on activity. Net effect: active users never have
// to re-login; 15 idle days logs them out. All knobs are env-overridable.
const IDLE_SECONDS = Number(process.env.SESSION_IDLE_DAYS || 15) * 24 * 60 * 60;
const TOKEN_TTL_SECONDS = Number(process.env.SESSION_MAX_DAYS || 400) * 24 * 60 * 60;
const SLIDE_THROTTLE_MS = 60 * 1000; // rewrite lastSeen / slide expiresAt at most once per 60s per user
const MIN_PASSWORD_LENGTH = 8;

// Display names and usernames reach HTML an admin sees: Framework7 built its
// dialogs from them unescaped, and a member's name ran as script in the admin's
// session. The client now escapes every dialog;
// the server still refuses markup and control characters and caps the length,
// so what is stored never depends on that. A double quote too: a name lands in an
// attribute as easily as in text.
const NAME_MAX_LENGTH = 50;
const USERNAME_MAX_LENGTH = 64;
const MARKUP_OR_CONTROL = /[<>"\u0000-\u001f\u007f]/;
function textProblem(value, max, label) {
  if (value.length > max) return `${label} must be at most ${max} characters`;
  if (MARKUP_OR_CONTROL.test(value)) return `${label} cannot contain < > " or control characters`;
  return null;
}

// In-memory throttle so an active client hitting the API repeatedly doesn't rewrite
// NeDB on every request. Keyed by session (touchKey); resets on restart (worst case:
// one extra write per session after a restart). Single process, so one map.
const lastTouchAt = new Map();
// By session, not by account: with one throttle for the account, a phone used for a
// moment while a computer kept winning the minute never slid, and its session could
// run out while in use. The same key where a session is issued
// and where it slides: issued under the account's id alone, the first request after
// a sign-in wrote everything again.
const touchKey = (userId, token) => `${userId}:${hashSessionToken(token).slice(0, 16)}`;

// Failed sign-ins lock an address out and block it for longer each time
// (services/securityLog.js); each try is kept for the admin's page.
const placeOf = (req) => security.where(req, isLoopback(req.socket?.remoteAddress || req.connection?.remoteAddress) && trustsCloudflare());

// case-insensitive exact-match username lookup (external users WILL type
// "alice" for "Alice"; NeDB has no collation, so use an anchored regex)
function usernameQuery(username) {
  const escaped = String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { username: new RegExp(`^${escaped}$`, 'i') };
}

function activeUserMutationQuery(userId) {
  return {
    _id: userId,
    $or: [
      { lifecycleStatus: LIFECYCLE_STATUS.ACTIVE },
      { lifecycleStatus: { $exists: false } },
    ],
  };
}

// Turned away without checking the password: kept, so the page shows who kept trying.
function loginBlocked(ip, req, username, method = 'password') {
  if (!security.blockOf(ip)) return false;
  security.login({ outcome: 'blocked', reason: 'blocked', username, method, ip, ua: req?.headers?.['user-agent'], place: req ? placeOf(req) : {} });
  return true;
}
// userId: the account tried, when it is known (a signed-in session's own by default).
function recordLoginFailure(ip, req, username, reason, method = 'password', userId = req?.userId || '') {
  const made = security.fail(ip, username, userId, { real: reason !== 'no-such-user' });
  security.login({ outcome: made ? 'locked' : 'fail', reason, username, method, ip, ua: req?.headers?.['user-agent'], place: req ? placeOf(req) : {} });
  if (made) audit({ source: 'security', action: 'auto-block', group: made.group, until: made.until, strikes: made.strikes });
  // By account as well, for a sign-in: a guess at one name from many addresses
  // (securityLog.js). A signed-in session asking for its own password
  // again (binding a phone, two-step settings) counts against its address only.
  // A wrong code comes only from someone who had the password right: a far smaller
  // count of its own, at sign-in, when turning two-step off and when adding a passkey
  // (not when first turning two-step on: that code is for a secret not yet in use).
  const coded = reason === 'wrong-code' && method !== 'two-step' ? security.codeFail(username) : null;
  if (coded) audit({ source: 'security', action: 'account-protect', name: coded.name, until: coded.until, times: coded.times, reason: 'wrong codes' });
  if (method !== 'password' && method !== 'code') return;
  const guard = security.accountFail(username);
  if (guard) audit({ source: 'security', action: 'account-protect', name: guard.name, until: guard.until, times: guard.times });
}
// An account under protection takes a password only from an address it has signed
// in from lately; anywhere else is turned away unchecked, a name that is no account
// just the same.
function accountGuarded(ip, req, username, userId, method = 'password') {
  if (!security.accountGuard(username, ip, userId)) return false;
  security.login({ outcome: 'blocked', reason: 'account', username, method, ip, ua: req?.headers?.['user-agent'], place: req ? placeOf(req) : {} });
  return true;
}
const TOO_MANY = { message: 'Too many login attempts, try again later' };
// The account has had its day's wrong codes (securityLog.codeSpent): no authenticator
// code is looked at any more today. Said so, with 429, and not counted as one more
// wrong code: nothing was checked, and counting on would only lengthen the block on
// the owner's own address without telling them why. A recovery code is still taken.
const CODES_SPENT = { message: 'No more authenticator codes are taken for this account today. Use a recovery code, a passkey or QR sign-in.', code: 'CODES_SPENT' };
// Said, and kept: one line for the admin, folded with the ones after it from the
// same address (securityLog.login, outcome blocked), so guessing that goes on past
// the day's count still leaves its trace.
function sayCodesSpent(req, res, user) {
  security.login({ outcome: 'blocked', reason: 'codes-spent', username: user?.username || '', method: 'code', ip: resolveClientIp(req), ua: req?.headers?.['user-agent'], place: req ? placeOf(req) : {} });
  return res.status(429).json(CODES_SPENT);
}
const recoveryShaped = (code) => typeof code === 'string' && twoStep.looksLikeRecovery(code);
const codeRefusedToday = (user, code) => Boolean(user?.twoStep && !recoveryShaped(code) && security.codeSpent(user.username));
// While an account's codes are being guessed its sign-in settings are frozen, but
// not to a recovery code: eighty bits are not guessed, and the owner must still be
// able to change a password that leaked or turn two-step off.
// Past the day's count it is said as that (codeRefusedToday), not as this.
const codesFrozen = (user, code) => Boolean(security.codesGuessed(user.username) && !recoveryShaped(code) && !security.codeSpent(user.username));
// No code sent at all is not a wrong code: asked for, not counted (a page that did
// not know two-step had been turned on elsewhere sends none).
const NEED_CODE = { message: 'Enter your two-step code', code: 'NEED_CODE' };
const noCode = (code) => typeof code !== 'string' || !code.trim();
// The password was right and no code came: asked for, not counted, but kept in the
// audit log like a sign-in that reached the code step, since a session that is
// not its owner's has just learnt the password is right.
function needCode(req, res, user, where) {
  audit({ source: 'two-step', action: 'code-missing', userId: String(user?._id || ''), where, ip: resolveClientIp(req) });
  return res.status(400).json(NEED_CODE);
}
// Room for one more try from this address (and on this name) while it is checked;
// given back when the answer has gone out (securityLog.js, hold).
function held(ip, res, username = '') {
  const release = security.hold(ip, username);
  if (!release) return false;
  // (A response that cannot say when it is over, as in a unit test, holds nothing.)
  if (typeof res.on === 'function') res.on('close', release); else release();
  return true;
}

function ensureSecret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me-to-a-long-random-string') {
    throw new Error('JWT_SECRET must be set to a strong non-default value');
  }
}

// The way back in for an only admin nothing else lets in (authenticator, recovery
// codes and bound phone all gone, or the account under protection with no known
// address left): a note, sign-in-rescue.json in the database folder (DB_DIR), written
// by hand on this machine as {"what": "two-step" | "protection" | "block", "username":
// "<account name, or the address for a block>"}. The next start reads and removes it
// and turns that account's two-step sign-in off, lifts its protection, or lifts the
// address block. No script in this repository writes it. Only someone with the
// machine's files can leave that note.
const RESCUE_NOTE_MS = 24 * 3600_000;
function applySignInRescue() {
  const file = path.join(process.env.DB_DIR || path.join(__dirname, '..', 'db'), 'sign-in-rescue.json');
  let note, age;
  try { age = Date.now() - require('fs').statSync(file).mtimeMs; note = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch { note = undefined; }
  if (age === undefined) return;
  try { require('fs').unlinkSync(file); } catch (e) { console.error('sign-in rescue: note not removed, nothing done:', e.message); return; }
  if (note === undefined) return;
  // A note left and forgotten must not act at some start weeks later: after a day it
  // is removed and nothing is done.
  if (!(age < RESCUE_NOTE_MS)) { console.error('sign-in rescue: the note is more than a day old, removed and not applied'); return; }
  const name = note?.username;
  if (typeof name !== 'string' || !name || name.length > 80) return;
  if (note.what === 'block') {
    if (security.unblock(security.groupOf(name), 'this machine')) { console.log('address block lifted from this machine'); audit({ source: 'security', action: 'unblock', group: security.groupOf(name), by: 'this machine' }); }
    return;
  }
  if (note.what === 'protection') {
    if (security.accountRelease(name, 'this machine')) { console.log('account protection lifted from this machine'); audit({ source: 'security', action: 'account-release', name, by: 'this machine' }); }
    return;
  }
  if (note.what !== 'two-step') return;
  usersDB.update(usernameQuery(name), { $unset: { twoStep: true, twoStepPending: true } }, {}, (err, n) => {
    if (err) return console.error('two-step reset:', err.message);
    console.log(`two-step sign-in reset from this machine for ${n} account(s)`);
    if (n) { audit({ source: 'two-step', action: 'local-reset', username: name }); security.twoStep({ action: 'reset', by: 'this machine' }); }
  });
}

ensureSecret();
applySignInRescue();

function publicUser(user) {
  const lifecycleStatus = effectiveLifecycleStatus(user);
  return {
    id: user._id,
    username: user.username,
    name: user.name || user.username,
    role: user.role,
    language: user.language || 'en',
    keyLayout: keyLayoutOf(user.keyLayout),
    lifecycleStatus,
    disabledAt: user.disabledAt || null,
    deletedAt: user.deletedAt || null,
    twoStep: Boolean(user.twoStep),
  };
}

let injectedLifecycleService = null;
function lifecycleService() {
  return injectedLifecycleService
    || require('../services/userLifecycle').getDefaultUserLifecycleService();
}

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'Lax',
  path: '/',
};
// Secure whenever the request came in over HTTPS (requestGuards.isHttpsRequest).
const sessionCookieOpts = (res) => ({ ...COOKIE_OPTS, secure: isHttpsRequest(res.req), maxAge: TOKEN_TTL_SECONDS * 1000 });

function issueSession(user, res, { method = 'password', ua = '', approvedBy = null } = {}) {
  const now = Date.now();
  const token = jwt.sign(
    { id: user._id, username: user.username, role: user.role, jti: randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS },
  );

  sessionsDB.insert({
    userId: user._id,
    username: user.username,
    tokenHash: hashSessionToken(token),
    // How and from what it signed in, for the account's device list.
    method, userAgent: String(ua || '').slice(0, 300), createdAt: now, ...(approvedBy ? { approvedBy } : {}),
    lastSeen: now,
    expiresAt: new Date(now + IDLE_SECONDS * 1000),
  });

  // stamp the user active immediately so they show online right after logging in
  usersDB.update(activeUserMutationQuery(user._id), { $set: { lastSeen: now } }, {}, () => {});
  lastTouchAt.set(touchKey(user._id, token), now);

  res.cookie('session_id', token, sessionCookieOpts(res));
  // One line per sign-in, whichever way it came: the app's Activity tab reads these
  // (server/localApi.js).
  audit({ source: 'auth', action: 'sign-in', username: user.username, method, ip: res.req ? resolveClientIp(res.req) : undefined });

  return token;
}

// Sliding-session renewal + presence heartbeat, shared by verifyToken and
// verifySession. Throttled to once/60s/user. Pushes the idle gate
// (sessionsDB.expiresAt) forward, stamps lastSeen for the online badge, and
// refreshes the cookie so its absolute lifetime rolls too. Fire-and-forget:
// the DB writes never block the request.
function touchActivity(userId, token, res) {
  // Best-effort: presence + sliding must NEVER break auth. Any failure here is
  // swallowed so verifyToken/verifySession keep working even if a DB write hiccups.
  try {
    const now = Date.now();
    const key = touchKey(userId, token);
    if (lastTouchAt.size > 5000) for (const [k, at] of lastTouchAt) if (now - at >= SLIDE_THROTTLE_MS) lastTouchAt.delete(k);
    if (now - (lastTouchAt.get(key) || 0) < SLIDE_THROTTLE_MS) return;
    lastTouchAt.set(key, now);
    // The address a live session is used from stays known to the account's protection.
    if (res?.req) security.seen(userId, resolveClientIp(res.req));

    const expiresAt = new Date(now + IDLE_SECONDS * 1000);
    usersDB.update(activeUserMutationQuery(userId), { $set: { lastSeen: now } }, {}, () => {});
    sessionsDB.update({ tokenHash: hashSessionToken(token) }, { $set: { lastSeen: now, expiresAt } }, {}, () => {});
    if (res && !res.headersSent) {
      res.cookie('session_id', token, sessionCookieOpts(res));
    }
  } catch (err) {
    console.error('touchActivity failed (ignored):', err.message);
  }
}
exports.touchActivity = touchActivity;

exports.login = (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  const ip = resolveClientIp(req);
  if (loginBlocked(ip, req, username)) {
    return res.status(429).json(TOO_MANY);
  }

  usersDB.findOne(usernameQuery(username), (err, user) => {
    if (err) return res.status(500).json({ message: 'Error reading user' });
    if (accountGuarded(ip, req, username, user?._id)) return res.status(429).json(TOO_MANY);
    if (!held(ip, res, username)) return res.status(429).json(TOO_MANY);
    if (!user) {
      recordLoginFailure(ip, req, username, 'no-such-user');
      return res.status(400).json({ message: 'Invalid credentials' });
    }
    if (!isActiveUser(user)) {
      recordLoginFailure(ip, req, username, 'inactive', 'password', user._id);
      return res.status(403).json({ message: 'Account is not active', code: 'ACCOUNT_INACTIVE' });
    }
    findPendingLifecycleTransition(userLifecycleTransitionsDB, user._id).then((pending) => {
      if (pending) {
        recordLoginFailure(ip, req, username, 'inactive', 'password', user._id);
        res.status(403).json({ message: 'Account is not active', code: 'ACCOUNT_INACTIVE' });
        return;
      }
      bcrypt.compare(password, user.password, (compareErr, isMatch) => {
        if (compareErr || !isMatch) {
          recordLoginFailure(ip, req, username, 'wrong-password', 'password', user._id);
          return res.status(400).json({ message: 'Invalid credentials' });
        }

        // Re-read after the asynchronous password comparison so a concurrent
        // disable/delete cannot issue a fresh session from a stale user object,
        // nor a password changed meanwhile sign in with the old one: the hash read
        // last, just before the session is made, must be the one just compared. Nothing waits between that read and the
        // session, so a change that lands later removes it with the other sessions.
        findPendingLifecycleTransition(userLifecycleTransitionsDB, user._id)
          .then((freshPending) => {
            if (freshPending) {
              recordLoginFailure(ip, req, username, 'inactive', 'password', user._id);
              res.status(403).json({
                message: 'Account is not active', code: 'ACCOUNT_INACTIVE',
              });
              return;
            }
            usersDB.findOne({ _id: user._id }, (freshErr, freshUser) => {
              if (freshErr) return res.status(500).json({ message: 'Error reading user' });
              if (!isActiveUser(freshUser)) {
                recordLoginFailure(ip, req, username, 'inactive', 'password', user._id);
                return res.status(403).json({
                  message: 'Account is not active', code: 'ACCOUNT_INACTIVE',
                });
              }
              // Not counted: the password was right a moment ago.
              if (freshUser.password !== user.password) return res.status(400).json({ message: 'Invalid credentials' });
              // Two-step on: the right password earns a ticket, not a session
              // (services/twoStep.js); POST /login/code turns it into one, and
              // only while the password is still the one this ticket was for.
              if (freshUser.twoStep) {
                // Kept: a right password with no code after it is what a leaked password looks like.
                audit({ source: 'two-step', action: 'code-asked', userId: freshUser._id, ip });
                res.json({ step: 'code', ...twoStepTickets.issue(freshUser._id, passwordMark(freshUser)) });
                return;
              }
              security.succeeded(ip);
              security.login({ outcome: 'ok', username: freshUser.username, userId: freshUser._id, ip, ua: req.headers['user-agent'], place: placeOf(req) });
              // The token travels only in the httpOnly cookie; the SPA never
              // read it from here, and a copy in the body is one XSS away.
              issueSession(freshUser, res, { method: 'password', ua: req.headers['user-agent'] });
              res.json({
                message: 'Login successful',
                user: publicUser(freshUser),
                expiresIn: IDLE_SECONDS,
              });
            });
          })
          .catch(() => res.status(500).json({ message: 'Error reading user lifecycle' }));
      });
    }).catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ message: 'Error reading user lifecycle' });
      }
    });
  });
};

// POST /api/auth/login/start {username}: the login page has the name and asks what
// the account can sign in with, so it can ask for a passkey before a password. It says only whether there is a passkey; a name that
// is no account, or not active, is answered as one without. That does tell a caller
// that a name with a passkey exists: the name-first page accepts that.
exports.loginStart = async (req, res) => {
  try {
    const { username } = req.body || {};
    if (typeof username !== 'string' || !username || username.length > USERNAME_MAX_LENGTH) return res.json({ passkey: false });
    const user = await findUser(usernameQuery(username));
    res.json({ passkey: Boolean(user && isActiveUser(user) && (await passkeyStore.ids(user._id)).length) });
  } catch (e) { console.error('login start:', e.message); res.json({ passkey: false }); }
};

// Two-step sign-in (services/twoStep.js).
const twoStepTickets = twoStep.createTickets();
// What a two-step ticket is tied to: the password hash it was checked against.
const passwordMark = (user) => String(user?.password || '');
const updateUser = (query, change) => new Promise((ok, no) => usersDB.update(query, change, {}, (e, n) => (e ? no(e) : ok(n))));
// Is this the account's code: its authenticator's six digits, not used before, or
// a recovery code, which is spent. The write is what decides: of two requests with
// the same code, one changes the row and the other finds nothing to change.
// spend false only looks: for a step that is not the end of what the code is for.
async function passesTwoStep(user, code, { spend = true } = {}) {
  if (!user?.twoStep) return false;
  if (twoStep.looksLikeRecovery(code)) {
    const hash = twoStep.hashRecovery(code);
    if (!(user.twoStep.recovery || []).includes(hash)) return false;
    if (!spend) return true;
    return (await updateUser({ _id: user._id, 'twoStep.recovery': hash }, { $pull: { 'twoStep.recovery': hash } })) > 0;
  }
  // The day's wrong codes are spent: no authenticator code is looked at, on any of
  // the ways that take one (sign-in, turning it off, binding a phone, a passkey).
  if (security.codeSpent(user.username)) return false;
  const secret = twoStep.open(user.twoStep.secret, process.env.JWT_SECRET);
  const step = secret && twoStep.matchStep(secret, code, { lastStep: user.twoStep.lastStep || 0 });
  if (!step) return false;
  if (!spend) return true;
  return (await updateUser({ _id: user._id, 'twoStep.lastStep': { $lt: step } }, { $set: { 'twoStep.lastStep': step } })) > 0;
}

// POST /api/auth/login/code {ticket, code}: the second step of a password sign-in.
exports.loginCode = async (req, res) => {
  try {
    const { ticket, code } = req.body || {};
    const ip = resolveClientIp(req);
    if (loginBlocked(ip, req, '', 'code')) return res.status(429).json(TOO_MANY);
    const userId = twoStepTickets.userOf(ticket);
    const user = userId && await activeAccount(userId);
    // A ticket from before the password changed is gone: the old password must
    // not lead to a session.
    if (!user || !user.twoStep || twoStepTickets.markOf(ticket) !== passwordMark(user)) {
      if (userId) twoStepTickets.spend(ticket);
      return res.status(401).json({ message: 'Sign in again', code: 'TICKET_GONE' });
    }
    if (accountGuarded(ip, req, user.username, user._id, 'code')) return res.status(429).json(TOO_MANY);
    if (!held(ip, res, user.username)) return res.status(429).json(TOO_MANY);
    // None sent is asked for, not counted, and costs the ticket no try.
    if (noCode(code)) return res.status(400).json(NEED_CODE);
    if (codeRefusedToday(user, code)) return sayCodesSpent(req, res, user);
    if (!twoStepTickets.tryOne(ticket)) return res.status(401).json({ message: 'Sign in again', code: 'TICKET_GONE' });
    if (typeof code !== 'string' || code.length > 40 || !(await passesTwoStep(user, code))) {
      twoStepTickets.missed(ticket);
      recordLoginFailure(ip, req, user.username, 'wrong-code', 'code', user._id);
      return res.status(400).json({ message: 'Invalid code', code: twoStepTickets.userOf(ticket) ? 'WRONG_CODE' : 'TICKET_GONE' });
    }
    twoStepTickets.spend(ticket);
    // Read once more just before the session, nothing waited for in between: the
    // password may have changed or the account gone off while the code was checked.
    const latest = await findUser({ _id: user._id });
    if (!isActiveUser(latest) || passwordMark(latest) !== passwordMark(user)) return res.status(401).json({ message: 'Sign in again', code: 'TICKET_GONE' });
    security.login({ outcome: 'ok', username: latest.username, userId: latest._id, ip, ua: req.headers['user-agent'], place: placeOf(req) });
    issueSession(latest, res, { method: 'password', ua: req.headers['user-agent'] });
    res.json({ message: 'Login successful', user: publicUser(latest), expiresIn: IDLE_SECONDS });
  } catch (e) { console.error('login code:', e.message); res.status(500).json({ message: 'Error' }); }
};

// The password again for a signed-in session, before it changes how the account
// signs in. A wrong one counts against the address, as when binding a phone.
async function passwordAgain(req, res, method) {
  const ip = resolveClientIp(req);
  if (loginBlocked(ip, req, '', method) || !held(ip, res)) { res.status(429).json(TOO_MANY); return null; }
  const user = await activeAccount(req.userId);
  if (!user) { res.status(403).json({ message: 'Account is not active' }); return null; }
  const { password } = req.body || {};
  if (!(typeof password === 'string' && password && await bcrypt.compare(password, user.password))) {
    recordLoginFailure(ip, req, user.username, 'wrong-password', method);
    res.status(400).json({ message: 'Invalid credentials', code: 'WRONG_PASSWORD' });
    return null;
  }
  return user;
}
// GET /api/auth/two-step: is it on, and how many recovery codes are left.
exports.twoStepStatus = async (req, res) => {
  try {
    const user = await activeAccount(req.userId);
    if (!user) return res.status(403).json({ message: 'Account is not active' });
    res.json({ enabled: Boolean(user.twoStep), enabledAt: user.twoStep?.enabledAt || null, recoveryLeft: user.twoStep ? (user.twoStep.recovery || []).length : 0 });
  } catch { res.status(500).json({ message: 'Error' }); }
};
// POST /api/auth/two-step/setup {password}: a new secret to put in an authenticator.
// Nothing changes until a code from it comes back to /enable.
exports.twoStepSetup = async (req, res) => {
  try {
    const user = await passwordAgain(req, res, 'two-step');
    if (!user) return;
    if (user.twoStep) return res.status(409).json({ message: 'Two-step sign-in is already on', code: 'ALREADY_ON' });
    const secret = twoStep.newSecret();
    await updateUser(activeUserMutationQuery(user._id), { $set: { twoStepPending: { secret: twoStep.seal(secret, process.env.JWT_SECRET), at: Date.now() } } });
    res.json({ secret, uri: twoStep.uri(secret, user.username) });
  } catch (e) { console.error('two-step setup:', e.message); res.status(500).json({ message: 'Error' }); }
};
// POST /api/auth/two-step/enable {code}: the authenticator shows the right digits,
// so it is on. The recovery codes are given here, once.
exports.twoStepEnable = async (req, res) => {
  try {
    const ip = resolveClientIp(req);
    if (loginBlocked(ip, req, '', 'two-step') || !held(ip, res)) return res.status(429).json(TOO_MANY);
    const user = await activeAccount(req.userId);
    if (!user) return res.status(403).json({ message: 'Account is not active' });
    if (user.twoStep) return res.status(409).json({ message: 'Two-step sign-in is already on', code: 'ALREADY_ON' });
    const pending = user.twoStepPending;
    const secret = pending && Date.now() - pending.at < twoStep.PENDING_MS ? twoStep.open(pending.secret, process.env.JWT_SECRET) : null;
    if (!secret) return res.status(409).json({ message: 'Start the setup again', code: 'SETUP_GONE' });
    const step = twoStep.matchStep(secret, (req.body || {}).code);
    if (!step) {
      recordLoginFailure(ip, req, user.username, 'wrong-code', 'two-step');
      return res.status(400).json({ message: 'Invalid code', code: 'WRONG_CODE' });
    }
    const { codes, hashes } = twoStep.newRecoveryCodes();
    const changed = await updateUser({ ...activeUserMutationQuery(user._id), twoStep: { $exists: false } }, {
      $set: { twoStep: { secret: pending.secret, enabledAt: new Date().toISOString(), lastStep: step, recovery: hashes } },
      $unset: { twoStepPending: true },
    });
    if (!changed) return res.status(409).json({ message: 'Two-step sign-in is already on', code: 'ALREADY_ON' });
    endPasskeyChallenges(req.userId);
    // The users file is append-only until compacted: a secret set up and replaced, or
    // turned off, stays in it as an older line. Compacted whenever two-step changes. A compaction that fails
    // is said, never left as an unhandled rejection.
    compactQuietly(usersDB, 'two-step: users');
    audit({ source: 'two-step', action: 'enable', userId: req.userId });
    security.twoStep({ action: 'on', userId: req.userId, ip, place: placeOf(req) });
    res.json({ enabled: true, recoveryCodes: codes });
  } catch (e) { console.error('two-step enable:', e.message); res.status(500).json({ message: 'Error' }); }
};
// POST /api/auth/two-step/disable {password, code}: both, so neither a stolen
// session nor a stolen password alone turns it off. (An admin can reset another
// account's with their own password, below.)
exports.twoStepDisable = async (req, res) => {
  try {
    const user = await passwordAgain(req, res, 'two-step');
    if (!user) return;
    if (!user.twoStep) return res.json({ enabled: false });
    // Not while the account is under protection: codes are being guessed.
    const { code } = req.body || {};
    if (noCode(code)) return needCode(req, res, user, 'two-step-off');
    if (codesFrozen(user, code)) return res.status(429).json(TOO_MANY);
    if (codeRefusedToday(user, code)) return sayCodesSpent(req, res, user);
    if (typeof code !== 'string' || code.length > 40 || !(await passesTwoStep(user, code))) {
      recordLoginFailure(resolveClientIp(req), req, user.username, 'wrong-code', 'two-step-off');
      return res.status(400).json({ message: 'Invalid code', code: 'WRONG_CODE' });
    }
    await updateUser({ _id: user._id }, { $unset: { twoStep: true, twoStepPending: true } });
    twoStepTickets.revokeUser(user._id);
    compactQuietly(usersDB, 'two-step: users');
    audit({ source: 'two-step', action: 'disable', userId: req.userId });
    security.twoStep({ action: 'off', userId: req.userId, ip: resolveClientIp(req), place: placeOf(req) });
    res.json({ enabled: false });
  } catch (e) { console.error('two-step disable:', e.message); res.status(500).json({ message: 'Error' }); }
};
exports._twoStepTickets = twoStepTickets;

// Passkeys (services/passkeys.js). Signing in
// with one asks for no password and no two-step code: the device has verified its
// owner, and holding it is the second step. A password change or reset removes
// them, as it does bound phones: whoever changed it may be shutting out someone
// who got in before and left a passkey behind.
const passkeyChallenges = passkeys.createChallenges();
const passkeyStore = passkeys.createStore(passkeysDB);
const sendPasskeyError = (res, e) => res.status(e.status || 500).json({ message: e.status ? e.message : 'Error', ...(e.status === 400 ? { code: 'PASSKEY_REFUSED' } : {}) });
// GET /api/auth/passkeys: the account's passkeys.
exports.listPasskeys = async (req, res) => {
  try { res.json({ passkeys: await passkeyStore.list(req.userId) }); } catch (e) { sendPasskeyError(res, e); }
};
// What changes how the account signs in drops a challenge waiting to add a passkey.
function endPasskeyChallenges(userId) {
  passkeyChallenges.revokeUser(userId);
}
// A passkey is made and kept only by a page on the public HTTPS address, the one
// origin a passkey belongs to (requestGuards.isPasskeyOrigin). A page on this Mac's
// loopback, which the site trusts for its other requests, cannot add one.
function passkeyPageOnly(req, res) {
  if (isPasskeyOrigin(req.get('origin'))) return true;
  res.status(403).json({ message: 'Passkeys are added on the public address', code: 'PASSKEY_ORIGIN' });
  return false;
}
// POST /api/auth/passkeys/options {password, code}: what the browser needs to make
// one. The password again, and the two-step code when that is on: a new passkey is
// a new way in, so a session alone must not add it, however recently it signed in.
exports.passkeyOptions = async (req, res) => {
  try {
    if (!passkeyPageOnly(req, res)) return;
    // No password given: said plainly, and not counted as a wrong password.
    if (!(req.body || {}).password) return res.status(400).json({ message: 'Enter your password to add a passkey', code: 'NEED_PASSWORD' });
    const user = await passwordAgain(req, res, 'passkey');
    if (!user) return;
    if (user.twoStep) {
      const { code } = req.body || {};
      if (noCode(code)) return needCode(req, res, user, 'passkey');
      if (codesFrozen(user, code)) return res.status(429).json(TOO_MANY);
      // Looked at here, spent when the passkey is kept: a sheet closed on the device
      // must not cost a recovery code.
      if (codeRefusedToday(user, code)) return sayCodesSpent(req, res, user);
      if (typeof code !== 'string' || code.length > 40 || !(await passesTwoStep(user, code, { spend: false }))) {
        recordLoginFailure(resolveClientIp(req), req, user.username, 'wrong-code', 'passkey');
        return res.status(400).json({ message: 'Invalid code', code: 'WRONG_CODE' });
      }
    }
    res.json({
      challenge: passkeyChallenges.issue('create', user._id),
      user: { id: passkeys.b64u(Buffer.from(String(user._id))), name: user.username, displayName: user.name || user.username },
      algs: Object.keys(passkeys.ALGS).map(Number),
      exclude: await passkeyStore.ids(user._id),
    });
  } catch (e) { sendPasskeyError(res, e); }
};
// POST /api/auth/passkeys {name, id, clientDataJSON, authenticatorData, publicKey, alg, code}:
// the passkey the browser made for that challenge is kept.
exports.addPasskey = async (req, res) => {
  try {
    if (!passkeyPageOnly(req, res)) return;
    const user = await activeAccount(req.userId);
    if (!user) return res.status(403).json({ message: 'Account is not active' });
    const body = req.body || {};
    const { made } = passkeys.register(body, { challenges: passkeyChallenges, userId: user._id, isAllowedOrigin: isPasskeyOrigin });
    if (user.twoStep && noCode(body.code)) return needCode(req, res, user, 'passkey');
    if (user.twoStep && codeRefusedToday(user, body.code)) return sayCodesSpent(req, res, user);
    if (user.twoStep && !(typeof body.code === 'string' && body.code.length <= 40 && await passesTwoStep(user, body.code))) {
      recordLoginFailure(resolveClientIp(req), req, user.username, 'wrong-code', 'passkey');
      return res.status(400).json({ message: 'Invalid code', code: 'WRONG_CODE' });
    }
    // How it was added: whether it may stand for the password and code later (passkeys.confirmsAdmin).
    const passkey = await passkeyStore.add(user._id, typeof body.name !== 'string' || textProblem(body.name, 40, 'name') ? 'Passkey' : body.name, { ...made, addedWith: 'password', withCode: Boolean(user.twoStep) });
    // The password changed, or the account was switched off (or off and on again), while
    // this was checked: the key goes again (a password change removes the account's
    // passkeys, and this one came after that).
    const after = await activeAccount(req.userId);
    if (!after || after.password !== user.password || after.enabledAt !== user.enabledAt) {
      // Not removed, it would still sign in: said, and written down.
      try { await passkeyStore.remove(user._id, passkey.id); } catch (e) {
        console.error('passkey not removed again:', e.message);
        audit({ source: 'passkey', action: 'add-not-undone', userId: req.userId, passkeyId: passkey.id });
        return res.status(500).json({ message: 'Your sign-in changed meanwhile and the new passkey could not be removed; remove it on the Passkeys page', code: 'PASSKEY_NOT_REMOVED' });
      }
      audit({ source: 'passkey', action: 'add-undone', userId: req.userId, passkeyId: passkey.id });
      return res.status(409).json({ message: 'Your sign-in changed meanwhile; add the passkey again', code: 'SIGN_IN_CHANGED' });
    }
    audit({ source: 'passkey', action: 'add', userId: req.userId, passkeyId: passkey.id });
    security.passkey({ action: 'add', userId: req.userId, ip: resolveClientIp(req), place: placeOf(req) });
    res.status(201).json({ passkey });
  } catch (e) { sendPasskeyError(res, e); }
};
// DELETE /api/auth/passkeys/:id
exports.removePasskey = async (req, res) => {
  try {
    if (!(await passkeyStore.remove(req.userId, req.params.id))) return res.status(404).json({ message: 'Not found' });
    audit({ source: 'passkey', action: 'remove', userId: req.userId, passkeyId: String(req.params.id) });
    security.passkey({ action: 'remove', userId: req.userId, ip: resolveClientIp(req), place: placeOf(req) });
    res.json({ ok: true });
  } catch (e) { sendPasskeyError(res, e); }
};
// POST /api/auth/passkey/start: a login page asks for a challenge (no session yet).
exports.passkeyStart = (req, res) => res.json({ challenge: passkeyChallenges.issue('get', '', security.groupOf(resolveClientIp(req))) });
// POST /api/auth/passkey/finish {id, clientDataJSON, authenticatorData, signature}:
// the passkey's answer; right, and its account is signed in. Like QR sign-in it is
// open to an address shut out of password sign-in: there is nothing here to guess.
exports.passkeyFinish = async (req, res) => {
  const ip = resolveClientIp(req), body = req.body || {};
  try {
    const answer = passkeys.answer(body, { challenges: passkeyChallenges, isAllowedOrigin: isPasskeyOrigin });
    const kept = await passkeyStore.byCredential(body.id);
    const { signCount } = passkeys.assert(answer, body, kept);
    const user = await activeAccount(kept.userId);
    if (!user) throw Object.assign(new Error('Passkey not accepted'), { status: 400, reason: 'inactive' });
    if (!(await passkeyStore.used(kept, signCount))) throw Object.assign(new Error('Passkey not accepted'), { status: 400, reason: 'counter' });
    security.login({ outcome: 'ok', username: user.username, userId: user._id, method: 'passkey', ip, ua: req.headers['user-agent'], place: placeOf(req) });
    issueSession(user, res, { method: 'passkey', ua: req.headers['user-agent'] });
    res.json({ message: 'Login successful', user: publicUser(user), expiresIn: IDLE_SECONDS });
  } catch (e) {
    if (e.status === 400) security.login({ outcome: 'fail', reason: 'passkey', username: '', method: 'passkey', ip, ua: req.headers['user-agent'], place: placeOf(req) });
    else console.error('passkey sign-in:', e.message);
    sendPasskeyError(res, e);
  }
};
exports._passkeyChallenges = passkeyChallenges;
// An admin's own passkey in place of the password and code, for an action that asks
// for them again (opening Remote with Face ID or Touch ID). The device verified its
// owner (UV), the key is this admin's own, and the challenge came from a pool of its
// own, so a login page's challenge is never accepted here.
const againChallenges = passkeys.createChallenges();
// purpose: 'remote' (opening Remote, trusting a device for it), the one kind left since
// accounts are no longer managed from the web (one account). A challenge answers only an
// action of its own purpose.
const AGAIN_PURPOSES = new Set(['remote']);
exports.adminPasskeyStart = async (req, purpose) => {
  if (!AGAIN_PURPOSES.has(purpose)) throw new Error(`unknown purpose ${purpose}`);
  const me = await activeAccount(req.userId);
  if (!me || me.role !== 'admin') return null;
  const ids = await passkeyStore.ids(req.userId, (d) => passkeys.confirmsAdmin(d, me));
  if (!ids.length) return null;
  // Each kind waits in its own few (a stolen session asking for many cannot push out the one
  // the admin is answering for the other kind).
  return { challenge: againChallenges.issue('get', req.userId, `again:${purpose}:${req.userId}`, purpose), allow: ids };
};
// Throws (400) unless the answer is this admin's passkey, one that may stand for the
// password and code, signed just now, to a challenge issued for this purpose. Refused
// answers count as the wrong password does; a blocked address, or one with an attempt
// still being checked, is refused (429) before the answer is looked at.
exports.adminPasskeyAgain = async (req, res, body = {}, purpose) => {
  if (!AGAIN_PURPOSES.has(purpose)) throw new Error(`unknown purpose ${purpose}`);
  const ip = resolveClientIp(req);
  if (loginBlocked(ip, req, req.username || '', 'admin-grant') || !held(ip, res)) throw Object.assign(new Error('Too many attempts'), { status: 429 });
  const me = await activeAccount(req.userId);
  if (!me || me.role !== 'admin') throw Object.assign(new Error('Account is not active'), { status: 403 });
  try {
    const answer = passkeys.answer(body, { challenges: againChallenges, isAllowedOrigin: isPasskeyOrigin, userId: me._id, note: purpose });
    const kept = await passkeyStore.byCredential(body.id);
    if (!kept || String(kept.userId) !== String(me._id)) throw Object.assign(new Error('Passkey not accepted'), { status: 400 });
    if (!passkeys.confirmsAdmin(kept, me)) throw Object.assign(new Error('Passkey not accepted'), { status: 400 });
    const { signCount } = passkeys.assert(answer, body, kept);
    if (!(await passkeyStore.used(kept, signCount))) throw Object.assign(new Error('Passkey not accepted'), { status: 400 });
  } catch (e) {
    if (e.status === 400) recordLoginFailure(ip, req, me.username, 'wrong-passkey', 'admin-grant');
    throw e;
  }
  return me;
};
exports._applySignInRescue = applySignInRescue;

exports.logout = (req, res) => {
  const token = req.cookies.session_id || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  res.clearCookie('session_id', { path: '/' });
  // Signing out on a trusted device ends its trust too (services/trustedDevices.js).
  const trustValue = req.cookies?.[TRUST.COOKIE];
  if (typeof trustValue === 'string') trustedDevices().forget(trustValue).catch((e) => console.error(`trust not ended at sign-out: ${e.message}`));
  res.clearCookie(TRUST.COOKIE, TRUST.cookieOptions(isHttpsRequest(req)));

  // A string or nothing (app.js drops a parsed j:{…} cookie as well; checked here too
  // so the handler does not depend on that).
  if (!token || typeof token !== 'string') return res.json({ message: 'Logged out successfully' });

  // A browser PushSubscription may outlive its login cookie. Bind subscriptions
  // to the live session and deactivate this session's devices before deleting
  // the row; a later login can deliberately re-register the same browser endpoint.
  Promise.resolve()
    .then(() => require('../services/pushStore').getDefaultPushStore().deactivateSession(token))
    .catch((error) => console.error(`push logout suppression failed: ${error.message}`))
    // A phone bound as a login key in this session can approve nothing once it is
    // gone: its key goes with it, so the device list does not show a dead one. What it let in stays signed in: signing
    // out on the phone is the owner putting the phone away, not losing it; the same
    // when its session runs out (dropLapsedPhones). A key unbound or replaced, or a
    // session signed out from the list, does take what it let in along: dropPhone.
    .then(() => loginDevices.bySession(req.userId || jwt.decode(token)?.id, hashSessionToken(token)))
    .then((phone) => { if (phone) { qrRequests.revokeDevice(phone._id); return loginDevices.remove(phone.userId, phone._id); } })
    .catch(() => {})
    .finally(() => {
      // Also a row still holding the token itself (a start-up conversion that failed):
      // by its hash alone it stayed, and worked again once a later start converted it.
      sessionsDB.remove({ $or: [{ tokenHash: hashSessionToken(token) }, { token: String(token) }] }, { multi: true }, () => {
        compactQuietly(sessionsDB, 'sessions');
        // Its other open pages (other tabs) told at once (server/liveUpdates.js).
        require('../liveUpdates').endSignIn(hashSessionToken(token));
        res.json({ message: 'Logged out successfully' });
      });
    });
};

exports.verifySession = (req, res) => {
  const token = req.cookies.session_id;
  if (!token || typeof token !== 'string') return res.status(401).json({ message: 'No session cookie found' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ message: 'Invalid or expired session cookie' });

    sessionsDB.findOne({ tokenHash: hashSessionToken(token), userId: decoded.id }, (sessionErr, session) => {
      if (sessionErr || !session || new Date(session.expiresAt).getTime() < Date.now()) {
        return res.status(401).json({ message: 'Invalid or expired session' });
      }

      usersDB.findOne({ _id: decoded.id }, (userErr, user) => {
        if (userErr || !isActiveUser(user)) return res.status(401).json({ message: 'User not found' });
        findPendingLifecycleTransition(userLifecycleTransitionsDB, decoded.id).then((pending) => {
          if (pending) return res.status(401).json({ message: 'User not found' });
          touchActivity(decoded.id, token, res);
          res.json({ user: publicUser(user), expiresIn: IDLE_SECONDS });
        }).catch(() => res.status(401).json({ message: 'User not found' }));
      });
    });
  });
};

exports.me = (req, res) => {
  usersDB.findOne({ _id: req.userId }, (err, user) => {
    if (err) return res.status(500).json({ message: 'Error reading user' });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user: publicUser(user) });
  });
};

// The phone's key row as the account has set it (Settings › Remote › Key row), the same on
// every device: one round button at most at the left, two at the right, four pages between,
// each a key of the page's own list (web/src/js/remotePrefs.js), each once. Anything else
// is no layout (the page's default).
const KEY_IDS = new Set(['dock', 'kb', 'compose', 'esc', 'tab', '⇧tab', '↑', '↓', '←', '→', '⌃C', 'shift', 'ctrl', 'alt', 'meta', 'clip', 'panel', 'delete', 'return', 'home', 'end', 'page up', 'page down', 'mission', 'space-left', 'space-right']);
function keyLayoutOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const seen = new Set();
  const list = (a, max) => {
    if (!Array.isArray(a) || a.length > max) return null;
    for (const id of a) { if (typeof id !== 'string' || !KEY_IDS.has(id) || seen.has(id)) return null;seen.add(id); }
    return [...a];
  };
  const left = list(v.left, 1), right = list(v.right, 2);
  if (!left || !right || !Array.isArray(v.pages) || v.pages.length !== 4) return null;
  const pages = v.pages.map((p) => list(p, KEY_IDS.size));
  return pages.every(Boolean) ? { left, pages, right } : null;
}
exports.keyLayoutOf = keyLayoutOf;

exports.updateMe = (req, res) => {
  const allowedLanguages = ['en', 'zh-TW'];
  const update = {};
  if (typeof req.body.name === 'string') update.name = req.body.name.trim() || req.username;
  const nameProblem = update.name && textProblem(update.name, NAME_MAX_LENGTH, 'Name');
  if (nameProblem) return res.status(400).json({ message: nameProblem });
  if (typeof req.body.language === 'string') {
    if (!allowedLanguages.includes(req.body.language)) {
      return res.status(400).json({ message: 'Unsupported language' });
    }
    update.language = req.body.language;
  }
  if ('keyLayout' in (req.body || {})) {
    if (req.body.keyLayout === null) update.keyLayout = null;
    else if (!(update.keyLayout = keyLayoutOf(req.body.keyLayout))) return res.status(400).json({ message: 'Unsupported key layout' });
  }
  // Settings an older build kept that this product does not have: a value still
  // stored, or one sent here, is ignored.

  usersDB.update(activeUserMutationQuery(req.userId), { $set: update }, {}, (err, updated) => {
    if (err) return res.status(500).json({ message: 'Error updating user' });
    if (!updated) {
      return res.status(409).json({ message: 'Account is no longer active', code: 'ACCOUNT_INACTIVE' });
    }
    compactQuietly(usersDB, 'users');
    usersDB.findOne({ _id: req.userId }, (readErr, user) => {
      if (readErr || !user) return res.status(404).json({ message: 'User not found' });
      res.json({ user: publicUser(user) });
    });
  });
};

exports.changePassword = (req, res) => {
  const { oldPassword, newPassword, code } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ message: 'Old and new passwords are required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return res
      .status(400)
      .json({ message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  // A wrong old password is a guess at the password like any other: counted against
  // the address, kept in the log, and not looked at from a blocked address. A stolen
  // session could otherwise guess it here without end and take the account over.
  const ip = resolveClientIp(req);
  if (loginBlocked(ip, req, req.username || '', 'change-password') || !held(ip, res)) return res.status(429).json(TOO_MANY);

  usersDB.findOne({ _id: req.userId }, (err, user) => {
    if (err) return res.status(500).json({ message: 'Error reading user' });
    if (!user) return res.status(404).json({ message: 'User not found' });

    bcrypt.compare(oldPassword, user.password, (compareErr, isMatch) => {
      if (compareErr || !isMatch) {
        recordLoginFailure(ip, req, user.username, 'wrong-password', 'change-password');
        return res.status(400).json({ message: 'Incorrect old password' });
      }
      // With two-step on, the code as well: a new password removes the account's passkeys and bound
      // phones, so a session and the password alone could shut the owner out.
      const coded = !user.twoStep ? Promise.resolve(true) : (async () => {
        if (noCode(code)) { needCode(req, res, user, 'change-password'); return false; }
        if (codesFrozen(user, code)) { res.status(429).json(TOO_MANY); return false; }
        if (codeRefusedToday(user, code)) { sayCodesSpent(req, res, user); return false; }
        // A code is spent as it is looked at (one request wins, here and at the
        // administrator's doors); a recovery code is given back when the change then
        // fails, so that does not cost one.
        if (code.length > 40 || !(await passesTwoStep(user, code))) {
          recordLoginFailure(ip, req, user.username, 'wrong-code', 'change-password');
          res.status(400).json({ message: 'Invalid code', code: 'WRONG_CODE' }); return false;
        }
        return true;
      })();
      const notChanged = () => giveRecoveryBack(user, user.twoStep && recoveryShaped(code) ? twoStep.hashRecovery(code) : null);
      coded.then((ok) => { if (!ok) return;

      bcrypt.hash(newPassword, 10, (hashErr, hashedPassword) => {
        if (hashErr) return notChanged().then(() => res.status(500).json({ message: 'Error hashing password' }));

        // Only over the password that was just checked: one changed meanwhile (an
        // admin's reset, another of the owner's pages) is not overwritten by a change
        // that was already on its way.
        usersDB.update(
          { ...activeUserMutationQuery(req.userId), password: user.password },
          { $set: { password: hashedPassword } },
          {},
          (updateErr, updated) => {
            // The account's other sessions, its passkeys and its phones all go, each
            // waited for, and said when they did not all go (the sessions too, as lifecycleAction says it).
            // A new password unbinds every login-key phone: whoever changed it may be
            // shutting out someone who had the old one. This session stays, however the
            // request named it (cookie or Authorization).
            const signInsGo = () => {
              qrRequests.revokeUser(req.userId);twoStepTickets.revokeUser(req.userId);endPasskeyChallenges(req.userId);
              const mine = hashSessionToken(req.sessionToken || req.cookies.session_id);
              return Promise.all([removeSessionsOrFail({ userId: req.userId, tokenHash: { $ne: mine } }), passkeyStore.removeAll(req.userId), loginDevices.removeAll(req.userId), trustedDevices().removeAll(req.userId)]);
            };
            // A write the store reports as failed may have been made all the same (NeDB
            // changes the row in memory before it saves it): the code stays spent (see
            // adminKept). Read back: if the new password is what the account now has,
            // it is treated as changed, the old ways in go as they would, and the page is
            // told the password may have changed.
            if (updateErr) {
              return findUser({ _id: req.userId }).catch(() => null).then((now) => {
                if (now?.password !== hashedPassword) return res.status(500).json({ message: 'Error updating password' });
                const unknown = { message: 'The password may have been changed: sign in with the new one, or with the old one if that fails', code: 'PASSWORD_CHANGE_UNKNOWN' };
                return signInsGo().then(() => res.status(500).json(unknown), (e) => { console.error('password change: sign-ins not all removed:', e.message); res.status(500).json(unknown); });
              });
            }
            if (!updated) {
              return notChanged().then(() => findUser(activeUserMutationQuery(req.userId)).catch(() => null)).then((now) => res.status(409).json(now
                ? { message: 'The password was changed meanwhile; try again', code: 'PASSWORD_CHANGED' }
                : { message: 'Account is no longer active', code: 'ACCOUNT_INACTIVE' }));
            }
            compactQuietly(usersDB, 'users');
            signInsGo()
              .then(() => res.json({ message: 'Password changed successfully' }))
              .catch((e) => { console.error('password change: sign-ins not all removed:', e.message); res.status(500).json({ message: 'Password changed, but its other sign-ins, passkeys or bound phones could not all be removed; remove them from Settings', code: 'CREDENTIAL_CLEANUP_INCOMPLETE' }); });
          },
        );
      });
      }).catch((e) => { console.error('change password:', e.message); if (!res.headersSent) res.status(500).json({ message: 'Error' }); });
    });
  });
};

// --- asking an admin again ---

// The acting admin's own password again, and the two-step code when theirs is on, or a
// passkey: for Remote (server/remote.js, opening it and trusting a device for it). A
// session alone must not be enough. (Deleting an account, the other action that asked,
// went with the web's account management: one account, kept from the Mac, localApi.js.)
// how: what is confirmed (Remote's own), written to the audit line.
// purpose: the kind of action (AGAIN_PURPOSES), which a passkey's challenge must have
// been issued for; named by every caller, none is assumed.
async function adminAgain(req, res, how, target, { purpose } = {}) {
  const { adminPassword, adminCode, adminPasskey } = req.body || {};
  // A passkey stands for the password and the code together (adminPasskeyAgain): one
  // challenge, one action, of its own kind.
  if (adminPasskey && typeof adminPasskey === 'object' && !Array.isArray(adminPasskey)) {
    let me;
    try { me = await exports.adminPasskeyAgain(req, res, adminPasskey, purpose); }
    catch (e) {
      if (e.status === 429) res.status(429).json(TOO_MANY);
      else if (e.status === 403) res.status(403).json({ message: 'Account is not active' });
      else if (e.status === 400) res.status(400).json({ message: 'Passkey not accepted', code: 'PASSKEY_REFUSED' });
      else throw e;
      return false;
    }
    req.adminGrant = { how, target, me, by: 'passkey' };
    return true;
  }
  if (typeof adminPassword !== 'string' || !adminPassword) { res.status(400).json({ message: 'Enter your own password to do this', code: 'NEED_PASSWORD' }); return false; }
  const ip = resolveClientIp(req);
  if (loginBlocked(ip, req, req.username || '', 'admin-grant') || !held(ip, res)) { res.status(429).json(TOO_MANY); return false; }
  const me = await activeAccount(req.userId);
  if (!me || me.role !== 'admin') { res.status(403).json({ message: 'Account is not active' }); return false; }
  if (!(await bcrypt.compare(adminPassword, me.password))) {
    recordLoginFailure(ip, req, me.username, 'wrong-password', 'admin-grant');
    res.status(400).json({ message: 'Invalid credentials', code: 'WRONG_PASSWORD' }); return false;
  }
  if (me.twoStep) {
    if (noCode(adminCode)) { needCode(req, res, me, 'admin-again'); return false; }
    if (codesFrozen(me, adminCode)) { res.status(429).json(TOO_MANY); return false; }
    if (codeRefusedToday(me, adminCode)) { sayCodesSpent(req, res, me); return false; }
    // A code is spent as it is looked at, so one code is one action however many
    // requests carry it at once, here or at any other door that takes one. It stays
    // spent whatever the action then does.
    if (adminCode.length > 40 || !(await passesTwoStep(me, adminCode))) {
      recordLoginFailure(ip, req, me.username, 'wrong-code', 'admin-grant');
      res.status(400).json({ message: 'Invalid code', code: 'WRONG_CODE' }); return false;
    }
  }
  req.adminGrant = { how, target, me };
  return true;
}
// The confirmed action is going ahead: the line is written now, not before, so the
// record shows only confirmations that were used.
function adminGranted(req, userId) {
  const grant = req.adminGrant;
  if (!grant) return;
  req.adminGrant = null;
  audit({ source: 'users', action: 'admin-again', how: grant.how, by: req.username, with: grant.by || 'password', target: String(userId || grant.target) });
}
// It may have happened: a store write reported as failed can have been made all the
// same (NeDB changes its rows in memory before it saves them), or the action stopped
// part-way. The confirmation counts as used and its code stays spent; no line is
// written, since the record shows only what is known to have happened.
function adminKept(req) { req.adminGrant = null; }
// A recovery code that was claimed for something that then did not happen goes back,
// to the two-step it came from and no other (one turned off or set up anew meanwhile
// has other codes): a password change that was not made (changePassword).
const giveRecoveryBack = (user, hash) => (!hash || !user?.twoStep?.secret ? Promise.resolve()
  : updateUser({ _id: user._id, 'twoStep.secret': user.twoStep.secret }, { $addToSet: { 'twoStep.recovery': hash } }).then(() => {}, (e) => console.error('recovery code not given back:', e.message)));
// Two names that are one name once folded (a Kelvin sign for k, ß for ẞ), or that the
// security log counts under one key (accountKey), would share its counts while being two
// accounts.
const nameFold = (v) => String(v || '').normalize('NFKC').trim().toLowerCase();
const sameName = (a, b) => nameFold(a) === nameFold(b) || accountKey(a) === accountKey(b);

// What changes which accounts there are is done one at a time, each reading the accounts
// as the one before left it: the setup assistant's first administrator and the Mac's
// choice of the one account to keep (server/localApi.js), and the removals at start.
let accountTurn = Promise.resolve();
const inAccountTurn = (work) => {
  const run = accountTurn.catch(() => {}).then(work);
  accountTurn = run;
  return run;
};

// The first administrator, made by Castpane.app's setup wizard (server/localApi.js)
// while there is no active account: the rule /api/local/status counts by
// (activeUserQuery), so the wizard the app opens on 0 is never refused. Accounts left
// disabled or deleted by a version that had several do not count. One at a time: a
// second call while the first is writing finds the first account and is refused like
// any later one.
exports.createFirstAdmin = ({ username, password } = {}) => inAccountTurn(async () => {
  const name = typeof username === 'string' ? username.trim() : '';
  if (!name || typeof password !== 'string') throw Object.assign(new Error('Username and password are required'), { status: 400 });
  const problem = textProblem(name, USERNAME_MAX_LENGTH, 'Username');
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  if (password.length < MIN_PASSWORD_LENGTH) throw Object.assign(new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`), { status: 400 });
  if (password.length > 1024) throw Object.assign(new Error('Password is too long'), { status: 400 });
  const rows = await new Promise((ok, no) => usersDB.find({}, (e, r) => (e ? no(e) : ok(r))));
  const active = await new Promise((ok, no) => usersDB.count(activeUserQuery(), (e, n) => (e ? no(e) : ok(n))));
  if (active > 0) throw Object.assign(new Error('An account already exists'), { status: 409, code: 'ALREADY_SET_UP' });
  // An old account keeps its name (a deleted one too, as its record): sign-in finds
  // accounts by name, and the security log counts by it.
  if (rows.some((u) => sameName(u.username, name) || u.normalizedUsername === normalizeUsername(name))) {
    throw Object.assign(new Error('This name is taken by an old account kept from an earlier version. Choose another name.'), { status: 409, code: 'NAME_TAKEN_BY_OLD_ACCOUNT' });
  }
  const hashed = await bcrypt.hash(password, 10);
  const user = await new Promise((ok, no) => usersDB.insert({ username: name, normalizedUsername: normalizeUsername(name), password: hashed, role: 'admin', language: 'en', lifecycleStatus: LIFECYCLE_STATUS.ACTIVE, lifecycleSchemaVersion: 1, madeBySetup: true }, (e, u) => (e ? no(e) : ok(u))));
  compactQuietly(usersDB, 'users');
  audit({ source: 'users', action: 'first-admin', username: user.username });
  return publicUser(user);
});

// What a disabled or deleted account runs stops (server/productAccountHooks.js; nothing
// in Castpane, whose remote viewer is cut by the relay's own re-check). Only for an
// account read back as not active: one not found is left alone.
// What could not be stopped is handed back for the response, so the admin is told which
// things to stop by hand: agentsNotStopped lists them
// by id and name; agentsStopUnchecked says the stop itself could not be done or checked.
// A product with nothing to stop returns nothing from the hook.
async function stopAgentsIfOff(id) {
  try {
    const user = await findUser({ _id: id });
    if (!user || isActiveUser(user)) return {};
    const { stopped = [], failed = [] } = require('../productAccountHooks').onAccountOff(String(user._id)) || {};
    if (stopped.length) audit({ source: 'users', action: 'agents-stopped', target: String(user._id), count: stopped.length, conversations: stopped });
    if (failed.length) audit({ source: 'users', action: 'agents-not-stopped', target: String(user._id), count: failed.length, conversations: failed.map((c) => c.id) });
    return failed.length ? { agentsNotStopped: failed } : {};
  } catch (e) { console.error('account off: its agents not all stopped:', e.message); return { agentsStopUnchecked: true }; }
}

// What goes with an account once the lifecycle delete has made it a tombstone, for
// removeMembers and keepOneAccount (finishSystemRemovals). A deleted account keeps no login-key phone, nor
// anything they approved; `left` says they did not all go (they open nothing while the
// account is off). A delete forgets what the security log holds for the account.
async function afterDelete(id, username) {
  let left = null;
  qrRequests.revokeUser(id); twoStepTickets.revokeUser(id); endPasskeyChallenges(id);
  try { await Promise.all([loginDevices.removeAll(id), trustedDevices().removeAll(id), passkeyStore.removeAll(id)]); } catch (e) { left = e; console.error('delete: passkeys or bound phones not removed:', e.message); }
  security.forgetUser(id, username);
  return { left, agentsLeft: await stopAgentsIfOff(id) };
}

// One account. A member account (role 'user') left from a version that had several is
// deleted by the server itself at start (server/start.js, removeMembers); every account
// but the one administrator the person at the Mac keeps is deleted when they choose it
// (keepOneAccount, localApi.js). Both delete by SYSTEM_ACTOR (services/userLifecycle.js),
// with their own reason ('not-an-admin', 'one-account'). Disabled ones and ones with a
// disable or enable left pending go too. A removal stopped before its clean-up or its
// audit line, or with a clean-up left undone, is finished at the next start: the
// tombstone keeps systemRemoval until it is clean, and a system delete left pending is
// run again. systemRemoval is written on the account, with the reason, before its delete
// is started, and the delete keeps it on the tombstone (services/userLifecycle.js): a
// delete an older version's web route left pending is carried on by the lifecycle service
// under that admin's name (its tombstone's deletedBy is the user), and the mark is what
// still makes it one of these. Each removal is one audit line, which the Mac app's Activity shows
// (localApi.js, kind account-removed, with its reason). Nothing here throws but the
// refusal of an account to keep that is not an active administrator.
const usersNow = () => new Promise((ok, no) => usersDB.find({}, (e, r) => (e ? no(e) : ok(r))));
const pendingNow = () => new Promise((ok, no) => userLifecycleTransitionsDB.find({ status: 'pending' }, (e, r) => (e ? no(e) : ok(r))));
const markRemoval = (id, mark) => new Promise((ok, no) => usersDB.update({ _id: id }, { $set: { systemRemoval: mark } }, {}, (e) => (e ? no(e) : ok())));
// Before a delete: on an account not yet a tombstone only, so a tombstone's mark (logged
// already, perhaps) is never set back.
const notTombstone = (id) => ({ _id: id, lifecycleStatus: { $ne: LIFECYCLE_STATUS.DELETED_TOMBSTONE } });
const markBefore = (id, reason) => new Promise((ok, no) => usersDB.update(notTombstone(id), { $set: { systemRemoval: { reason, logged: false, clean: false } } }, {}, (e) => (e ? no(e) : ok())));
const unmarkBefore = (id) => new Promise((ok, no) => usersDB.update(notTombstone(id), { $unset: { systemRemoval: true } }, {}, (e) => (e ? no(e) : ok())));
const isTombstone = (u) => u.lifecycleStatus === LIFECYCLE_STATUS.DELETED_TOMBSTONE;
const markedReason = (u) => (SYSTEM_DELETE_REASONS.includes(u?.systemRemoval?.reason) ? u.systemRemoval.reason : null);
// Deleted by the server: by its own actor, or a delete it carried on (markedReason).
const byServer = (u) => u.deletedBy?.type === 'system' || !!markedReason(u);
// A tombstone written before the reason was kept with it is a member's.
const removalReason = (u) => ((u.deletedBy?.type === 'system' && SYSTEM_DELETE_REASONS.includes(u.deletionReason)) ? u.deletionReason : markedReason(u) || 'not-an-admin');

async function systemDelete(id, reason, failed) {
  try { await markBefore(id, reason); }
  catch (e) {
    console.error(`account ${id} not removed (tried again at the next start):`, e?.message);
    failed.push({ id, error: e?.code || e?.message });
    return false;
  }
  try { await lifecycleService().deleteUser({ targetUserId: id, actor: SYSTEM_ACTOR, reason }); return true; }
  catch (e) {
    // Left part-way, the delete is still pending and keeps its mark; refused before it
    // began, the account is as it was.
    if (e?.code === 'USER_LIFECYCLE_PARTIAL') await stopAgentsIfOff(id);
    else await unmarkBefore(id).catch((u) => console.error(`account ${id}: removal mark not cleared:`, u?.message));
    console.error(`account ${id} not removed (tried again at the next start):`, e?.code || '', e?.message);
    failed.push({ id, error: e?.code || e?.message });
    return false;
  }
}

// Every tombstone the server deleted that is not yet clean, of those `only` takes: the
// rest of the removal (afterDelete), its audit line once, and the mark.
async function finishSystemRemovals(only = () => true) {
  const removed = [], failed = [];
  let rows;
  try { rows = await usersNow(); } catch (e) { console.error('removals not finished (tried again at the next start):', e.message); return { removed, failed: [{ error: e.message }] }; }
  for (const u of rows) {
    if (!isTombstone(u) || !byServer(u) || u.systemRemoval?.clean || !only(u)) continue;
    const id = String(u._id);
    try {
      const { left } = await afterDelete(id, u.username);
      if (!u.systemRemoval?.logged) audit({ source: 'users', action: 'account-removed', username: u.username, target: id, reason: removalReason(u), by: SYSTEM_ACTOR.id, ...(left ? { cleanupIncomplete: true } : {}) });
      await markRemoval(id, { ...(markedReason(u) ? { reason: markedReason(u) } : {}), logged: true, clean: !left });
      if (left) failed.push({ id, error: 'CREDENTIAL_CLEANUP_INCOMPLETE' }); else removed.push(id);
    } catch (e) {
      console.error(`account ${id} removal not finished (tried again at the next start):`, e?.message);
      failed.push({ id, error: e?.message });
    }
  }
  return { removed, failed };
}

// At start. Only while an administrator is active, with nothing pending: with none, the
// accounts are not what Castpane leaves (a database cut short, restored or edited by
// hand) and nothing is deleted; it is logged instead. Administrators stay unless a
// keepOneAccount left their delete pending, which is run again here.
exports.removeMembers = () => inAccountTurn(async () => {
  const failed = [];
  let rows, pending;
  try { [rows, pending] = await Promise.all([usersNow(), pendingNow()]); }
  catch (e) { console.error('members not removed (tried again at the next start):', e.message); return { removed: [], failed: [{ error: e.message }], skipped: false }; }
  let adminActive = false;
  for (const u of rows) if (u.role === 'admin' && await activeAccount(String(u._id)).catch(() => null)) { adminActive = true; break; }
  const targets = new Map();
  for (const u of rows) if (u.role === 'user' && !isTombstone(u)) targets.set(String(u._id), 'not-an-admin');
  // A system delete stopped part-way (a tombstone too: its journal row is then closed),
  // and an older version's delete the server carried on (its account marked).
  const byId = new Map(rows.map((u) => [String(u._id), u]));
  for (const t of pending) {
    if (t.action !== 'delete') continue;
    const reason = t.actor?.type === 'system' && SYSTEM_DELETE_REASONS.includes(t.reason) ? t.reason : markedReason(byId.get(String(t.userId)));
    if (reason) targets.set(String(t.userId), reason);
  }
  if (targets.size && !adminActive) {
    console.error(`${targets.size} account(s) not removed: no administrator is active, so the accounts are not as Castpane leaves them`);
    audit({ source: 'users', action: 'members-kept', count: targets.size, reason: 'no-active-admin', by: SYSTEM_ACTOR.id });
    return { removed: [], failed, skipped: true };
  }
  for (const [id, reason] of targets) await systemDelete(id, reason, failed);
  // Every tombstone the server deleted that is not yet clean: those just made, and those
  // an earlier start or keep left part-way.
  const done = await finishSystemRemovals();
  return { removed: done.removed, failed: [...failed, ...done.failed], skipped: false };
});

// The administrators the person at the Mac can choose from (localApi.js, GET
// /api/local/accounts, and status.admins counts them): active, with nothing pending
// (activeAccount), by name. Only the id and the names. others: how many accounts that are
// not tombstones are not among them, which a keep deletes too (members, disabled ones,
// ones with something pending, other roles); from the same read.
async function keepChoice() {
  const [rows, pending] = await Promise.all([usersNow(), pendingNow()]);
  const busy = new Set(pending.map((t) => String(t.userId)));
  const key = (u) => String(u.username || '').toLowerCase();
  const admins = rows
    .filter((u) => u.role === 'admin' && isActiveUser(u) && !busy.has(String(u._id)))
    .sort((a, b) => key(a).localeCompare(key(b)) || String(a._id).localeCompare(String(b._id)))
    .map((u) => ({ id: String(u._id), username: u.username, name: u.name || u.username, madeBySetup: u.madeBySetup === true }));
  const listed = new Set(admins.map((a) => a.id));
  return { admins, others: rows.filter((u) => !isTombstone(u) && !listed.has(String(u._id))).length };
}
exports.keepChoice = keepChoice;
exports.activeAdmins = async () => (await keepChoice()).admins;

// POST /api/local/accounts/keep (localApi.js): the person at the Mac keeps one active
// administrator and every other account goes, whatever its role or state; a tombstone
// is already gone. In the account turn, so two keeps (or a keep and the setup assistant)
// never interleave. Said again, it deletes nothing more and finishes what an earlier
// one left part-way. The kept account's sign-ins are untouched; the others' end with
// their delete (services/userLifecycle.js removes their sessions).
const KEEP_ID_MAX = 128;
exports.keepOneAccount = (id) => inAccountTurn(async () => {
  const keep = typeof id === 'string' && id.length <= KEEP_ID_MAX ? id : '';
  const kept = keep ? await activeAccount(keep) : null;
  if (!kept || kept.role !== 'admin') throw Object.assign(new Error('Choose an active administrator account to keep'), { status: 400, code: 'NOT_AN_ACTIVE_ADMIN' });
  const failed = [];
  const targets = (await usersNow()).filter((u) => String(u._id) !== keep && !isTombstone(u)).map((u) => String(u._id));
  if (targets.length) audit({ source: 'users', action: 'one-account-kept', username: kept.username, target: keep, count: targets.length, by: SYSTEM_ACTOR.id });
  for (const target of targets) await systemDelete(target, 'one-account', failed);
  const notDone = new Set(failed.map((f) => f.id));
  const chosen = new Set(targets);
  const done = await finishSystemRemovals((u) => !notDone.has(String(u._id)) && (chosen.has(String(u._id)) || removalReason(u) === 'one-account'));
  return { kept: keep, removed: done.removed, failed: [...failed, ...done.failed] };
});

exports._setUserLifecycleServiceForTests = (service) => {
  injectedLifecycleService = service || null;
};

// QR sign-in (services/qrLogin.js).
const qrRequests = qrLogin.createRequests();
const loginDevices = qrLogin.createDevices(loginDevicesDB);
const findUser = (query) => new Promise((ok, no) => usersDB.findOne(query, (e, u) => (e ? no(e) : ok(u))));
const findSessions = (query) => new Promise((ok, no) => sessionsDB.find(query, (e, r) => (e ? no(e) : ok(r))));
async function activeAccount(userId) {
  const user = await findUser({ _id: userId });
  if (!isActiveUser(user)) return null;
  if (await findPendingLifecycleTransition(userLifecycleTransitionsDB, userId)) return null;
  return user;
}
const sendQrError = (res, e) => res.status(e.status || 500).json({ message: e.status ? e.message : 'Error' });

const liveSessionMarks = (rows) => rows.filter((x) => new Date(x.expiresAt).getTime() > Date.now()).map((x) => x.tokenHash);
const removeSessions = (query) => new Promise((ok) => sessionsDB.remove(query, { multi: true }, () => ok()));
// The same, but a failure is one: for the places that tell an admin the sign-ins are gone.
const removeSessionsOrFail = (query) => new Promise((ok, no) => sessionsDB.remove(query, { multi: true }, (e) => (e ? no(e) : ok())));
// A phone is unbound: what it approved and has not been collected is void, and what
// it let in is signed out, with any phone bound in those sessions in turn; a session
// signed out takes the phone bound in it along (only the first link of that chain used to go).
async function dropPhone(userId, phone) {
  await loginDevices.remove(userId, phone._id);
  qrRequests.revokeDevice(phone._id);
  for (const row of await findSessions({ userId, approvedBy: phone._id })) await dropSession(userId, row);
}
// A phone whose binding session is gone (idle past its days) can approve nothing any
// more: its key goes, and does not count against the ten. What it let in stays signed
// in, as when the phone signs itself out: a phone left unopened for two weeks must not
// sign the account's computers out. A key unbound, replaced, or whose session is
// signed out from the list does take what it let in along: dropPhone.
async function dropLapsedPhones(userId) {
  const live = liveSessionMarks(await findSessions({ userId }));
  for (const phone of await loginDevices.lapsed(userId, live)) { qrRequests.revokeDevice(phone._id); await loginDevices.remove(userId, phone._id); }
}
// One bind at a time for an account: two sent at once each found no key before
// them and left two keys on one session.
const bindQueue = new Map();
function oneBindAtATime(userId, work) {
  const key = String(userId);
  const run = (bindQueue.get(key) || Promise.resolve()).catch(() => {}).then(work);
  bindQueue.set(key, run);
  run.catch(() => {}).then(() => { if (bindQueue.get(key) === run) bindQueue.delete(key); });
  return run;
}
async function dropSession(userId, row) {
  await removeSessions({ _id: row._id });
  const phone = await loginDevices.bySession(userId, row.tokenHash);
  if (phone) await dropPhone(userId, phone);
}
// POST /api/auth/devices {name, password, code}: this phone becomes a login key. The
// password again (and the two-step code, when that is on), so a session cookie alone
// cannot make one.
exports.bindDevice = async (req, res) => {
  try {
    const { name, password, code } = req.body || {};
    const ip = resolveClientIp(req);
    // A place taken before the password is looked at, like every other check of one.
    if (loginBlocked(ip, req, '', 'bind') || !held(ip, res)) return res.status(429).json({ message: 'Too many attempts, try again later' });
    const user = await activeAccount(req.userId);
    if (!user) return res.status(403).json({ message: 'Account is not active' });
    const ok = typeof password === 'string' && password && await bcrypt.compare(password, user.password);
    if (!ok) { recordLoginFailure(ip, req, user.username, 'wrong-password', 'bind'); return res.status(400).json({ message: 'Invalid credentials', code: 'WRONG_PASSWORD' }); }
    // A bound phone is a way in (it approves QR sign-ins): with two-step on it takes
    // the code as well, like a new passkey, or a session and the password would get
    // round the second step.
    if (user.twoStep) {
      if (noCode(code)) return needCode(req, res, user, 'bind');
      if (codesFrozen(user, code)) return res.status(429).json(TOO_MANY);
      if (codeRefusedToday(user, code)) return sayCodesSpent(req, res, user);
      if (typeof code !== 'string' || code.length > 40 || !(await passesTwoStep(user, code))) {
        recordLoginFailure(ip, req, user.username, 'wrong-code', 'bind');
        return res.status(400).json({ message: 'Invalid code', code: 'WRONG_CODE' });
      }
    }
    // One key a session: binding again replaces the one before, so signing the
    // session out leaves no second key behind. Replacing it is unbinding it: the
    // computers the old key let in are signed out with it (the page says so).
    const mark = hashSessionToken(req.sessionToken || req.cookies?.session_id || '');
    const device = await oneBindAtATime(req.userId, async () => {
      await dropLapsedPhones(req.userId);
      // This session may itself have been let in by a key that just went.
      if (!liveSessionMarks(await findSessions({ userId: req.userId })).includes(mark)) throw Object.assign(new Error('Sign in again'), { status: 401 });
      const before = await loginDevices.bySession(req.userId, mark);
      if (before) await dropPhone(req.userId, before);
      const made = await loginDevices.bind(req.userId, typeof name !== 'string' || textProblem(name, 40, 'name') ? 'Phone' : name, mark);
      for (const extra of await loginDevices.others(req.userId, mark, made.id)) await dropPhone(req.userId, extra);
      return made;
    });
    audit({ source: 'qr-login', action: 'bind', userId: req.userId, deviceId: device.id });
    security.qr({ action: 'bind', userId: req.userId, deviceId: device.id, ip, place: placeOf(req) });
    res.status(201).json({ device });
  } catch (e) { sendQrError(res, e); }
};
// GET /api/auth/devices: the account's login-key phones and its signed-in sessions.
exports.listDevices = async (req, res) => {
  try {
    const current = req.sessionToken || req.cookies?.session_id ? hashSessionToken(req.sessionToken || req.cookies.session_id) : null;
    // Keys bound in a session that has ended approve nothing: dropped, not listed,
    // before the sessions are read, since what they let in goes with them.
    await dropLapsedPhones(req.userId);
    const rows = await findSessions({ userId: req.userId });
    if (current && !rows.some((x) => x.tokenHash === current)) return res.status(401).json({ message: 'Sign in again' });
    // Sessions from before devices were kept have no browser noted: this one is
    // known now, so it is filled in.
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    for (const x of rows) if (x.tokenHash === current && !x.userAgent && ua) { x.userAgent = ua;sessionsDB.update({ _id: x._id }, { $set: { userAgent: ua } }, {}, () => {}); }
    const sessions = rows.filter((x) => new Date(x.expiresAt).getTime() > Date.now())
      .map((x) => ({ id: x._id, method: x.method || 'password', userAgent: x.userAgent || '', createdAt: x.createdAt ? new Date(x.createdAt).toISOString() : null, lastSeen: x.lastSeen ? new Date(x.lastSeen).toISOString() : null, current: x.tokenHash === current }))
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
    res.json({ devices: await loginDevices.list(req.userId), sessions });
  } catch (e) { sendQrError(res, e); }
};
// Unbinding a phone also signs out what it let in, and, removed from another device
// (a lost phone), the phone's own session.
exports.removeDevice = async (req, res) => {
  try {
    const device = await loginDevices.find(req.userId, req.params.id);
    if (!device) return res.status(404).json({ message: 'Not found' });
    const current = hashSessionToken(req.sessionToken || req.cookies?.session_id || '');
    await dropPhone(req.userId, device);
    if (device.sessionHash && device.sessionHash !== current) await removeSessions({ userId: req.userId, tokenHash: device.sessionHash });
    audit({ source: 'qr-login', action: 'unbind', userId: req.userId, deviceId: device._id });
    security.qr({ action: 'unbind', userId: req.userId, deviceId: device._id, ip: resolveClientIp(req), place: placeOf(req) });
    res.json({ ok: true });
  } catch (e) { sendQrError(res, e); }
};
// DELETE /api/auth/sessions/:id: sign one of one's own devices out.
// A phone's own session signed out unbinds that phone too, with what it let in:
// signing out a lost phone should leave nothing of it behind.
exports.removeSession = async (req, res) => {
  try {
    const [row] = await findSessions({ _id: String(req.params.id), userId: req.userId });
    if (!row) return res.status(404).json({ message: 'Not found' });
    await dropSession(req.userId, row);
    // That device's open pages told at once (server/liveUpdates.js).
    require('../liveUpdates').endSignIn(row.tokenHash);
    res.json({ ok: true });
  } catch (e) { sendQrError(res, e); }
};
// The app's "Stop sharing now" (server/remote.js): the sign-in the viewer watched
// from ends, as when it is signed out from the account's device list.
exports.endSession = async (userId, token) => {
  if (!token || typeof token !== 'string') return;
  const tokenHash = hashSessionToken(token);
  for (const row of await findSessions({ tokenHash })) if (String(row.userId) === String(userId)) await dropSession(row.userId, row);
  require('../liveUpdates').endSignIn(tokenHash);
};
// POST /api/auth/qr/start {username}: a login page asks for a request (no session
// yet), for the account whose name it was given.
exports.qrStart = (req, res) => {
  try { res.json(qrRequests.start({ ip: resolveClientIp(req), ua: req.headers['user-agent'], name: (req.body || {}).username })); } catch (e) { sendQrError(res, e); }
};
// GET /api/auth/qr/poll?id= with its poll secret in X-QR-Poll: that page asks how it
// stands; approved, it is signed in here, once. A GET, so its asking every two
// seconds is not counted against the site's cap on changes; the secret travels in
// a header another site cannot set.
exports.qrPoll = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const r = qrRequests.collect(req.query?.id, req.headers['x-qr-poll']);
    if (r.status !== 'approved') return res.json({ status: r.status });
    const user = await activeAccount(r.userId);
    // The approving phone must still be bound, and the session it was bound in still
    // signed in: unbinding it, signing it out, or a password change (which unbinds
    // them all) voids what it approved.
    const phone = user && r.deviceId ? await loginDevices.find(r.userId, r.deviceId) : null;
    if (!phone || !liveSessionMarks(await findSessions({ userId: r.userId })).includes(phone.sessionHash)) return res.json({ status: 'denied' });
    issueSession(user, res, { method: 'qr', ua: req.headers['user-agent'], approvedBy: r.deviceId });
    audit({ source: 'qr-login', action: 'signed-in', userId: r.userId, ip: resolveClientIp(req) });
    security.qr({ action: 'signed-in', userId: r.userId, deviceId: r.deviceId, ip: resolveClientIp(req), place: placeOf(req) });
    res.json({ status: 'approved', user: publicUser(user), expiresIn: IDLE_SECONDS });
  } catch (e) { sendQrError(res, e); }
};
// GET /api/auth/qr/:id: the bound phone reads who is asking, before deciding.
exports.qrPeek = async (req, res) => {
  // Only a bound phone reads who is asking (its id and secret in headers): another
  // account seeing the code learns nothing of that computer.
  const session = hashSessionToken(req.sessionToken || req.cookies?.session_id || '');
  if (!(await loginDevices.verify(req.userId, req.headers['x-device-id'], req.headers['x-device-secret'], session).catch(() => null))) return res.status(403).json({ message: 'This phone is not bound as a login key', code: 'DEVICE_NOT_BOUND' });
  const r = qrRequests.peek(req.params.id);
  if (!r) return res.status(404).json({ message: 'This code has expired; refresh the login page' });
  // A hint only, by address group: an IPv6 /64 is one network.
  const { group, ...shown } = r;
  res.json({ ...shown, sameNetwork: group === security.groupOf(resolveClientIp(req)) });
};
// POST /api/auth/qr/:id/decide {approve, deviceId, secret}: only from a phone the
// account bound, and only for the account signed in on it.
exports.qrDecide = async (req, res) => {
  try {
    const { approve, deviceId, secret, code } = req.body || {};
    const account = await activeAccount(req.userId);
    if (!account) return res.status(403).json({ message: 'Account is not active' });
    const session = hashSessionToken(req.sessionToken || req.cookies?.session_id || '');
    if (!(await loginDevices.verify(req.userId, deviceId, secret, session))) return res.status(403).json({ message: 'This phone is not bound as a login key', code: 'DEVICE_NOT_BOUND' });
    const outcome = qrRequests.decide(req.params.id, req.userId, approve === true, { code, deviceId, name: account.username });
    if (outcome === 'gone') return res.status(404).json({ message: 'This code has expired; refresh the login page' });
    if (outcome === 'wrong-account') { audit({ source: 'qr-login', action: 'wrong-account', userId: req.userId, deviceId });security.qr({ action: 'wrong-account', userId: req.userId, deviceId, ip: resolveClientIp(req), place: placeOf(req) }); }
    if (outcome === 'wrong-account') return res.status(409).json({ message: 'That page is signing in a different account; the request was refused', code: 'WRONG_ACCOUNT' });
    if (outcome === 'wrong-code') { audit({ source: 'qr-login', action: 'wrong-code', userId: req.userId, deviceId });security.qr({ action: 'wrong-code', userId: req.userId, deviceId, ip: resolveClientIp(req), place: placeOf(req) });return res.status(400).json({ message: 'The number does not match; the request was refused', code: 'WRONG_CODE' }); }
    audit({ source: 'qr-login', action: approve === true ? 'approve' : 'deny', userId: req.userId, deviceId });
    security.qr({ action: approve === true ? 'approve' : 'deny', userId: req.userId, deviceId, ip: resolveClientIp(req), place: placeOf(req) });
    res.json({ ok: true });
  } catch (e) { sendQrError(res, e); }
};
exports._qrRequests = qrRequests;
// The admin's password (and code) again, for what another part of the site guards the
// same way: a remote pass (server/remote.js).
exports.adminAgain = adminAgain;
exports.adminGranted = adminGranted;
exports.adminKept = adminKept;
