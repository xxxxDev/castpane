// Castpane's server. Castpane.app runs it with its bundled Node and this environment
// (docs/protocol.md):
//
//   CASTPANE_HOME           the app's folder; the server keeps its data in data/
//   CASTPANE_PORT           the loopback port (47900)
//   CASTPANE_PUBLIC_ORIGIN  the address people open, or empty for this Mac only
//   CASTPANE_WEB_DIST       the built PWA
//   CASTPANE_EXIT_ON_STDIN_EOF=1  stop when stdin, a pipe from the app, closes (below)
//
// It sets the data folder up (databases, secrets, the audit log), makes local.token if
// the app has not, and serves the web app, the API, the live socket and the remote
// relay. It never starts the capture core: that is the app's (server/remote.js).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');

const home = path.resolve(process.env.CASTPANE_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'Castpane'));
process.env.CASTPANE_HOME = home;
const data = path.join(home, 'data');
const privateDir = (dir) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); };
privateDir(home); privateDir(data);
// The secret that signs sign-ins. Accounts without it would get a new one, and every
// two-step secret sealed with the old would be lost, so a start that finds accounts
// and no secret is refused before anything is written.
const secretsFile = path.join(data, 'secrets.json');
if (!fs.existsSync(secretsFile) && fs.existsSync(path.join(data, 'db', 'users.db'))) { console.error('Accounts exist without data/secrets.json; refusing to start.'); process.exit(1); }
privateDir(path.join(data, 'db')); privateDir(path.join(data, 'audit'));
process.env.NODE_ENV ||= 'production';
process.env.DB_DIR = path.join(data, 'db');
process.env.CASTPANE_AUDIT_LOG ||= path.join(data, 'audit', 'api-audit.log');
process.env.CASTPANE_SECURITY_DIR ||= data;

const site = require('./siteConfig');
// A wrong setting stops the service here, not at the first request.
site.servicePort(); site.publicOrigin();

// One server per folder.
const lock = path.join(data, 'server.lock');
try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); } catch {
  const pid = Number(fs.readFileSync(lock, 'utf8')); let live = Number.isInteger(pid) && pid > 0;
  if (live) try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
  if (live) { console.error('Another Castpane server is already running on this folder.'); process.exit(1); }
  fs.unlinkSync(lock); fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
}
// Removed at exit only while it is still the file this process made.
const ownedLock = fs.lstatSync(lock);
process.on('exit', () => { try { const now = fs.lstatSync(lock); if (!now.isSymbolicLink() && now.ino === ownedLock.ino && now.dev === ownedLock.dev && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch { /* gone */ } });

if (!fs.existsSync(secretsFile)) {
  fs.writeFileSync(secretsFile, JSON.stringify({ jwt: randomBytes(32).toString('hex') }, null, 2), { mode: 0o600, flag: 'wx' });
}
process.env.JWT_SECRET = JSON.parse(fs.readFileSync(secretsFile, 'utf8')).jwt;

// Web Push keys, made once. The subject is the public HTTPS address when there is one
// (a quick tunnel's changes at every start, so it is not stored).
const pushKeys = path.join(data, 'push-keys.json');
if (!fs.existsSync(pushKeys)) {
  const vapid = require('web-push').generateVAPIDKeys();
  fs.writeFileSync(pushKeys, JSON.stringify({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, PUSH_SUBSCRIPTION_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PUSH_SUBSCRIPTION_HMAC_KEY: randomBytes(32).toString('hex') }), { mode: 0o600, flag: 'wx' });
}
Object.assign(process.env, JSON.parse(fs.readFileSync(pushKeys, 'utf8')), { VAPID_SUBJECT: site.publicIsHttps() ? site.publicOrigin() : 'mailto:castpane@example.invalid' });

const { ensureLocalToken, createLocalRoutes } = require('./localApi');
ensureLocalToken(home);

// Castpane.app gives the server a pipe as its stdin, never writes to it, and sets
// CASTPANE_EXIT_ON_STDIN_EOF=1. When that pipe closes (the app quit or crashed, and the
// system closed its end) the server stops as on SIGTERM, so it never outlives the app.
// Only with that setting, and only on a pipe or a socket: without it (a tool that starts
// the server with a pipe it has already closed, say) or from a terminal or /dev/null,
// stdin is left alone.
let stopService = null;
const stdinIsPipe = () => { try { const st = fs.fstatSync(0); return st.isFIFO() || st.isSocket(); } catch { return false; } };
if (process.env.CASTPANE_EXIT_ON_STDIN_EOF === '1' && !process.stdin.isTTY && stdinIsPipe()) {
  const parentGone = () => { console.log('stdin closed (the app is gone): stopping'); return stopService ? stopService() : process.exit(0); };
  process.stdin.on('data', () => {}); process.stdin.once('end', parentGone); process.stdin.once('error', parentGone);
  process.stdin.resume();
}

async function main() {
  const { sessionsDB, pushSubscriptionsDB, usersDB } = require('./stores');
  const service = require('./serviceStart');
  // Logins still holding a raw token are converted before serving.
  await service.migrateSessions({ sessionsDB, subscriptionsDB: pushSubscriptionsDB });
  const remote = require('./remote');
  const { getDefaultPushService } = require('./services/pushService');
  const { getPushConfig } = require('./services/pushCrypto');
  const { isActiveUser } = require('./services/userLifecycle');
  const version = require('./package.json').version;
  let relay = null;
  // The other Macs that joined this one (server/members.js), and this Mac's own link
  // when it joined another (server/memberLink.js).
  const members = require('./members').createMembers({ file: path.join(data, 'members.json') });
  const memberLink = require('./memberLink').createMemberLink({ home, connectHost: () => remote.connectHost({ home }), tokenOf: () => remote.readHostToken(home), running: () => remote.hostRunning(home) });
  const app = require('./app').createApp({
    remoteRoutes: (a, opts) => remote.installRemoteRoutes(a, { ...opts, members }),
    localRoutes: createLocalRoutes({ home, version, memberLink, remote: { viewer: () => relay?.viewer() || memberLink.viewer(), endViewer: async (r) => { const here = relay ? await relay.endViewer(r) : false; return memberLink.endViewer() || here; } } }),
  });
  const push = getDefaultPushService();
  // Every admin is told when a remote session opens: who, and from where.
  const admins = () => new Promise((ok, no) => usersDB.find({ role: 'admin' }, (e, users) => (e ? no(e) : ok(users.filter(isActiveUser).map((u) => String(u._id))))));
  async function announceOpen({ username, userId, ip, at }) {
    if (!getPushConfig().available) return;
    await push.notifyAdmins({ kind: 'remote_open', eventId: `remote-open:${userId}:${at}`, ownerUserId: userId, username, ip }, await admins());
  }
  stopService = service.startService({
    app,
    port: site.servicePort(),
    host: site.bindHost(),
    onListening: () => console.log(`Castpane ${version}: http://127.0.0.1:${site.servicePort()}${site.publicOrigin() ? ` (public: ${site.publicOrigin()})` : ''}`),
    product(server) {
      push.start();
      relay = remote.installRemote(server, { members, onOpen: (o) => { announceOpen(o).catch((e) => console.error('remote: notification not sent:', e.message)); } });
      return { stop() { push.stop(); relay.close(); members.close(); memberLink.close(); return 0; } };
    },
  }).stop;
}

main().catch((error) => { console.error(error); process.exit(1); });
