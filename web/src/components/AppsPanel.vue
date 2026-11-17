<template>
  <!-- Every app, as the Mac's Apps window: a panel over the home, searched at the top, the
       apps running first, then every app in a grid that scrolls; a tap starts it. -->
  <div class="remote-launchpad" @click.self="$emit('close')">
    <div class="remote-launchpad-panel" role="dialog" :aria-label="ct('所有 App')">
      <div class="remote-launchpad-top">
        <f7-icon f7="search" :size="17" class="remote-launchpad-glass"/>
        <input v-model="query" class="remote-launchpad-search" type="search" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" :placeholder="ct('搜尋 App')">
        <button type="button" class="remote-launchpad-close" :title="ct('關閉')" @click="$emit('close')"><f7-icon f7="xmark" :size="15"/></button>
      </div>
      <div ref="pagesEl" class="remote-launchpad-body">
        <template v-if="!query.trim() && running.length">
          <div class="remote-launchpad-grid remote-launchpad-running" :style="{gridTemplateColumns: `repeat(${fitted.cols}, 1fr)`}">
            <button v-for="a in running" :key="a.bundle" type="button" class="remote-home-app running" :class="{launching: launching === a.bundle}" :data-bundle="a.bundle" @click="$emit('pick', a)">
              <span class="remote-home-icon"><img v-if="icons[a.bundle]" :src="icons[a.bundle]" alt=""/></span>
              <span class="remote-home-applabel">{{ a.name }}</span>
            </button>
          </div>
          <div class="remote-launchpad-sep"></div>
        </template>
        <div class="remote-launchpad-grid remote-launchpad-all" :style="{gridTemplateColumns: `repeat(${fitted.cols}, 1fr)`}">
          <button v-for="a in shown" :key="a.bundle" type="button" class="remote-home-app" :class="{running: a.running, launching: launching === a.bundle}" :data-bundle="a.bundle" @click="$emit('pick', a)">
            <span class="remote-home-icon"><img v-if="icons[a.bundle]" :src="icons[a.bundle]" alt=""/></span>
            <span class="remote-home-applabel">{{ a.name }}</span>
          </button>
        </div>
        <div v-if="!shown.length" class="remote-launchpad-none">{{ ct('沒有符合的 App') }}</div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ct } from '../js/text.js';
const props = defineProps({ apps: { type: Array, default: () => [] }, icons: { type: Object, default: () => ({}) }, launching: { type: String, default: '' } });
defineEmits(['close', 'pick']);
const query = ref(''), pagesEl = ref(null);
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
</script>
<style>
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
/* Over CastpaneOS's desk and its live window. */
.remote-launchpad.cp-apps {z-index:9500;}
/* On a computer a window of its own, as the Mac's: centred, not the whole page. */
@media (min-width: 900px) and (hover: hover) {
  .remote-launchpad {align-items:center;justify-content:center;padding:40px;}
  .remote-launchpad-panel {flex:0 1 auto;width:min(860px, 100%);height:min(720px, 100%);}
}
</style>
