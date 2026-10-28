<template>
  <!-- Two-step sign-in for this account: the six digits of an
       authenticator app after the password. On, off, and the recovery codes. -->
  <f7-page name="two-step" class="page-large-static two-step-page" @page:afterin="load">
    <f7-navbar :title="ct('兩步驟驗證')" :back-link="t('back')"></f7-navbar>

    <!-- Just turned on: the recovery codes, shown this once. -->
    <template v-if="codes.length">
      <f7-block-title>{{ ct('備用碼') }}</f7-block-title>
      <f7-block class="ts-note">{{ ct('兩步驟驗證已開啟。請把這 10 組備用碼存到安全的地方：手機不在身邊時，每組可以代替驗證碼登入一次。離開這一頁後就不會再顯示。') }}</f7-block>
      <f7-block strong inset class="ts-codes"><span v-for="c in codes" :key="c">{{ c }}</span></f7-block>
      <f7-block><f7-button round large class="ts-copy" @click="copyCodes">{{ ct('複製備用碼') }}</f7-button></f7-block>
      <f7-block><f7-button fill round large class="ts-done" @click="codes = []">{{ ct('我存好了') }}</f7-button></f7-block>
    </template>

    <template v-else-if="status?.enabled">
      <f7-block class="ts-note ts-on">{{ ct('已開啟。用密碼登入時，還要輸入驗證器 App 的 6 位數驗證碼。掃碼登入不受影響。') }} {{ ct('備用碼還剩') }} {{ status.recoveryLeft }} {{ ct('組') }}。</f7-block>
      <f7-block-title>{{ ct('關閉兩步驟驗證') }}</f7-block-title>
      <f7-list strong-ios dividers-ios inset form @submit.prevent>
        <f7-list-input :label="t('password')" type="password" autocomplete="current-password" v-model:value="password"></f7-list-input>
        <f7-list-input :label="ct('驗證碼或備用碼')" type="text" autocomplete="one-time-code" autocapitalize="off" v-model:value="code" @keyup.enter="turnOff"></f7-list-input>
      </f7-list>
      <f7-block v-if="message" class="form-error">{{ message }}</f7-block>
      <f7-block><f7-button round large class="ts-off" :disabled="busy || !password || !code" @click="turnOff">{{ ct('關閉兩步驟驗證') }}</f7-button></f7-block>
    </template>

    <!-- The secret is waiting in the authenticator for its first code. -->
    <template v-else-if="setup">
      <f7-block class="ts-note">{{ ct('用驗證器 App（Google Authenticator、1Password、Microsoft Authenticator 等）掃描這個 QR code，再輸入 App 顯示的 6 位數驗證碼。') }}</f7-block>
      <div class="ts-qr" v-html="qrMarkup"></div>
      <!-- A phone cannot scan its own screen: the same address as a link, which the
           authenticator app on this device opens. -->
      <f7-block class="ts-open"><a class="external ts-open-app" :href="setup.uri">{{ ct('在這台裝置開啟驗證器 App') }}</a></f7-block>
      <f7-block class="ts-secret">{{ ct('無法掃描時，手動輸入這組金鑰') }}<br><code>{{ setup.secret.match(/.{1,4}/g).join(' ') }}</code></f7-block>
      <f7-list strong-ios dividers-ios inset form @submit.prevent>
        <f7-list-input :label="ct('驗證碼')" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" v-model:value="code" @keyup.enter="turnOn"></f7-list-input>
      </f7-list>
      <f7-block v-if="message" class="form-error">{{ message }}</f7-block>
      <f7-block><f7-button fill round large class="ts-enable" :disabled="busy || !code" @click="turnOn">{{ ct('開啟兩步驟驗證') }}</f7-button></f7-block>
    </template>

    <template v-else-if="status">
      <f7-block class="ts-note">{{ ct('開啟後，用密碼登入時還要輸入驗證器 App 的 6 位數驗證碼，密碼外洩也無法登入。掃碼登入不受影響。先輸入密碼開始設定。') }}</f7-block>
      <f7-list strong-ios dividers-ios inset form @submit.prevent>
        <f7-list-input :label="t('password')" type="password" autocomplete="current-password" v-model:value="password" @keyup.enter="start"></f7-list-input>
      </f7-list>
      <f7-block v-if="message" class="form-error">{{ message }}</f7-block>
      <f7-block><f7-button fill round large class="ts-start" :disabled="busy || !password" @click="start">{{ ct('開始設定') }}</f7-button></f7-block>
    </template>
  </f7-page>
</template>

<script setup>
import { computed, ref } from 'vue';
import { f7 } from 'framework7-vue';
import { t } from '../js/i18n.js';
import { ct } from '../js/text.js';
import { api, currentUser } from '../js/auth.js';
import { qrSvg } from '../js/qrLogin.js';

const status = ref(null), setup = ref(null), codes = ref([]);
const password = ref(''), code = ref(''), message = ref(''), busy = ref(false);
const qrMarkup = computed(() => (setup.value ? qrSvg(setup.value.uri) : ''));
const post = (path, body) => api(`/auth/two-step/${path}`, { method: 'POST', body: JSON.stringify(body) });
function problem(e) {
  if (e.code === 'CODES_SPENT') return ct('今天驗證碼輸錯太多次，今天不再接受驗證器的碼，請改用備用碼');
  if (e.status === 429) return t('tooManyAttempts');
  if (e.code === 'WRONG_PASSWORD') return ct('密碼不正確');
  if (e.code === 'NEED_CODE') return ct('請輸入你的驗證碼或備用碼。');
  if (e.code === 'WRONG_CODE') return ct('驗證碼不正確');
  if (e.code === 'SETUP_GONE') return ct('設定逾時，請重新開始');
  return e.message;
}
async function load() {
  try { status.value = await api('/auth/two-step'); } catch (e) { f7.dialog.alert(e.message); }
}
async function run(work) {
  if (busy.value) return;
  busy.value = true;message.value = '';
  try { await work(); } catch (e) { message.value = problem(e);if (e.code === 'SETUP_GONE') setup.value = null; } finally { busy.value = false; }
}
const start = () => run(async () => { setup.value = await post('setup', { password: password.value });password.value = '';code.value = ''; });
const turnOn = () => run(async () => {
  const r = await post('enable', { code: code.value });
  codes.value = r.recoveryCodes || [];setup.value = null;code.value = '';
  if (currentUser.value) currentUser.value = { ...currentUser.value, twoStep: true };
  await load();
});
const turnOff = () => run(async () => {
  await post('disable', { password: password.value, code: code.value });
  password.value = '';code.value = '';
  if (currentUser.value) currentUser.value = { ...currentUser.value, twoStep: false };
  await load();
  f7.toast.create({ text: ct('兩步驟驗證已關閉'), closeTimeout: 1800 }).open();
});
async function copyCodes() {
  try { await navigator.clipboard.writeText(codes.value.join('\n'));f7.toast.create({ text: ct('已複製'), closeTimeout: 1500 }).open(); }
  catch { f7.dialog.alert(ct('無法複製，請手動抄下。')); }
}
load();
</script>

<style scoped>
.ts-note {font-size:14px;color:var(--cc-color-text-secondary,#8e8e93);line-height:1.5;}
.ts-on {color:var(--cc-color-text);}
.ts-qr {width:200px;height:200px;margin:8px auto;padding:10px;border-radius:14px;background:#fff;}
.ts-qr :deep(svg) {width:100%;height:100%;display:block;}
.ts-open {text-align:center;margin:4px 0 0;font-size:15px;}
.ts-secret {text-align:center;font-size:13px;color:var(--cc-color-text-secondary,#8e8e93);}
.ts-secret code {display:inline-block;margin-top:6px;font-size:15px;letter-spacing:1px;color:var(--cc-color-text);user-select:all;overflow-wrap:anywhere;}
.ts-codes {display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;font-family:ui-monospace,Menlo,monospace;font-size:16px;text-align:center;user-select:text;}
.ts-off {color:#ff453a;}
.form-error {color:#ff3b30;font-size:14px;}
</style>
