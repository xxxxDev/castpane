<template>
  <!-- QR sign-in on the phone: bind this phone as a
       login key once, then scan a computer's login page and approve it. -->
  <f7-page name="scan-login" class="page-large-static" @page:beforeout="stopCamera">
    <f7-navbar :title="ct('掃碼登入')" :back-link="t('back')"></f7-navbar>

    <template v-if="!bound">
      <f7-block strong inset class="scan-intro">
        <div class="scan-emoji">📱</div>
        <div class="scan-heading">{{ ct('把這支手機設為登入鑰匙') }}</div>
        <p>{{ ct('綁定後，可以掃電腦上的 QR code 直接登入，不用輸入密碼。') }}</p>
        <p class="scan-note">{{ ct('在這支手機登出後，綁定會一起解除，要再綁定一次。') }}</p>
      </f7-block>
      <f7-list inset strong-ios form @submit.prevent class="bind-form">
        <f7-list-input :label="ct('裝置名稱')" class="bind-name" :value="name" maxlength="40" @update:value="name = $event" />
        <f7-list-input :label="ct('目前密碼')" class="bind-password" type="password" autocomplete="current-password" :value="password" @update:value="password = $event" />
        <!-- With two-step sign-in on, a new login key takes the code too. -->
        <f7-list-input v-if="currentUser?.twoStep" :label="ct('驗證碼或備用碼')" class="bind-code" type="text" autocomplete="one-time-code" autocapitalize="off" :value="code" @update:value="code = $event" />
      </f7-list>
      <f7-block>
        <f7-button fill round large class="bind-button" :disabled="!installed || busy || !password || (currentUser?.twoStep && !code)" @click="bind">{{ ct('綁定這支手機') }}</f7-button>
        <p v-if="!installed" class="scan-note">{{ ct('只有加到主畫面的 App 可以綁定，網頁版不行') }}</p>
        <p v-else class="scan-note rebind-note">{{ ct('重新綁定會取代先前的綁定，先前用它核准登入的電腦會被登出') }}</p>
        <p v-if="error" class="scan-error" role="alert">{{ error }}</p>
      </f7-block>
    </template>

    <template v-else>
      <f7-block strong inset class="scan-intro">
        <div class="scan-emoji">🔑</div>
        <div class="scan-heading">{{ bound.name }}</div>
        <p>{{ ct('這支手機是登入鑰匙。電腦打開 {product} 登入頁時，掃描上面的 QR code。') }}</p>
      </f7-block>
      <f7-block>
        <f7-button fill round large class="scan-button" @click="openCamera">{{ ct('掃描') }}</f7-button>
        <p v-if="error" class="scan-error" role="alert">{{ error }}</p>
      </f7-block>
      <f7-list inset strong-ios>
        <f7-list-item link no-chevron :title="ct('解除這支手機')" class="unbind-row" @click.prevent="unbind"><template #media><f7-icon f7="xmark_circle" style="color:#ff3b30" /></template></f7-list-item>
      </f7-list>
    </template>

    <!-- The camera, full screen, until a code is read; above the tab bar. -->
    <Teleport to=".framework7-root">
    <div v-if="scanning" class="scanner">
      <video ref="video" playsinline webkit-playsinline muted autoplay class="scanner-video" @click="startVideo"></video>
      <div class="scanner-frame"></div>
      <a href="#" class="scanner-close" :aria-label="ct('關閉')" @click.prevent="stopCamera"><i class="icon f7-icons">xmark</i></a>
      <button v-if="needsTap" type="button" class="scanner-tap" @click="startVideo">{{ ct('點一下開啟相機畫面') }}</button>
      <div class="scanner-hint">{{ ct('對準電腦上的 QR code') }}<small>{{ ct('只會登入你自己的帳號') }}</small></div>
    </div>

    <!-- Who is asking, before anything is let in. -->
    <div v-if="request" class="confirm">
      <div class="confirm-sheet">
        <div class="scan-emoji">💻</div>
        <div class="scan-heading">{{ ct('要讓這台裝置登入嗎？') }}</div>
        <div class="list inset confirm-list"><ul>
          <li class="item-content"><div class="item-inner"><div class="item-title">{{ ct('裝置') }}</div><div class="item-after confirm-device">{{ describeAgent(request.ua) }}</div></div></li>
          <li class="item-content"><div class="item-inner"><div class="item-title">{{ ct('網路') }}</div><div class="item-after">{{ request.ip }}</div></div></li>
          <li class="item-content"><div class="item-inner"><div class="item-title">{{ ct('帳號') }}</div><div class="item-after">{{ currentUser?.name || currentUser?.username }}</div></div></li>
        </ul></div>
        <p v-if="!request.sameNetwork" class="confirm-warn">{{ ct('這台裝置和你的手機不在同一個網路。若不是你正在操作的電腦，請拒絕。') }}</p>
        <p class="confirm-ask">{{ ct('選電腦登入頁上顯示的數字來登入。看不到那個畫面，就不是你正在用的電腦，請拒絕。') }}</p>
        <div class="confirm-codes">
          <button v-for="c in request.choices" :key="c" type="button" class="confirm-code" :disabled="busy" @click="decide(true, c)">{{ c }}</button>
        </div>
        <f7-button round large class="deny-button" :disabled="busy" @click="decide(false)">{{ ct('不是我，拒絕') }}</f7-button>
      </div>
    </div>
    </Teleport>
  </f7-page>
</template>

<script setup>
import { nextTick, onUnmounted, ref } from 'vue';
import { f7 } from 'framework7-vue';
import jsQR from 'jsqr';
import { t } from '../js/i18n.js';
import { ct } from '../js/text.js';
import { currentUser } from '../js/auth.js';
import { loginKey, isInstalledApp, defaultDeviceName, bindThisPhone, unbindThisPhone, requestIdFrom, peekRequest, decideRequest, describeAgent } from '../js/qrLogin.js';

const toast = (text) => f7.toast.create({ text, closeTimeout: 1800 }).open();
const bound = ref(loginKey());
const installed = isInstalledApp();
const name = ref(defaultDeviceName()), password = ref(''), code = ref(''), busy = ref(false), error = ref('');
const scanning = ref(false), video = ref(null), request = ref(null), needsTap = ref(false);
let requestId = null, stream = null, frame = null;

async function bind() {
  busy.value = true;error.value = '';
  try { await bindThisPhone(name.value.trim() || defaultDeviceName(), password.value, code.value.trim());password.value = '';code.value = '';bound.value = loginKey();toast(ct('已綁定這支手機')); }
  // Too many tries from here is said as that, not as the server's own words.
  catch (e) { error.value = e.code === 'CODES_SPENT' ? ct('今天驗證碼輸錯太多次，今天不再接受驗證器的碼，請改用備用碼') : e.status === 429 ? t('tooManyAttempts') : e.code === 'NEED_CODE' ? ct('請輸入你的驗證碼或備用碼。') : e.code === 'WRONG_CODE' ? ct('驗證碼不正確') : e.status === 400 ? ct('密碼不正確') : e.message; }
  finally { busy.value = false; }
}
function unbind() {
  f7.dialog.confirm(ct('解除後，這支手機就不能再核准登入。'), ct('解除這支手機'), async () => {
    try { await unbindThisPhone();bound.value = null; } catch (e) { error.value = e.message; }
  });
}

async function openCamera() {
  error.value = '';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch { error.value = ct('無法使用相機，請到系統設定允許 {product} 使用相機');return; }
  scanning.value = true;needsTap.value = false;
  await nextTick();
  // iOS shows a black video unless muted and inline are attributes on the element
  // before it plays (Vue sets muted only as a property); a play refused outside a
  // tap is offered as a tap.
  const v = video.value;
  v.muted = true;v.setAttribute('muted', '');v.setAttribute('playsinline', '');v.setAttribute('autoplay', '');
  v.srcObject = stream;
  await startVideo();
  // Still no picture after a moment (the first stream after the permission prompt
  // can stay dark on iOS): ask for the camera once more.
  setTimeout(async () => {
    if (!scanning.value || video.value?.videoWidth) return;
    try {
      stream?.getTracks().forEach((track) => track.stop());
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (!scanning.value) { stream.getTracks().forEach((track) => track.stop());stream = null;return; }
      video.value.srcObject = stream;await startVideo();
    } catch { stopCamera();error.value = ct('無法使用相機，請到系統設定允許 {product} 使用相機'); }
  }, 2500);
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  let last = 0;
  const look = (time) => {
    if (!scanning.value) return;
    frame = requestAnimationFrame(look);
    if (time - last < 150 || !video.value?.videoWidth) return;
    last = time;
    const w = Math.min(640, video.value.videoWidth), h = Math.round(video.value.videoHeight * w / video.value.videoWidth);
    canvas.width = w;canvas.height = h;ctx.drawImage(video.value, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    if (!code) return;
    const id = requestIdFrom(code.data);
    stopCamera();
    if (id) open(id);else error.value = ct('這不是 {product} 的登入 QR code');
  };
  frame = requestAnimationFrame(look);
}
async function startVideo() {
  try { await video.value?.play();needsTap.value = false; } catch { needsTap.value = true; }
}
function stopCamera() {
  scanning.value = false;cancelAnimationFrame(frame);
  stream?.getTracks().forEach((track) => track.stop());stream = null;
}
async function open(id) {
  try { request.value = await peekRequest(id);requestId = id; }
  catch (e) {
    if (e.code === 'DEVICE_NOT_BOUND') { bound.value = null;error.value = ct('這支手機已被解除綁定，請重新綁定');return; }
    error.value = e.status === 404 ? ct('這個 QR code 已過期，請重新整理電腦上的登入頁') : e.message;
  }
}
async function decide(approve, code) {
  busy.value = true;
  try {
    await decideRequest(requestId, approve, code);
    toast(approve ? ct('已核准登入') : ct('已拒絕'));
    request.value = null;
  } catch (e) {
    request.value = null;
    if (e.code === 'DEVICE_NOT_BOUND') { bound.value = null;error.value = ct('這支手機已被解除綁定，請重新綁定'); }
    else error.value = e.code === 'WRONG_ACCOUNT' ? ct('那台電腦要登入的是另一個帳號，這次登入已被拒絕') : e.code === 'WRONG_CODE' ? ct('數字不對，這次登入已被拒絕') : e.status === 404 ? ct('這個 QR code 已過期，請重新整理電腦上的登入頁') : e.message;
  } finally { busy.value = false; }
}
// A link to a request (?qr=) opens this page but never the request itself: sent a
// link, someone could approve a computer they are not at.
onUnmounted(stopCamera);
</script>

<style>
.scan-intro {text-align:center;}
.scan-emoji {font-size:40px;}
.scan-heading {font-weight:700;font-size:17px;margin-top:6px;}
.scan-note {text-align:center;font-size:13px;color:var(--cc-color-text-secondary,#8e8e93);}
.scan-error {text-align:center;font-size:13px;color:#ff453a;}
.scanner {position:fixed;inset:0;z-index:13000;background:#000;}
.scanner-video {position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
.scanner-frame {position:absolute;left:50%;top:44%;width:240px;height:240px;transform:translate(-50%,-50%);border:3px solid #fff;border-radius:20px;box-shadow:0 0 0 9999px rgba(0,0,0,.5);}
.scanner-close {position:absolute;top:calc(16px + env(safe-area-inset-top));left:16px;width:40px;height:40px;border-radius:20px;background:rgba(0,0,0,.5);color:#fff;display:flex;align-items:center;justify-content:center;}
.scanner-tap {position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);padding:12px 20px;border:0;border-radius:22px;background:rgba(255,255,255,.9);color:#000;font-size:15px;font-weight:600;z-index:1;}
.scanner-hint {position:absolute;left:0;right:0;bottom:calc(60px + env(safe-area-inset-bottom));text-align:center;color:#fff;font-weight:600;}
.scanner-hint small {display:block;font-weight:400;opacity:.7;margin-top:4px;}
.confirm {position:fixed;inset:0;z-index:13000;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center;}
.confirm-sheet {width:100%;max-width:480px;background:var(--f7-page-bg-color,#121212);border-radius:20px 20px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom));text-align:center;}
.confirm-list {text-align:left;margin:14px 0;}
.confirm-warn {font-size:13px;color:#ff9f0a;margin:0 0 8px;}
.confirm-ask {font-size:13px;color:var(--cc-color-text-secondary,#8e8e93);margin:0 0 12px;}
.confirm-codes {display:flex;gap:12px;justify-content:center;margin-bottom:14px;}
.confirm-code {width:84px;height:64px;border:1px solid rgba(120,120,128,.35);border-radius:16px;background:rgba(120,120,128,.18);color:var(--f7-text-color,#fff);font-size:26px;font-weight:700;letter-spacing:1px;}
.confirm-code:disabled {opacity:.5;}
.deny-button {color:#ff453a;}
</style>
