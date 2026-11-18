// No Node or browser dependencies: loaded by the server (require) and by the web app (import).
// What a member's capture core may say to the page, checked because the member is another
// machine: by the hub (server/members.js), and by the page for what comes by its direct link
// (web/src/js/remoteStream.js), this one file for both. Each message is rebuilt from its known
// fields, of the right types and sizes, as the page's are (remote.js); anything else is
// dropped. Never throws.
const THUMB = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]*$/;
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const int = (v) => (Number.isInteger(v) && Math.abs(v) <= 0xffffffff ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const rect = (v) => (Array.isArray(v) && v.length === 4 && v.every((x) => num(x) !== undefined) ? v : undefined);
const pick = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
function item(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || (x.kind !== 'display' && x.kind !== 'window') || int(x.id) === undefined) return null;
  const d = x.desk && typeof x.desk === 'object' && !Array.isArray(x.desk) ? x.desk : {};
  return pick({
    kind: x.kind, id: x.id, title: str(x.title, 300) ?? '', app: str(x.app, 200) ?? '', bundle: str(x.bundle, 200),
    width: int(x.width) ?? 0, height: int(x.height) ?? 0, here: bool(x.here), all: bool(x.all), dock: bool(x.dock), minimized: bool(x.minimized),
    thumb: typeof x.thumb === 'string' && x.thumb.length <= 512 * 1024 && THUMB.test(x.thumb) ? x.thumb : '',
    desk: pick({ id: int(d.id), number: int(d.number), display: int(d.display), fullscreen: bool(d.fullscreen), current: bool(d.current) }),
  });
}
const ICON = /^data:image\/png;base64,[A-Za-z0-9+/=]*$/;
function app(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || !str(x.bundle, 200)) return null;
  return pick({ bundle: x.bundle, name: str(x.name, 200) ?? '', running: bool(x.running) ?? false, kept: bool(x.kept) });
}
// A folder or file at the Dock's right: its name and kind only (the page opens it by its
// place in the list, so each one stays, however malformed, to keep the places).
const other = (x) => ({ name: str(x?.name, 200) ?? '', kind: x?.kind === 'folder' ? 'folder' : 'file' });
const SHAPES = {
  // The direct link to a page (server/directLink.js), set up through the hub.
  'rtc-answer': (m) => (str(m.sdp, 16384) !== undefined && m.type === 'answer' ? { sdp: m.sdp, type: 'answer' } : null),
  'rtc-candidate': (m) => (str(m.candidate, 1024) !== undefined && str(m.mid, 64) !== undefined ? { candidate: m.candidate, mid: m.mid } : null),
  'rtc-none': () => ({}),
  echo: (m) => (Number.isSafeInteger(m.n) ? { n: m.n } : null),
  locked: (m) => ({ locked: bool(m.locked) ?? false }),
  unlocked: (m) => pick({ ok: bool(m.ok) ?? false, busy: bool(m.busy) }),
  status: (m) => pick({ screen: bool(m.screen) ?? false, accessibility: bool(m.accessibility) ?? false, version: str(m.version, 64), host: str(m.host, 64), windows: bool(m.windows) }),
  list: (m) => (Array.isArray(m.items) ? { items: m.items.slice(0, 500).map(item).filter(Boolean) } : null),
  shots: (m) => (Array.isArray(m.items) ? { items: m.items.slice(0, 4).filter((x) => int(x?.id) !== undefined && typeof x.thumb === 'string' && x.thumb.length <= 512 * 1024 && THUMB.test(x.thumb)).map((x) => ({ id: x.id, thumb: x.thumb })) } : null),
  started: (m) => (m.kind === 'display' || m.kind === 'window') && int(m.id) !== undefined ? pick({ kind: m.kind, id: m.id, width: int(m.width) ?? 0, height: int(m.height) ?? 0, fps: int(m.fps) }) : null,
  config: (m) => (str(m.codec, 64) ? pick({ codec: m.codec, width: int(m.width) ?? 0, height: int(m.height) ?? 0 }) : null),
  stopped: (m) => pick({ reason: str(m.reason, 100) ?? '', closed: bool(m.closed) }),
  focus: (m) => pick({ editable: bool(m.editable) ?? false, caret: rect(m.caret), initial: bool(m.initial) }),
  caret: (m) => (rect(m.caret) ? { caret: m.caret } : null),
  probe: (m) => pick({ editable: bool(m.editable) ?? false, n: int(m.n) ?? 0 }),
  error: (m) => pick({ where: str(m.where, 32) ?? '', message: str(m.message, 200) ?? '', code: str(m.code, 32) }),
  clipboard: (m) => pick({ s: str(m.s, 100000), truncated: bool(m.truncated), empty: bool(m.empty), concealed: bool(m.concealed), notAllowed: bool(m.notAllowed), denied: bool(m.denied), error: bool(m.error) }),
  'clipboard-set': () => ({}),
  'clipboard-changed': () => ({}),
  apps: (m) => (Array.isArray(m.apps) ? { apps: m.apps.slice(0, 300).map(app).filter(Boolean) } : null),
  icons: (m) => (m.icons && typeof m.icons === 'object' && !Array.isArray(m.icons)
    ? { icons: Object.fromEntries(Object.entries(m.icons).slice(0, 40).filter(([b, v]) => str(b, 200) && typeof v === 'string' && v.length <= 64 * 1024 && ICON.test(v))) } : null),
  launched: (m) => (str(m.bundle, 200) ? { bundle: m.bundle, ok: bool(m.ok) ?? false, ...(m.newWindow === true ? { newWindow: true } : {}) } : null),
  quit: (m) => (str(m.bundle, 200) ? { bundle: m.bundle, ok: bool(m.ok) ?? false } : null),
  dock: (m) => (Array.isArray(m.apps) ? pick({ apps: m.apps.slice(0, 300).map(app).filter(Boolean), others: Array.isArray(m.others) ? m.others.slice(0, 64).map(other) : undefined, trash: bool(m.trash) }) : null),
  'dock-opened': (m) => ({ ok: bool(m.ok) ?? false, ...(m.asking === true ? { asking: true } : {}), ...(m.late === true ? { late: true } : {}) }),
  fitted: (m) => (int(m.id) !== undefined ? pick({ id: m.id, ok: bool(m.ok) ?? false, width: int(m.width), height: int(m.height) }) : null),
  'clipboard-busy': () => ({}),
};
export function vetFromMember(text) {
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string' || !Object.hasOwn(SHAPES, m.t)) return null;
    const fields = SHAPES[m.t](m);
    return fields ? JSON.stringify({ t: m.t, ...fields }) : null;
  } catch { return null; }
}
