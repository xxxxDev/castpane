<template>
  <!-- The account's login-key phones and signed-in devices (QR sign-in):
       each can be removed or signed out from here. -->
  <f7-page name="devices" class="page-large-static" ptr :ptr-mousewheel="true" @ptr:refresh="refresh" @page:afterin="load">
    <f7-navbar :title="ct('裝置')" :back-link="t('back')"></f7-navbar>
    <f7-block-title>{{ ct('可核准登入的手機') }}</f7-block-title>
    <f7-block v-if="!devices.length" class="devices-empty">{{ ct('還沒有綁定的手機') }}</f7-block>
    <f7-list v-else inset strong-ios class="login-keys">
      <f7-list-item v-for="d in devices" :key="d.id" :title="d.name" :footer="keyFooter(d)">
        <template #media><f7-icon f7="device_phone_portrait" /></template>
        <template #after><span v-if="d.id === mine" class="this-one">{{ ct('這支') }}</span><a v-else href="#" class="device-remove" @click.prevent="removeKey(d)">{{ ct('解除') }}</a></template>
      </f7-list-item>
    </f7-list>
    <f7-block-title>{{ ct('登入中的裝置') }}</f7-block-title>
    <f7-list inset strong-ios class="sessions">
      <f7-list-item v-for="s in sessions" :key="s.id" :title="sessionTitle(s)" :footer="sessionFooter(s)">
        <template #media><f7-icon :f7="/iPhone|Android|iPad/.test(s.userAgent) ? 'device_phone_portrait' : 'desktopcomputer'" /></template>
        <template #after><span v-if="s.current" class="this-one">{{ ct('目前這台') }}</span><a v-else href="#" class="session-out" @click.prevent="signOut(s)">{{ ct('登出') }}</a></template>
      </f7-list-item>
    </f7-list>
  </f7-page>
</template>

<script setup>
import { ref } from 'vue';
import { f7 } from 'framework7-vue';
import { t } from '../js/i18n.js';
import { ct } from '../js/text.js';
import { listDevices, removeDevice, signOutSession, loginKey, describeAgent } from '../js/qrLogin.js';

const devices = ref([]), sessions = ref([]), mine = ref(loginKey()?.id || null);
const day = (iso) => { if (!iso) return ''; const d = new Date(iso);return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const keyFooter = (d) => `${day(d.createdAt)} ${ct('綁定')}${d.lastUsedAt ? ' · ' + ct('上次使用') + ' ' + day(d.lastUsedAt) : ''}`;
const sessionTitle = (s) => (s.userAgent ? describeAgent(s.userAgent) : ct('較早登入的裝置'));
const sessionFooter = (s) => `${s.method === 'qr' ? ct('掃碼登入') : s.method === 'passkey' ? ct('通行密鑰登入') : ct('密碼登入')}${s.createdAt ? ' · ' + day(s.createdAt) : ''}${s.lastSeen ? ' · ' + ct('最近') + ' ' + day(s.lastSeen) : ''}`;
async function load() {
  try { const r = await listDevices();devices.value = r.devices || [];sessions.value = r.sessions || [];mine.value = loginKey()?.id || null; }
  catch (e) { f7.dialog.alert(e.message); }
}
async function refresh(done) { try { await load(); } finally { done(); } }
function removeKey(d) {
  f7.dialog.confirm(ct('解除後，那支手機就不能再核准登入。'), ct('解除') + ' ' + d.name, async () => { await removeDevice(d.id).catch((e) => f7.dialog.alert(e.message));load(); });
}
function signOut(s) {
  f7.dialog.confirm(ct('那台裝置會被登出，要重新登入才能使用。'), ct('登出') + ' ' + sessionTitle(s), async () => { await signOutSession(s.id).catch((e) => f7.dialog.alert(e.message));load(); });
}
load();
</script>

<style scoped>
.this-one {font-size:12px;color:#34c759;}
.device-remove, .session-out {color:#ff453a;font-size:14px;}
.devices-empty {font-size:13px;color:var(--cc-color-text-secondary,#8e8e93);}
</style>
