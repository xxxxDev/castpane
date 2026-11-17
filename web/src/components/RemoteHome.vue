<template>
  <!-- The Remote page's home: the apps open on the Mac, one card each (its windows stacked,
       their number on it: a tap then asks which one), as a phone's own app switcher. Every app is a button away, as Launchpad shows them;
       the whole screen (the remote desktop) is at the top, in reach without scrolling past
       every app. -->
  <div ref="homeEl" class="remote-home">
    <!-- A bar at the top, as the whole screen's: back to the list of Macs, this Mac, every app. -->
    <div class="remote-home-head">
      <button type="button" class="remote-home-back" :title="ct('中斷連線')" @click="$emit('leave')"><f7-icon f7="chevron_left" :size="18"/></button>
      <div class="remote-home-name">{{ name }}</div>
      <button v-if="os" type="button" class="remote-home-all remote-home-os" @click="$emit('os')"><f7-icon f7="rectangle_on_rectangle" :size="15"/>CastpaneOS</button>
      <button type="button" class="remote-home-all" @click="allOpen = true"><f7-icon f7="square_grid_2x2" :size="15"/>{{ ct('所有 App') }}</button>
    </div>
    <!-- Under the bar: the Mac's Dock at the left (the page's slot), the apps beside it. -->
    <div class="remote-home-body">
    <slot name="dock"/>
    <div class="remote-home-scroll">
    <div v-if="notice" class="remote-home-notice">{{ notice }}</div>
    <button type="button" class="remote-home-desktop" @click="$emit('desktop')"><f7-icon f7="desktopcomputer" :size="18"/>{{ ct('整個螢幕（遠端桌面）') }}</button>
    <div class="remote-home-title">
      <!-- Which apps: those with a window on a desktop, those put in the Dock, or both. -->
      <span class="remote-home-filter" role="tablist" :aria-label="ct('開著的 App')">
        <button v-for="f in FILTERS.filter((x) => canMinimize || x.id === 'all')" :key="f.id" type="button" role="tab" :class="['filter-' + f.id, {on: filter === f.id}]" :aria-selected="filter === f.id" @click="setFilter(f.id)">{{ ct(f.label) }}</button>
      </span>
      <!-- Two a row or one: kept on this device. -->
      <span class="remote-home-cols" role="group" :aria-label="ct('排列')">
        <button type="button" class="cols-2" :class="{on: cols === 2}" :title="ct('一列兩個')" :aria-label="ct('一列兩個')" :aria-pressed="cols === 2" @click="setCols(2)"><f7-icon f7="square_grid_2x2" :size="15"/></button>
        <button type="button" class="cols-1" :class="{on: cols === 1}" :title="ct('一列一個')" :aria-label="ct('一列一個')" :aria-pressed="cols === 1" @click="setCols(1)"><f7-icon f7="rectangle_grid_1x2" :size="15"/></button>
      </span>
    </div>
    <!-- Loading only until the Mac's first list: a Mac with no app window open says so. -->
    <div v-if="!listed && !windows.length" class="remote-home-empty">{{ ct('正在讀取…') }}</div>
    <div v-else-if="!openApps.length" class="remote-home-empty">{{ windows.length || filter !== 'all' ? ct('這裡沒有 App') : ct('這台 Mac 沒有開著的 App 視窗。從 Dock 或「所有 App」打開一個。') }}</div>
    <div class="remote-home-open" :class="{one: cols === 1}">
      <div v-for="o in openApps" :key="o.key" role="button" tabindex="0" class="remote-home-card" :class="{launching: launching && launching === o.bundle}" :data-bundle="o.bundle" @pointerdown="holdDown($event, o)" @pointermove="holdMove" @pointerup="holdEnd" @pointercancel="holdEnd" @contextmenu.prevent="rightClick($event, o)" @click="held ? (held = false) : o.count > 1 ? $emit('windows', o.key) : o.window ? $emit('open', o.window) : $emit('app', o.app)" @keydown.enter.self.prevent="o.count > 1 ? $emit('windows', o.key) : o.window ? $emit('open', o.window) : $emit('app', o.app)" @keydown.space.self.prevent="o.count > 1 ? $emit('windows', o.key) : o.window ? $emit('open', o.window) : $emit('app', o.app)">
        <span class="remote-home-shot">
          <img v-if="o.window?.thumb" :src="o.window.thumb" alt=""/>
          <img v-else-if="icons[o.bundle]" class="remote-home-shot-icon" :src="icons[o.bundle]" alt=""/>
          <!-- The number of windows at the top right; held, the window on top's menu. -->
          <span v-if="o.count > 1" class="remote-home-count" :aria-label="ct('{n} 個視窗').replace('{n}', () => o.count)">{{ o.count }}</span>
        </span>
        <span class="remote-home-label">{{ o.name }}</span>
      </div>
    </div>

    </div>
    </div>

    <!-- A card held: its window on top put in the Dock, or closed. -->
    <div v-if="menu" class="remote-home-menu-layer" @pointerdown.self="menu = null">
      <div class="remote-home-menu" :style="{left: menu.x + 'px', top: menu.y + 'px'}">
        <button v-if="canMinimize && !menu.w.minimized" type="button" class="minimize" @click="$emit('minimize', menu.w);menu = null">{{ ct('縮到 Dock') }}</button>
        <button type="button" class="close-window" @click="$emit('closeWindow', menu.w);menu = null">{{ ct('關閉視窗') }}</button>
      </div>
    </div>

    <AppsPanel v-if="allOpen" :apps="apps" :icons="icons" :launching="launching" @close="allOpen = false" @pick="pick"/>
  </div>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ct } from '../js/text.js';
import AppsPanel from './AppsPanel.vue';
const props = defineProps({ name: { type: String, default: '' }, windows: { type: Array, default: () => [] }, apps: { type: Array, default: () => [] }, icons: { type: Object, default: () => ({}) }, launching: { type: String, default: '' }, notice: { type: String, default: '' }, canMinimize: { type: Boolean, default: false }, allAsked: { type: Number, default: 0 }, os: { type: Boolean, default: false }, listed: { type: Boolean, default: false } });
// windows: an app with several windows, whose card asks which one (RemoteWindows.vue).
const emit = defineEmits(['open', 'app', 'desktop', 'leave', 'all', 'windows', 'closeWindow', 'minimize', 'allTaken', 'os']);
const COLS_KEY = 'castpane-home-cols';
const cols = ref((() => { try { return localStorage.getItem(COLS_KEY) === '1' ? 1 : 2; } catch { return 2; } })());
function setCols(n) { cols.value = n;try { localStorage.setItem(COLS_KEY, String(n)); } catch { /* this time only */ } }
// One card an app with a window open, its window used last on top. Apps running with no
// window (helpers in the background, menu-bar apps) are left to All apps.
const FILTERS = [{ id: 'all', label: '全部' }, { id: 'desk', label: '桌面上' }, { id: 'dock', label: 'Dock 裡' }];
const FILTER_KEY = 'castpane-home-filter';
const filter = ref((() => { try { const f = localStorage.getItem(FILTER_KEY);return FILTERS.some((x) => x.id === f) ? f : 'all'; } catch { return 'all'; } })());
function setFilter(f) { filter.value = f;try { localStorage.setItem(FILTER_KEY, f); } catch { /* this time only */ } }
const openApps = computed(() => {
  const seen = new Map();
  // A Mac that cannot say which windows are in the Dock shows all of them.
  const f = props.canMinimize ? filter.value : 'all';
  const wanted = (w) => f === 'all' || (f === 'dock' ? !!w.minimized : !w.minimized);
  for (const w of props.windows.filter(wanted)) {
    const key = w.bundle || w.app || String(w.id);
    if (seen.has(key)) seen.get(key).count++;
    else seen.set(key, { key, bundle: w.bundle || '', name: w.app || w.title, window: w, count: 1 });
  }
  return [...seen.values()];
});
// Held half a second without moving by touch, or a right click with a mouse: the card's menu
// instead of a tap.
const menu = ref(null), homeEl = ref(null);
let held = false, holdAt = null, holdTimer = 0;
function rightClick(e, o) {
  if (!o.window) return;
  clearTimeout(holdTimer);holdAt = null;
  const home = homeEl.value?.getBoundingClientRect() || { left: 0, top: 0, width: innerWidth, height: innerHeight };
  menu.value = { w: o.window, x: Math.max(8, Math.min(e.clientX - home.left, home.width - 208)), y: Math.max(8, Math.min(e.clientY - home.top, home.height - 110)) };
}
function holdDown(e, o) {
  // A mouse has its right click for this: a long left press is no menu.
  if (!o.window || e.pointerType === 'mouse') return;
  holdAt = { x: e.clientX, y: e.clientY };held = false;clearTimeout(holdTimer);
  const el = e.currentTarget;
  holdTimer = setTimeout(() => {
    held = true;holdAt = null;
    const box = el.getBoundingClientRect(), home = homeEl.value?.getBoundingClientRect() || { left: 0, top: 0, width: innerWidth, height: innerHeight };
    menu.value = { w: o.window, x: Math.max(8, Math.min(box.left - home.left + 12, home.width - 208)), y: Math.min(box.top - home.top + 40, home.height - 110) };
  }, 500);
}
function holdMove(e) { if (holdAt && Math.hypot(e.clientX - holdAt.x, e.clientY - holdAt.y) > 10) { clearTimeout(holdTimer);holdAt = null; } }
function holdEnd() { clearTimeout(holdTimer);holdAt = null; }
onBeforeUnmount(() => clearTimeout(holdTimer));
const allOpen = ref(false);
// The Mac's Apps or Launchpad tapped in the Dock: All apps opens.
watch(() => props.allAsked, (n) => { if (n) { allOpen.value = true;emit('allTaken'); } }, { immediate: true });
watch(allOpen, (on) => { if (on) emit('all'); });
// As many columns as the panel's width holds, four at the least.
function pick(a) { allOpen.value = false;emit('app', a); }
</script>
<style>
.remote-home {position:relative;flex:1;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;}
.remote-home-body {flex:1;min-height:0;display:flex;}
.remote-home-scroll {flex:1;min-width:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 16px calc(env(safe-area-inset-bottom) + 16px);box-sizing:border-box;}
/* Capsules throughout. Glass only on what floats over a window (the cards' buttons, the count)
   and on the Dock; the rest plain fills, so the page is not all glass. */
.remote-home-head {flex:0 0 auto;z-index:2;display:flex;align-items:center;gap:8px;padding:10px 16px;background:rgba(0,0,0,.92);}
.remote-stage .remote-home-back, .remote-stage .remote-home-all, .remote-stage .remote-home-desktop, .remote-home-filter, .remote-home-cols {background:rgba(255,255,255,.12);}
.remote-stage .remote-home-back {flex:0 0 auto;width:34px;height:34px;margin:0;padding:0;border:0;border-radius:17px;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.remote-home-name {flex:1;min-width:0;font-size:18px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-stage .remote-home-all {flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;width:auto;height:34px;margin:0;padding:0 14px;border:0;border-radius:17px;color:#fff;font-size:14px;cursor:pointer;}
.remote-home-notice {margin:8px 0;padding:10px 12px;border-radius:10px;background:rgba(255,69,58,.18);color:#fff;font-size:14px;}
.remote-home-title {display:flex;align-items:center;justify-content:space-between;margin:14px 0 10px;font-size:13px;color:#999;}
.remote-home-filter {display:inline-flex;gap:2px;padding:3px;border-radius:100px;}
.remote-stage .remote-home-filter button {height:26px;margin:0;padding:0 11px;white-space:nowrap;border:0;border-radius:100px;background:none;color:#999;font-size:12px;cursor:pointer;}
.remote-stage .remote-home-filter button.on {background:rgba(255,255,255,.22);color:#fff;}
.remote-home-cols {display:inline-flex;gap:2px;padding:3px;border-radius:100px;}
.remote-stage .remote-home-cols button {width:34px;height:26px;margin:0;padding:0;border:0;border-radius:100px;background:none;color:#999;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.remote-stage .remote-home-cols button.on {background:rgba(255,255,255,.22);color:#fff;}
.remote-home-open.one {grid-template-columns:1fr;}
.remote-home-open.one .remote-home-shot {aspect-ratio:16/10;}
.remote-home-menu-layer {position:absolute;inset:0;z-index:15;}
.remote-home-menu {position:absolute;width:200px;padding:4px;border-radius:14px;background:rgba(44,44,46,.98);box-shadow:0 10px 40px rgba(0,0,0,.6);}
.remote-stage .remote-home-menu button {display:block;width:100%;height:42px;margin:0;padding:0 12px;border:0;border-radius:10px;background:none;color:#fff;font-size:15px;text-align:left;cursor:pointer;}
.remote-stage .remote-home-menu button.close-window {color:#ff6961;}
.remote-home-empty {font-size:14px;color:#888;}
.remote-home-open {display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:14px 12px;}
/* A tablet or a computer: as many as fit, two at the least. */
/* A tablet or a computer: the two sizes are small and large cards, as many as fit (on a
   phone, two a row or one). */
@media (min-width: 700px) {
  .remote-home-open:not(.one) {grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));}
  .remote-home-open.one {grid-template-columns:repeat(auto-fill, minmax(460px, 1fr));}
  .remote-home-open.one .remote-home-shot {aspect-ratio:4/3;}
}
.remote-stage .remote-home-card {-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;display:flex;flex-direction:column;align-items:stretch;gap:6px;width:auto;height:auto;margin:0;padding:0;border:0;background:none;color:#ddd;font-size:13px;cursor:pointer;text-align:center;}
.remote-home-shot {position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;border-radius:18px;background:#2c2c2e;overflow:hidden;}
.remote-home-shot img {width:100%;height:100%;object-fit:cover;object-position:top;}
.remote-home-shot img.remote-home-shot-icon {width:56px;height:56px;object-fit:contain;}
.remote-home-count {position:absolute;top:6px;right:6px;z-index:1;min-width:22px;height:22px;padding:0 7px;border-radius:100px;box-sizing:border-box;background:rgba(30,30,32,.55);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:rgba(255,255,255,.4) 0 0 1px 0 inset;color:#fff;font-size:12px;line-height:22px;text-align:center;}
.remote-home-label {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-home-card.launching .remote-home-shot, .remote-home-app.launching .remote-home-icon {opacity:.5;animation:remote-home-pulse 1s ease-in-out infinite alternate;}
@keyframes remote-home-pulse {to {opacity:1;}}
.remote-stage .remote-home-desktop {display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;margin:4px 0 0;padding:0;border:0;border-radius:100px;color:#fff;font-size:15px;cursor:pointer;}
.remote-stage .remote-home-app {display:flex;flex-direction:column;align-items:center;gap:5px;width:auto;height:auto;margin:0;padding:0;border:0;background:none;color:#ddd;font-size:12px;cursor:pointer;}
.remote-home-icon {width:56px;height:56px;border-radius:13px;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.remote-home-icon img {width:56px;height:56px;}
.remote-home-applabel {max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-home-app.running .remote-home-applabel::before {content:'';display:inline-block;width:5px;height:5px;border-radius:50%;background:#30d158;margin-right:4px;vertical-align:middle;}
</style>
