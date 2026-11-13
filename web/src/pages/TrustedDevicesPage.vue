<template>
  <!-- The devices an admin trusts to open Remote without asking each time
       (server/services/trustedDevices.js): how long trust lasts, and removing them. -->
  <f7-page name="trusted" class="page-large-static" ptr :ptr-mousewheel="true" @ptr:refresh="refresh" @page:afterin="load">
    <f7-navbar :title="ct('信任的裝置')" :back-link="t('back')"></f7-navbar>
    <f7-block-title>{{ ct('信任多久') }}</f7-block-title>
    <f7-block class="trusted-days">
      <div class="segmented segmented-strong">
        <button v-for="d in options" :key="d" type="button" class="button" :class="{'button-active': d === days}" @click="setDays(d)">{{ d }} {{ ct('天') }}</button>
      </div>
      <p class="trusted-note">{{ ct('從最後一次用信任連線算起；每次連線都會重新計算。') }}</p>
    </f7-block>
    <f7-block-title>{{ ct('目前信任的裝置') }}</f7-block-title>
    <f7-block v-if="!devices.length" class="trusted-empty">{{ ct('還沒有信任的裝置。在那台裝置的「設定 › 帳號」打開「信任這台裝置」。') }}</f7-block>
    <f7-list v-else inset strong-ios class="trusted-list">
      <f7-list-item v-for="d in devices" :key="d.id" :title="d.label" :footer="footer(d)">
        <template #media><f7-icon :f7="/iPhone|Android|iPad/.test(d.label) ? 'device_phone_portrait' : 'desktopcomputer'" /></template>
        <template #after><a href="#" class="trusted-remove" @click.prevent="remove(d)">{{ ct('移除') }}</a></template>
      </f7-list-item>
    </f7-list>
    <f7-list v-if="devices.length" inset strong-ios>
      <f7-list-button color="red" class="trusted-remove-all" @click="removeAll">{{ ct('全部取消信任') }}</f7-list-button>
    </f7-list>
  </f7-page>
</template>

<script setup>
import { ref } from 'vue';
import { f7 } from 'framework7-vue';
import { t } from '../js/i18n.js';
import { ct } from '../js/text.js';
import { api } from '../js/api.js';

const days = ref(30), options = ref([30, 60, 90, 180]), devices = ref([]);
const day = (iso) => { const d = new Date(iso);return `${d.getMonth() + 1}/${d.getDate()}`; };
const footer = (d) => `${d.username ? d.username + ' · ' : ''}${ct('最後使用')} ${day(d.lastUsedAt)} · ${day(d.expiresAt)} ${ct('到期')}`;
async function load() {
  try { const r = await api('/remote/trusted');days.value = r.days;options.value = r.options || options.value;devices.value = r.devices || []; }
  catch (e) { f7.dialog.alert(e.message); }
}
async function refresh(done) { try { await load(); } finally { done(); } }
async function setDays(d) {
  try { days.value = (await api('/remote/trusted/days', { method: 'PUT', body: JSON.stringify({ days: d }) })).days; }
  catch (e) { f7.dialog.alert(e.message); }
}
function remove(d) {
  f7.dialog.confirm(ct('這台裝置之後連線要再驗證一次。'), ct('取消信任') + ' ' + d.label, async () => {
    try { await api(`/remote/trusted/${encodeURIComponent(d.id)}`, { method: 'DELETE' });await load(); } catch (e) { f7.dialog.alert(e.message); }
  });
}
function removeAll() {
  f7.dialog.confirm(ct('每一台裝置之後連線都要再驗證一次。'), ct('全部取消信任'), async () => {
    try { await api('/remote/trusted', { method: 'DELETE' });await load(); } catch (e) { f7.dialog.alert(e.message); }
  });
}
</script>

<style>
.trusted-days .segmented {max-width:420px;}
.trusted-note {margin:10px 0 0;font-size:13px;opacity:.65;}
.trusted-empty {font-size:14px;opacity:.7;}
.trusted-remove {color:var(--f7-color-red);font-size:15px;}
</style>
