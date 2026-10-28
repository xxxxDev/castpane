<template>
  <f7-page name="login" login-screen class="login-page">
    <!-- Sign in by scanning this with a phone bound as a login key: on a
         computer, once the name is given and "scan with a phone" is chosen. -->
    <div v-if="showQr" class="qr-login">
      <div class="qr-box" :class="{faded: qrState !== 'waiting'}" v-html="qrMarkup"></div>
      <div class="qr-title">{{ ct('用手機 {product} 掃描登入') }}</div>
      <!-- The phone asks for this number: only someone in front of this screen has it. -->
      <div v-if="qrState === 'waiting' && qrCode" class="qr-code">{{ ct('手機上選這個數字') }}<b>{{ qrCode }}</b></div>
      <div class="qr-note">{{ qrNote }}</div>
    </div>
    <f7-login-screen-title><img v-if="PRODUCT.loginLogo" :src="PRODUCT.loginLogo" alt="" class="login-logo" /> {{ PRODUCT.name }}</f7-login-screen-title>
    <!-- The name first, alone: what comes next
         depends on the account. A passkey when it has one, else the password, then
         the two-step code when that is on.
         @submit.prevent: a form with one field is sent by the browser itself on Enter,
         which reloaded the page and lost the sign-in just made. -->
    <f7-list v-if="step === 'name'" form @submit.prevent class="login-inputs no-hairlines login-name">
      <f7-list-input
        type="text"
        :placeholder="t('username')"
        autocomplete="username webauthn"
        autocapitalize="off"
        v-model:value="username"
        @keyup.enter="next"
      ></f7-list-input>
    </f7-list>
    <template v-else-if="step === 'password'">
      <div class="login-who">{{ username.trim() }}<f7-link class="login-change" @click="startOver('')">{{ ct('換帳號') }}</f7-link></div>
      <f7-list form @submit.prevent class="login-inputs no-hairlines login-password">
        <!-- Kept, out of sight, so a password manager knows whose password this is. -->
        <input type="text" autocomplete="username" :value="username.trim()" readonly tabindex="-1" class="login-hidden-name" />
        <f7-list-input
          type="password"
          :placeholder="t('password')"
          autocomplete="current-password"
          v-model:value="password"
          @keyup.enter="submit"
        ></f7-list-input>
      </f7-list>
    </template>
    <f7-list v-else form @submit.prevent class="login-inputs no-hairlines login-code">
      <f7-list-input
        type="text"
        inputmode="numeric"
        autocapitalize="off"
        :placeholder="ct('6 位數驗證碼')"
        autocomplete="one-time-code"
        v-model:value="code"
        @keyup.enter="submitCode"
      ></f7-list-input>
    </f7-list>
    <f7-block class="login-actions">
      <f7-button fill round large class="login-btn" :disabled="submitting" @click="step === 'name' ? next() : step === 'password' ? submit() : submitCode()">
        {{ submitting ? t('signingIn') : step === 'name' ? ct('繼續') : t('signIn') }}
      </f7-button>
      <f7-block-footer :class="{ 'login-error': error }">
        {{ error || (step === 'code' ? ct('輸入驗證器 App 顯示的驗證碼；手機不在身邊可以輸入備用碼。') : step === 'name' ? t('loginSubtitle') : '') }}
      </f7-block-footer>
      <!-- Other ways in, once the account is known. -->
      <template v-if="step === 'password'">
        <f7-button v-if="hasPasskey && passkeyOk" round large outline class="login-passkey" :disabled="submitting" @click="usePasskey">{{ ct('用通行密鑰登入') }}</f7-button>
        <f7-link v-if="wide && !showQr" class="login-back login-scan" @click="openQr">{{ ct('改用手機掃碼登入') }}</f7-link>
      </template>
      <f7-link v-if="step === 'code'" class="login-back" @click="startOver('')">{{ ct('改用其他帳號登入') }}</f7-link>
    </f7-block>
  </f7-page>
</template>

<script setup>
import { PRODUCT } from '../js/productConfig.js';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { f7 } from 'framework7-vue';
import { t } from '../js/i18n.js';
import { ct } from '../js/text.js';
import { api, login, loginCode, signedInByQr, currentUser } from '../js/auth.js';
import { passkeysWork, passkeyAutofillWorks, signInWithPasskey, cancelled, shouldOfferPasskey, passkeyOfferDone, addPasskey } from '../js/passkeys.js';
import { startRequest, pollRequest, requestUrl, qrSvg, describeAgent } from '../js/qrLogin.js';

// The steps: the name, then the password (or a passkey, or a phone's scan), then
// the two-step code.
const step = ref('name');
const username = ref('');
const password = ref('');
const submitting = ref(false);
const error = ref('');
const hasPasskey = ref(false);
// The password just typed, held for the passkey offer after sign-in alone (offerPasskey).
let heldPassword = '';
function startOver(message) { heldPassword = '';step.value = 'name';password.value = '';ticket.value = '';code.value = '';hasPasskey.value = false;closeQr();error.value = message;waitForPasskey(); }

// QR sign-in: a request, shown as a code, asked about every two seconds; a new one
// when it lapses or is refused. Only on a screen wide enough to be a computer's,
// and only once it is asked for.
const wide = typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 768px)').matches;
const showQr = ref(false);
const qrMarkup = ref(''), qrState = ref('loading'), qrLeft = ref(60), qrCode = ref('');
let request = null, pollTimer = null, clockTimer = null, stopped = false, retryAt = 0;
const qrNote = computed(() => qrState.value === 'denied' ? ct('手機拒絕了這次登入') : qrState.value === 'error' ? ct('暫時無法產生 QR code') : qrState.value === 'loading' ? ct('產生中…') : `${ct('手機：設定 → 掃碼登入 → 掃描')} · ${qrLeft.value} ${ct('秒後更新')}`);
async function newRequest() {
  if (stopped || !showQr.value) return;
  try {
    // Out of sight, no new request until the page is back (each one counts against
    // the site's caps).
    if (document.hidden) { request = null;qrState.value = 'loading';return; }
    const made = await startRequest(username.value.trim());
    if (!showQr.value) return;
    request = made;
    qrMarkup.value = qrSvg(requestUrl(request.id));qrCode.value = request.code || '';qrState.value = 'waiting';qrLeft.value = request.expiresIn;
  } catch { qrState.value = 'error';setTimeout(newRequest, 60000); }
}
async function pollOnce() {
  if (!request || qrState.value !== 'waiting' || document.hidden) return;
  try {
    const r = await pollRequest(request.id, request.poll);
    if (r.status === 'approved') { stopped = true;signedInByQr(r.user);return; }
    if (r.status === 'denied') { qrState.value = 'denied';request = null;setTimeout(newRequest, 3000); }
    else if (r.status === 'expired') { request = null;newRequest(); }
    // Gone early (pushed out by a flood): wait before asking again, so a flood does
    // not spend this address's caps.
    else if (r.status === 'unknown') { request = null;qrState.value = 'loading';retryAt = Date.now() + 15000; }
  } catch {}
}
function openQr() { if (!wide || showQr.value) return;showQr.value = true;qrState.value = 'loading';newRequest(); }
function closeQr() { showQr.value = false;request = null;qrMarkup.value = '';qrCode.value = '';qrState.value = 'loading'; }
onMounted(() => {
  pollTimer = setInterval(pollOnce, 2000);
  clockTimer = setInterval(() => {
    if (!showQr.value) return;
    if (qrState.value === 'waiting' && --qrLeft.value <= 0) { request = null;newRequest(); }
    else if (!request && qrState.value === 'loading' && !document.hidden && !stopped && Date.now() >= retryAt) newRequest();
  }, 1000);
});
// Signed in, the page stops asking; signed out again, it starts over from the name.
watch(currentUser, (user) => {
  if (user) { stopped = true;request = null;qrState.value = 'loading';stopWaiting(); }
  else { stopped = false;startOver(''); }
});
onUnmounted(() => { stopped = true;clearInterval(pollTimer);clearInterval(clockTimer);clearInterval(waitTimer);document.removeEventListener('visibilitychange', onVisible);stopWaiting(); });

// Signed in with the password just now: offer a passkey for this device, once. The
// server adds one only with the password again (and, with two-step on, a code), so
// the password just typed is held for this offer alone and a new code is asked for.
const askCode = () => new Promise((done) => {
  f7.dialog.prompt(ct('輸入驗證器上新的驗證碼，或一組備用碼。'), ct('建立通行密鑰'), (v) => done(String(v || '').trim()), () => done(''));
});
function offerPasskey(twoStep = false) {
  const typed = heldPassword;
  heldPassword = '';
  if (!typed || !shouldOfferPasskey()) return;
  f7.dialog.create({
    title: ct('要在這台裝置建立通行密鑰嗎？'),
    text: ct('之後可以直接用 Face ID、Touch ID 或裝置密碼登入，不必輸入密碼和驗證碼。'),
    cssClass: 'passkey-offer',
    buttons: [
      { text: ct('不用'), onClick: () => passkeyOfferDone('no') },
      { text: ct('建立'), strong: true, onClick: async () => {
        const code = twoStep ? await askCode() : undefined;
        if (twoStep && !code) return;
        try {
          await addPasskey({ name: describeAgent(navigator.userAgent), password: typed, code });
          f7.toast.create({ text: ct('通行密鑰已建立'), closeTimeout: 2200 }).open();
        } catch (e) {
          // Closed on the device: asked again at the next password sign-in.
          if (cancelled(e)) return;
          if (e?.name === 'InvalidStateError') { passkeyOfferDone('made');f7.toast.create({ text: ct('這個裝置已經有這個帳號的通行密鑰。'), closeTimeout: 2200 }).open();return; }
          f7.dialog.alert(ct('沒有建立成功，可以到「設定 → 通行密鑰」再試一次。'));
        }
      } },
    ],
  }).open();
}

const passkeyOk = passkeysWork();
// In the name field the browser lists this device's passkeys: a request that waits
// there, unseen, until one is picked. Its challenge lasts five minutes, so it is
// asked for again every four; one request at a time, so asking outright ends it first.
let waiting = null, waitTimer = null;
function stopWaiting() { waiting?.abort();waiting = null; }
async function waitForPasskey() {
  stopWaiting();
  if (currentUser.value || step.value !== 'name' || document.hidden) return;
  // Set before anything is awaited, so a second call ends this one for certain.
  const mine = waiting = new AbortController();
  if (!(await passkeyAutofillWorks()) || waiting !== mine) return;
  try { signedInByQr(await signInWithPasskey({ conditional: true, signal: mine.signal })); }
  catch (err) {
    if (waiting !== mine || cancelled(err)) return;
    waiting = null;
    if (err.code === 'PASSKEY_REFUSED') { error.value = ct('這把通行密鑰無法登入，可能已被刪除。');waitForPasskey(); }
  }
}
const onVisible = () => { if (!document.hidden && !waiting && !submitting.value) waitForPasskey(); };
onMounted(() => { waitForPasskey();document.addEventListener('visibilitychange', onVisible);waitTimer = setInterval(() => { if (!submitting.value && step.value === 'name') waitForPasskey(); }, 4 * 60_000); });
// Returns whether it signed in. Turned down or closed on the device is not an error:
// the password is there below.
const usePasskey = async () => {
  if (submitting.value) return false;
  submitting.value = true;
  error.value = '';
  stopWaiting();
  try { signedInByQr(await signInWithPasskey());return true; }
  catch (err) {
    if (cancelled(err)) error.value = '';
    else if (err.status === 429) error.value = t('tooManyAttempts');
    else if (err.code === 'PASSKEY_REFUSED') error.value = ct('這把通行密鑰無法登入，可能已被刪除。');
    else error.value = err.message || t('loginFailed');
    return false;
  } finally { submitting.value = false; }
};

// The name is given: what the account can sign in with. A passkey is asked for at
// once when it has one and this browser can use it; the password is the way on
// otherwise, or when that is turned down.
const focusField = (selector) => nextTick(() => document.querySelector(`.login-page ${selector} input:not([readonly])`)?.focus());
const next = async () => {
  if (!username.value.trim() || submitting.value) return;
  submitting.value = true;
  error.value = '';
  stopWaiting();
  try {
    const r = await api('/auth/login/start', { method: 'POST', body: JSON.stringify({ username: username.value.trim() }) });
    hasPasskey.value = !!r.passkey;
  } catch (err) {
    if (err.status === 429) { error.value = t('tooManyAttempts');submitting.value = false;return; }
    hasPasskey.value = false;
  }
  submitting.value = false;
  step.value = 'password';
  if (hasPasskey.value && passkeyOk && await usePasskey()) return;
  if (step.value === 'password') focusField('.login-password');
};

const submit = async () => {
  if (!password.value || submitting.value) return;
  submitting.value = true;
  error.value = '';
  try {
    heldPassword = password.value;
    const r = await login(username.value.trim(), password.value);
    if (r?.step === 'code') { ticket.value = r.ticket;code.value = '';password.value = '';step.value = 'code';closeQr();focusField('.login-code'); }
    else offerPasskey(false);
  } catch (err) {
    heldPassword = '';
    if (err.status === 429) error.value = t('tooManyAttempts');
    else if (err.status === 400 || err.status === 401) error.value = t('loginFailed');
    else error.value = err.message || t('loginFailed');
  } finally {
    submitting.value = false;
  }
};

// The second step: the ticket the right password earned, and the code.
const ticket = ref(''), code = ref('');
const submitCode = async () => {
  if (!code.value.trim() || submitting.value) return;
  submitting.value = true;
  error.value = '';
  try {
    await loginCode(ticket.value, code.value.trim());
    ticket.value = '';code.value = '';
    offerPasskey(true);
  } catch (err) {
    if (err.code === 'CODES_SPENT') error.value = ct('今天驗證碼輸錯太多次，今天不再接受驗證器的碼，請改用備用碼、通行密鑰或手機掃碼');
    else if (err.status === 429) error.value = t('tooManyAttempts');
    // Five wrong codes, or five minutes: from the start again.
    else if (err.code === 'TICKET_GONE') startOver(ct('請重新輸入帳號密碼'));
    else if (err.code === 'NEED_CODE') error.value = ct('請輸入你的驗證碼或備用碼。');
    else if (err.code === 'WRONG_CODE') error.value = ct('驗證碼不正確');
    else error.value = err.message || t('loginFailed');
  } finally {
    submitting.value = false;
  }
};
</script>

<style scoped>
.login-back {display:block;margin-top:10px;text-align:center;font-size:14px;}
.login-who {display:flex;justify-content:center;align-items:baseline;gap:12px;margin:0 16px 10px;font-size:16px;font-weight:600;overflow-wrap:anywhere;}
.login-change {font-size:13px;font-weight:400;}
.login-hidden-name {position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;}
.login-passkey {height:44px;border-radius:22px;margin-top:6px;font-size:15px;text-transform:none;}
.qr-login {display:flex;flex-direction:column;align-items:center;margin:24px auto 8px;text-align:center;}
.qr-box {width:188px;height:188px;padding:10px;border-radius:14px;background:#fff;transition:opacity .2s;}
.qr-box.faded {opacity:.25;}
.qr-box :deep(svg) {width:100%;height:100%;display:block;}
.qr-title {margin-top:12px;font-weight:600;}
.qr-code {margin-top:8px;font-size:14px;}
.qr-code b {margin-left:8px;font-size:22px;letter-spacing:2px;}
.qr-note {margin-top:4px;font-size:13px;color:var(--cc-color-text-secondary,#8e8e93);}
/* inputs as search pills: white-8% capsule + inset white-40% ring + blur(5px),
   transparent input inside (skin.css .searchbar-input-wrap recipe) */
.login-inputs {
  --f7-list-bg-color: transparent;
  --f7-list-item-border-color: transparent;
}
.login-inputs :deep(li) {
  margin-bottom: 14px;
}
.login-inputs :deep(.item-content) {
  padding-left: 16px;
  padding-right: 16px;
}
.login-inputs :deep(.item-inner) {
  padding: 0;
}
.login-inputs :deep(.item-inner::after),
.login-inputs :deep(.item-content::after) {
  display: none; /* kill hairlines */
}
.login-inputs :deep(.item-input-wrap) {
  background: var(--cc-surface-card);
  border-radius: 24px;
  box-shadow: inset 0 0 2px 0 var(--cc-glass-ring);
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
}
.login-inputs :deep(.item-input-wrap input) {
  height: 44px;
  padding: 0 20px;
  background: transparent;
  color: var(--cc-color-text);
}
.login-inputs :deep(.item-input-wrap input::placeholder) {
  color: var(--cc-color-text-secondary);
}

.login-actions {
  margin-top: 8px;
}
/* primary action: white fill pill (black text) */
.login-btn {
  height: 44px;
  border-radius: 22px;
  font-size: 16px;
  font-weight: 600;
  text-transform: none;
  color: var(--cc-color-on-accent);
}

.login-page :deep(.block-footer) {
  max-width: 320px;
  min-height: 34px;
  margin-left: auto;
  margin-right: auto;
  text-align: center;
  color: #8e8e93;
  font-size: 14px;
  overflow-wrap: anywhere;
}

.login-page :deep(.block-footer.login-error) {
  color: #ff3b30;
}

/* PRODUCT.loginLogo sits inline with the title, sized to the text. */
.login-logo {width:1em;height:1em;border-radius:22%;vertical-align:-0.12em;}
</style>
