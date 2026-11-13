<template>
  <!-- The home of a phone or tablet: the Mac's windows used last, then all its apps, as a
       phone's own home screen. The whole screen (the remote desktop) is at the bottom. -->
  <div class="remote-home">
    <div class="remote-home-head">
      <div class="remote-home-name">{{ name }}</div>
      <button type="button" class="remote-home-leave" @click="$emit('leave')">{{ ct('換一台 Mac') }}</button>
    </div>
    <div v-if="notice" class="remote-home-notice remote-notice-text">{{ notice }}</div>
    <div v-if="recent.length" class="remote-home-title">{{ ct('最近用的') }}</div>
    <div v-if="recent.length" class="remote-home-recent">
      <button v-for="w in recent" :key="w.id" type="button" class="remote-home-card" @click="$emit('open', w)">
        <img v-if="w.thumb" :src="w.thumb" alt=""/>
        <div v-else class="remote-home-blank"><img v-if="icons[w.bundle]" :src="icons[w.bundle]" alt=""/></div>
        <span>{{ w.app || w.title }}</span>
      </button>
    </div>
    <div class="remote-home-title">{{ ct('所有 App') }}</div>
    <div v-if="!apps.length" class="remote-home-empty">{{ ct('正在讀取…') }}</div>
    <div class="remote-home-apps">
      <button v-for="a in apps" :key="a.bundle" type="button" class="remote-home-app" :class="{running: a.running, launching: launching === a.bundle}" :data-bundle="a.bundle" @click="$emit('app', a)">
        <span class="remote-home-icon"><img v-if="icons[a.bundle]" :src="icons[a.bundle]" alt=""/></span>
        <span class="remote-home-label">{{ a.name }}</span>
      </button>
    </div>
    <button type="button" class="remote-home-desktop" @click="$emit('desktop')"><f7-icon f7="desktopcomputer" :size="18"/>{{ ct('整個螢幕（遠端桌面）') }}</button>
  </div>
</template>
<script setup>
import { ct } from '../js/text.js';
defineProps({ name: { type: String, default: '' }, recent: { type: Array, default: () => [] }, apps: { type: Array, default: () => [] }, icons: { type: Object, default: () => ({}) }, launching: { type: String, default: '' }, notice: { type: String, default: '' } });
defineEmits(['open', 'app', 'desktop', 'leave']);
</script>
<style>
.remote-home {flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 16px calc(env(safe-area-inset-bottom) + 16px);box-sizing:border-box;}
.remote-home-head {display:flex;align-items:center;justify-content:space-between;gap:12px;margin:4px 0 10px;}
.remote-home-name {font-size:20px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-stage .remote-home-leave {flex:0 0 auto;width:auto;height:32px;margin:0;padding:0 12px;border:0;border-radius:16px;background:rgba(255,255,255,.12);color:#fff;font-size:13px;cursor:pointer;}
.remote-home-notice {margin:8px 0;padding:10px 12px;border-radius:10px;background:rgba(255,69,58,.18);color:#fff;font-size:14px;}
.remote-home-title {margin:14px 0 8px;font-size:13px;color:#999;}
.remote-home-empty {font-size:14px;color:#888;}
.remote-home-recent {display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;padding-bottom:4px;}
.remote-stage .remote-home-card {flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:6px;width:96px;height:auto;margin:0;padding:0;border:0;background:none;color:#ddd;font-size:12px;cursor:pointer;}
.remote-home-card img {width:96px;height:132px;object-fit:cover;object-position:top;border-radius:12px;background:#2c2c2e;}
.remote-home-blank {width:96px;height:132px;border-radius:12px;background:#2c2c2e;display:flex;align-items:center;justify-content:center;}
.remote-home-card .remote-home-blank img {width:44px;height:44px;background:none;border-radius:0;}
.remote-home-card span {max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-home-apps {display:grid;grid-template-columns:repeat(auto-fill, minmax(72px, 1fr));gap:14px 8px;}
.remote-stage .remote-home-app {display:flex;flex-direction:column;align-items:center;gap:5px;width:auto;height:auto;margin:0;padding:0;border:0;background:none;color:#ddd;font-size:12px;cursor:pointer;position:relative;}
.remote-home-icon {width:56px;height:56px;border-radius:13px;background:#2c2c2e;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.remote-home-icon img {width:56px;height:56px;}
.remote-home-label {max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-home-app.running .remote-home-label::before {content:'';display:inline-block;width:5px;height:5px;border-radius:50%;background:#30d158;margin-right:4px;vertical-align:middle;}
.remote-home-app.launching .remote-home-icon {opacity:.5;animation:remote-home-pulse 1s ease-in-out infinite alternate;}
@keyframes remote-home-pulse {to {opacity:1;}}
.remote-stage .remote-home-desktop {display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;margin:22px 0 0;padding:0;border:0;border-radius:12px;background:rgba(255,255,255,.1);color:#fff;font-size:15px;cursor:pointer;}
</style>
