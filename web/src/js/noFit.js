// The apps whose windows Labs leaves at their own size (pages/NoFitPage.vue): those the
// owner put on the list, those found too wide to be made a phone's shape, and the names of
// the apps a Mac listed last, to add from when no Mac is open. Kept on this device.
import {reactive} from 'vue';

const KEY = 'castpane-nofit';
function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
    return { never: obj(v.never), narrow: obj(v.narrow), known: obj(v.known) };
  } catch { return { never: {}, narrow: {}, known: {} }; }
}
export const noFit = reactive(read());
function save() { try { localStorage.setItem(KEY, JSON.stringify(noFit)); } catch { /* kept for now only */ } }

export const neverFits = (bundle) => !!bundle && Object.hasOwn(noFit.never, bundle);
export function setNever(bundle, name, on) {
  if (!bundle) return;
  if (on) noFit.never[bundle] = String(name || bundle).slice(0, 100);
  else delete noFit.never[bundle];
  save();
}
// An app that kept a wider window than asked for: how narrow it would go.
export function noteNarrow(bundle, name, width) {
  if (!bundle || noFit.narrow[bundle]?.width === width) return;
  noFit.narrow[bundle] = { name: String(name || bundle).slice(0, 100), width: Math.round(width) };
  save();
}
export function forgetNarrow(bundle) { delete noFit.narrow[bundle];save(); }
// The apps a Mac listed, for the picker.
export function noteApps(apps) {
  const known = {};
  for (const a of apps.slice(0, 300)) if (a?.bundle) known[a.bundle] = String(a.name || a.bundle).slice(0, 100);
  noFit.known = known;
  save();
}
