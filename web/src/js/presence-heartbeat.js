export const PRESENCE_HEARTBEAT_MS = 120_000;

export function createPresenceHeartbeat({
  ping,
  intervalMs = PRESENCE_HEARTBEAT_MS,
  setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
  clearIntervalFn = (timer) => globalThis.clearInterval(timer),
  documentRef = typeof document === 'undefined' ? null : document,
} = {}) {
  if (typeof ping !== 'function') throw new TypeError('presence heartbeat requires ping');

  let timer = null;
  let inFlight = null;
  const beat = () => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => ping())
      .catch(() => {})
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  const onVisibilityChange = () => (
    documentRef?.visibilityState === 'visible' ? beat() : Promise.resolve()
  );

  return {
    start() {
      if (timer !== null) return;
      timer = setIntervalFn(beat, intervalMs);
      if (typeof timer?.unref === 'function') timer.unref();
      documentRef?.addEventListener?.('visibilitychange', onVisibilityChange);
    },
    stop() {
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
      documentRef?.removeEventListener?.('visibilitychange', onVisibilityChange);
    },
  };
}
