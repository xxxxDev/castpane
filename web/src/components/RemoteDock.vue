<template>
  <!-- The Mac's Dock at the left edge, as a pill: its apps (a dot under those running), then
       the windows put in the Dock. Opened by the handle (a slide from the edge is "back"). -->
  <div :class="docked ? 'remote-dock-rail' : 'remote-dock-layer'" @pointerdown.self="docked || $emit('close')">
    <div class="remote-dock" role="toolbar" :aria-label="ct('Dock')">
      <div v-if="!apps.length && !windows.length" class="remote-dock-empty">{{ ct('正在讀取…') }}</div>
      <button v-for="a in apps" :key="a.bundle" type="button" class="remote-dock-app" :class="{running: a.running}" :data-bundle="a.bundle" :title="a.name" :aria-label="a.name" @click="$emit('app', a)">
        <img v-if="icons[a.bundle]" :src="icons[a.bundle]" alt=""/>
        <span v-else class="remote-dock-letter">{{ (a.name || '?').slice(0, 1) }}</span>
      </button>
      <div v-if="windows.length" class="remote-dock-sep" aria-hidden="true"></div>
      <button v-for="w in windows" :key="w.id" type="button" class="remote-dock-window" :data-id="w.id" :title="w.title || w.app" :aria-label="w.title || w.app" @click="$emit('window', w)">
        <img v-if="w.thumb" :src="w.thumb" alt=""/>
        <img v-if="icons[w.bundle]" class="remote-dock-badge" :src="icons[w.bundle]" alt=""/>
      </button>
    </div>
  </div>
</template>
<script setup>
import { ct } from '../js/text.js';
// docked: kept open at the home's left, beside its cards, rather than over a window.
defineProps({ apps: { type: Array, default: () => [] }, windows: { type: Array, default: () => [] }, icons: { type: Object, default: () => ({}) }, docked: { type: Boolean, default: false } });
defineEmits(['app', 'window', 'close']);
</script>
<style>
.remote-dock-layer {position:absolute;inset:0;z-index:28;}
.remote-dock {position:absolute;left:8px;top:50%;transform:translateY(-50%);max-height:calc(100% - 24px);overflow-y:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px 8px;border-radius:36px;background:rgba(28,28,30,.92);border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 40px rgba(0,0,0,.6);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);}
.remote-dock::-webkit-scrollbar {display:none;}
.remote-dock-rail {flex:0 0 auto;display:flex;align-items:center;padding:8px 0 8px 8px;min-height:0;}
.remote-dock-rail .remote-dock {position:static;transform:none;max-height:100%;}
.remote-stage .remote-dock-app, .remote-stage .remote-dock-window {position:relative;flex:0 0 auto;width:52px;height:52px;margin:0;padding:0;border:0;background:none;cursor:pointer;}
.remote-dock-app img {width:52px;height:52px;}
.remote-dock-letter {display:flex;width:52px;height:52px;align-items:center;justify-content:center;border-radius:12px;background:#3a3a3c;color:#fff;font-size:20px;font-weight:600;}
.remote-dock-app.running::after {content:'';position:absolute;left:-6px;top:50%;width:4px;height:4px;margin-top:-2px;border-radius:50%;background:rgba(255,255,255,.85);}
.remote-dock-sep {width:40px;height:1px;flex:0 0 auto;background:rgba(255,255,255,.2);}
.remote-dock-window img:first-child {width:52px;height:40px;margin-top:6px;object-fit:cover;object-position:top;border-radius:6px;background:#000;}
.remote-dock-badge {position:absolute;right:-4px;bottom:-2px;width:22px;height:22px;}
.remote-dock-empty {padding:8px 4px;color:#999;font-size:12px;writing-mode:vertical-rl;}
.remote-dock-handle {position:absolute;left:0;top:50%;z-index:12;width:14px;height:72px;margin-top:-36px;padding:0;border:0;border-radius:0 8px 8px 0;background:rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:none;}
.remote-dock-handle span {width:4px;height:32px;border-radius:2px;background:rgba(255,255,255,.6);}
</style>
