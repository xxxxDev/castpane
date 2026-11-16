// Whether the whole screen lists the Mac's app windows beside its desktops
// (pages/RemotePage.vue). Off by default: the apps have their own home. Kept on each device.
import {ref} from 'vue';
import {PRODUCT} from './productConfig.js';

const KEY = PRODUCT.storageKeys.deskWindows;
function read() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
export const deskWindows = ref(read());
export function setDeskWindows(on) {
  deskWindows.value = !!on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
}

// The phone's key row (Settings › Remote › Key row): one round button at most at its left,
// two at most at its right, and four pages of keys between, each key in one place only.
// Kept on this device; a key a saved layout does not have (a new one) goes where it is by
// default.
export const KEY_NAMES = {
  dock: 'Dock', kb: '鍵盤', compose: '輸入文字',
  esc: 'esc', tab: 'tab', '⇧tab': '⇧tab', '↑': '↑', '↓': '↓', '←': '←', '→': '→', '⌃C': '^C',
  shift: '⇧ Shift', ctrl: '⌃ Control', alt: '⌥ Option', meta: '⌘ Command', clip: '剪貼簿', panel: '按鍵面板',
  delete: 'delete', return: 'return', home: 'home', end: 'end', 'page up': 'pgup', 'page down': 'pgdn',
  mission: '指揮中心', 'space-left': '上一個桌面', 'space-right': '下一個桌面',
};
export const KEY_LIMITS = {left: 1, right: 2};
export const DEFAULT_LAYOUT = Object.freeze({
  left: ['dock'],
  pages: [['esc', 'mission', 'space-left', 'space-right', 'panel', 'clip'], ['shift', 'ctrl', 'alt', 'meta', '⌃C', 'return'], ['delete', 'home', 'end', 'page up', 'page down'], ['↑', '↓', '←', '→', 'tab', '⇧tab']],
  right: ['kb', 'compose'],
});
const LAYOUT_KEY = PRODUCT.storageKeys.keyLayout;
const copy = (l) => ({left: [...l.left], pages: l.pages.map((p) => [...p]), right: [...l.right]});
// A saved layout made whole: known keys only, each once, the limits kept, the missing ones
// back where they are by default.
function whole(saved) {
  const out = {left: [], pages: [[], [], [], []], right: []}, seen = new Set();
  const take = (list, into, max = Infinity) => { for (const id of Array.isArray(list) ? list : []) if (KEY_NAMES[id] && !seen.has(id) && into.length < max) { seen.add(id);into.push(id); } };
  if (saved && typeof saved === 'object') {
    take(saved.left, out.left, KEY_LIMITS.left);take(saved.right, out.right, KEY_LIMITS.right);
    for (let i = 0; i < 4; i++) take(saved.pages?.[i], out.pages[i]);
  }
  const place = (id, where) => { if (!seen.has(id)) { seen.add(id);where.push(id); } };
  DEFAULT_LAYOUT.left.forEach((id) => place(id, out.left.length < KEY_LIMITS.left ? out.left : out.pages[0]));
  DEFAULT_LAYOUT.pages.forEach((p, i) => p.forEach((id) => place(id, out.pages[i])));
  DEFAULT_LAYOUT.right.forEach((id) => place(id, out.right.length < KEY_LIMITS.right ? out.right : out.pages[0]));
  return out;
}
function readLayout() { try { return whole(JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null')); } catch { return whole(null); } }
export const keyLayout = ref(readLayout());
export function setKeyLayout(layout) {
  keyLayout.value = layout ? whole(layout) : whole(null);
  try { if (layout) localStorage.setItem(LAYOUT_KEY, JSON.stringify(keyLayout.value));else localStorage.removeItem(LAYOUT_KEY); } catch {}
}
// A key moved: to another place ('left', 'right' or a page 0 to 3), at its end.
export function moveKey(id, to) {
  const l = copy(keyLayout.value);
  for (const list of [l.left, l.right, ...l.pages]) { const i = list.indexOf(id);if (i >= 0) list.splice(i, 1); }
  const into = to === 'left' ? l.left : to === 'right' ? l.right : l.pages[to];
  if (!into || (KEY_LIMITS[to] && into.length >= KEY_LIMITS[to])) return false;
  into.push(id);setKeyLayout(l);return true;
}
export function reorderKeys(where, from, to) {
  const l = copy(keyLayout.value), list = where === 'left' ? l.left : where === 'right' ? l.right : l.pages[where];
  list.splice(to, 0, list.splice(from, 1)[0]);setKeyLayout(l);
}
// The whole row as one list, its places as markers between the keys (Settings › Remote › Key
// row drags a key across them). Answers false, the layout kept, when a place would be over
// its limit.
export const PLACES = ['left', 0, 1, 2, 3, 'right'];
export function flatLayout(l = keyLayout.value) {
  return PLACES.flatMap((w) => [{place: w}, ...(w === 'left' || w === 'right' ? l[w] : l.pages[w]).map((id) => ({id}))]);
}
export function setFlatLayout(flat) {
  const l = {left: [], pages: [[], [], [], []], right: []};
  let at = 'left';
  for (const x of flat) {
    if ('place' in x) { at = x.place;continue; }
    (at === 'left' || at === 'right' ? l[at] : l.pages[at]).push(x.id);
  }
  if (l.left.length > KEY_LIMITS.left || l.right.length > KEY_LIMITS.right) return false;
  setKeyLayout(l);return true;
}
