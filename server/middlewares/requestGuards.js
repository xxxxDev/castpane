const crypto = require('crypto');
const { resolveClientIp } = require('../services/clientIp');

// Site-wide mutation guards. The app authenticates with a cookie
// (authMiddleware.js), so without these a signed-in user's browser could be driven by
// any third-party page: accounts and settings changed in their name, or a remote pass
// asked for. These are deliberately identity-blind: they run before verifyToken and
// never read req.userId/req.username/req.role.
//
// Single source of truth for the origin policy. server/app.js's cors() calls
// isAllowedOrigin() too, so the CORS list and the mutation gate cannot drift apart.
//
// The address and the ports come from server/siteConfig.js (one place). The service
// is reached through its public address (a tunnel or a proxy) and on this Mac's
// loopback; the Host check in server/app.js
// (siteConfig.isAllowedHost) refuses any other Host, a LAN address included, before
// these guards run.
const site = require('../siteConfig');

// The public address, when there is one. Origin-checked even for the app's own
// POSTs, so it MUST stay allow-listed or sign-in and every POST fail.
const publicOrigins = () => (site.publicOrigin() ? [site.publicOrigin()] : []);
// This Mac's loopback on the service's own port: what "Open in browser" on this Mac
// opens. Another port is another program's page. The vite dev server's and a test
// instance's ports only while developing (siteConfig.devMode: CASTPANE_DEV=1 outside
// production), never for the service the app starts.
const loopbackOrigins = () => [...new Set([site.servicePort(), ...site.devPorts()])].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

// Passkeys belong to the public HTTPS address alone: a key made for localhost would be
// the same key on every machine and port, and anything serving a page there could ask
// for it; and a plain-HTTP page cannot use them at all. The setting
// PRODUCT.env.passkeyTestOrigin names (siteConfig.js) is a test seam for a throwaway
// instance, never set for the real service.
function isPasskeyOrigin(origin) {
  if (site.publicIsHttps() && publicOrigins().includes(origin)) return true;
  const testOrigin = process.env[site.PRODUCT.env.passkeyTestOrigin];
  return process.env.NODE_ENV !== 'production' && !!testOrigin && origin === testOrigin;
}

function isAllowedOrigin(origin) {
  return publicOrigins().includes(origin) || loopbackOrigins().includes(origin);
}

// GET/HEAD are never gated. OPTIONS is cors()'s preflight and never reaches a route.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isUnsafe = (req) => !SAFE_METHODS.has(req.method);

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const csrfTokenShape = /^[a-f0-9]{64}$/;

// Whether this request reached the browser over HTTPS. The tunnel terminates TLS
// and forwards to loopback in plain HTTP, and Cloudflare redirects plain HTTP to
// the public host before it gets here, so that Host is the signal. Loopback access
// stays plain HTTP, where a Secure cookie would never be sent back.
// Keyed on the request, not on NODE_ENV: the same service answers both the public
// HTTPS address and plain-HTTP loopback.
function isHttpsRequest(req) {
  const publicName = site.publicIsHttps() ? new URL(site.publicOrigin()).hostname : '';
  return Boolean(req && (req.secure || req.get?.('x-forwarded-proto') === 'https' || (publicName && String(req.hostname || '') === publicName)));
}

function csrfCookieOpts(req) {
  return {
    // the SPA has to read this one back out to echo it in the header, so unlike
    // session_id it cannot be httpOnly — it is a CSRF token, not a credential
    httpOnly: false,
    secure: isHttpsRequest(req),
    sameSite: 'Lax',
    path: '/',
  };
}

// A session cookie by design: if it is dropped, the next /api request re-mints
// it before any mutation can be attempted (App.vue fires GET /api/auth/verify
// on every boot), so the pair is self-healing and survives a server restart.
function issueCsrfCookie(req, res, next) {
  if (!csrfTokenShape.test(req.cookies?.[CSRF_COOKIE] || '')) {
    res.cookie(CSRF_COOKIE, crypto.randomBytes(32).toString('hex'), csrfCookieOpts(req));
  }
  next();
}

function sameToken(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function requireAllowedOrigin(req, res, next) {
  if (!isUnsafe(req)) return next();
  const origin = req.get('origin');
  // fail closed: absent or unparseable Origin is refused, never waved through
  if (!origin || !isAllowedOrigin(origin)) {
    return res.status(403).json({ message: 'Origin not allowed' });
  }
  next();
}

// Blocks the form-post / simple-request CSRF shapes (text/plain,
// form-urlencoded, multipart) that never trigger a preflight. Only enforced when
// a body is actually present: the app's DELETEs are bodyless and would otherwise
// be refused for a content-type they have no reason to send.
function hasBody(req) {
  return req.get('transfer-encoding') !== undefined || Number(req.get('content-length')) > 0;
}

function requireJsonContentType(req, res, next) {
  if (!isUnsafe(req) || !hasBody(req)) return next();
  if (!req.is('application/json')) {
    return res.status(415).json({ message: 'Content-Type must be application/json' });
  }
  next();
}

// Double-submit cookie: the token is echoed from a JS-readable cookie into a
// header. A cross-site attacker can make the browser SEND the cookie but cannot
// READ it (it is host-only, and JS cannot see Set-Cookie), so it cannot populate
// the header. This needs no server-side state, unlike a session-bound HMAC.
function requireCsrfToken({ exempt = [] } = {}) {
  return (req, res, next) => {
    if (!isUnsafe(req) || exempt.includes(req.path)) return next();
    const cookie = req.cookies?.[CSRF_COOKIE];
    const header = req.get(CSRF_HEADER);
    if (
      !csrfTokenShape.test(cookie || '') ||
      !csrfTokenShape.test(header || '') ||
      !sameToken(cookie, header)
    ) {
      return res.status(403).json({ message: 'Invalid CSRF token' });
    }
    next();
  };
}

// Fixed window, in memory, same shape as authController's login-failure limiter.
const RATE_LIMIT_MAX_KEYS = 5000;

const { ipGroup } = require('../services/qrLogin');
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    if (!isUnsafe(req)) return next();
    const now = Date.now();
    // By the address's group, as the sign-in blocks are: an IPv6 /64 is one caller.
    const key = ipGroup(String(resolveClientIp(req) || 'unknown'));
    let entry = hits.get(key);
    // reclaim this caller's own expired bucket so a returning client is a fresh
    // window, not counted as a brand-new key against the cap
    if (entry && now > entry.resetAt) {
      hits.delete(key);
      entry = undefined;
    }
    if (!entry) {
      // Admitting a NEW key. Sweeping only expired entries frees nothing under a
      // flood of unique unexpired, trusted client addresses, so after
      // an opportunistic sweep we FAIL CLOSED once full: an unbounded key map is
      // itself a denial-of-service. Existing keys (handled above/below) are never
      // rejected here, so legitimate in-window callers keep their bucket.
      if (hits.size >= RATE_LIMIT_MAX_KEYS) {
        for (const [k, e] of hits) if (now > e.resetAt) hits.delete(k);
      }
      if (hits.size >= RATE_LIMIT_MAX_KEYS) {
        res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
        return res.status(429).json({ message: 'Too many requests, slow down' });
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ message: 'Too many requests, slow down' });
    }
    next();
  };
}

// express.json()'s 100kb default, stated explicitly: mutation bodies are small
// allow-listed field sets, far below it.
const JSON_BODY_LIMIT = '100kb';

// express's default error handler answers a body-parser error with HTML — and
// leaks a stack trace outside production. Keep the API's JSON error shape.
function jsonBodyErrorHandler(err, req, res, next) {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body too large' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Malformed JSON body' });
  }
  return next(err);
}

module.exports = {
  isAllowedOrigin,
  isPasskeyOrigin,
  isHttpsRequest,
  issueCsrfCookie,
  requireAllowedOrigin,
  requireJsonContentType,
  requireCsrfToken,
  rateLimit,
  RATE_LIMIT_MAX_KEYS,
  jsonBodyErrorHandler,
  JSON_BODY_LIMIT,
};
