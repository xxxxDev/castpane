// What this product does with an account's own things when the account changes: the
// account code (controllers/authController.js, services/userLifecycle.js) calls these
// and is otherwise generic. Castpane keeps nothing per account beyond what that code
// already removes (sessions, devices, passkeys, push subscriptions), so these are
// empty. The remote relay re-checks its viewer every few seconds (server/remote.js):
// an account disabled, deleted or made a member loses the stream there.
module.exports = {
  // An admin made a member.
  onDemoted() { return undefined; },
  // An account read back as disabled or deleted: nothing of its own runs here.
  onAccountOff() { return { stopped: [], failed: [] }; },
  // An account deleted for good.
  onPurge() { return undefined; },
  // What would still run for an account (services/userLifecycle.js shows it before a
  // disable or delete).
  lifecycleInventory() { return { schedules: [], sources: [] }; },
};
