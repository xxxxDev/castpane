/* global self */

// Generic: what is this product's own (which addresses a
// notification may open, its icons, the cache a tap is left in) is in
// public/push-config.js, loaded just before this one.
const CONFIG = self.PUSH_CONFIG;
const PAYLOAD_FIELDS = new Set(['title', 'body', 'url', 'tag']);

// The address a notification may open, as the browser will read it, or null. Checked
// as sent and again once resolved: a backslash or a dot segment resolves elsewhere.
function allowedTarget(raw) {
  if (typeof raw !== 'string' || !CONFIG.url.test(raw)) return null;
  let target;
  try {
    target = new URL(raw, self.location.origin);
  } catch (_error) {
    return null;
  }
  if (target.origin !== self.location.origin || !CONFIG.url.test(target.pathname + target.search)) return null;
  return target;
}

function safePayload(event) {
  let value;
  try {
    value = event.data?.json();
  } catch (_error) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== PAYLOAD_FIELDS.size || keys.some((key) => !PAYLOAD_FIELDS.has(key))) return null;
  if (
    typeof value.title !== 'string' || !value.title || value.title.length > 80
    || typeof value.body !== 'string' || !value.body || value.body.length > 180
    || typeof value.tag !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value.tag)
    || !allowedTarget(value.url)
  ) return null;
  return value;
}

self.addEventListener('push', (event) => {
  const payload = safePayload(event);
  if (!payload) return;
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    renotify: true,
    icon: CONFIG.icon,
    badge: CONFIG.badge,
    data: { url: payload.url },
  }));
});

// An iPhone or iPad opens the home-screen app itself when a notification is
// tapped. Asking for a window as well, while the app was still starting, gave a
// second one: a blank page under Safari's toolbar that reloading did not fix (after tapping notifications with the app swiped
// away several times). There the worker waits for the app's own window instead.
const OPENS_ITSELF = /iPhone|iPad|iPod/.test(self.navigator?.userAgent || '');
const WINDOW_WAIT_MS = 5000;
const WINDOW_POLL_MS = 250;

async function appWindow(origin) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.find((client) => {
    try {
      return new URL(client.url).origin === origin;
    } catch (_error) {
      return false;
    }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = allowedTarget(event.notification?.data?.url);
    if (!target) return;
    // iOS can open the app without the address and without delivering a message.
    // Leaving the target where the page can read it covers both
    // (src/js/notification-open.js).
    const at = Date.now();
    try {
      const cache = await self.caches.open(CONFIG.intentCache);
      await cache.put('/__intent', new Response(JSON.stringify({url: target.href, at}), {headers: {'Content-Type': 'application/json'}}));
    } catch (_error) {}
    let existing = await appWindow(target.origin);
    if (!existing && OPENS_ITSELF) {
      for (let waited = 0; !existing && waited < WINDOW_WAIT_MS; waited += WINDOW_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, WINDOW_POLL_MS));
        existing = await appWindow(target.origin);
      }
      // Still starting: the page takes the address from the cache when it is up.
      if (!existing) return;
    }
    if (existing) {
      // A standalone iOS window ignores navigate(), so the tap only focused the
      // app and left it wherever it was. The page
      // listens for this message and opens the address itself
      // (src/js/notification-open.js). No navigate() as well: where it works it
      // reloads the app, which then showed its first screen before the address.
      try { existing.postMessage({ type: 'open-url', url: target.href, at }); } catch (_error) {}
      return existing.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
