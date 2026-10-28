// The page's line to the server (server/liveUpdates.js): which build is served, so an
// open page offers a new version within seconds, and a sign-in ended elsewhere (4401)
// shows the sign-in at once. It carries no data of its own. A line that goes quiet, as
// one does when a phone puts the app away or a network changes, is dropped and opened
// again.
// The server pings every 14 s.
const QUIET_MS = 30000;
// Whether a page counts as in use: the installed app whenever it is
// open; a browser tab unless it has been in the background for 10 minutes or in
// front with no mouse, keyboard or touch for 15. A page in use keeps its line open
// while it is out of sight, and tells the server whether it is.
export const AWAY_MS = 10 * 60_000, IDLE_MS = 15 * 60_000;
export function isPresent({standalone, visible, now, lastInput, hiddenSince}) {
  if (standalone) return true;
  return visible ? now - lastInput < IDLE_MS : hiddenSince !== null && now - hiddenSince < AWAY_MS;
}

// tracksPresence: the page reports whether it is in use and in sight (every signed-in page).
export function openLiveUpdates({onChanged = () => {}, onBuild = () => {}, onSignedOut = () => {}, scope = globalThis, tracksPresence = () => false} = {}) {
  let socket = null, open = false, closed = false, retry = 0, timer = null, lastHeard = 0, lastView = null;
  let lastInput = Date.now(), hiddenSince = null, lastPresence = '';
  const visible = () => scope.document?.visibilityState !== 'hidden';
  const standalone = () => !!(scope.matchMedia?.('(display-mode: standalone)')?.matches || scope.navigator?.standalone === true);
  const presence = () => {
    const state = {visible: visible(), now: Date.now(), lastInput, hiddenSince};
    return {type: 'presence', active: isPresent({...state, standalone: standalone()}), hidden: !visible()};
  };
  function sendPresence(force = false) {
    if (!tracksPresence()) return;
    const p = presence(), text = JSON.stringify(p);
    if (!force && text === lastPresence) return;
    lastPresence = text;
    if (open) socket.send(text);
  }
  const url = () => `${scope.location.protocol === 'https:' ? 'wss' : 'ws'}://${scope.location.host}/live`;
  const later = () => {
    if (closed || timer) return;
    const wait = Math.min(15000, 1000 * 2 ** retry++);
    timer = scope.setTimeout(() => { timer = null; if (!scope.document?.hidden) connect(); }, wait);
  };
  function connect() {
    if (closed) return;
    const old = socket; socket = null; open = false; old?.close();
    let next;
    try { next = new scope.WebSocket(url()); } catch { return later(); }
    socket = next; lastHeard = Date.now();
    next.onopen = () => {
      if (socket !== next) return;
      open = true; retry = 0; lastHeard = Date.now();
      if (lastView) next.send(JSON.stringify(lastView));
      lastPresence = '';sendPresence(true);
    };
    next.onmessage = event => {
      if (socket !== next) return;
      lastHeard = Date.now();
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'changed') onChanged();
      else if ((msg.type === 'hello' || msg.type === 'version') && typeof msg.buildId === 'string') onBuild(msg.buildId);
    };
    // 4401: the server ended it because this sign-in is gone; the page asks who it is
    // (onSignedOut) instead of reconnecting.
    next.onclose = (event) => { if (socket !== next) return; socket = null; open = false; if (event?.code === 4401) { onSignedOut(); return; } later(); };
    next.onerror = () => {};
  }
  const watchdog = scope.setInterval(() => {
    if (open && Date.now() - lastHeard > QUIET_MS && visible()) connect();
    sendPresence();
    // A tab away long enough no longer counts: nothing more to keep the line for.
    if (!visible() && open && !presence().active) { const old = socket; socket = null; open = false; old?.close(); }
  }, 5000);
  const onInput = () => { const was = presence(); lastInput = Date.now(); if (!was.active) sendPresence(); };
  const INPUTS = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'mousemove'];
  for (const name of INPUTS) scope.addEventListener?.(name, onInput, {passive: true, capture: true});
  // A page put away closes its socket, as it stopped polling before, so the server
  // does no work for it; back in front, it opens one and hears what changed.
  const onVisible = () => {
    if (timer) { scope.clearTimeout(timer); timer = null; }
    if (scope.document?.visibilityState !== 'visible') {
      hiddenSince = Date.now();
      // The owner's app put away still counts (the installed app always, a tab for
      // a while): the line stays open and says so; otherwise it closes as before.
      if (tracksPresence() && presence().active) { sendPresence(); return; }
      const old = socket; socket = null; open = false; old?.close();
      return;
    }
    hiddenSince = null; lastInput = Date.now();
    retry = 0;
    if (!socket || Date.now() - lastHeard > QUIET_MS) connect();
    else sendPresence(true);
  };
  scope.document?.addEventListener?.('visibilitychange', onVisible);
  connect();
  return {
    connected: () => open,
    // What the page shows, for a server that compares it (Castpane's does not).
    view(id, onScreen) {
      lastView = {type: 'view', id: id || null, onScreen: !!onScreen};
      if (open) socket.send(JSON.stringify(lastView));
    },
    close() {
      closed = true; open = false;
      scope.clearInterval(watchdog); if (timer) scope.clearTimeout(timer);
      scope.document?.removeEventListener?.('visibilitychange', onVisible);
      for (const name of INPUTS) scope.removeEventListener?.(name, onInput, {capture: true});
      socket?.close(); socket = null;
    },
  };
}
