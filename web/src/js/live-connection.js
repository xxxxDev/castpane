// The page's live socket (liveUpdates.js), opened by App.vue once someone is signed in. The build the server names is said as a
// window event, which the update check listens for (App.vue, onServedBuild): one
// socket a page, whoever else uses what it hears.
import { openLiveUpdates } from './liveUpdates.js';
import { PRODUCT } from './productConfig.js';

export function openLiveConnection(options = {}, scope = globalThis) {
  return openLiveUpdates({
    ...options,
    scope,
    onBuild: (buildId) => scope.dispatchEvent(new CustomEvent(PRODUCT.buildEvent, { detail: buildId })),
  });
}

// listener(buildId) whenever the server names the build it serves; returns the way to stop.
export function onServedBuild(listener, scope = globalThis) {
  const heard = (event) => listener(event.detail);
  scope.addEventListener(PRODUCT.buildEvent, heard);
  return () => scope.removeEventListener(PRODUCT.buildEvent, heard);
}
