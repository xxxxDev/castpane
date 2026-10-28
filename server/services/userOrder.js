// The order of the accounts on Manage Users, as an admin drags it. Only the order: a list of account ids, one small private JSON file beside
// the users database (DB_DIR), written atomically. An account not in it (new since, or never placed)
// follows the placed ones, by name; an id whose account is gone is simply passed over.
// A missing file is no order; an unreadable one is set aside, never written over.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { ensurePrivateDirectory, hardenExistingPrivateFile } = require('./privateFiles');

const ID = /^[A-Za-z0-9_-]{1,64}$/;
// A short digest of the stored order, which the page sends back with a new one.
const versionOf = (ids) => require('node:crypto').createHash('sha256').update(JSON.stringify(ids)).digest('hex').slice(0, 16);
const MAX_IDS = 5000;

function create(dir) {
  const file = path.join(dir, 'user-order.json');
  let ids = null;
  function load() {
    if (ids) return ids;
    let raw;
    try {
      hardenExistingPrivateFile(file);
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      ids = [];
      return ids;
    }
    let stored;
    try { stored = JSON.parse(raw).ids; } catch { stored = null; }
    if (!Array.isArray(stored)) {
      const aside = `${file}.unreadable-${Date.now()}`;
      fs.renameSync(file, aside);
      console.error(`user order: ${file} could not be read and was moved to ${aside}`);
      ids = [];
      return ids;
    }
    ids = [...new Set(stored.filter((id) => typeof id === 'string' && ID.test(id)))].slice(0, MAX_IDS);
    return ids;
  }
  function save(next) {
    ensurePrivateDirectory(dir);
    const text = JSON.stringify({ ids: next }, null, 1);
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    ids = next;
  }
  // known: the ids of the accounts there are now. The new order is checked against them:
  // each a real account, none twice. Accounts left out keep their place after these.
  // version: version() as the page loaded it; an order another admin saved since then is
  // not laid over. Read first, so a file that cannot be read is
  // moved aside by load(), never written over unseen.
  const version = () => versionOf(load());
  function set(next, known, expected) {
    const current = load();
    const real = new Set(known);
    if (typeof expected !== 'string' || expected !== versionOf(current)
      || !Array.isArray(next) || next.length > MAX_IDS || new Set(next).size !== next.length
      || !next.every((id) => typeof id === 'string' && ID.test(id) && real.has(id))) {
      throw Object.assign(new Error('The account list has changed; reload it and try again'), { status: 409, code: 'USER_ORDER_STALE' });
    }
    save([...next]);
    return [...next];
  }
  // A list of accounts (each with id and name) in the stored order.
  function sort(list, idOf = (u) => u.id, nameOf = (u) => u.name || u.username || '') {
    const at = new Map(load().map((id, i) => [id, i]));
    return [...list].sort((a, b) => {
      const x = at.get(String(idOf(a))), y = at.get(String(idOf(b)));
      if (x !== undefined || y !== undefined) return x === undefined ? 1 : y === undefined ? -1 : x - y;
      return String(nameOf(a)).localeCompare(String(nameOf(b)));
    });
  }
  return { list: () => [...load()], set, sort, version, file };
}

let shared = null;
function defaultUserOrder() {
  if (!shared) shared = create(process.env.DB_DIR || path.join(__dirname, '..', 'db'));
  return shared;
}

module.exports = { create, defaultUserOrder, MAX_IDS };
