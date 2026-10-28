const os = require('os');
const path = require('path');
const { appendPrivateJsonLine, ensurePrivateDirectory, hardenExistingPrivateFile } = require('./privateFiles');
const { PRODUCT } = require('../siteConfig');

// One audit log for the API, sign-ins and the remote relay.
//
// Test processes write somewhere else. Otherwise every `node --test` run
// would append to the real log, and the deliberately unauthenticated requests the
// suites make (hundreds of refused requests per run) read like an
// attack when the log is reviewed.
// (The setting's name and the test folder's prefix are the product's: siteConfig.js.)
const AUDIT_LOG = process.env[PRODUCT.env.auditLog]
  || (process.env.NODE_TEST_CONTEXT
    ? path.join(os.tmpdir(), `${PRODUCT.tempPrefix}-test-audit-${process.pid}`, 'api-audit.log')
    : path.join(__dirname, '..', 'logs', 'api-audit.log'));
ensurePrivateDirectory(path.dirname(AUDIT_LOG));
hardenExistingPrivateFile(AUDIT_LOG);

function audit(entry) {
  try {
    appendPrivateJsonLine(AUDIT_LOG, { ts: new Date().toISOString(), ...entry });
  } catch (err) {
    console.error('audit log write failed:', err.message);
  }
}

module.exports = { audit, AUDIT_LOG };
