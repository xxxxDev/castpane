const { sessionsDB, usersDB, userLifecycleTransitionsDB } = require('../stores');
const { principalFromUser } = require('./trustedPrincipal');
const { hashSessionToken } = require('./sessionTokens');
const { isActiveUser, findPendingLifecycleTransition } = require('./userLifecycle');

function findOne(db, query) {
  return new Promise((resolve, reject) => {
    db.findOne(query, (error, value) => {
      if (error) reject(error);
      else resolve(value || null);
    });
  });
}

async function resolveLivePrincipal(token, userId) {
  if (typeof token !== 'string' || !token || !userId) return null;
  const session = await findOne(sessionsDB, { tokenHash: hashSessionToken(token), userId });
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null;
  const user = await findOne(usersDB, { _id: userId });
  if (!isActiveUser(user)) return null;
  if (await findPendingLifecycleTransition(userLifecycleTransitionsDB, userId)) return null;
  try {
    return principalFromUser(user);
  } catch (_error) {
    return null;
  }
}

module.exports = { resolveLivePrincipal };
