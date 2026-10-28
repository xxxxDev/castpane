const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  const mapped = candidate.match(/^::ffff:(\d{1,3}(?:[.]\d{1,3}){3})$/i);
  if (mapped && net.isIP(mapped[1]) === 4) return mapped[1];
  return net.isIP(candidate) ? candidate : null;
}

function isLoopback(value) {
  const ip = normalizeIp(value);
  if (!ip) return false;
  if (net.isIP(ip) === 4) return ip.startsWith('127.');
  return ip === '::1';
}

function singleCloudflareIp(headers = {}) {
  const value = headers['cf-connecting-ip'];
  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    return normalizeIp(value[0]);
  }
  if (typeof value !== 'string' || value.includes(',')) return null;
  return normalizeIp(value);
}

// How people reach this Mac, as the app chose it: `connection` in
// $CASTPANE_HOME/config.json (none, quick, domain or tailscale; docs/protocol.md), or
// CASTPANE_CONNECTION when it is set (it wins). Read again whenever the file changes.
const CLOUDFLARE_MODES = new Set(['quick', 'domain']);
let cached = { key: '', mode: '' };
function configFile() {
  const home = process.env.CASTPANE_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'Castpane');
  return path.join(home, 'config.json');
}
function connectionMode() {
  const fromEnv = process.env.CASTPANE_CONNECTION;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const file = configFile();
  let st;
  try { st = fs.statSync(file); } catch { return ''; }
  if (!st.isFile() || st.size > 64 * 1024) return '';
  const key = `${file}:${st.ino}:${st.size}:${st.mtimeMs}`;
  if (cached.key !== key) {
    let mode = '';
    try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (typeof c?.connection === 'string') mode = c.connection; } catch { /* unreadable: none */ }
    cached = { key, mode };
  }
  return cached.mode;
}
// Cloudflare's tunnel (cloudflared) is the only hop that sets CF-Connecting-IP, and it
// runs only for the quick and own-domain connections. Anything else, a missing or
// unreadable config.json included, trusts no header.
const trustsCloudflare = () => CLOUDFLARE_MODES.has(connectionMode());

// A request that came through some other local proxy, though the mode is Cloudflare's: a
// `tailscale serve` left over from the Tailscale mode, say, which passes on a tailnet
// client's own CF-Connecting-IP. Tailscale names the tailnet user in Tailscale-User-*
// headers. Cloudflare appends the address it was reached from, the same one as
// CF-Connecting-IP, to X-Forwarded-For; another proxy appends its own peer after it, so
// the last entry no longer matches.
function viaOtherProxy(headers = {}) {
  if (Object.keys(headers).some((k) => k.toLowerCase().startsWith('tailscale-user-'))) return true;
  const xff = headers['x-forwarded-for'];
  if (xff === undefined) return false;
  const hops = (Array.isArray(xff) ? xff.join(',') : String(xff)).split(',').map((h) => h.trim()).filter(Boolean);
  return !hops.length || normalizeIp(hops[hops.length - 1]) !== singleCloudflareIp(headers);
}

function resolveClientIp(req = {}) {
  // Express trust-proxy remains disabled. Every non-loopback peer is keyed by its
  // socket address; X-Forwarded-For is deliberately ignored. A Cloudflare identity
  // header is accepted only from a direct local peer, and only while a Cloudflare
  // tunnel is how this Mac is reached: under Tailscale the client itself could set it. Nor when another local proxy relayed the request.
  const remote = normalizeIp(
    req.socket?.remoteAddress || req.connection?.remoteAddress,
  ) || 'unknown';
  if (!isLoopback(remote) || !trustsCloudflare() || viaOtherProxy(req.headers)) return remote;
  return singleCloudflareIp(req.headers) || remote;
}

module.exports = {
  connectionMode,
  isLoopback,
  normalizeIp,
  resolveClientIp,
  singleCloudflareIp,
  trustsCloudflare,
  viaOtherProxy,
};
