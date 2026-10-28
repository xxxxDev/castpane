const crypto = require('node:crypto');
const webPush = require('web-push');
const { assertPushConfigured, selectVapidDetails } = require('./pushCrypto');
const { getDefaultPushStore } = require('./pushStore');
const { PRODUCT } = require('../siteConfig');
const events = require('../pushEvents');

function clipPreview(text,limit){if(text.length<=limit)return text;let out='';for(const char of text){if(out.length+char.length>limit-1)break;out+=char;}return out+'…';}

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

const tagOf=(prefix,id)=>prefix+crypto.createHash('sha256').update(id).digest('hex').slice(0,24);
// What a notification shows. Castpane sends one kind: a remote session opened on this
// Mac, to every admin, saying who and from where (server/start.js). A tap opens the app.
function buildPayload(event) {
  if(event?.kind==='remote_open'){
    if(!event.eventId)throw new Error('Unsupported notification');
    const who=String(event.username||'Someone'),where=event.ip?` from ${event.ip}`:'';
    return {title:clipPreview(`${PRODUCT.name}: remote session opened`,80),body:clipPreview(`${who} is viewing this Mac${where}.`,180),url:'/',tag:tagOf('remote-',event.eventId)};
  }
  throw new Error('Unsupported notification');
}

// Per-row VAPID selection: the keypair is chosen from the row's
// stored vapidKeyId (defaulting to 'k0') on every send, rather than a single
// process-global setVapidDetails. selectVapidDetails throws
// PUSH_VAPID_KEY_UNAVAILABLE — before any network call — for a row whose keyId
// matches neither the current nor the previous VAPID key, so a device is never
// messaged with the wrong key; sendOne maps that to a suppression, not a send.
function createWebPushSender(env = process.env) {
  return async (subscription, payload, _delivery = null, vapidKeyId = 'k0') => {
    assertPushConfigured(env);
    const vapid = selectVapidDetails(vapidKeyId, env);
    return webPush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 24 * 60 * 60,
      urgency: 'high',
      topic: payload.tag.slice(0, 32),
      vapidDetails: {
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
    });
  };
}

function createPushService({
  store,
  sender = createWebPushSender(),
  logger = console,
  now = () => new Date(),
  autoDrain = true,
  // Deny by default: admin_report rows send only through a wired gate that finds
  // the recipient still an active admin.
  reportGate = async () => ({ ok: false, reason: 'report_gate_unconfigured' }),
} = {}) {
  if (!store) throw new Error('push store is required');
  let draining = null;
  let timer = null;

  // Enqueue this event's webpush deliveries for one recipient's active devices.
  // Rows for an admin pass recipientReason 'admin_report' (re-checked at send time).
  // Preference gating is per-recipient (an admin's own preferences govern the
  // reports sent to them). Enqueue-time checks are an optimization; send-time re-checks
  // (sendOne) are authoritative.
  async function enqueueForRecipient(event, recipientUserId, recipientReason) {
    const [subscriptions, preferences] = await Promise.all([
      store.listActiveSubscriptions(recipientUserId),
      store.getPreferences(recipientUserId),
    ]);
    const payload = buildPayload(event);
    let pending = 0;
    let suppressed = 0;
    // One device that cannot be written must not cost the others this notification:
    // each is tried, and the first failure is thrown once all have been, so the
    // caller still sees a failed fan-out and may send it again (every row is found
    // again by its stable key).
    let failed = null;
    for (const subscription of subscriptions) {
      try {
        const sessionActive = await store.isSessionActive(subscription);
        const preferenceEnabled = preferences[events.eventCategory(event)] === true;
        const enabled = sessionActive && preferenceEnabled;
        if (!sessionActive) {
          await store.deactivateByFingerprint(subscription.endpointFingerprint, 'session_inactive');
        }
        const projection = await store.ensureDelivery({
          reply: event,
          subscription,
          payload,
          recipientUserId: String(recipientUserId),
          recipientReason,
          status: enabled ? 'pending' : 'suppressed',
          suppressionReason: sessionActive ? 'preference_disabled' : 'session_inactive',
        });
        if (projection.created) {
          if (enabled) pending += 1;
          else suppressed += 1;
        }
      } catch (error) {
        failed ||= error;
        logger.error?.(`push: a device's delivery was not queued: ${error.message}`);
      }
    }
    if (failed) {
      if (autoDrain && pending) queueMicrotask(() => void drain());
      throw failed;
    }
    return { pending, suppressed };
  }

  // An event for every admin's devices (a remote session opened). Each admin is
  // checked again at send time (reportGate): still active, still an admin.
  async function notifyAdmins(report, adminUserIds = []) {
    let pending = 0;
    let suppressed = 0;
    // One admin whose device cannot be written does not cost the admins after them
    // the event: each is tried, the first failure thrown once all have been.
    let failed = null;
    for (const adminUserId of adminUserIds) {
      try {
        const counts = await enqueueForRecipient(report, String(adminUserId), 'admin_report');
        pending += counts.pending;
        suppressed += counts.suppressed;
      } catch (error) { failed ||= error; }
    }
    if (autoDrain && (pending || failed)) queueMicrotask(() => void drain());
    if (failed) throw failed;
    return { deliveries: pending + suppressed, pending, suppressed };
  }

  async function suppress(delivery, reason) {
    await store.updateDelivery(delivery.deliveryId, {
      status: 'suppressed',
      suppressionReason: reason,
      nextAttemptAt: null,
      claimedAt: null,
    });
  }

  async function sendOne(candidate) {
    const delivery = await store.claimDelivery(candidate.deliveryId);
    if (!delivery) return;
    const subscription = await store.getSubscription(delivery.endpointFingerprint);
    if (!subscription || !subscription.active) {
      await suppress(delivery, 'subscription_inactive');
      return;
    }
    // A browser endpoint may be explicitly re-bound when another account
    // enables notifications on the same device. A queued delivery keeps its
    // original recipient, so every initial send and retry must fail closed if
    // the endpoint now belongs to someone else.
    const recipientUserId = delivery.recipientUserId || delivery.userId;
    if (
      !recipientUserId
      || !subscription.userId
      || String(subscription.userId) !== String(recipientUserId)
    ) {
      await suppress(delivery, 'subscription_recipient_mismatch');
      return;
    }
    if (!(await store.isSessionActive(subscription))) {
      await store.deactivateByFingerprint(subscription.endpointFingerprint, 'session_inactive');
      await suppress(delivery, 'session_inactive');
      return;
    }
    // A row without recipientUserId/recipientReason is an owner
    // delivery whose recipient is delivery.userId (the owner).
    const recipientReason = delivery.recipientReason || 'owner';
    const preferences = await store.getPreferences(recipientUserId);
    if (preferences[delivery.category] !== true) {
      await suppress(delivery, 'preference_disabled');
      return;
    }
    // admin_report rows are re-verified against live state at send/retry time:
    // recipient exists, lifecycle-active, still admin. Any failure ⇒ suppressed
    // (with a reason), never failed.
    if (recipientReason === 'admin_report') {
      const gate = await reportGate(recipientUserId);
      if (!gate.ok) {
        await suppress(delivery, gate.reason || 'report_suppressed');
        return;
      }
    }
    // The checks above await mutable session/preferences/role state. Re-read the
    // endpoint binding after the final await and call the provider without another
    // yield in between, so an account rebind during those gates fails closed.
    const currentSubscription = await store.getSubscription(delivery.endpointFingerprint);
    if (!currentSubscription || !currentSubscription.active) {
      await suppress(delivery, 'subscription_inactive');
      return;
    }
    if (
      !currentSubscription.userId
      || String(currentSubscription.userId) !== String(recipientUserId)
    ) {
      await suppress(delivery, 'subscription_recipient_mismatch');
      return;
    }
    try {
      const response = await sender(
        store.readSubscription(currentSubscription), delivery.payload, delivery,
        currentSubscription.vapidKeyId || 'k0',
      );
      await store.updateDelivery(delivery.deliveryId, {
        status: 'sent',
        attempts: delivery.attempts + 1,
        sentAt: now().toISOString(),
        nextAttemptAt: null,
        claimedAt: null,
        lastErrorCode: null,
        providerStatusCode: Number(response?.statusCode || 201),
      });
    } catch (error) {
      // The device's VAPID key is gone (neither current nor previous matches):
      // fail closed as a suppression, never a `failed` send and never a retry —
      // retrying cannot conjure the key, and it must never be sent with another.
      if (error?.code === 'PUSH_VAPID_KEY_UNAVAILABLE') {
        await suppress(delivery, 'vapid_key_unavailable');
        return;
      }
      const statusCode = Number(error?.statusCode || 0);
      const attempts = delivery.attempts + 1;
      if (statusCode === 404 || statusCode === 410) {
        await store.deactivateByFingerprint(currentSubscription.endpointFingerprint, 'push_endpoint_gone');
        await store.updateDelivery(delivery.deliveryId, {
          status: 'gone', attempts, nextAttemptAt: null, claimedAt: null,
          lastErrorCode: `push_${statusCode}`,
        });
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        await store.updateDelivery(delivery.deliveryId, {
          status: 'failed', attempts, nextAttemptAt: null, claimedAt: null,
          lastErrorCode: statusCode ? `push_${statusCode}` : 'push_send_failed',
        });
        return;
      }
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
      await store.updateDelivery(delivery.deliveryId, {
        status: 'pending', attempts, claimedAt: null,
        nextAttemptAt: new Date(now().getTime() + delay).toISOString(),
        lastErrorCode: statusCode ? `push_${statusCode}` : 'push_send_failed',
      });
    }
  }

  // A plumbing check: broadcasts to every active device of the caller's own account
  // (a test must behave like a real notification would), while bypassing the delivery
  // ledger on purpose: a test must never look like a real event. Dead sessions are deactivated and skipped, not fatal, so one
  // stale device cannot hide the healthy ones.
  async function sendTest({ userId }) {
    const subscriptions = await store.listActiveSubscriptions(userId);
    // Click target is the app itself: the worker allow-list accepts it, and a
    // made-up detail id would open an "unavailable" page.
    const payload = {
      title: `${PRODUCT.name}: test notification`,
      body: 'Notifications reach this device.',
      url: '/',
      tag: `push-test-${crypto.randomUUID()}`,
    };
    let sentCount = 0;
    let skipped = 0;
    for (const subscription of subscriptions) {
      if (!(await store.isSessionActive(subscription))) {
        await store.deactivateByFingerprint(subscription.endpointFingerprint, 'session_inactive');
        skipped += 1;
        continue;
      }
      try {
        await sender(store.readSubscription(subscription), payload, null, subscription.vapidKeyId || 'k0');
        sentCount += 1;
      } catch (error) {
        // A device on a retired VAPID key (PUSH_VAPID_KEY_UNAVAILABLE) is
        // skipped like a dead session — never sent with the wrong key.
        const statusCode = Number(error?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await store.deactivateByFingerprint(subscription.endpointFingerprint, 'push_endpoint_gone');
        }
        skipped += 1;
      }
    }
    if (!sentCount) {
      const error = new Error('No active push subscription for this account');
      error.code = 'PUSH_TEST_NO_DEVICE';
      error.status = 404;
      throw error;
    }
    return { sent: sentCount, skipped };
  }

  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      const staleBefore = new Date(now().getTime() - 5 * 60_000).toISOString();
      await store.recoverStaleSending(staleBefore);
      const due = await store.listDue(now().toISOString());
      for (const delivery of due) await sendOne(delivery);
      return due.length;
    })().catch((error) => {
      logger.error(`[push] delivery drain failed: ${error.message}`);
      return 0;
    }).finally(() => {
      draining = null;
    });
    return draining;
  }

  function start() {
    void drain();
    timer = setInterval(() => void drain(), 60_000);
    timer.unref();
    return stop;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { notifyAdmins, enqueueForRecipient, sendTest, drain, start, stop };
}

// Who may receive an admin's notification, checked again at every send.
function createReportGate(usersDB) {
  const { isActiveUser } = require('./userLifecycle');
  return (recipientUserId) => new Promise((resolve) => {
    usersDB.findOne({ _id: String(recipientUserId) }, (error, user) => {
      if (error || !user || !isActiveUser(user)) resolve({ ok: false, reason: 'recipient_inactive' });
      else if (user.role !== 'admin') resolve({ ok: false, reason: 'recipient_not_admin' });
      else resolve({ ok: true });
    });
  });
}

let defaultService = null;
function getDefaultPushService() {
  if (!defaultService) {
    defaultService = createPushService({
      store: getDefaultPushStore(),
      reportGate: createReportGate(require('../stores').usersDB),
    });
  }
  return defaultService;
}

module.exports = {
  MAX_ATTEMPTS,
  buildPayload,
  createWebPushSender,
  createPushService,
  createReportGate,
  getDefaultPushService,
};
