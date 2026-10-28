const PRINCIPAL_FIELDS = ['type', 'id', 'username', 'name', 'role'];

function invalidPrincipal(message, status = 401) {
  const error = new Error(message);
  error.code = 'TRUSTED_PRINCIPAL_REQUIRED';
  error.status = status;
  return error;
}

function principalFromUser(user) {
  if (!user || typeof user !== 'object') throw invalidPrincipal('live user principal is required');
  const id = typeof user._id === 'string' ? user._id.trim() : String(user._id || '').trim();
  const username = typeof user.username === 'string' ? user.username.trim() : '';
  const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : username;
  if (!id || !username || !name || !['user', 'admin'].includes(user.role)) {
    throw invalidPrincipal('live user principal is invalid');
  }
  return { type: 'user', id, username, name, role: user.role };
}

function normalizeTrustedPrincipal(principal) {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) {
    throw invalidPrincipal('trusted principal is required');
  }
  const keys = Object.keys(principal).sort();
  if (keys.join('\0') !== [...PRINCIPAL_FIELDS].sort().join('\0')) {
    throw invalidPrincipal('trusted principal shape is invalid');
  }
  return principalFromUser({
    _id: principal.id,
    username: principal.username,
    name: principal.name,
    role: principal.role,
  });
}

function requireTrustedPrincipal(req) {
  return normalizeTrustedPrincipal(req?.principal);
}

function withTrustedPrincipal(req, payload) {
  return { ...payload, __principal: requireTrustedPrincipal(req) };
}

module.exports = {
  principalFromUser,
  normalizeTrustedPrincipal,
  requireTrustedPrincipal,
  withTrustedPrincipal,
};
