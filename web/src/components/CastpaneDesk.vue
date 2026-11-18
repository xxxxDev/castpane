<template>
  <!-- CastpaneOS: the page as a desktop of the Mac's windows, each one a window here
       that is dragged by its bar, resized from its corner and brought to the front with a
       click; the Mac's Dock at the foot. Which windows are open here, where and how big, is
       kept on this device for each Mac. The one in front is live (the page lays its picture over
       it), the others show the Mac's thumbnails, read again every few seconds; a window's last
       bar button opens it alone, full size. -->
  <div ref="deskEl" class="cp-desk" @pointerdown.self="focused = null">
    <div class="cp-desk-top">
      <button type="button" class="cp-desk-back" :title="ct('首頁')" :aria-label="ct('首頁')" @click="$emit('home')"><f7-icon f7="chevron_left" :size="18"/></button>
      <b class="cp-desk-name">{{ name }}</b>
      <!-- The live window's figures and the way they come, as the whole screen's bar shows them. -->
      <span class="cp-desk-space"><span class="cp-desk-stats">{{ stats.fps || 0 }} fps · {{ stats.mbps || 0 }} Mbps<template v-if="stats.rtt"> · {{ stats.rtt }} ms · {{ stats.direct ? ct('直連中') : ct('中繼中') }}</template></span></span>
      <button type="button" class="cp-desk-tool" @click="$emit('all')"><f7-icon f7="square_grid_2x2" :size="15"/><span>{{ ct('所有 App') }}</span></button>
      <button type="button" class="cp-desk-tool" @click="$emit('desktop')"><f7-icon f7="desktopcomputer" :size="15"/><span>{{ ct('整個螢幕') }}</span></button>
    </div>
    <div v-for="o in shown" :key="o.id" class="cp-win" :class="{focus: focused === o.id, max: o.max}" :data-id="o.id"
         :style="o.max ? {zIndex: o.z} : {left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px', zIndex: o.z}"
         @pointerdown="raise(o)">
      <div class="cp-win-bar" @pointerdown="dragStart($event, o)" @dblclick="toggleMax(o)">
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
      <template v-if="!o.max"><div v-for="e in EDGES" :key="e" :class="['cp-win-edge', 'cp-edge-' + e, {'cp-win-grip': e === 'se'}]" @pointerdown.stop="resizeStart($event, o, e)"></div></template>
    </div>
    <div v-if="!shown.length" class="cp-desk-empty">{{ ct('從左側的 Dock 打開 App，視窗會出現在這裡，可以拖動和縮放。') }}</div>
    <!-- The Mac's Dock at the left, as on the Remote home: its apps (a dot beside those running); a tap brings up the app's window here. -->
    <div class="cp-dock" role="toolbar" :aria-label="ct('Dock')">
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
    </div>
  </div>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ct } from '../js/text.js';
const props = defineProps({ name: { type: String, default: '' }, machine: { type: String, default: '' }, windows: { type: Array, default: () => [] }, icons: { type: Object, default: () => ({}) }, dockApps: { type: Array, default: () => [] }, others: { type: Array, default: () => [] }, trash: { type: Boolean, default: false }, snaps: { type: Object, default: () => ({}) }, stats: { type: Object, default: () => ({}) } });
const emit = defineEmits(['home', 'all', 'desktop', 'open', 'app', 'closeWindow', 'minimize', 'live', 'other', 'trash', 'appMenu']);
const deskEl = ref(null), focused = ref(null);
// The desk's bar, as tall as the Remote home's (no window goes under it).
const BAR = 54;
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
  if (have) { raise(have);return; }
  const box = deskEl.value?.getBoundingClientRect() || { width: 1200, height: 800 };
  const room = { w: box.width - 40, h: box.height - 140 };
  const ratio = win.width && win.height ? win.width / win.height : 1.5;
  const n = placed.value.length % 6;
  // A phone's narrow desk: the room right of the Dock, a little lower for each one after.
  const narrow = box.width < 600;
  let w = narrow ? box.width - 80 : Math.min(room.w * 0.6, 760), h = w / ratio;
  if (h > room.h * (narrow ? 0.85 : 0.75)) { h = room.h * (narrow ? 0.85 : 0.75);w = h * ratio; }
  const o = { id: win.id, x: narrow ? 70 + n * 4 : 100 + n * 36, y: narrow ? BAR + 10 + n * 24 : BAR + 14 + n * 30, w: Math.round(Math.max(narrow ? 240 : 260, w)), h: Math.round(Math.max(narrow ? 160 : 180, h) + 30), z: ++top, max: false };
  placed.value = [...placed.value, o];focused.value = o.id;keep();
}
function update(id, patch) { placed.value = placed.value.map((o) => (o.id === id ? { ...o, ...patch } : o)); }
function raise(o) { focused.value = o.id;if (o.z !== top) { update(o.id, { z: ++top });keep(); } }
function toggleMax(o) { update(o.id, { max: !o.max });keep(); }
function close(o) { emit('closeWindow', o.win);placed.value = placed.value.filter((x) => x.id !== o.id);keep(); }
function minimize(o) { mark(restored, o.id, false);mark(hidden, o.id, true);if (focused.value === o.id) focused.value = null;emit('minimize', o.win); }
// A Dock app: its window used last comes here, or the app is started (the page opens it).
function pick(a) {
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
function behind() { return shown.value.filter((o) => o.id !== focused.value).sort((a, b) => (b.z || 0) - (a.z || 0)).map((o) => ({ id: o.id, width: o.max ? (deskEl.value?.clientWidth || o.w) : o.w })); }
defineExpose({ place, behind });
// The window in front is live: the page lays its picture over this window's body, told again as
// the window moves or is resized (the corner that resizes it sits just outside).
function liveRect() {
  const o = shown.value.find((x) => x.id === focused.value);
  const el = o && deskEl.value?.querySelector(`.cp-win[data-id="${o.id}"] .cp-win-body`);
  if (!el) return null;
  const b = el.getBoundingClientRect(), d = deskEl.value.getBoundingClientRect();
  return { win: o.win, rect: { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }, desk: { left: Math.round(d.left), top: Math.round(d.top), width: Math.round(d.width), height: Math.round(d.height) } };
}
watch([focused, placed], () => nextTick(() => emit('live', liveRect())), { deep: true });
// The desk itself moved or resized (the browser window, the sidebar folded or opened): told again.
let sized = null;
watch(deskEl, (el) => { sized?.disconnect();sized = null;if (el && typeof ResizeObserver !== 'undefined') { sized = new ResizeObserver(() => { fitIn();emit('live', liveRect()); });sized.observe(el); } });
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
    y = Math.max(BAR, Math.min(y, Math.floor(b.height - 60)));
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
  if (drag.kind === 'move') update(drag.id, { x: Math.round(Math.min(Math.max(drag.ox + dx, -drag.ow + 80), b.w - 80)), y: Math.round(Math.min(Math.max(drag.oy + dy, BAR), b.h - 60)) });
  else {
    // Each side that moves keeps the window at least 240 × 160, within the desk and under its bar.
    const d = drag.edge, p = {};
    if (d.includes('e')) p.w = Math.round(Math.max(240, Math.min(drag.ow + dx, b.w - drag.ox)));
    if (d.includes('s')) p.h = Math.round(Math.max(160, Math.min(drag.oh + dy, b.h - drag.oy)));
    if (d.includes('w')) { const x = Math.min(Math.max(drag.ox + dx, 0), drag.ox + drag.ow - 240);p.x = Math.round(x);p.w = Math.round(drag.ow + drag.ox - x); }
    if (d.includes('n')) { const y = Math.min(Math.max(drag.oy + dy, BAR), drag.oy + drag.oh - 160);p.y = Math.round(y);p.h = Math.round(drag.oh + drag.oy - y); }
    update(drag.id, p);
  }
}
function dragEnd() { removeEventListener('pointermove', dragMove);if (drag) keep();drag = null; }
onBeforeUnmount(() => removeEventListener('pointermove', dragMove));
</script>
<style>
.cp-desk {position:relative;flex:1;min-height:0;overflow:hidden;background:radial-gradient(1200px 700px at 30% 20%, #253048, #0e1117 70%);-webkit-user-select:none;user-select:none;}
.cp-desk-top {position:absolute;left:0;right:0;top:0;z-index:9000;height:54px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:10px 16px;background:rgba(0,0,0,.92);}
.remote-stage .cp-desk-back {flex:0 0 auto;width:34px;height:34px;margin:0;padding:0;border:0;border-radius:17px;background:rgba(255,255,255,.12);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.cp-desk-name {min-width:0;font-size:18px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cp-desk-space {flex:1;min-width:0;display:flex;justify-content:flex-end;overflow:hidden;}
.cp-desk-stats {padding:0 4px;font-size:11px;color:#8e8e93;white-space:nowrap;font-variant-numeric:tabular-nums;}
.remote-stage .cp-desk-tool {flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;width:auto;height:34px;margin:0;padding:0 14px;border:0;border-radius:17px;background:rgba(255,255,255,.12);color:#fff;font-size:14px;cursor:pointer;}
.cp-win {position:absolute;display:flex;flex-direction:column;border-radius:12px;background:#1c1c1e;box-shadow:0 18px 50px rgba(0,0,0,.55), 0 0 0 .5px rgba(255,255,255,.18);}
.cp-win.focus {box-shadow:0 24px 70px rgba(0,0,0,.7), 0 0 0 1px rgba(10,132,255,.6);}
.cp-win.max {left:0 !important;top:54px !important;right:0;bottom:0;width:auto !important;height:auto !important;border-radius:0;}
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
.cp-dock {position:absolute;left:12px;top:calc(50% + 27px);transform:translateY(-50%);z-index:9000;display:flex;flex-direction:column;gap:8px;max-height:calc(100% - 94px);overflow-y:auto;scrollbar-width:none;padding:10px 8px;border-radius:22px;background:rgba(40,40,44,.6);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);box-shadow:0 0 0 .5px rgba(255,255,255,.25), 0 10px 40px rgba(0,0,0,.5);}
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
.cp-dock-app.running::after {content:'';position:absolute;left:-6px;top:50%;width:4px;height:4px;margin-top:-2px;border-radius:2px;background:#ddd;}
</style>
