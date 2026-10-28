const crypto = require('node:crypto');
const { sessionFingerprint, sessionFingerprintPrevious } = require('./pushCrypto');

// A session row keeps a SHA-256 of its token, never the token. Kept in the clear,
// any copy of sessions.db — a backup, a data directory carried to another host —
// would be a working login for everyone in it. The token is a signed, high-entropy JWT, so a
// plain hash is enough; nothing here needs to be slow.
function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function call(db, method, ...args) {
  return new Promise((resolve, reject) => {
    db[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

// One-time and idempotent: rows written before the change carry `token`. Each is
// rewritten to `tokenHash`, and the push subscriptions bound to it are re-pointed:
// a subscription's session fingerprint is now taken over the hash, so a key
// rotation can still recompute it from what is stored. Nobody has to log in again.
async function migrateRawSessionTokens({ sessionsDB, subscriptionsDB, env = process.env }) {
  const rows = await call(sessionsDB, 'find', { token: { $exists: true } });
  let subscriptions = 0;
  let discarded = 0;
  let unbound = 0;
  let pushProblem = null;
  try {
  for (const row of rows) {
    // A row whose token is not a string could never authenticate. Drop it rather
    // than let it stop the service from starting, which is where this runs.
    if (typeof row.token !== 'string' || !row.token) {
      discarded += await call(sessionsDB, 'remove', { _id: row._id }, {});
      continue;
    }
    const tokenHash = hashSessionToken(row.token);
    if (subscriptionsDB) {
      let before = null;
      let after = null;
      try {
        before = [sessionFingerprint(row.token, env), sessionFingerprintPrevious(row.token, env)].filter(Boolean);
        after = sessionFingerprint(tokenHash, env);
      } catch (error) {
        // No push keys, or keys that do not resolve (a bad previous key among them):
        // the logins are converted all the same, since the service cannot read them
        // otherwise and must not stop starting. Subscriptions bound to them cannot
        // follow and are counted, so the start says how many devices have to turn
        // notifications on again.
        if (!String(error.code || '').startsWith('PUSH_')) throw error;
        unbound += await call(subscriptionsDB, 'count', {}) > 0 ? 1 : 0;
        pushProblem = error.code;
      }
      if (after) {
        subscriptions += await call(subscriptionsDB, 'update',
          { sessionFingerprint: { $in: before } },
          { $set: { sessionFingerprint: after } },
          { multi: true });
      }
    }
    await call(sessionsDB, 'update', { _id: row._id }, { $set: { tokenHash }, $unset: { token: true } }, {});
  }
  } finally {
    // Also when a row stopped the rewrite part-way: the rows already rewritten still
    // have their raw token in the append-only file until it is compacted.
    // Waited for and never thrown: a disk that cannot be written must not end the
    // start-up through a rejection nobody holds.
    if (rows.length) {
      for (const db of [sessionsDB, subscriptionsDB]) {
        try { await db?.compactDatafileAsync(); } catch (error) { console.error('sessions: not compacted:', error.message); }
      }
    }
  }
  if (pushProblem && unbound) {
    console.error(`sessions: push keys did not resolve (${pushProblem}); ${unbound} login(s) converted without re-pointing push subscriptions. Devices bound to them must turn notifications on again.`);
  }
  return { sessions: rows.length - discarded, subscriptions, discarded };
}

module.exports = { hashSessionToken, migrateRawSessionTokens };
