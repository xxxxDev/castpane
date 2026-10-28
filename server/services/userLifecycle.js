const crypto = require('node:crypto');
const { normalizeTrustedPrincipal } = require('./trustedPrincipal');
const { runLifecycleExclusive } = require('./userLifecycleGate');

const LIFECYCLE_STATUS = Object.freeze({
  ACTIVE: 'active',
  DISABLED: 'disabled',
  DELETED_TOMBSTONE: 'deleted_tombstone',
});
const VALID_STATUSES = new Set(Object.values(LIFECYCLE_STATUS));
const LIFECYCLE_SCHEMA_VERSION = 1;

function lifecycleError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, details });
}

function normalizeUsername(value) {
  const normalized = typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US') : '';
  if (!normalized) throw lifecycleError(500, 'USER_LIFECYCLE_INVALID', 'user username is invalid');
  return normalized;
}

function effectiveLifecycleStatus(user) {
  if (!user || typeof user !== 'object') {
    throw lifecycleError(500, 'USER_LIFECYCLE_INVALID', 'user lifecycle record is invalid');
  }
  if (user.lifecycleStatus === undefined || user.lifecycleStatus === null) {
    return LIFECYCLE_STATUS.ACTIVE;
  }
  if (!VALID_STATUSES.has(user.lifecycleStatus)) {
    throw lifecycleError(500, 'USER_LIFECYCLE_INVALID', 'user lifecycle status is invalid');
  }
  return user.lifecycleStatus;
}

function isActiveUser(user) {
  try {
    return effectiveLifecycleStatus(user) === LIFECYCLE_STATUS.ACTIVE;
  } catch (_error) {
    return false;
  }
}

function databaseCall(database, method, ...args) {
  return new Promise((resolve, reject) => {
    database[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

async function findPendingLifecycleTransition(transitionsDB, userId) {
  if (!transitionsDB || !userId) return null;
  return databaseCall(
    transitionsDB, 'findOne', { userId: String(userId), status: 'pending' },
  );
}

function ensureIndex(database, options) {
  return new Promise((resolve, reject) => {
    database.ensureIndex(options, (error) => (error ? reject(error) : resolve()));
  });
}

function compact(database) {
  // Best effort after durable writes: a failure is said, never thrown (compactQuietly.js).
  require('./compactQuietly').compactQuietly(database, 'user lifecycle');
}

function cleanReason(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.trim().length > 240) {
    throw lifecycleError(400, 'USER_LIFECYCLE_REASON_INVALID', 'lifecycle reason is invalid');
  }
  return value.trim();
}

function publicLifecycleUser(user) {
  return {
    id: String(user._id),
    username: user.username,
    name: user.name || user.username,
    role: user.role,
    lifecycleStatus: effectiveLifecycleStatus(user),
    disabledAt: user.disabledAt || null,
    deletedAt: user.deletedAt || null,
  };
}

function actorSnapshot(actor) {
  return {
    type: 'user',
    id: actor.id,
    username: actor.username,
    name: actor.name,
    role: actor.role,
  };
}

function createUserLifecycleService({
  usersDB,
  sessionsDB,
  transitionsDB,
  pushStore,
  scheduleInventory,
  now = () => new Date(),
  createId = () => crypto.randomUUID(),
}) {
  if (!usersDB || !sessionsDB || !transitionsDB) {
    throw new Error('user lifecycle datastores are required');
  }
  if (!pushStore || typeof pushStore.deactivateUser !== 'function') {
    throw new Error('user-wide push deactivation is required');
  }
  if (typeof scheduleInventory !== 'function') {
    throw new Error('user lifecycle cleanup dependencies are required');
  }

  const ready = Promise.all([
    ensureIndex(transitionsDB, { fieldName: 'transitionId', unique: true }),
    ensureIndex(transitionsDB, { fieldName: 'pendingKey', unique: true, sparse: true }),
    ensureIndex(transitionsDB, { fieldName: 'userId' }),
    ensureIndex(transitionsDB, { fieldName: 'status' }),
  ]);
  const inFlightRuns = new Map();

  async function findUser(userId) {
    const user = await databaseCall(usersDB, 'findOne', { _id: String(userId) });
    if (!user) throw lifecycleError(404, 'USER_NOT_FOUND', 'User not found');
    effectiveLifecycleStatus(user);
    return user;
  }

  function validateActor(input) {
    const actor = normalizeTrustedPrincipal(input);
    if (actor.role !== 'admin') {
      throw lifecycleError(403, 'FORBIDDEN', 'Only an admin can change user lifecycle');
    }
    return actor;
  }

  async function assertDeleteSafe(targetUserId) {
    let inventory;
    try {
      inventory = await scheduleInventory();
    } catch (error) {
      throw lifecycleError(409, 'USER_SCHEDULE_STATE_UNAVAILABLE', 'Schedule state could not be verified', {
        cause: error.code || error.message,
      });
    }
    if (!inventory || !Array.isArray(inventory.schedules) || !Array.isArray(inventory.sources)) {
      throw lifecycleError(409, 'USER_SCHEDULE_STATE_UNAVAILABLE', 'Schedule state could not be verified');
    }
    const unavailable = inventory.sources.filter((source) => source?.ok !== true);
    if (unavailable.length) {
      throw lifecycleError(409, 'USER_SCHEDULE_STATE_UNAVAILABLE', 'Schedule state could not be verified', {
        sources: unavailable.map((source) => ({
          provider: source?.provider || 'unknown', error: source?.error || 'unavailable',
        })),
      });
    }
    // Existing owned records are conservatively blocking: the inventory lists only
    // what is still running or due to run, and `running` is authoritative runtime
    // state. Unknown future statuses therefore also fail closed.
    const blocking = inventory.schedules.filter(
      (schedule) => String(schedule?.ownerUserId || '') === String(targetUserId),
    );
    if (blocking.length) {
      throw lifecycleError(409, 'USER_HAS_ACTIVE_SCHEDULE', 'User still has something running', {
        schedules: blocking.map((schedule) => ({
          id: schedule.id, provider: schedule.provider, status: schedule.status,
          running: schedule.running === true,
        })),
      });
    }
  }

  async function findPending(userId) {
    await ready;
    return findPendingLifecycleTransition(transitionsDB, userId);
  }

  async function beginTransition({ userId, action, actor, reason, timestamp }) {
    const pending = await findPending(userId);
    if (pending) {
      if (pending.action !== action) {
        throw lifecycleError(409, 'USER_LIFECYCLE_TRANSITION_IN_PROGRESS', 'Another lifecycle transition is pending', {
          transitionId: pending.transitionId, action: pending.action,
        });
      }
      return pending;
    }
    const transition = {
      transitionId: String(createId()),
      userId: String(userId),
      pendingKey: String(userId),
      action,
      reason,
      actor: actorSnapshot(actor),
      status: 'pending',
      step: 'created',
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    await ready;
    try {
      return await databaseCall(transitionsDB, 'insert', transition);
    } catch (error) {
      if (!/unique constraint/i.test(String(error?.message || ''))) throw error;
      const winner = await findPending(userId);
      if (!winner || winner.action !== action) {
        throw lifecycleError(409, 'USER_LIFECYCLE_TRANSITION_IN_PROGRESS', 'Another lifecycle transition is pending', {
          transitionId: winner?.transitionId || null, action: winner?.action || null,
        });
      }
      return winner;
    }
  }

  async function updateTransition(transitionId, update) {
    await ready;
    const modifier = { $set: { ...update, updatedAt: now().toISOString() } };
    if (update.status === 'completed') modifier.$unset = { pendingKey: true };
    await databaseCall(
      transitionsDB, 'update', { transitionId },
      modifier, {},
    );
  }

  async function lockAccount(user, transition, timestamp) {
    if (effectiveLifecycleStatus(user) === LIFECYCLE_STATUS.DELETED_TOMBSTONE) {
      throw lifecycleError(409, 'USER_TOMBSTONE_TERMINAL', 'Deleted users cannot change lifecycle');
    }
    await databaseCall(
      usersDB, 'update', { _id: user._id },
      { $set: {
        lifecycleStatus: LIFECYCLE_STATUS.DISABLED,
        lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION,
        normalizedUsername: user.normalizedUsername || normalizeUsername(user.username),
        lifecycleTransition: {
          transitionId: transition.transitionId,
          action: transition.action,
          startedAt: transition.startedAt,
        },
        lifecycleLockedAt: user.lifecycleLockedAt || timestamp,
      } }, {},
    );
  }

  async function cleanupUser(userId, action, transition) {
    await updateTransition(transition.transitionId, { step: 'revoking_sessions' });
    await databaseCall(sessionsDB, 'remove', { userId: String(userId) }, { multi: true });

    await updateTransition(transition.transitionId, { step: 'deactivating_push' });
    await pushStore.deactivateUser(String(userId), `user_${action}`);
  }

  async function finalize(user, action, actor, reason, transition, timestamp) {
    await updateTransition(transition.transitionId, { step: 'finalizing_user' });
    if (action === 'delete') {
      const tombstone = {
        _id: user._id,
        username: user.username,
        normalizedUsername: user.normalizedUsername || normalizeUsername(user.username),
        name: user.name || user.username,
        role: user.role,
        lifecycleStatus: LIFECYCLE_STATUS.DELETED_TOMBSTONE,
        lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION,
        deletedAt: user.deletedAt || timestamp,
        deletedBy: actorSnapshot(actor),
        deletionReason: reason,
      };
      await databaseCall(usersDB, 'update', { _id: user._id }, tombstone, {});
    } else if (action === 'enable') {
      await databaseCall(
        usersDB, 'update', { _id: user._id },
        {
          $set: {
            lifecycleStatus: LIFECYCLE_STATUS.ACTIVE,
            lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION,
            normalizedUsername: user.normalizedUsername || normalizeUsername(user.username),
            enabledAt: timestamp,
            enabledBy: actorSnapshot(actor),
            enableReason: reason,
          },
          $unset: {
            disabledAt: true, disabledBy: true, disabledReason: true,
            lifecycleTransition: true, lifecycleLockedAt: true,
          },
        }, {},
      );
    } else {
      await databaseCall(
        usersDB, 'update', { _id: user._id },
        {
          $set: {
            lifecycleStatus: LIFECYCLE_STATUS.DISABLED,
            lifecycleSchemaVersion: LIFECYCLE_SCHEMA_VERSION,
            normalizedUsername: user.normalizedUsername || normalizeUsername(user.username),
            disabledAt: user.disabledAt || timestamp,
            disabledBy: user.disabledBy || actorSnapshot(actor),
            disabledReason: user.disabledReason || reason,
          },
          $unset: { lifecycleTransition: true, lifecycleLockedAt: true },
        }, {},
      );
    }
    const finalized = await findUser(user._id);
    const expectedStatus = action === 'delete'
      ? LIFECYCLE_STATUS.DELETED_TOMBSTONE
      : (action === 'enable' ? LIFECYCLE_STATUS.ACTIVE : LIFECYCLE_STATUS.DISABLED);
    if (effectiveLifecycleStatus(finalized) !== expectedStatus) {
      throw lifecycleError(500, 'USER_LIFECYCLE_FINALIZE_FAILED', 'User lifecycle did not finalize');
    }
    await updateTransition(transition.transitionId, {
      status: 'completed', step: 'completed', completedAt: timestamp,
      lastErrorCode: null, lastErrorMessage: null,
    });
    compact(usersDB);
    compact(sessionsDB);
    compact(transitionsDB);
    return finalized;
  }

  async function execute(action, { userId, actor, reasonInput }) {
    let user = await findUser(userId);
    const current = effectiveLifecycleStatus(user);
    const pendingAtStart = await findPending(userId);
    if (pendingAtStart && pendingAtStart.action !== action) {
      throw lifecycleError(409, 'USER_LIFECYCLE_TRANSITION_IN_PROGRESS', 'Another lifecycle transition is pending', {
        transitionId: pendingAtStart.transitionId, action: pendingAtStart.action,
      });
    }
    if (action === 'delete' && current === LIFECYCLE_STATUS.DELETED_TOMBSTONE) {
      if (pendingAtStart) {
        await updateTransition(pendingAtStart.transitionId, {
          status: 'completed', step: 'completed', completedAt: user.deletedAt || now().toISOString(),
          lastErrorCode: null, lastErrorMessage: null,
        });
        compact(transitionsDB);
      }
      return {
        user: publicLifecycleUser(user), idempotent: !pendingAtStart,
        transitionId: pendingAtStart?.transitionId || null,
      };
    }
    if (current === LIFECYCLE_STATUS.DELETED_TOMBSTONE) {
      throw lifecycleError(409, 'USER_TOMBSTONE_TERMINAL', 'Deleted users cannot change lifecycle');
    }
    if (action === 'enable' && current === LIFECYCLE_STATUS.ACTIVE) {
      if (pendingAtStart) {
        await updateTransition(pendingAtStart.transitionId, {
          status: 'completed', step: 'completed', completedAt: user.enabledAt || now().toISOString(),
          lastErrorCode: null, lastErrorMessage: null,
        });
        compact(transitionsDB);
      }
      return {
        user: publicLifecycleUser(user), idempotent: !pendingAtStart,
        transitionId: pendingAtStart?.transitionId || null,
      };
    }
    if (action === 'enable' && current !== LIFECYCLE_STATUS.DISABLED) {
      throw lifecycleError(409, 'USER_ENABLE_INVALID', 'Only a disabled user can be enabled');
    }
    const reason = cleanReason(reasonInput, `admin_${action}`);
    if (action === 'delete') await assertDeleteSafe(userId);
    const timestamp = now().toISOString();
    const transition = await beginTransition({ userId, action, actor, reason, timestamp });
    const durableActor = validateActor({ type: 'user', ...transition.actor });
    const durableReason = transition.reason;
    const durableTimestamp = transition.startedAt;

    try {
      await updateTransition(transition.transitionId, { step: 'locking_account' });
      await lockAccount(user, transition, durableTimestamp);
      await cleanupUser(userId, action, transition);
      user = await findUser(userId);
      const finalized = await finalize(
        user, action, durableActor, durableReason, transition, durableTimestamp,
      );
      return { user: publicLifecycleUser(finalized), idempotent: false, transitionId: transition.transitionId };
    } catch (error) {
      try {
        await updateTransition(transition.transitionId, {
          status: 'pending',
          lastErrorCode: error.code || 'USER_LIFECYCLE_STEP_FAILED',
          lastErrorMessage: String(error.message || 'lifecycle step failed').slice(0, 240),
        });
      } catch (_journalError) { /* original failure remains authoritative */ }
      throw lifecycleError(500, 'USER_LIFECYCLE_PARTIAL', 'User lifecycle transition did not complete', {
        transitionId: transition.transitionId,
        action,
        causeCode: error.code || 'USER_LIFECYCLE_STEP_FAILED',
      });
    }
  }

  async function run(action, { targetUserId, actor: actorInput, reason: reasonInput }) {
    const actor = validateActor(actorInput);
    const userId = String(targetUserId || '');
    if (!userId) throw lifecycleError(400, 'USER_ID_INVALID', 'User id is required');
    if (actor.id === userId && ['disable', 'delete'].includes(action)) {
      throw lifecycleError(400, 'USER_LIFECYCLE_SELF_ACTION', `You cannot ${action} your own account`);
    }
    const existing = inFlightRuns.get(userId);
    if (existing) {
      if (existing.action !== action) {
        throw lifecycleError(
          409,
          'USER_LIFECYCLE_TRANSITION_IN_PROGRESS',
          'Another lifecycle transition is pending',
          { action: existing.action },
        );
      }
      return existing.promise;
    }
    const promise = runLifecycleExclusive(userId, action, () => (
      execute(action, { userId, actor, reasonInput })
    ));
    inFlightRuns.set(userId, { action, promise });
    try {
      return await promise;
    } finally {
      if (inFlightRuns.get(userId)?.promise === promise) inFlightRuns.delete(userId);
    }
  }

  return {
    disableUser: (input) => run('disable', input),
    enableUser: (input) => run('enable', input),
    deleteUser: (input) => run('delete', input),
  };
}

async function defaultScheduleInventory() {
  return require('../productAccountHooks').lifecycleInventory();
}

let defaultService = null;
function getDefaultUserLifecycleService() {
  if (!defaultService) {
    const { usersDB, sessionsDB, userLifecycleTransitionsDB } = require('../stores');
    const { getDefaultPushStore } = require('./pushStore');
    defaultService = createUserLifecycleService({
      usersDB,
      sessionsDB,
      transitionsDB: userLifecycleTransitionsDB,
      pushStore: getDefaultPushStore(),
      scheduleInventory: defaultScheduleInventory,
    });
  }
  return defaultService;
}

module.exports = {
  LIFECYCLE_STATUS,
  LIFECYCLE_SCHEMA_VERSION,
  normalizeUsername,
  effectiveLifecycleStatus,
  isActiveUser,
  publicLifecycleUser,
  findPendingLifecycleTransition,
  createUserLifecycleService,
  getDefaultUserLifecycleService,
};
