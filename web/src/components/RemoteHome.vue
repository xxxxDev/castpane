<template>
  <!-- The Remote page's home: the apps open on the Mac, one card each (its windows stacked,
       their number on it: a tap then asks which one), as a phone's own app switcher. Every app is a button away, as Launchpad shows them;
       the whole screen (the remote desktop) is at the top, in reach without scrolling past
       every app. -->
  <div class="remote-home">
    <!-- A bar at the top, as the whole screen's: back to the list of Macs, this Mac, every app. -->
    <div class="remote-home-head">
      <button type="button" class="remote-home-back" :title="ct('中斷連線')" @click="$emit('leave')"><f7-icon f7="chevron_left" :size="18"/></button>
      <div class="remote-home-name">{{ name }}</div>
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
    <div v-if="!windows.length" class="remote-home-empty">{{ ct('正在讀取…') }}</div>
    <div v-else-if="!openApps.length" class="remote-home-empty">{{ ct('這裡沒有 App') }}</div>
    <div class="remote-home-open" :class="{one: cols === 1}">
      <div v-for="o in openApps" :key="o.key" role="button" tabindex="0" class="remote-home-card" :class="{launching: launching && launching === o.bundle}" :data-bundle="o.bundle" @click="o.count > 1 ? $emit('windows', o.key) : o.window ? $emit('open', o.window) : $emit('app', o.app)" @keydown.enter.self.prevent="o.count > 1 ? $emit('windows', o.key) : o.window ? $emit('open', o.window) : $emit('app', o.app)" @keydown.space.self.prevent="o.count > 1 ? $emit('windows', o.key) : o.window ? $emit('open', o.window) : $emit('app', o.app)">
        <span class="remote-home-shot">
          <!-- A Mac window's buttons, as macOS draws them, at the top left: red closes the window on
               top, yellow puts it in the Dock, green holds the number of windows. -->
          <button v-if="o.window" type="button" class="light close" :title="ct('關閉視窗')" :aria-label="ct('關閉視窗')" @click.stop="$emit('closeWindow', o.window)"><f7-icon f7="xmark" :size="13"/></button>
          <button v-if="o.window && canMinimize && !o.window.minimized" type="button" class="light minimize" :title="ct('縮到 Dock')" :aria-label="ct('縮到 Dock')" @click.stop="$emit('minimize', o.window)"><f7-icon f7="minus" :size="13"/></button>
          <img v-if="o.window?.thumb" :src="o.window.thumb" alt=""/>
          <img v-else-if="icons[o.bundle]" class="remote-home-shot-icon" :src="icons[o.bundle]" alt=""/>
          <span v-if="o.window" class="remote-home-count" :aria-label="o.count > 1 ? ct('{n} 個視窗').replace('{n}', () => o.count) : null">{{ o.count > 1 ? o.count : '' }}</span>
        </span>
        <span class="remote-home-label">{{ o.name }}</span>
      </div>
    </div>

    </div>
    </div>

    <!-- Every app, as the Mac's Apps window: a panel over the home, searched at the top, the
         apps running first, then every app in a grid that scrolls; a tap starts it. -->
    <div v-if="allOpen" class="remote-launchpad" @click.self="allOpen = false">
      <div class="remote-launchpad-panel" role="dialog" :aria-label="ct('所有 App')">
        <div class="remote-launchpad-top">
          <f7-icon f7="search" :size="17" class="remote-launchpad-glass"/>
          <input v-model="query" class="remote-launchpad-search" type="search" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" :placeholder="ct('搜尋 App')">
          <button type="button" class="remote-launchpad-close" :title="ct('關閉')" @click="allOpen = false"><f7-icon f7="xmark" :size="15"/></button>
        </div>
        <div ref="pagesEl" class="remote-launchpad-body">
          <template v-if="!query.trim() && running.length">
            <div class="remote-launchpad-grid remote-launchpad-running" :style="{gridTemplateColumns: `repeat(${fitted.cols}, 1fr)`}">
              <button v-for="a in running" :key="a.bundle" type="button" class="remote-home-app running" :class="{launching: launching === a.bundle}" :data-bundle="a.bundle" @click="pick(a)">
                <span class="remote-home-icon"><img v-if="icons[a.bundle]" :src="icons[a.bundle]" alt=""/></span>
                <span class="remote-home-applabel">{{ a.name }}</span>
              </button>
            </div>
            <div class="remote-launchpad-sep"></div>
          </template>
          <div class="remote-launchpad-grid remote-launchpad-all" :style="{gridTemplateColumns: `repeat(${fitted.cols}, 1fr)`}">
            <button v-for="a in shown" :key="a.bundle" type="button" class="remote-home-app" :class="{running: a.running, launching: launching === a.bundle}" :data-bundle="a.bundle" @click="pick(a)">
              <span class="remote-home-icon"><img v-if="icons[a.bundle]" :src="icons[a.bundle]" alt=""/></span>
              <span class="remote-home-applabel">{{ a.name }}</span>
            </button>
          </div>
          <div v-if="!shown.length" class="remote-launchpad-none">{{ ct('沒有符合的 App') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ct } from '../js/text.js';
const props = defineProps({ name: { type: String, default: '' }, windows: { type: Array, default: () => [] }, apps: { type: Array, default: () => [] }, icons: { type: Object, default: () => ({}) }, launching: { type: String, default: '' }, notice: { type: String, default: '' }, canMinimize: { type: Boolean, default: false } });
// windows: an app with several windows, whose card asks which one (RemoteWindows.vue).
const emit = defineEmits(['open', 'app', 'desktop', 'leave', 'all', 'windows', 'closeWindow', 'minimize']);
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
const allOpen = ref(false), query = ref(''), pagesEl = ref(null);
watch(allOpen, (on) => { if (on) emit('all'); query.value = ''; });
// As many columns as the panel's width holds, four at the least.
const fitted = ref({ cols: 4 });
let sized = null;
watch(pagesEl, (el) => {
  sized?.disconnect();sized = null;
  if (!el || typeof ResizeObserver === 'undefined') return;
  sized = new ResizeObserver(() => { const w = el.clientWidth;if (w) fitted.value = { cols: Math.max(4, Math.floor((w - 24) / 84)) }; });
  sized.observe(el);
});
onBeforeUnmount(() => sized?.disconnect());
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? props.apps.filter((a) => a.name.toLowerCase().includes(q)) : props.apps;
});
// The apps running, first, as the Mac's window puts its most used: one row's worth.
const running = computed(() => props.apps.filter((a) => a.running).slice(0, fitted.value.cols));
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
/* The Mac's window buttons, as macOS draws them, together at the top left: a red dot (close),
   a yellow one (into the Dock), a green one holding the number of windows. Each in an area a
   finger can hit, which shows nothing itself. */
.remote-stage .remote-home-shot .light {position:absolute;top:2px;z-index:1;width:26px;height:36px;margin:0;padding:0;border:0;border-radius:13px;background:none;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.remote-stage .remote-home-shot .light::before, .remote-home-count {content:'';width:16px;height:16px;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.25),0 1px 3px rgba(0,0,0,.45);}
.remote-stage .remote-home-shot .light .icon {display:none;}
.remote-stage .remote-home-shot .light.close {left:3px;}
.remote-stage .remote-home-shot .light.close::before {background:radial-gradient(circle at 50% 35%, #ff7b74, #ec5a52 70%);}
.remote-stage .remote-home-shot .light.minimize {left:27px;}
.remote-stage .remote-home-shot .light.minimize::before {background:radial-gradient(circle at 50% 35%, #ffd34d, #f5b81c 70%);}
.remote-home-empty {font-size:14px;color:#888;}
.remote-home-open {display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:14px 12px;}
/* A tablet or a computer: as many as fit, two at the least. */
@media (min-width: 700px) { .remote-home-open:not(.one) {grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));} }
.remote-stage .remote-home-card {display:flex;flex-direction:column;align-items:stretch;gap:6px;width:auto;height:auto;margin:0;padding:0;border:0;background:none;color:#ddd;font-size:13px;cursor:pointer;text-align:center;}
.remote-home-shot {position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;border-radius:18px;background:#2c2c2e;overflow:hidden;}
.remote-home-shot img {width:100%;height:100%;object-fit:cover;object-position:top;}
.remote-home-shot img.remote-home-shot-icon {width:56px;height:56px;object-fit:contain;}
.remote-home-count {position:absolute;top:12px;left:56px;z-index:1;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 35%, #5fd86a, #29b53b 70%);color:rgba(0,0,0,.7);font-size:10px;font-weight:700;line-height:1;}
.remote-home-label {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-home-card.launching .remote-home-shot, .remote-home-app.launching .remote-home-icon {opacity:.5;animation:remote-home-pulse 1s ease-in-out infinite alternate;}
@keyframes remote-home-pulse {to {opacity:1;}}
.remote-stage .remote-home-desktop {display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;margin:4px 0 0;padding:0;border:0;border-radius:100px;color:#fff;font-size:15px;cursor:pointer;}
.remote-launchpad {position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.35);display:flex;padding:calc(env(safe-area-inset-top) + 10px) 10px calc(env(safe-area-inset-bottom) + 10px);box-sizing:border-box;}
.remote-launchpad-panel {flex:1;min-height:0;display:flex;flex-direction:column;border-radius:28px;overflow:hidden;background:rgba(40,40,44,.72);-webkit-backdrop-filter:saturate(180%) blur(30px);backdrop-filter:saturate(180%) blur(30px);box-shadow:rgba(255,255,255,.35) 0 0 1px 0 inset,rgba(255,255,255,.25) 1px 1px 2px -1px inset,0 20px 60px rgba(0,0,0,.6);}
.remote-launchpad-top {flex:0 0 auto;display:flex;gap:10px;align-items:center;margin:0 16px;padding:14px 0 12px;border-bottom:1px solid rgba(255,255,255,.12);}
.remote-launchpad-glass {color:#aaa;}
.remote-launchpad-search {flex:1;min-width:0;height:34px;box-sizing:border-box;padding:0;border:0;background:none;color:#fff;font-size:20px;font-weight:600;outline:none;}
.remote-launchpad-search::placeholder {color:rgba(255,255,255,.45);}
.remote-stage .remote-launchpad-close {flex:0 0 auto;width:30px;height:30px;margin:0;padding:0;border:0;border-radius:15px;background:rgba(255,255,255,.12);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.remote-launchpad-body {flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 12px 20px;box-sizing:border-box;}
.remote-launchpad-grid {display:grid;grid-template-columns:repeat(4, 1fr);gap:16px 6px;align-content:start;}
.remote-launchpad-sep {height:1px;margin:16px 4px;background:rgba(255,255,255,.12);}
.remote-launchpad-none {padding:24px 0;text-align:center;color:#999;font-size:14px;}
.remote-stage .remote-home-app {display:flex;flex-direction:column;align-items:center;gap:5px;width:auto;height:auto;margin:0;padding:0;border:0;background:none;color:#ddd;font-size:12px;cursor:pointer;}
.remote-home-icon {width:56px;height:56px;border-radius:13px;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.remote-home-icon img {width:56px;height:56px;}
.remote-home-applabel {max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-home-app.running .remote-home-applabel::before {content:'';display:inline-block;width:5px;height:5px;border-radius:50%;background:#30d158;margin-right:4px;vertical-align:middle;}
</style>
