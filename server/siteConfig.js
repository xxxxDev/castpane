// Where this Castpane is reached, in one place: every check that trusts a Host or an
// Origin reads the public address and the port from here.
//
// Castpane.app starts the server with (docs/protocol.md):
//   CASTPANE_HOME           the app's folder (~/Library/Application Support/Castpane)
//   CASTPANE_PORT           the loopback port, 47900 unless set
//   CASTPANE_PUBLIC_ORIGIN  the address people open: an HTTPS origin (a tunnel, your
//                           own domain, Tailscale), or empty for this Mac only
//   CASTPANE_WEB_DIST       the built PWA (web/dist)
//
// Passkeys belong to the public HTTPS address, so changing it later makes every
// registered passkey stop working.
const DEFAULT_PORT = 47900;

// What else is this product's own: the generic files read these from here. The labels
// below are mixed into what is stored, so each keeps the value it had when the data was
// made: a different push label leaves every saved subscription unreadable, a different
// two-step label every authenticator secret, a different recovery label every recovery
// code. They are not to be changed.
const PRODUCT = Object.freeze({
  name: 'Castpane',
  // pushCrypto.js: the AES-GCM additional data of a stored push subscription.
  pushEncryptionLabel: 'castpane:web-push-subscription:v1',
  // twoStep.js: the name an authenticator app shows, the key the secrets are sealed
  // with, and what a recovery code is hashed with.
  twoStepIssuer: 'Castpane',
  twoStepKeyLabel: 'castpane two-step',
  recoveryCodeLabel: 'castpane recovery',
  // app.js: sources a page may use beyond this origin, by CSP directive. None here.
  cspExtraSources: Object.freeze({}),
  // The names of the environment settings that generic files read: the audit log's
  // path (services/audit.js), a throwaway instance's passkey origin
  // (middlewares/requestGuards.js) and the build folder (app.js).
  env: Object.freeze({
    auditLog: 'CASTPANE_AUDIT_LOG',
    passkeyTestOrigin: 'CASTPANE_PASSKEY_TEST_ORIGIN',
    distDir: 'CASTPANE_WEB_DIST',
    home: 'CASTPANE_HOME',
  }),
  // Folder names a test process writes in under the system's temporary folder
  // (services/audit.js, services/securityLog.js): `${tempPrefix}-test-audit-<pid>`.
  tempPrefix: 'castpane',
  // services/securityLog.js, stored data: the folder it is kept in (the setting dirEnv
  // names; start.js sets it to <CASTPANE_HOME>/data, else dir from the repository's
  // root), its file, and the label account names are hashed with. The label and the
  // file are not to be changed.
  securityLog: Object.freeze({
    dirEnv: 'CASTPANE_SECURITY_DIR',
    dir: '.castpane/data',
    file: 'security-log.json',
    nameHashLabel: 'security-log-names',
  }),
});
// A throwaway test instance and the vite dev server.
const TEST_PORT = 47901, DEV_PORT = 47902;
// Their ports are trusted only while developing: CASTPANE_DEV=1 and NODE_ENV not
// production. Castpane.app starts the server with NODE_ENV=production and a clean
// environment, so never there. Otherwise any program on this Mac that serves a page on
// one of those ports would be a trusted origin: credentialed CORS, the CSRF cookie read
// back, the account's own actions taken in its name.
const devMode = () => process.env.CASTPANE_DEV === '1' && process.env.NODE_ENV !== 'production';
const devPorts = () => (devMode() ? [TEST_PORT, DEV_PORT] : []);

function servicePort() {
  const raw = process.env.CASTPANE_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new Error('CASTPANE_PORT must be a port from 1 to 65535');
  return Number(raw);
}

// The public origin, or '' when Castpane is for this Mac only. An HTTPS origin and
// nothing else (no path, no user, no query) on a public host name. Plain HTTP is never
// public: browsers give the video decoder and passkeys to secure pages only.
function publicOrigin() {
  const raw = process.env.CASTPANE_PUBLIC_ORIGIN || '';
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('CASTPANE_PUBLIC_ORIGIN must be an origin such as https://remote.example.com'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || raw !== url.origin) {
    throw new Error('CASTPANE_PUBLIC_ORIGIN must be an origin without a path');
  }
  const name = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:') throw new Error('CASTPANE_PUBLIC_ORIGIN must be an https:// origin');
  // A public name, not this machine: such an address would be given HSTS and passkeys.
  if (/^(localhost|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i.test(name) || name.endsWith('.localhost')) {
    throw new Error('CASTPANE_PUBLIC_ORIGIN must be a public host name, not localhost or an IP address');
  }
  return url.origin;
}
const publicHost = () => (publicOrigin() ? new URL(publicOrigin()).host : '');
// Served over HTTPS (by a tunnel or a proxy that terminates TLS): passkeys, Secure
// cookies and HSTS belong to it.
const publicIsHttps = () => publicOrigin().startsWith('https://');
// Where the server listens: this Mac's loopback only. A tunnel or Tailscale brings the
// public address here.
const bindHost = () => '127.0.0.1';

// Loopback ports a request may name as its Host: the service, and while developing a
// test instance.
const loopbackPorts = () => [...new Set([servicePort(), ...(devMode() ? [TEST_PORT] : [])])];
const loopbackHosts = (ports) => ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]);

// The Host header a request may carry. Anything else is refused (app.js), a LAN
// address included.
const isAllowedHost = (host) => typeof host === 'string' && ((!!publicHost() && host === publicHost()) || loopbackHosts(loopbackPorts()).includes(host));
// A TLS-terminating proxy or tunnel forwards plain HTTP, so the public Host says HTTPS.
const isHttpsHost = (host) => publicIsHttps() && host === publicHost();

// The pages a live-update or remote socket may come from: the public address and, on
// this machine, the service's own port (and while developing the vite dev server and a
// test instance).
const socketOrigins = () => new Set([...(publicOrigin() ? [publicOrigin()] : []), ...loopbackHosts([...new Set([servicePort(), ...devPorts()])]).map((h) => 'http://' + h)]);
// Both the Origin and the Host are checked, the Host as the page would have named it.
const isAllowedSocket = (req) => {
  const origins = socketOrigins(), host = req.headers.host;
  return origins.has(req.headers.origin) && origins.has((isHttpsHost(host) ? 'https://' : 'http://') + host);
};

module.exports = { PRODUCT, DEV_PORT, TEST_PORT, devMode, devPorts, servicePort, publicOrigin, publicHost, publicIsHttps, bindHost, loopbackPorts, isAllowedHost, isHttpsHost, socketOrigins, isAllowedSocket };
