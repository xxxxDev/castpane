const fs = require('node:fs');
const path = require('node:path');

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const DATASTORE_MODES = Object.freeze({
  fileMode: PRIVATE_FILE_MODE,
  dirMode: PRIVATE_DIR_MODE,
});

function privateStorageError(message) {
  return Object.assign(new Error(message), { code: 'PRIVATE_STORAGE_INVALID' });
}

function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIR_MODE });
  const info = fs.lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw privateStorageError(`private storage directory is not a real directory: ${resolved}`);
  }
  fs.chmodSync(resolved, PRIVATE_DIR_MODE);
  return resolved;
}

function hardenExistingPrivateFile(filename) {
  const resolved = path.resolve(filename);
  let info;
  try {
    info = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw privateStorageError(`private storage file is not a regular file: ${resolved}`);
  }
  fs.chmodSync(resolved, PRIVATE_FILE_MODE);
  return true;
}

function privateDatastoreOptions(filename) {
  const resolved = path.resolve(filename);
  ensurePrivateDirectory(path.dirname(resolved));
  hardenExistingPrivateFile(resolved);
  // NeDB may recover this crash-safe companion into the live filename.
  hardenExistingPrivateFile(`${resolved}~`);
  return {
    filename: resolved,
    autoload: true,
    modes: { ...DATASTORE_MODES },
  };
}

function appendPrivateJsonLine(filename, value) {
  const resolved = path.resolve(filename);
  ensurePrivateDirectory(path.dirname(resolved));
  hardenExistingPrivateFile(resolved);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_APPEND
    | (fs.constants.O_CLOEXEC || 0)
    | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(resolved, flags, PRIVATE_FILE_MODE);
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile()) throw privateStorageError(`private log is not regular: ${resolved}`);
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    let pending = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    while (pending.length) {
      const written = fs.writeSync(descriptor, pending);
      if (written <= 0) throw privateStorageError(`private log write stalled: ${resolved}`);
      pending = pending.subarray(written);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = {
  DATASTORE_MODES,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  appendPrivateJsonLine,
  ensurePrivateDirectory,
  hardenExistingPrivateFile,
  privateDatastoreOptions,
};
