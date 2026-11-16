<template>
  <!-- One app's windows, as a sheet from the bottom: the one shown now outlined, those in the
       Dock said so; a tap opens one (out of the Dock too). -->
  <div class="remote-windows" @pointerdown.self="$emit('close')">
    <div class="remote-windows-sheet" role="dialog" :aria-label="name">
      <div class="remote-windows-grab" aria-hidden="true"></div>
      <div class="remote-windows-head">
        <img v-if="icon" :src="icon" alt=""/>
        <b>{{ name }}</b>
        <span>{{ windows.length === 1 ? ct('1 個視窗') : ct('{n} 個視窗').replace('{n}', () => windows.length) }}</span>
        <button type="button" class="remote-windows-close" :title="ct('關閉')" :aria-label="ct('關閉')" @click="$emit('close')"><f7-icon f7="xmark" :size="14"/></button>
      </div>
      <div class="remote-windows-list">
        <button v-for="w in windows" :key="w.id" type="button" class="remote-windows-row" :class="{now: w.id === currentId}" :data-id="w.id" @click="$emit('pick', w)">
          <img v-if="w.thumb" :src="w.thumb" alt=""/>
          <span v-else class="remote-windows-blank"></span>
          <span class="remote-windows-text">
            <b>{{ w.title || name }}</b>
            <i>{{ where(w) }}</i>
          </span>
        </button>
      </div>
      <!-- The whole app, all its windows: asked first, as from its menu. -->
      <div v-if="canQuit" class="remote-windows-quits">
        <button type="button" class="remote-windows-quit" @click="$emit('quit')"><f7-icon f7="power" :size="17"/>{{ ct('結束 App') }}</button>
        <button type="button" class="remote-windows-quit force" @click="$emit('forceQuit')"><f7-icon f7="exclamationmark_octagon" :size="17"/>{{ ct('強制結束') }}</button>
      </div>
    </div>
  </div>
</template>
<script setup>
import { ct } from '../js/text.js';
defineProps({ name: { type: String, default: '' }, icon: { type: String, default: '' }, windows: { type: Array, default: () => [] }, currentId: { type: Number, default: null }, canQuit: { type: Boolean, default: false } });
defineEmits(['pick', 'close', 'quit', 'forceQuit']);
function where(w) {
  if (w.minimized) return ct('在 Dock 裡');
  if (w.desk?.fullscreen) return ct('全螢幕');
  return w.desk?.number ? ct('桌面 {n}').replace('{n}', () => w.desk.number) : '';
}
</script>
<style>
.remote-windows {position:absolute;inset:0;z-index:30;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;}
.remote-windows-sheet {width:100%;max-height:75%;display:flex;flex-direction:column;background:#1c1c1e;border-radius:18px 18px 0 0;padding:8px 16px calc(env(safe-area-inset-bottom) + 16px);box-sizing:border-box;color:#fff;}
.remote-windows-grab {width:38px;height:5px;border-radius:3px;background:rgba(255,255,255,.3);margin:0 auto 10px;}
.remote-windows-head {display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:17px;}
.remote-windows-head img {width:30px;height:30px;border-radius:7px;}
.remote-windows-head span {color:#999;font-size:14px;}
.remote-stage .remote-windows-close {margin:0 0 0 auto;width:30px;height:30px;padding:0;border:0;border-radius:15px;background:rgba(255,255,255,.12);color:#fff;display:flex;align-items:center;justify-content:center;}
.remote-windows-list {overflow-y:auto;-webkit-overflow-scrolling:touch;}
.remote-stage .remote-windows-row {display:flex;align-items:center;gap:12px;width:100%;height:auto;margin:0 0 10px;padding:10px;border:0;border-radius:12px;background:#2c2c2e;color:#fff;text-align:left;cursor:pointer;}
.remote-windows-row.now {outline:2px solid #0a84ff;}
.remote-windows-row img, .remote-windows-blank {flex:0 0 auto;width:104px;height:72px;object-fit:cover;object-position:top;border-radius:8px;background:#000;}
.remote-windows-text {min-width:0;}
.remote-windows-quits {flex:0 0 auto;display:flex;gap:10px;}
.remote-stage .remote-windows-quit {flex:1 1 0;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;margin:4px 0 0;padding:0;border:0;border-radius:12px;background:#2c2c2e;color:#ff6961;font-size:16px;cursor:pointer;}
.remote-windows-text b {display:block;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-windows-text i {display:block;font-style:normal;font-size:12px;color:#999;margin-top:3px;}
</style>
