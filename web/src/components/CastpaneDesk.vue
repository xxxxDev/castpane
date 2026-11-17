<template>
  <!-- CastpaneOS: the page as a desktop of the Mac's windows, each one a window here
       that is dragged by its bar, resized from its corner and brought to the front with a
       click; the Mac's Dock at the foot. Which windows are open here, where and how big, is
       kept on this device for each Mac. The one in front is live (the page lays its picture over
       it), the others show the Mac's thumbnails, read again every few seconds; a window's last
       bar button opens it alone, full size. -->
  <div ref="deskEl" class="cp-desk" :class="{'cp-sharing': splitting}" @pointerdown.self="focused = null">
    <div class="cp-desk-top">
      <button type="button" class="cp-desk-back" :title="ct('首頁')" :aria-label="ct('首頁')" @click="$emit('home')"><f7-icon f7="chevron_left" :size="16"/></button>
      <b class="cp-desk-name">{{ name }}</b>
      <span class="cp-desk-space"></span>
      <button type="button" class="cp-desk-tool" @click="$emit('all')"><f7-icon f7="square_grid_2x2" :size="14"/><span>{{ ct('所有 App') }}</span></button>
      <button type="button" class="cp-desk-tool" @click="$emit('desktop')"><f7-icon f7="desktopcomputer" :size="14"/><span>{{ ct('整個螢幕') }}</span></button>
    </div>
    <!-- On a phone each window comes and goes as an iPad's does (grows in, Slide Over from the right). -->
    <TransitionGroup :css="phone" name="cp-pw">
    <div v-for="o in (phone ? phoneShown : shown)" :key="o.id" class="cp-win" :class="{focus: focused === o.id, max: o.max && !phone, 'cp-phone': phone, 'cp-over': phone && o.id === pv.over}" :data-id="o.id"
         :style="phone ? phoneStyle(o) : o.max ? {zIndex: o.z} : {left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px', zIndex: o.z}"
         @pointerdown="raise(o)">
      <!-- A phone: as an iPad's, the window's ••• in the middle of its bar gives full screen, split, Slide Over. -->
      <div v-if="phone" class="cp-win-bar" @pointerdown="overDown($event, o)" @pointermove="overMove" @pointerup="overUp" @pointercancel="overUp">
        <img v-if="icons[o.win.bundle]" :src="icons[o.win.bundle]" alt=""/>
        <b>{{ o.win.app || o.win.title }}</b>
        <span class="cp-win-title">{{ o.win.title && o.win.title !== o.win.app ? o.win.title : '' }}</span>
        <button type="button" class="cp-win-more" :title="ct('多工處理')" :aria-label="ct('多工處理')" @pointerdown.stop @click="moreOf = moreOf === o.id ? null : o.id"><span></span><span></span><span></span></button>
      </div>
      <div v-else class="cp-win-bar" @pointerdown="dragStart($event, o)" @dblclick="toggleMax(o)">
        <button type="button" class="cp-light close" :title="ct('關閉視窗')" :aria-label="ct('關閉視窗')" @pointerdown.stop @click="close(o)"></button>
        <button type="button" class="cp-light minimize" :title="ct('縮到 Dock')" :aria-label="ct('縮到 Dock')" @pointerdown.stop @click="minimize(o)"></button>
        <button type="button" class="cp-light zoom" :title="ct('放大')" :aria-label="ct('放大')" @pointerdown.stop @click="toggleMax(o)"></button>
        <img v-if="icons[o.win.bundle]" :src="icons[o.win.bundle]" alt=""/>
        <b>{{ o.win.app || o.win.title }}</b>
        <span class="cp-win-title">{{ o.win.title && o.win.title !== o.win.app ? o.win.title : '' }}</span>
        <button type="button" class="cp-win-full" :title="ct('單獨全畫面')" :aria-label="ct('單獨全畫面')" @pointerdown.stop @click="$emit('open', o.win)"><f7-icon f7="arrow_up_left_arrow_down_right" :size="13"/></button>
      </div>
      <div class="cp-win-body">
        <img v-if="snaps[o.id] || o.win.thumb" :src="snaps[o.id] || o.win.thumb" alt="" draggable="false"/>
        <div v-else class="cp-win-blank"><img v-if="icons[o.win.bundle]" :src="icons[o.win.bundle]" alt=""/></div>
      </div>
      <!-- Resized from any edge or corner, as a Mac window is; the corner bottom right marked. -->
      <template v-if="!o.max && !phone"><div v-for="e in EDGES" :key="e" :class="['cp-win-edge', 'cp-edge-' + e, {'cp-win-grip': e === 'se'}]" @pointerdown.stop="resizeStart($event, o, e)"></div></template>
    </div>
    </TransitionGroup>
    <div v-if="!shown.length" class="cp-desk-empty">{{ phone ? ct('點下方的橫條叫出 Dock，打開 App。') : ct('從左側的 Dock 打開 App，視窗會出現在這裡，可以拖動和縮放。') }}</div>
    <template v-if="phone">
      <!-- Split: the bar between the two, dragged to share the room. -->
      <div v-if="pv.second" class="cp-split" :style="{top: (box.top + box.h * ph.ratio - 9) + 'px'}" @pointerdown="splitDown" @pointermove="splitMove" @pointerup="splitUp" @pointercancel="splitUp"><span></span></div>
      <!-- Slide Over pushed off the right edge: its tab brings it back. -->
      <button v-if="pv.overId && ph.overHidden" type="button" class="cp-over-tab" :aria-label="ct('滑動置前')" @click="showOver"></button>
      <!-- The window's ••• menu. -->
      <Transition name="cp-pop">
      <div v-if="moreOf !== null" class="cp-more-layer" @pointerdown.self="moreOf = null">
        <div class="cp-more-menu" :style="moreStyle">
          <button type="button" class="full" @click="arrange('full')"><f7-icon f7="rectangle" :size="16"/>{{ ct('全螢幕') }}</button>
          <button type="button" class="split" @click="arrange('split')"><f7-icon f7="square_split_1x2" :size="16"/>{{ ct('分割顯示') }}</button>
          <button type="button" class="over" @click="arrange('over')"><f7-icon f7="square_on_square" :size="16"/>{{ ct('滑動置前') }}</button>
          <button type="button" class="minimize" @click="arrange('minimize')"><f7-icon f7="minus_square" :size="16"/>{{ ct('縮到 Dock') }}</button>
          <button type="button" class="close-window" @click="arrange('close')"><f7-icon f7="xmark_square" :size="16"/>{{ ct('關閉視窗') }}</button>
        </div>
      </div>
      </Transition>
      <!-- The App Switcher: every window open here, a tap brings one full screen. -->
      <Transition name="cp-switch">
      <div v-if="switcher" class="cp-switcher" @pointerdown.self="switcher = false">
        <div v-for="o in shown" :key="'s' + o.id" class="cp-switch-card" :data-id="o.id" @click="fromSwitcher(o)">
          <div class="cp-switch-name"><img v-if="icons[o.win.bundle]" :src="icons[o.win.bundle]" alt=""/>{{ o.win.app || o.win.title }}</div>
          <div class="cp-switch-pic"><img v-if="snaps[o.id] || o.win.thumb" :src="snaps[o.id] || o.win.thumb" alt="" draggable="false"/></div>
          <button type="button" class="cp-switch-close" :aria-label="ct('關閉視窗')" @click.stop="close(o)"><f7-icon f7="xmark" :size="12"/></button>
        </div>
        <div v-if="!shown.length" class="cp-switch-empty">{{ ct('沒有開著的視窗') }}</div>
      </div>
      </Transition>
      <div v-if="dockOpen" class="cp-dock-backdrop" @pointerdown="dockOpen = false"></div>
      <!-- The home bar: a tap or a slide up gives the Dock; slid further up, the App Switcher. -->
      <div class="cp-homebar" @pointerdown="barDown" @pointermove="barMove" @pointerup="barUp" @pointercancel="barCancel"><span></span></div>
    </template>
    <!-- The Mac's Dock at the left, as on the Remote home: its apps (a dot beside those running); a tap brings up the app's window here. -->
    <Transition name="cp-dock-up">
    <div v-show="!phone || dockOpen" class="cp-dock" :class="{row: phone}" role="toolbar" :aria-label="ct('Dock')">
      <button v-for="a in dockApps" :key="a.bundle" type="button" class="cp-dock-app" :class="{running: a.running}" :data-bundle="a.bundle" :title="a.name" :aria-label="a.name" @click="held ? (held = false) : pick(a)" @contextmenu.prevent="dockContext($event, a)" @pointerdown="holdDown($event, a)" @pointermove="holdMove" @pointerup="holdEnd" @pointercancel="holdEnd">
        <img v-if="icons[a.bundle]" :src="icons[a.bundle]" alt="" draggable="false"/><span v-else>{{ (a.name || '?').slice(0, 1) }}</span>
      </button>
      <!-- Then, as the Mac's Dock: the windows put in it, the folders and files kept there, the Trash. -->
      <div v-if="inDock.length || others.length || trash" class="cp-dock-sep" aria-hidden="true"></div>
      <button v-for="w in inDock" :key="'w' + w.id" type="button" class="cp-dock-app cp-dock-window" :data-id="w.id" :title="w.title || w.app" :aria-label="w.title || w.app" @click="place(w)">
        <img v-if="w.thumb" class="cp-dock-thumb" :src="w.thumb" alt=""/><img v-if="icons[w.bundle]" class="cp-dock-badge" :src="icons[w.bundle]" alt=""/>
      </button>
      <button v-for="(o, i) in others" :key="'o' + i" type="button" class="cp-dock-app cp-dock-other" :data-index="i" :title="o.name" :aria-label="o.name" @click="$emit('other', i, o)">
        <span class="cp-dock-glyph"><f7-icon :f7="o.kind === 'file' ? 'doc_fill' : 'folder_fill'" :size="26"/></span>
      </button>
      <button v-if="trash" type="button" class="cp-dock-app cp-dock-trash" :title="ct('垃圾桶')" :aria-label="ct('垃圾桶')" @click="$emit('trash')">
        <span class="cp-dock-glyph"><f7-icon f7="trash" :size="26"/></span>
      </button>
      <button v-if="phone" type="button" class="cp-dock-app cp-dock-switch" :title="ct('所有視窗')" :aria-label="ct('所有視窗')" @click="dockOpen = false;switcher = true">
        <span class="cp-dock-glyph"><f7-icon f7="rectangle_stack" :size="24"/></span>
      </button>
    </div>
    </Transition>
  </div>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ct } from '../js/text.js';
const props = defineProps({ name: { type: String, default: '' }, machine: { type: String, default: '' }, windows: { type: Array, default: () => [] }, icons: { type: Object, default: () => ({}) }, dockApps: { type: Array, default: () => [] }, others: { type: Array, default: () => [] }, trash: { type: Boolean, default: false }, snaps: { type: Object, default: () => ({}) }, phone: { type: Boolean, default: false } });
const emit = defineEmits(['home', 'all', 'desktop', 'open', 'app', 'closeWindow', 'minimize', 'live', 'other', 'trash', 'appMenu']);
const deskEl = ref(null), focused = ref(null);
// The windows in the Mac's Dock, as its Dock shows them after its apps.
// Put in the Dock here, or brought out of it, before the Mac's next list says so: taken as done
// at once (a window put in the Dock and still in front here was made live again, and so
// brought back out on the Mac), forgotten when the list agrees or after a few seconds.
const hidden = ref(new Map()), restored = ref(new Map());
const isMin = (w) => hidden.value.has(w.id) || (w.minimized && !restored.value.has(w.id));
function mark(map, id, on) { const m = new Map(map.value);if (on) m.set(id, Date.now());else m.delete(id);map.value = m; }
watch(() => props.windows, (list) => {
  const now = Date.now(), by = new Map(list.map((w) => [w.id, w]));
  for (const [id, at] of hidden.value) if (by.get(id)?.minimized || !by.has(id) || now - at > 8000) mark(hidden, id, false);
  for (const [id, at] of restored.value) if ((by.has(id) && !by.get(id).minimized) || !by.has(id) || now - at > 8000) mark(restored, id, false);
});
const inDock = computed(() => props.windows.filter(isMin));
// The windows open here: {id, x, y, w, h, z, max}, kept for this Mac on this device.
const KEY = () => 'castpane-desk-' + (props.machine || 'local');
function read() { try { const v = JSON.parse(localStorage.getItem(KEY()) || '[]');return Array.isArray(v) ? v.filter((o) => Number.isFinite(o?.id)) : []; } catch { return []; } }
const placed = ref(read());
watch(() => props.machine, () => { placed.value = read();fitWidth = 0;nextTick(fitIn); });
function keep() { try { localStorage.setItem(KEY(), JSON.stringify(placed.value)); } catch { /* this time only */ } }
let top = Math.max(1, ...placed.value.map((o) => o.z || 1));
// Those of the Mac's windows still there (and not in its Dock); one gone is forgotten.
const byId = computed(() => new Map(props.windows.map((w) => [w.id, w])));
const shown = computed(() => placed.value.filter((o) => byId.value.get(o.id) && !isMin(byId.value.get(o.id))).map((o) => ({ ...o, win: byId.value.get(o.id) })));
// Coming in to windows kept from before: the top one is live at once, not left a thumbnail.
let entered = false;
watch(shown, (l) => { if (entered || !l.length) return;entered = true;if (focused.value === null) focused.value = l.reduce((a, b) => ((b.z || 0) > (a.z || 0) ? b : a)).id; }, { immediate: true });
watch(byId, (m) => { const left = placed.value.filter((o) => m.has(o.id));if (left.length !== placed.value.length) { placed.value = left;keep(); } });
// A window brought here, cascaded from the last one, sized to its own shape within the desk.
function place(win) {
  // Out of the Dock: shown here at once; made live, the Mac brings it out.
  if (isMin(win)) { mark(hidden, win.id, false);mark(restored, win.id, true); }
  const have = placed.value.find((o) => o.id === win.id);
  if (props.phone) toSlot(win.id);
  if (have) { raise(have);return; }
  const box = deskEl.value?.getBoundingClientRect() || { width: 1200, height: 800 };
  const room = { w: box.width - 40, h: box.height - 140 };
  const ratio = win.width && win.height ? win.width / win.height : 1.5;
  const n = placed.value.length % 6;
  // A phone's narrow desk: the room right of the Dock, a little lower for each one after.
  const narrow = box.width < 600;
  let w = narrow ? box.width - 80 : Math.min(room.w * 0.6, 760), h = w / ratio;
  if (h > room.h * (narrow ? 0.85 : 0.75)) { h = room.h * (narrow ? 0.85 : 0.75);w = h * ratio; }
  const o = { id: win.id, x: narrow ? 70 + n * 4 : 100 + n * 36, y: narrow ? 50 + n * 24 : 54 + n * 30, w: Math.round(Math.max(narrow ? 240 : 260, w)), h: Math.round(Math.max(narrow ? 160 : 180, h) + 30), z: ++top, max: false };
  placed.value = [...placed.value, o];focused.value = o.id;keep();
}
function update(id, patch) { placed.value = placed.value.map((o) => (o.id === id ? { ...o, ...patch } : o)); }
function raise(o) { focused.value = o.id;if (o.z !== top) { update(o.id, { z: ++top });keep(); } }
function toggleMax(o) { update(o.id, { max: !o.max });keep(); }
function close(o) { emit('closeWindow', o.win);placed.value = placed.value.filter((x) => x.id !== o.id);keep(); }
function minimize(o) { mark(restored, o.id, false);mark(hidden, o.id, true);if (focused.value === o.id) focused.value = null;emit('minimize', o.win); }
// A Dock app: its window used last comes here, or the app is started (the page opens it).
function pick(a) {
  dockOpen.value = false;
  const w = props.windows.find((x) => x.bundle === a.bundle && !isMin(x)) || props.windows.find((x) => x.bundle === a.bundle);
  if (w) place(w);else emit('app', a);
}
// By touch (no right click), a Dock app held half a second gives its menu; the tap after it does nothing.
let held = false, holdAt = null, holdTimer = 0;
function holdDown(e, a) {
  held = false;clearTimeout(holdTimer);holdAt = null;
  if (e.pointerType === 'mouse') return;
  holdAt = { x: e.clientX, y: e.clientY };
  const el = e.currentTarget;
  holdTimer = setTimeout(() => {
    held = true;holdAt = null;
    const b = el.getBoundingClientRect();
    emit('appMenu', a, { clientX: b.right + 8, clientY: b.top });
  }, 500);
}
function holdMove(e) { if (holdAt && Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) > 10) { clearTimeout(holdTimer);holdAt = null; } }
function holdEnd() { clearTimeout(holdTimer);holdAt = null; }
// The browser's own long-press menu (Android) and the hold give one menu, not two.
function dockContext(e, a) {
  clearTimeout(holdTimer);holdAt = null;
  if (held) return;
  if (e.pointerType && e.pointerType !== 'mouse') held = true;
  emit('appMenu', a, e);
}
onBeforeUnmount(() => clearTimeout(holdTimer));
// The windows on show and not in front, the top ones first, with their body's width.
function behind() {
  if (props.phone) return phoneShown.value.filter((o) => o.id !== focused.value && !(o.id === pv.value.overId && ph.value.overHidden)).map((o) => ({ id: o.id, width: Math.round(parseFloat(phoneStyle(o).width) || 300) }));
  return shown.value.filter((o) => o.id !== focused.value).sort((a, b) => (b.z || 0) - (a.z || 0)).map((o) => ({ id: o.id, width: o.max ? (deskEl.value?.clientWidth || o.w) : o.w }));
}
defineExpose({ place, behind });
// The window in front is live: the page lays its picture over this window's body, told again as
// the window moves or is resized (the corner that resizes it sits just outside).
function liveRect() {
  const o = shown.value.find((x) => x.id === focused.value);
  const el = o && deskEl.value?.querySelector(`.cp-win[data-id="${o.id}"] .cp-win-body`);
  if (!el) return null;
  const d = deskEl.value.getBoundingClientRect();
  let b = el.getBoundingClientRect();
  // A phone's window may be on its way to its slot: the picture goes where it is going, with it.
  if (props.phone) {
    const st = phoneStyle(o), bar = el.previousElementSibling?.offsetHeight || 36;
    b = { left: d.left + parseFloat(st.left), top: d.top + parseFloat(st.top) + bar, width: parseFloat(st.width), height: parseFloat(st.height) - bar };
  }
  return { win: o.win, glide: props.phone && Date.now() < glideUntil, rect: { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }, desk: { left: Math.round(d.left), top: Math.round(d.top), width: Math.round(d.width), height: Math.round(d.height) } };
}
watch([focused, placed], () => nextTick(() => emit('live', liveRect())), { deep: true });
// The desk itself moved or resized (the browser window, the sidebar folded or opened): told again.
let sized = null;
watch(deskEl, (el) => { sized?.disconnect();sized = null;if (el && typeof ResizeObserver !== 'undefined') { sized = new ResizeObserver(() => { measure();fitIn();emit('live', liveRect()); });sized.observe(el); } });
// Each window kept within the desk as it is now (one placed on a wider screen, or before the
// phone turned): no wider than it. On a phone's narrow desk wholly in the room right of the
// Dock; on a wider one only within the limits a drag has (partly off an edge is left so).
// Heights are left: the keyboard up while the phone turns would have made them short for good.
// Only when its width changes (turned, another screen): the keyboard coming up takes height for a
// while, and the windows stay as they were.
let fitWidth = 0;
function fitIn() {
  const b = deskEl.value?.getBoundingClientRect();if (!b?.width || Math.round(b.width) === fitWidth) return;
  fitWidth = Math.round(b.width);
  const narrow = b.width < 600, left = narrow ? 62 : 0;
  let changed = false;
  const next = placed.value.map((o) => {
    if (o.max) return o;
    let { x, y, w } = o;const { h } = o;
    w = Math.min(w, Math.max(240, Math.floor(b.width - left - 4)));
    if (narrow) { if (x + w > b.width) x = Math.max(left, Math.floor(b.width - w));if (x < left) x = left; }
    else x = Math.min(Math.max(x, -w + 80), Math.floor(b.width - 80));
    y = Math.max(40, Math.min(y, Math.floor(b.height - 60)));
    if (x === o.x && y === o.y && w === o.w) return o;
    changed = true;return { ...o, x, y, w, h };
  });
  if (changed) { placed.value = next;keep(); }
}
onBeforeUnmount(() => sized?.disconnect());
// Dragging and resizing, kept within the desk.
let drag = null;
function bounds() { const b = deskEl.value?.getBoundingClientRect();return b ? { w: b.width, h: b.height } : { w: 1200, h: 800 }; }
function dragStart(e, o) {
  if (o.max || e.button > 0) return;
  drag = { kind: 'move', id: o.id, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, ow: o.w, oh: o.h };
  e.currentTarget.setPointerCapture?.(e.pointerId);
  addEventListener('pointermove', dragMove);addEventListener('pointerup', dragEnd, { once: true });
}
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
function resizeStart(e, o, edge = 'se') {
  drag = { kind: 'size', edge, id: o.id, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, ow: o.w, oh: o.h };
  addEventListener('pointermove', dragMove);addEventListener('pointerup', dragEnd, { once: true });
}
function dragMove(e) {
  if (!drag) return;
  const b = bounds(), dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (drag.kind === 'move') update(drag.id, { x: Math.round(Math.min(Math.max(drag.ox + dx, -drag.ow + 80), b.w - 80)), y: Math.round(Math.min(Math.max(drag.oy + dy, 40), b.h - 60)) });
  else {
    // Each side that moves keeps the window at least 240 × 160, within the desk and under its bar.
    const d = drag.edge, p = {};
    if (d.includes('e')) p.w = Math.round(Math.max(240, Math.min(drag.ow + dx, b.w - drag.ox)));
    if (d.includes('s')) p.h = Math.round(Math.max(160, Math.min(drag.oh + dy, b.h - drag.oy)));
    if (d.includes('w')) { const x = Math.min(Math.max(drag.ox + dx, 0), drag.ox + drag.ow - 240);p.x = Math.round(x);p.w = Math.round(drag.ow + drag.ox - x); }
    if (d.includes('n')) { const y = Math.min(Math.max(drag.oy + dy, 40), drag.oy + drag.oh - 160);p.y = Math.round(y);p.h = Math.round(drag.oh + drag.oy - y); }
    update(drag.id, p);
  }
}
function dragEnd() { removeEventListener('pointermove', dragMove);if (drag) keep();drag = null; }
onBeforeUnmount(() => removeEventListener('pointermove', dragMove));

// ---- A phone: as an iPad's multitasking ----
// One window full screen, or two split top and bottom, and one more in Slide Over, floating at the
// right; the others open behind, in the App Switcher. Kept for this Mac on this device.
const PH_KEY = () => 'castpane-phone-desk-' + (props.machine || 'local');
function readPh() { try { const v = JSON.parse(localStorage.getItem(PH_KEY()) || '{}');return { main: v.main ?? null, second: v.second ?? null, over: v.over ?? null, overHidden: !!v.overHidden, ratio: Number.isFinite(v.ratio) ? v.ratio : 0.5 }; } catch { return { main: null, second: null, over: null, overHidden: false, ratio: 0.5 }; } }
const ph = ref(readPh());
watch(() => props.machine, () => { ph.value = readPh(); });
function keepPh() { try { localStorage.setItem(PH_KEY(), JSON.stringify(ph.value)); } catch { /* this time only */ } }
function setPh(patch) { ph.value = { ...ph.value, ...patch };keepPh(); }
// The slots as they can be now: a window gone or in the Dock leaves its slot, the main one taken
// by the window used last.
const pv = computed(() => {
  const ids = new Set(shown.value.map((o) => o.id)), byZ = [...shown.value].sort((a, b) => (b.z || 0) - (a.z || 0));
  const overId = ids.has(ph.value.over) ? ph.value.over : null;
  let main = ids.has(ph.value.main) && ph.value.main !== overId ? ph.value.main : null;
  let second = ids.has(ph.value.second) && ph.value.second !== overId && ph.value.second !== main ? ph.value.second : null;
  if (main === null && second !== null) { main = second;second = null; }
  if (main === null) main = byZ.find((o) => o.id !== overId)?.id ?? null;
  return { main, second, overId, over: overId !== null && !ph.value.overHidden ? overId : null };
});
const phoneShown = computed(() => shown.value.filter((o) => o.id === pv.value.main || o.id === pv.value.second || o.id === pv.value.over));
// The desk's size, for the boxes; read again as it changes.
const deskSize = ref({ w: 390, h: 700 });
function measure() { const b = deskEl.value?.getBoundingClientRect();if (b?.width) deskSize.value = { w: b.width, h: b.height }; }
watch(deskEl, () => nextTick(measure));
// The room under the desk's bar and over the home bar.
const box = computed(() => ({ top: 40, h: Math.max(200, deskSize.value.h - 40 - 22), w: deskSize.value.w }));
function phoneStyle(o) {
  const b = box.value, px = (n) => Math.round(n) + 'px';
  if (o.id === pv.value.over) { const w = Math.min(b.w * 0.72, 340), h = b.h * 0.62;return { left: px(b.w - w - 8), top: px(b.top + 28), width: px(w), height: px(h), zIndex: focused.value === o.id ? 20 : 9050 }; }
  if (pv.value.second !== null && (o.id === pv.value.main || o.id === pv.value.second)) {
    const first = o.id === pv.value.main, cut = b.h * ph.value.ratio;
    return { left: '0px', top: px(first ? b.top : b.top + cut + 4), width: px(b.w), height: px(first ? cut - 4 : b.h - cut - 4), zIndex: 10 };
  }
  return { left: '0px', top: px(b.top), width: px(b.w), height: px(b.h), zIndex: 10 };
}
// A window brought here goes where the finger is: in Slide Over or the split's second half when
// that is the one in front, otherwise full screen (the split kept, its first half replaced).
function toSlot(id) {
  const v = pv.value;
  if (id === v.main || id === v.second) return;
  if (id === v.overId) { setPh({ overHidden: false });return; }
  if (v.second !== null && focused.value === v.second) setPh({ second: id });
  else setPh({ main: id });
}
const moreOf = ref(null);
const moreStyle = computed(() => {
  const o = shown.value.find((x) => x.id === moreOf.value);if (!o) return {};
  const st = phoneStyle(o), left = parseFloat(st.left) + parseFloat(st.width) / 2 - 100;
  return { left: Math.max(8, Math.min(left, deskSize.value.w - 208)) + 'px', top: (parseFloat(st.top) + 40) + 'px' };
});
function arrange(how) {
  const o = shown.value.find((x) => x.id === moreOf.value);moreOf.value = null;if (!o) return;
  const v = pv.value, id = o.id;
  // The next window for a slot left empty: the one used last, not on show.
  const spare = (not) => [...shown.value].sort((a, b) => (b.z || 0) - (a.z || 0)).find((x) => !not.includes(x.id))?.id ?? null;
  if (how === 'close') return close(o);
  if (how === 'minimize') return minimize(o);
  if (how === 'full') { setPh({ main: id, second: null, over: v.overId === id ? null : ph.value.over });focused.value = id;return; }
  if (how === 'over') {
    const main = id === v.main ? (v.second ?? spare([id])) : v.main;
    setPh({ over: id, overHidden: false, main, second: id === v.main || id === v.second ? null : v.second });focused.value = id;return;
  }
  // Split: this window and another, the one in front first.
  if (id === v.main || id === v.second) {
    if (v.second !== null) return;
    const other = spare([id, v.overId]);
    if (other === null) { dockOpen.value = true;splitWanted = id;return; }
    setPh({ main: id, second: other });
  } else setPh({ second: id, over: v.overId === id ? null : ph.value.over });
  focused.value = id;
}
// Split chosen with no other window open: the next app opened from the Dock takes the other half.
let splitWanted = null;
watch(() => shown.value.map((o) => o.id).join(), () => {
  if (splitWanted === null) return;
  const fresh = shown.value.find((o) => o.id !== splitWanted && o.id === pv.value.main);
  if (fresh && shown.value.some((o) => o.id === splitWanted)) { setPh({ main: splitWanted, second: fresh.id });focused.value = fresh.id;splitWanted = null; }
});
function showOver() { setPh({ overHidden: false });focused.value = pv.value.overId; }
// Slide Over moved by its bar: pushed off to the right, it hides there.
let overDrag = null;
function overDown(e, o) {
  if (o.id !== pv.value.over) return;
  overDrag = { id: o.id, x: e.clientX, el: e.currentTarget.parentElement };
  capture(e);
}
function overMove(e) { if (overDrag) overDrag.el.style.transform = `translateX(${Math.max(-40, e.clientX - overDrag.x)}px)`; }
function overUp(e) {
  if (!overDrag) return;
  const dx = e.clientX - overDrag.x;overDrag.el.style.transform = '';
  if (dx > 70) { setPh({ overHidden: true });if (focused.value === overDrag.id) focused.value = pv.value.main; }
  overDrag = null;
}
// The split's bar dragged: the halves at a quarter of the room at least.
const splitting = ref(null);
function splitDown(e) { splitting.value = { y: e.clientY, r: ph.value.ratio };capture(e); }
function splitMove(e) { const sp = splitting.value;if (sp) ph.value = { ...ph.value, ratio: Math.min(0.75, Math.max(0.25, sp.r + (e.clientY - sp.y) / box.value.h)) }; }
function splitUp() { if (splitting.value) keepPh();splitting.value = null; }
// The home bar: a tap or a short slide up opens the Dock, a long one the App Switcher.
const dockOpen = ref(false), switcher = ref(false);
let bar = null;
function barDown(e) { bar = { y: e.clientY };capture(e); }
function capture(e) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer gone already */ } }
function barMove() { /* followed on lifting */ }
function barUp(e) {
  if (!bar) return;
  const dy = e.clientY - bar.y;bar = null;
  if (dy < -160) { dockOpen.value = false;switcher.value = true; } else { switcher.value = false;dockOpen.value = !dockOpen.value || dy < -20; }
}
function barCancel() { bar = null; }
function fromSwitcher(o) { switcher.value = false;setPh({ main: o.id, second: pv.value.second === o.id ? null : ph.value.second, over: pv.value.overId === o.id ? null : ph.value.over });focused.value = o.id; }
// Coming in on a phone: the window full screen is the live one.
watch(() => props.phone && pv.value.main, (m) => { if (props.phone && m !== null && m !== false && (focused.value === null || !phoneShown.value.some((o) => o.id === focused.value))) focused.value = m; }, { immediate: true });
// The slots changed: the windows glide to theirs, the live picture with them.
let glideUntil = 0;
watch(() => [pv.value.main, pv.value.second, pv.value.over].join(), () => { glideUntil = Date.now() + 350;nextTick(() => emit('live', liveRect())); });
</script>
<style>
.cp-desk {position:relative;flex:1;min-height:0;overflow:hidden;background:radial-gradient(1200px 700px at 30% 20%, #253048, #0e1117 70%);-webkit-user-select:none;user-select:none;}
.cp-desk-top {position:absolute;left:0;right:0;top:0;z-index:9000;height:40px;display:flex;align-items:center;gap:10px;padding:0 12px;background:rgba(20,20,22,.8);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,.08);}
.remote-stage .cp-desk-back {width:28px;height:28px;margin:0;padding:0;border:0;border-radius:14px;background:rgba(255,255,255,.12);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.cp-desk-name {font-size:14px;color:#fff;}
.cp-desk-space {flex:1;}
.remote-stage .cp-desk-tool {display:inline-flex;align-items:center;gap:6px;width:auto;height:28px;margin:0;padding:0 12px;border:0;border-radius:14px;background:rgba(255,255,255,.12);color:#fff;font-size:13px;cursor:pointer;}
.cp-win {position:absolute;display:flex;flex-direction:column;border-radius:12px;background:#1c1c1e;box-shadow:0 18px 50px rgba(0,0,0,.55), 0 0 0 .5px rgba(255,255,255,.18);}
.cp-win.focus {box-shadow:0 24px 70px rgba(0,0,0,.7), 0 0 0 1px rgba(10,132,255,.6);}
.cp-win.max {left:0 !important;top:40px !important;right:0;bottom:0;width:auto !important;height:auto !important;border-radius:0;}
.cp-win-bar {flex:0 0 auto;height:30px;border-radius:12px 12px 0 0;display:flex;align-items:center;gap:7px;padding:0 10px;background:rgba(40,40,44,.96);color:#fff;font-size:13px;cursor:grab;touch-action:none;}
.remote-stage .cp-light {width:12px;height:12px;margin:0;padding:0;border:0;border-radius:6px;cursor:pointer;}
.remote-stage .cp-light.close {background:#ff5f57;}
.remote-stage .cp-light.minimize {background:#febc2e;}
.remote-stage .cp-light.zoom {background:#28c840;}
.cp-win-bar img {flex:0 0 auto;width:16px;height:16px;margin-left:6px;}
.cp-win-bar b {flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-stage .cp-light {flex:0 0 auto;}
.cp-win-title {flex:1 1 0;min-width:0;margin-left:6px;color:#9a9a9f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* The body as the Mac's window: its rounded foot, no black around its picture. */
.cp-win-body {position:relative;flex:1;min-height:0;overflow:hidden;border-radius:0 0 12px 12px;background:#1c1c1e;cursor:default;}
/* The picture whole, at the top, when the Mac's window is not this one's shape (fit for another screen). */
.cp-win-body > img {width:100%;height:100%;object-fit:contain;object-position:top center;}
.cp-win-blank {width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
.cp-win-blank img {width:64px;height:64px;}
.remote-stage .cp-win-full {flex:0 0 auto;margin:0 0 0 auto;width:24px;height:22px;padding:0;border:0;border-radius:6px;background:none;color:#bbb;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.remote-stage .cp-win-full:hover {background:rgba(255,255,255,.12);color:#fff;}
.cp-win-edge {position:absolute;z-index:9001;touch-action:none;}
.cp-edge-n {top:-5px;left:10px;right:10px;height:8px;cursor:ns-resize;}
.cp-edge-s {bottom:-5px;left:10px;right:10px;height:8px;cursor:ns-resize;}
.cp-edge-e {right:-5px;top:10px;bottom:10px;width:8px;cursor:ew-resize;}
.cp-edge-w {left:-5px;top:10px;bottom:10px;width:8px;cursor:ew-resize;}
/* 14 wide, 6 of it over the window: clear of the lights and the bar's buttons (10 in). */
.cp-edge-ne, .cp-edge-nw, .cp-edge-se, .cp-edge-sw {width:14px;height:14px;}
.cp-edge-ne {right:-8px;top:-8px;cursor:nesw-resize;}
.cp-edge-sw {left:-8px;bottom:-8px;cursor:nesw-resize;}
.cp-edge-nw {left:-8px;top:-8px;cursor:nwse-resize;}
.cp-edge-se {right:-8px;bottom:-8px;cursor:nwse-resize;}
.cp-win-grip::after {content:'';position:absolute;right:2px;bottom:2px;width:8px;height:8px;border-right:2px solid rgba(255,255,255,.4);border-bottom:2px solid rgba(255,255,255,.4);}
.cp-desk-empty {position:absolute;left:50%;top:45%;transform:translate(-50%,-50%);color:#9a9a9f;font-size:14px;}
.cp-dock {position:absolute;left:12px;top:calc(50% + 20px);transform:translateY(-50%);z-index:9000;display:flex;flex-direction:column;gap:8px;max-height:calc(100% - 80px);overflow-y:auto;scrollbar-width:none;padding:10px 8px;border-radius:22px;background:rgba(40,40,44,.6);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);box-shadow:0 0 0 .5px rgba(255,255,255,.25), 0 10px 40px rgba(0,0,0,.5);}
.remote-stage .cp-dock-app {position:relative;flex:0 0 auto;width:48px;height:48px;margin:0;padding:0;border:0;background:none;cursor:pointer;}
.cp-dock-app img {width:48px;height:48px;}
.cp-dock-app span {display:flex;width:48px;height:48px;align-items:center;justify-content:center;border-radius:11px;background:#3a3a3c;color:#fff;font-weight:600;}
.cp-dock-sep {flex:0 0 auto;height:1px;margin:2px 4px;background:rgba(255,255,255,.2);}
.cp-dock-glyph {display:flex;width:48px;height:48px;align-items:center;justify-content:center;border-radius:11px;background:rgba(255,255,255,.12);color:#9fc3ff;}
.cp-dock-trash .cp-dock-glyph {color:#ddd;}
.cp-dock-thumb {width:48px !important;height:36px !important;margin-top:6px;object-fit:cover;object-position:top;border-radius:5px;background:#000;}
.cp-dock-badge {position:absolute;right:-4px;bottom:-2px;width:20px !important;height:20px !important;}
/* By touch: the lights and the edges larger to the finger than they look. */
@media (pointer: coarse) {
  .cp-win-bar {height:36px;gap:16px;}
  .remote-stage .cp-light {position:relative;width:14px;height:14px;border-radius:7px;}
  .remote-stage .cp-light::before {content:'';position:absolute;inset:-8px;}
  .remote-stage .cp-win-full {width:32px;height:30px;}
  .cp-edge-n, .cp-edge-s {height:16px;}
  .cp-edge-n {top:-10px;}
  .cp-edge-s {bottom:-10px;}
  .cp-edge-e, .cp-edge-w {width:16px;}
  .cp-edge-e {right:-10px;}
  .cp-edge-w {left:-10px;}
  .cp-edge-ne, .cp-edge-nw, .cp-edge-se, .cp-edge-sw {width:28px;height:28px;}
  .cp-edge-ne {right:-14px;top:-20px;}
  .cp-edge-sw {left:-14px;bottom:-14px;}
  .cp-edge-nw {left:-14px;top:-20px;}
  .cp-edge-se {right:-14px;bottom:-14px;}
}
/* A phone's narrow desk: the bar's tools as icons, a smaller Dock. */
@media (max-width: 599px) {
  .cp-desk-tool span {display:none;}
  .remote-stage .cp-desk-tool {padding:0 10px;}
  .cp-dock {left:6px;gap:6px;padding:8px 5px;border-radius:16px;}
  .remote-stage .cp-dock-app, .cp-dock-app img, .cp-dock-app span, .cp-dock-glyph {width:40px;height:40px;}
  .cp-dock-thumb {width:40px !important;height:30px !important;}
}

/* A phone, as an iPad's multitasking. */
.cp-win.cp-phone {border-radius:0;box-shadow:none;}
.cp-win.cp-phone .cp-win-bar {border-radius:0;justify-content:flex-start;position:relative;cursor:default;}
.cp-win.cp-phone .cp-win-body {border-radius:0;}
.cp-win.cp-over {border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.7), 0 0 0 .5px rgba(255,255,255,.25);transition:transform .2s;}
.cp-win.cp-over .cp-win-bar {border-radius:14px 14px 0 0;cursor:grab;}
.cp-win.cp-over .cp-win-body {border-radius:0 0 14px 14px;}
.remote-stage .cp-win-more {position:absolute;left:50%;top:0;transform:translateX(-50%);width:56px;height:100%;margin:0;padding:0;border:0;background:none;display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;}
.cp-win-more span {width:5px;height:5px;border-radius:3px;background:rgba(255,255,255,.75);}
.cp-win.cp-phone .cp-win-bar b {max-width:calc(50% - 60px);}
.cp-win.cp-phone .cp-win-title {display:none;}
.cp-split {position:absolute;left:0;right:0;height:18px;z-index:9001;display:flex;align-items:center;justify-content:center;touch-action:none;cursor:ns-resize;}
.cp-split span {width:56px;height:5px;border-radius:3px;background:rgba(255,255,255,.7);box-shadow:0 0 0 1px rgba(0,0,0,.4);}
.remote-stage .cp-over-tab {position:absolute;right:0;top:120px;z-index:9050;width:14px;height:72px;margin:0;padding:0;border:0;border-radius:8px 0 0 8px;background:rgba(255,255,255,.35);cursor:pointer;}
.cp-more-layer {position:absolute;inset:0;z-index:9700;}
.cp-more-menu {position:absolute;width:200px;padding:6px;border-radius:14px;background:rgba(44,44,46,.97);box-shadow:0 10px 40px rgba(0,0,0,.6);display:flex;flex-direction:column;}
.remote-stage .cp-more-menu button {display:flex;align-items:center;gap:10px;width:100%;height:42px;margin:0;padding:0 12px;border:0;border-radius:9px;background:none;color:#fff;font-size:15px;text-align:left;cursor:pointer;}
.remote-stage .cp-more-menu button.close-window {color:#ff6961;}
.cp-homebar {position:absolute;left:0;right:0;bottom:0;height:22px;z-index:9001;display:flex;align-items:center;justify-content:center;touch-action:none;}
.cp-homebar span {width:134px;height:5px;border-radius:3px;background:rgba(255,255,255,.7);}
.cp-dock.row {left:8px;right:8px;top:auto;bottom:28px;transform:none;flex-direction:row;max-height:none;overflow-x:auto;overflow-y:hidden;z-index:9060;}
.cp-dock.row .cp-dock-sep {width:1px;height:auto;margin:4px 2px;}
.cp-dock-backdrop {position:absolute;inset:0;z-index:9055;}
.cp-switcher {position:absolute;inset:0;z-index:9600;background:rgba(10,10,12,.92);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);display:grid;grid-template-columns:1fr 1fr;align-content:start;gap:18px 14px;padding:56px 16px 24px;overflow-y:auto;}
.cp-switch-card {position:relative;min-width:0;cursor:pointer;}
.cp-switch-name {display:flex;align-items:center;gap:6px;margin-bottom:6px;color:#fff;font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
.cp-switch-name img {width:18px;height:18px;}
.cp-switch-pic {aspect-ratio:3/4;border-radius:12px;overflow:hidden;background:#1c1c1e;}
.cp-switch-pic img {width:100%;height:100%;object-fit:contain;object-position:top center;}
.remote-stage .cp-switch-close {position:absolute;right:-6px;top:16px;width:24px;height:24px;margin:0;padding:0;border:0;border-radius:12px;background:rgba(80,80,84,.95);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.cp-switch-empty {grid-column:1 / -1;margin-top:30vh;text-align:center;color:#9a9a9f;}

/* Its movements, as an iPad's: windows glide to their slots and grow in; Slide Over from the right;
   the Dock up from the foot; the App Switcher and the ••• menu open out. */
.cp-win.cp-phone {transition:left .3s cubic-bezier(.2,.8,.2,1), top .3s cubic-bezier(.2,.8,.2,1), width .3s cubic-bezier(.2,.8,.2,1), height .3s cubic-bezier(.2,.8,.2,1);}
.cp-sharing .cp-win.cp-phone {transition:none;}
.cp-win.cp-over {transition:left .3s, top .3s, width .3s, height .3s, transform .2s;}
.cp-pw-enter-active {animation:cp-pw-in .3s cubic-bezier(.2,.8,.2,1);}
.cp-pw-leave-active {animation:cp-pw-out .22s ease-in forwards;pointer-events:none;}
.cp-pw-enter-active.cp-over {animation:cp-over-in .32s cubic-bezier(.2,.8,.2,1);}
.cp-pw-leave-active.cp-over {animation:cp-over-out .26s ease-in forwards;}
@keyframes cp-pw-in {from {opacity:0;transform:scale(.92);}}
@keyframes cp-pw-out {to {opacity:0;transform:scale(.92);}}
@keyframes cp-over-in {from {transform:translateX(115%);}}
@keyframes cp-over-out {to {transform:translateX(115%);}}
.cp-dock-up-enter-active, .cp-dock-up-leave-active {transition:transform .28s cubic-bezier(.2,.8,.2,1), opacity .28s;}
.cp-dock-up-enter-from, .cp-dock-up-leave-to {transform:translateY(140%);opacity:0;}
.cp-switch-enter-active, .cp-switch-leave-active {transition:opacity .25s, transform .3s cubic-bezier(.2,.8,.2,1);}
.cp-switch-enter-from, .cp-switch-leave-to {opacity:0;transform:scale(1.06);}
.cp-pop-enter-active .cp-more-menu, .cp-pop-leave-active .cp-more-menu {transition:opacity .18s, transform .22s cubic-bezier(.2,.8,.2,1);transform-origin:top center;}
.cp-pop-enter-active, .cp-pop-leave-active {transition:opacity .22s;}
.cp-pop-enter-from .cp-more-menu, .cp-pop-leave-to .cp-more-menu {opacity:0;transform:scale(.85);}
.cp-switch-card {animation:cp-pw-in .3s cubic-bezier(.2,.8,.2,1) backwards;}
.cp-switch-card:nth-child(2) {animation-delay:.03s;}
.cp-switch-card:nth-child(3) {animation-delay:.06s;}
.cp-switch-card:nth-child(n+4) {animation-delay:.09s;}
@media (prefers-reduced-motion: reduce) {
  .cp-win.cp-phone, .cp-win.cp-over {transition:none;}
  .cp-pw-enter-active, .cp-pw-leave-active, .cp-switch-card {animation:none;}
}
.cp-dock-app.running::after {content:'';position:absolute;left:-6px;top:50%;width:4px;height:4px;margin-top:-2px;border-radius:2px;background:#ddd;}
</style>
