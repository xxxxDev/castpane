<template>
  <!-- CastpaneOS: a computer's page as a desktop of the Mac's windows, each one a window here
       that is dragged by its bar, resized from its corner and brought to the front with a
       click; the Mac's Dock at the foot. Which windows are open here, where and how big, is
       kept on this device for each Mac. Their pictures are the Mac's thumbnails, read again
       every few seconds; a double click opens one live (stage 1 of .local/CASTPANEOS-PLAN). -->
  <div ref="deskEl" class="cp-desk" @pointerdown.self="focused = null">
    <div class="cp-desk-top">
      <button type="button" class="cp-desk-back" :title="ct('首頁')" :aria-label="ct('首頁')" @click="$emit('home')"><f7-icon f7="chevron_left" :size="16"/></button>
      <b class="cp-desk-name">{{ name }}</b>
      <span class="cp-desk-space"></span>
      <button type="button" class="cp-desk-tool" @click="$emit('all')"><f7-icon f7="square_grid_2x2" :size="14"/>{{ ct('所有 App') }}</button>
      <button type="button" class="cp-desk-tool" @click="$emit('desktop')"><f7-icon f7="desktopcomputer" :size="14"/>{{ ct('整個螢幕') }}</button>
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
      </div>
      <div class="cp-win-body" @dblclick="$emit('open', o.win)">
        <img v-if="o.win.thumb" :src="o.win.thumb" alt="" draggable="false"/>
        <div v-else class="cp-win-blank"><img v-if="icons[o.win.bundle]" :src="icons[o.win.bundle]" alt=""/></div>
        <span class="cp-win-hint">{{ ct('點兩下即時操作') }}</span>
      </div>
      <div v-if="!o.max" class="cp-win-grip" @pointerdown.stop="resizeStart($event, o)"></div>
    </div>
    <div v-if="!shown.length" class="cp-desk-empty">{{ ct('從下面的 Dock 打開 App，視窗會出現在這裡，可以拖動和縮放。') }}</div>
    <!-- The Mac's Dock: its apps (a dot under those running); a tap brings up the app's window here. -->
    <div class="cp-dock" role="toolbar" :aria-label="ct('Dock')">
      <button v-for="a in dockApps" :key="a.bundle" type="button" class="cp-dock-app" :class="{running: a.running}" :data-bundle="a.bundle" :title="a.name" :aria-label="a.name" @click="pick(a)">
        <img v-if="icons[a.bundle]" :src="icons[a.bundle]" alt=""/><span v-else>{{ (a.name || '?').slice(0, 1) }}</span>
      </button>
    </div>
  </div>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ct } from '../js/text.js';
const props = defineProps({ name: { type: String, default: '' }, machine: { type: String, default: '' }, windows: { type: Array, default: () => [] }, icons: { type: Object, default: () => ({}) }, dockApps: { type: Array, default: () => [] } });
const emit = defineEmits(['home', 'all', 'desktop', 'open', 'app', 'closeWindow', 'minimize']);
const deskEl = ref(null), focused = ref(null);
// The windows open here: {id, x, y, w, h, z, max}, kept for this Mac on this device.
const KEY = () => 'castpane-desk-' + (props.machine || 'local');
function read() { try { const v = JSON.parse(localStorage.getItem(KEY()) || '[]');return Array.isArray(v) ? v.filter((o) => Number.isFinite(o?.id)) : []; } catch { return []; } }
const placed = ref(read());
watch(() => props.machine, () => { placed.value = read(); });
function keep() { try { localStorage.setItem(KEY(), JSON.stringify(placed.value)); } catch { /* this time only */ } }
let top = Math.max(1, ...placed.value.map((o) => o.z || 1));
// Those of the Mac's windows still there (and not in its Dock); one gone is forgotten.
const byId = computed(() => new Map(props.windows.map((w) => [w.id, w])));
const shown = computed(() => placed.value.filter((o) => byId.value.get(o.id) && !byId.value.get(o.id).minimized).map((o) => ({ ...o, win: byId.value.get(o.id) })));
watch(byId, (m) => { const left = placed.value.filter((o) => m.has(o.id));if (left.length !== placed.value.length) { placed.value = left;keep(); } });
// A window brought here, cascaded from the last one, sized to its own shape within the desk.
function place(win) {
  const have = placed.value.find((o) => o.id === win.id);
  if (have) { raise(have);return; }
  const box = deskEl.value?.getBoundingClientRect() || { width: 1200, height: 800 };
  const room = { w: box.width - 40, h: box.height - 140 };
  const ratio = win.width && win.height ? win.width / win.height : 1.5;
  let w = Math.min(room.w * 0.6, 760), h = w / ratio;
  if (h > room.h * 0.75) { h = room.h * 0.75;w = h * ratio; }
  const n = placed.value.length % 6;
  const o = { id: win.id, x: 40 + n * 36, y: 54 + n * 30, w: Math.round(Math.max(260, w)), h: Math.round(Math.max(180, h) + 30), z: ++top, max: false };
  placed.value = [...placed.value, o];focused.value = o.id;keep();
}
function update(id, patch) { placed.value = placed.value.map((o) => (o.id === id ? { ...o, ...patch } : o)); }
function raise(o) { focused.value = o.id;if (o.z !== top) { update(o.id, { z: ++top });keep(); } }
function toggleMax(o) { update(o.id, { max: !o.max });keep(); }
function close(o) { emit('closeWindow', o.win);placed.value = placed.value.filter((x) => x.id !== o.id);keep(); }
function minimize(o) { emit('minimize', o.win); }
// A Dock app: its window used last comes here, or the app is started (the page opens it).
function pick(a) {
  const w = props.windows.find((x) => x.bundle === a.bundle && !x.minimized) || props.windows.find((x) => x.bundle === a.bundle);
  if (w) place(w);else emit('app', a);
}
defineExpose({ place });
// Dragging and resizing, kept within the desk.
let drag = null;
function bounds() { const b = deskEl.value?.getBoundingClientRect();return b ? { w: b.width, h: b.height } : { w: 1200, h: 800 }; }
function dragStart(e, o) {
  if (o.max || e.button > 0) return;
  drag = { kind: 'move', id: o.id, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, ow: o.w, oh: o.h };
  e.currentTarget.setPointerCapture?.(e.pointerId);
  addEventListener('pointermove', dragMove);addEventListener('pointerup', dragEnd, { once: true });
}
function resizeStart(e, o) {
  drag = { kind: 'size', id: o.id, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, ow: o.w, oh: o.h };
  addEventListener('pointermove', dragMove);addEventListener('pointerup', dragEnd, { once: true });
}
function dragMove(e) {
  if (!drag) return;
  const b = bounds(), dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (drag.kind === 'move') update(drag.id, { x: Math.round(Math.min(Math.max(drag.ox + dx, -drag.ow + 80), b.w - 80)), y: Math.round(Math.min(Math.max(drag.oy + dy, 40), b.h - 60)) });
  else update(drag.id, { w: Math.round(Math.max(240, Math.min(drag.ow + dx, b.w - drag.ox))), h: Math.round(Math.max(160, Math.min(drag.oh + dy, b.h - drag.oy))) });
}
function dragEnd() { removeEventListener('pointermove', dragMove);if (drag) keep();drag = null; }
onBeforeUnmount(() => removeEventListener('pointermove', dragMove));
</script>
<style>
.cp-desk {position:relative;flex:1;min-height:0;overflow:hidden;background:radial-gradient(1200px 700px at 30% 20%, #253048, #0e1117 70%);-webkit-user-select:none;user-select:none;}
.cp-desk-top {position:absolute;left:0;right:0;top:0;z-index:9000;height:40px;display:flex;align-items:center;gap:10px;padding:0 12px;background:rgba(20,20,22,.8);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,.08);}
.remote-stage .cp-desk-back {width:28px;height:28px;margin:0;padding:0;border:0;border-radius:14px;background:rgba(255,255,255,.12);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.cp-desk-name {font-size:14px;color:#fff;}
.cp-desk-space {flex:1;}
.remote-stage .cp-desk-tool {display:inline-flex;align-items:center;gap:6px;width:auto;height:28px;margin:0;padding:0 12px;border:0;border-radius:14px;background:rgba(255,255,255,.12);color:#fff;font-size:13px;cursor:pointer;}
.cp-win {position:absolute;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;background:#1c1c1e;box-shadow:0 18px 50px rgba(0,0,0,.55), 0 0 0 .5px rgba(255,255,255,.18);}
.cp-win.focus {box-shadow:0 24px 70px rgba(0,0,0,.7), 0 0 0 1px rgba(10,132,255,.6);}
.cp-win.max {left:0 !important;top:40px !important;right:0;bottom:0;width:auto !important;height:auto !important;border-radius:0;}
.cp-win-bar {flex:0 0 auto;height:30px;display:flex;align-items:center;gap:7px;padding:0 10px;background:rgba(40,40,44,.96);color:#fff;font-size:13px;cursor:grab;touch-action:none;}
.remote-stage .cp-light {width:12px;height:12px;margin:0;padding:0;border:0;border-radius:6px;cursor:pointer;}
.remote-stage .cp-light.close {background:#ff5f57;}
.remote-stage .cp-light.minimize {background:#febc2e;}
.remote-stage .cp-light.zoom {background:#28c840;}
.cp-win-bar img {width:16px;height:16px;margin-left:6px;}
.cp-win-title {margin-left:6px;color:#9a9a9f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cp-win-body {position:relative;flex:1;min-height:0;background:#000;cursor:default;}
.cp-win-body > img {width:100%;height:100%;object-fit:contain;object-position:top center;}
.cp-win-blank {width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
.cp-win-blank img {width:64px;height:64px;}
.cp-win-hint {position:absolute;right:8px;bottom:8px;padding:3px 8px;border-radius:10px;background:rgba(0,0,0,.55);color:#ddd;font-size:11px;opacity:0;transition:opacity .2s;}
.cp-win-body:hover .cp-win-hint {opacity:1;}
.cp-win-grip {position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;touch-action:none;}
.cp-win-grip::after {content:'';position:absolute;right:4px;bottom:4px;width:8px;height:8px;border-right:2px solid rgba(255,255,255,.4);border-bottom:2px solid rgba(255,255,255,.4);}
.cp-desk-empty {position:absolute;left:50%;top:45%;transform:translate(-50%,-50%);color:#9a9a9f;font-size:14px;}
.cp-dock {position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:9000;display:flex;gap:8px;max-width:calc(100% - 40px);overflow-x:auto;scrollbar-width:none;padding:8px 10px;border-radius:22px;background:rgba(40,40,44,.6);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);box-shadow:0 0 0 .5px rgba(255,255,255,.25), 0 10px 40px rgba(0,0,0,.5);}
.remote-stage .cp-dock-app {position:relative;flex:0 0 auto;width:48px;height:48px;margin:0;padding:0;border:0;background:none;cursor:pointer;}
.cp-dock-app img {width:48px;height:48px;}
.cp-dock-app span {display:flex;width:48px;height:48px;align-items:center;justify-content:center;border-radius:11px;background:#3a3a3c;color:#fff;font-weight:600;}
.cp-dock-app.running::after {content:'';position:absolute;left:50%;bottom:-6px;width:4px;height:4px;margin-left:-2px;border-radius:2px;background:#ddd;}
</style>
