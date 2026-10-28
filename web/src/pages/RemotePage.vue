<template>
  <!-- Remote (server/remote.js; first made at the owner's request, 2026-10-28, after
       Sill): this Mac's screen or one of its windows, live, with clicks, scrolls and keys
       sent back. -->
  <f7-page name="remote" class="page-large-static remote-page" @page:afterin="load">
    <f7-navbar :title="ct('遠端')" large></f7-navbar>

    <p class="remote-note">{{ ct('在這裡看到並操作這台 Mac 的畫面，或其中一個視窗。只有管理員能用，開始前要再驗證一次（有通行密鑰就用密鑰，沒有就輸入密碼），8 小時內不用再驗證。') }}</p>
    <f7-block v-if="!supported" class="remote-error" role="alert">{{ ct('這個瀏覽器不支援影片解碼（WebCodecs），請改用新版的 Edge、Chrome 或 Safari。') }}</f7-block>
    <f7-block v-if="error" class="remote-error" role="alert">{{ error }}</f7-block>

    <f7-block-title>{{ ct('連線到 Mac') }}</f7-block-title>
    <div class="remote-tiles">
      <!-- This Mac, then the other Macs that joined it (docs/multi-mac.md; the owner's
           request, 2026-10-29). -->
      <div v-for="m in machines" :key="m.id" class="remote-tile-wrap">
        <button type="button" class="remote-tile" :class="{disabled: !m.running || !supported, member: !m.local}" @click="connect(m)">
          <div class="remote-tile-shot"><img v-if="shots[m.id]" :src="shots[m.id]" alt=""/><f7-icon v-else f7="desktopcomputer" :size="44"/></div>
          <div class="remote-tile-name">{{ m.name }}</div>
          <div class="remote-tile-sub">{{ tileSub(m) }}</div>
        </button>
        <button v-if="!m.local" type="button" class="remote-tile-remove" :title="ct('移除這台 Mac')" @click="removeMac(m)"><f7-icon f7="xmark" :size="13"/></button>
      </div>
      <button v-if="canAdd" type="button" class="remote-tile add" @click="addMac">
        <div class="remote-tile-shot"><f7-icon f7="plus" :size="36"/></div>
        <div class="remote-tile-name">{{ ct('加入另一台 Mac') }}</div>
        <div class="remote-tile-sub">{{ ct('在這裡也能看到它的畫面') }}</div>
      </button>
    </div>
    <p v-if="machines.some(m => m.local && !m.running)" class="remote-note not-running">{{ ct('在這台 Mac 上打開 Castpane，或在選單列恢復分享，再回來這裡。') }}</p>

    <Teleport to="body">
      <div v-if="streaming" class="remote-stage" :class="{touch: isTouch}" :style="stageBox" @contextmenu.prevent>
        <!-- The bar: every window, the Desktop first, as Sill's bar of thumbnails. -->
        <!-- The Mac's desktops first, then the windows on the one picked (the owner's
             request, 2026-10-28): whole screens, each desktop, full-screen apps, the Dock. -->
        <div class="remote-head" :class="{collapsed: headCollapsed}">
        <div v-if="groups.length > 1 && !headCollapsed" class="remote-desks" role="tablist">
          <button v-for="g in groups" :key="g.key" type="button" class="remote-desk" :class="{active: g.key === groupKey, current: g.current}" @click="groupKey = g.key">{{ g.label }}<span class="remote-desk-count">{{ g.items.length }}</span></button>
        </div>
        <div class="remote-bar">
          <div v-if="!headCollapsed" class="remote-thumbs" role="tablist">
            <button v-for="w in shownItems" :key="w.kind + w.id" type="button" class="remote-thumb" :class="{active: current && current.kind === w.kind && current.id === w.id}" :title="w.app ? w.app + ' · ' + w.title : w.title" @click="show(w)">
              <img v-if="w.thumb" :src="w.thumb" alt=""/><f7-icon v-else :f7="w.kind === 'display' ? 'desktopcomputer' : 'macwindow'" :size="20"/>
              <span>{{ w.kind === 'display' ? (w.all ? ct('所有螢幕') : ct('整個螢幕') + (w.title.match(/\d+$/) ? ' ' + w.title.match(/\d+$/)[0] : '')) : (w.app || w.title) }}</span>
              <small v-if="w.kind === 'window' && w.here === false" class="remote-away">{{ ct('不在畫面上') }}</small>
            </button>
          </div>
          <div class="remote-actions">
            <!-- The screens, desktops and windows fold away for a bigger picture (the owner's request, 2026-10-28). -->
            <button type="button" class="remote-btn fold" :title="headCollapsed ? ct('展開視窗列') : ct('收起視窗列')" @pointerdown.prevent @mousedown.prevent @click="toggleHead"><f7-icon :f7="headCollapsed ? 'chevron_down' : 'chevron_up'" :size="16"/></button>
            <button v-if="view.z > 1" type="button" class="remote-btn zoom" :title="ct('還原大小')" @click="resetView">1×</button>
            <button v-if="!isTouch" type="button" class="remote-btn" :class="{on: keyboardOpen, hint: keyHint}" :title="ct('鍵盤')" @pointerdown.prevent @mousedown.prevent @click="toggleKeyboard"><f7-icon f7="keyboard" :size="18"/></button>
            <!-- On a phone the rest sit in one menu, so the bar keeps room for windows (the owner's request, 2026-10-28). -->
            <template v-if="isTouch">
              <button type="button" class="remote-btn more" :class="{on: menuOpen}" :title="ct('更多')" @pointerdown.prevent @mousedown.prevent @click="menuOpen = !menuOpen;settingsOpen = false"><f7-icon f7="ellipsis" :size="18"/></button>
            </template>
            <template v-else>
              <button type="button" class="remote-btn" :title="ct('重新整理視窗')" @click="list"><f7-icon f7="arrow_clockwise" :size="18"/></button>
              <button type="button" class="remote-btn" :title="ct('設定')" @click="settingsOpen = !settingsOpen"><f7-icon f7="slider_horizontal_3" :size="18"/></button>
              <button type="button" class="remote-btn danger" :title="ct('中斷連線')" @click="disconnect"><f7-icon f7="xmark" :size="18"/></button>
            </template>
          </div>
        </div>
        <div v-if="menuOpen" class="remote-menu" @pointerdown.stop>
          <!-- On a phone the keyboard lives here (the owner's request, 2026-10-28). -->
          <button type="button" class="remote-menu-item keyboard" @pointerdown.prevent @mousedown.prevent @click="menuOpen = false;toggleKeyboard()"><f7-icon f7="keyboard" :size="18"/>{{ keyboardOpen ? ct('收起鍵盤') : ct('打開鍵盤') }}</button>
          <button type="button" class="remote-menu-item clipboard" @click="menuOpen = false;clipOpen = true"><f7-icon f7="doc_on_clipboard" :size="18"/>{{ ct('剪貼簿') }}</button>
          <div class="remote-menu-label">{{ ct('操作方式') }}</div>
          <button v-for="m in MODES" :key="m.id" type="button" class="remote-menu-item mode" :class="['mode-' + m.id, {picked: mode === m.id}]" @click="setMode(m.id);menuOpen = false"><f7-icon :f7="m.icon" :size="18"/>{{ ct(m.label) }}<f7-icon v-if="mode === m.id" f7="checkmark" :size="15" class="remote-menu-check"/></button>
          <div class="remote-menu-sep"></div>
          <button type="button" class="remote-menu-item space-prev" @click="space('ArrowLeft')"><f7-icon f7="arrow_left_square" :size="18"/>{{ ct('上一個桌面') }}</button>
          <button type="button" class="remote-menu-item space-next" @click="space('ArrowRight')"><f7-icon f7="arrow_right_square" :size="18"/>{{ ct('下一個桌面') }}</button>
          <button type="button" class="remote-menu-item refresh" @click="list();menuOpen = false"><f7-icon f7="arrow_clockwise" :size="18"/>{{ ct('重新整理視窗') }}</button>
          <button type="button" class="remote-menu-item settings" @click="menuOpen = false;settingsOpen = true"><f7-icon f7="slider_horizontal_3" :size="18"/>{{ ct('畫質設定') }}</button>
          <button type="button" class="remote-menu-item disconnect" @click="menuOpen = false;disconnect()"><f7-icon f7="xmark_circle" :size="18"/>{{ ct('中斷連線') }}</button>
        </div>
        <div v-if="settingsOpen" class="remote-settings" @pointerdown.stop>
          <div class="remote-set-title">{{ ct('畫質') }}</div>
          <div class="remote-seg"><button v-for="q in ['low','standard','high','max']" :key="q" type="button" :class="{on: prefs.quality === q}" @click="setPref('quality', q)">{{ ct(QUALITY_LABEL[q]) }}</button></div>
          <div class="remote-set-title">{{ ct('解析度') }}</div>
          <div class="remote-seg"><button v-for="r in ['1280','1920','2560','native']" :key="r" type="button" :class="{on: prefs.resolution === r}" @click="setPref('resolution', r)">{{ r === 'native' ? ct('原生') : r }}</button></div>
          <div class="remote-set-title">{{ ct('每秒畫面') }}</div>
          <div class="remote-seg"><button v-for="f in [30, 60]" :key="f" type="button" :class="{on: prefs.fps === f}" @click="setPref('fps', f)">{{ f }}</button></div>
          <p class="remote-small">{{ ct('網路慢時調低畫質或解析度，畫面會比較順。') }}</p>
        </div>
        </div>

        <div ref="area" class="remote-area" @mousedown.prevent @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="cancel" @wheel.prevent="wheel">
          <canvas ref="canvas" class="remote-canvas" :class="{hidden: !hasPicture}" :style="view.z > 1 ? {transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`} : null"></canvas>
          <div v-if="!hasPicture || notice" class="remote-notice">
            <template v-if="permission">
              <f7-icon f7="lock_shield" :size="36"/>
              <p>{{ ct('Castpane 還沒有這台 Mac 的權限。請到這台 Mac 的「系統設定 › 隱私權與安全性」，在「螢幕與系統錄音」和「輔助使用」打開 Castpane，然後重新連線。') }}</p>
              <p class="remote-small">{{ ct('缺少：') }}{{ permission }}</p>
              <button type="button" class="remote-pill" @click="askPermissions">{{ ct('在 Mac 上跳出權限要求') }}</button>
            </template>
            <template v-else><f7-preloader :size="28"/><p>{{ notice || ct('連線中…') }}</p></template>
          </div>
          <!-- Pointer mode: the Mac's pointer drawn here (its black arrow with a white edge), with a ring below it to drag it
               by, so the finger never covers what it points at (the owner's idea, 2026-10-28). -->
          <template v-if="mode === 'pointer' && isTouch && hasPicture && handle">
            <svg class="remote-arrow" :style="{left: handle.cx + 'px', top: handle.cy + 'px'}" width="22" height="30" viewBox="0 0 22 30" aria-hidden="true"><path d="M3 2.5 L3 23 L8.1 18.3 L11.4 26.2 L14.9 24.7 L11.7 17 L18.5 17 Z" fill="#000" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>
            <div class="remote-ring" :class="{active: ring.active, holding: ring.holding}" :style="{left: handle.rx + 'px', top: handle.ry + 'px'}" @touchstart.stop.prevent @pointerdown.stop.prevent="ringDown" @pointermove.stop.prevent="ringMove" @pointerup.stop.prevent="ringUp" @pointercancel.stop.prevent="ringUp"></div>
          </template>
          <div v-if="mode === 'trackpad' && isTouch && hasPicture" class="remote-pad-hint">{{ ct('觸控板：滑動移動游標，點一下按一下，兩指滑動捲動') }}</div>
        </div>

        <!-- The pencil's field: text written on the phone, input method and all, and sent
             to where the Mac's cursor is in one go (the owner's request, 2026-10-29). -->
        <div v-if="compose" class="remote-compose" @pointerdown.stop>
          <input ref="composeField" v-model="composeText" class="remote-compose-field" type="text" enterkeyhint="send" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" :placeholder="ct('打好字，送到 Mac 的游標位置')" @keydown="composeKey">
          <button type="button" class="remote-compose-send" :disabled="!composeText" @pointerdown.prevent @mousedown.prevent @click="sendCompose">{{ ct('送出') }}</button>
        </div>
        <!-- The clipboard both ways (the owner's request, 2026-10-29). -->
        <div v-if="clipOpen" class="remote-clip" @pointerdown.stop>
          <button type="button" class="remote-clip-btn from-mac" @click="copyFromMac"><f7-icon f7="arrow_down_doc" :size="17"/>{{ ct('拷貝 Mac 的剪貼簿') }}</button>
          <button type="button" class="remote-clip-btn to-mac" @click="pasteToMac"><f7-icon f7="arrow_up_doc" :size="17"/>{{ ct('把剪貼簿放到 Mac') }}</button>
        </div>
        <!-- The keys a phone's keyboard lacks; ⇧ ⌃ ⌥ ⌘ hold for the next key. -->
        <div v-if="keyboardOpen || panel || compose || clipOpen || !isTouch" class="remote-keys" :class="{desk: !isTouch}">
          <template v-if="isTouch">
            <button type="button" class="remote-key tool compose-btn" :class="{on: compose}" :title="ct('輸入文字')" @pointerdown.prevent @mousedown.prevent @click="toggleCompose"><f7-icon f7="pencil" :size="17"/></button>
            <button type="button" class="remote-key tool panel-btn" :class="{on: panel}" :title="panel ? ct('鍵盤') : ct('按鍵面板')" @pointerdown.prevent @mousedown.prevent @click="togglePanel"><f7-icon :f7="panel ? 'keyboard' : 'square_grid_2x2'" :size="17"/></button>
          </template>
          <button type="button" class="remote-key tool clip-btn" :class="{on: clipOpen}" :title="ct('剪貼簿')" @pointerdown.prevent @mousedown.prevent @click="clipOpen = !clipOpen"><f7-icon f7="doc_on_clipboard" :size="17"/></button>
          <button v-for="k in KEYS" :key="k.code" type="button" class="remote-key" @pointerdown.prevent @click="tap(k.code)">{{ k.label }}</button>
          <button v-for="m in MODS" :key="m.id" type="button" class="remote-key mod" :class="{on: held.has(m.id)}" @pointerdown.prevent @click="toggleMod(m.id)">{{ m.label }}</button>
          <span class="remote-stats">{{ stats.fps }} fps · {{ stats.mbps }} Mbps</span>
        </div>
        <!-- In the phone keyboard's place: pages of keys, swiped sideways (the owner's request,
             2026-10-29). -->
        <div v-if="panel" class="remote-panel" @pointerdown.stop>
          <div ref="pagesEl" class="remote-pages" @scroll.passive="pageScroll">
            <div v-for="pg in PAGES" :key="pg.id" class="remote-page-grid" :class="['cols-' + pg.cols, 'page-' + pg.id]">
              <button v-for="k in pg.keys" :key="k.label" type="button" class="remote-pkey" @pointerdown.prevent @mousedown.prevent @click="press(k)">{{ ct(k.label) }}</button>
            </div>
          </div>
          <div class="remote-dots"><button v-for="(pg, i) in PAGES" :key="pg.id" type="button" :class="{on: i === pageNo}" :aria-label="ct(pg.name)" @click="goPage(i)"></button></div>
        </div>
        <textarea ref="typing" class="remote-typing" :inputmode="isTouch && !keyboardOpen ? 'none' : 'text'" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="keyboard" @beforeinput="beforeInput" @compositionend="compositionEnd" @keydown="keyDown" @keyup="keyUp" @blur="typingBlur"></textarea>

      </div>
    </Teleport>
  </f7-page>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, nextTick, watch } from 'vue';
import { f7 } from 'framework7-vue';
import { ct } from '../js/text.js';
import { api } from '../js/api.js';
import { adminProblem, withAdminAgain } from '../js/adminAgain.js';
import { passkeysWork, passkeyAgain, cancelled } from '../js/passkeys.js';
import { openRemote, remoteSupported, toPicture, codeOfChar, QUALITY, RESOLUTION } from '../js/remoteStream.js';

const supported = remoteSupported();
const machines = ref([]), error = ref(''), streaming = ref(false), items = ref([]), current = ref(null);
const hasPicture = ref(false), notice = ref(''), permission = ref(''), stats = reactive({ fps: 0, mbps: 0 });
const keyHint = ref(false), keyboardOpen = ref(false), settingsOpen = ref(false), menuOpen = ref(false), held = reactive(new Set());
const canvas = ref(null), area = ref(null), typing = ref(null);
const clipOpen = ref(false), panel = ref(false), pageNo = ref(0), pagesEl = ref(null), compose = ref(false), composeText = ref(''), composeField = ref(null);
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
const mode = ref(isTouch ? (localGet('castpane-remote-mode') || 'direct') : 'direct');
const QUALITY_LABEL = { low: '低', standard: '標準', high: '高', max: '最高' };
const KEYS = [{ code: 'Escape', label: 'esc' }, { code: 'Tab', label: 'tab' }, { code: 'ArrowLeft', label: '←' }, { code: 'ArrowUp', label: '↑' }, { code: 'ArrowDown', label: '↓' }, { code: 'ArrowRight', label: '→' }, { code: 'Backspace', label: '⌫' }, { code: 'Enter', label: '⏎' }];
const MODS = [{ id: 'shift', label: '⇧' }, { id: 'ctrl', label: '⌃' }, { id: 'alt', label: '⌥' }, { id: 'meta', label: '⌘' }];
// The key panel's pages. A Mac has no Insert, so Tab sits there; the shortcuts are the
// Mac's own (Mission Control ⌃↑, Show Desktop F11); the number pad types its characters.
const PAGES = [
  { id: 'edit', name: '編輯鍵', cols: 4, keys: [
    { code: 'Home', label: 'Home' }, { code: 'End', label: 'End' }, { code: 'PageUp', label: 'PgUp' }, { code: 'Backspace', label: '⌫' },
    { code: 'Tab', label: 'Tab' }, { code: 'ArrowUp', label: '↑' }, { code: 'PageDown', label: 'PgDn' }, { code: 'Delete', label: 'Del' },
    { code: 'ArrowLeft', label: '←' }, { code: 'ArrowDown', label: '↓' }, { code: 'ArrowRight', label: '→' }, { code: 'Enter', label: 'Enter' }] },
  { id: 'shortcuts', name: '快捷鍵', cols: 3, keys: [
    { code: 'KeyC', mods: ['meta'], label: '拷貝' }, { code: 'KeyV', mods: ['meta'], label: '貼上' }, { code: 'KeyX', mods: ['meta'], label: '剪下' },
    { code: 'KeyZ', mods: ['meta'], label: '復原' }, { code: 'KeyZ', mods: ['shift', 'meta'], label: '重做' }, { code: 'KeyA', mods: ['meta'], label: '全選' },
    { code: 'KeyF', mods: ['meta'], label: '尋找' }, { code: 'KeyM', mods: ['meta'], label: '縮到 Dock' }, { code: 'KeyW', mods: ['meta'], label: '關閉視窗' },
    { code: 'Space', mods: ['meta'], label: 'Spotlight' }, { code: 'ArrowUp', mods: ['ctrl'], label: '指揮中心' }, { code: 'F11', mods: [], label: '顯示桌面' }] },
  { id: 'numbers', name: '數字鍵', cols: 4, keys: [
    ...'789-456*123/'.split('').map((c) => ({ text: c, label: c })), { text: '0', label: '0' }, { text: '.', label: '.' }, { code: 'Backspace', label: '⌫' }, { text: '+', label: '+' }] },
  { id: 'fn', name: '功能鍵', cols: 4, keys: Array.from({ length: 12 }, (_, i) => ({ code: 'F' + (i + 1), label: 'F' + (i + 1) })) },
];
const prefs = reactive({ quality: 'standard', resolution: '1920', fps: 60, ...(JSON.parse(localGet('castpane-remote-prefs') || '{}')) });
// The last picture of each Mac, for its tile; this Mac's under the key it always had.
const shotKey = (id) => (id === 'local' ? 'castpane-remote-shot' : `castpane-remote-shot-${id}`);
const shots = reactive({});
const canAdd = ref(false);
let machine = 'local';
let link = null;

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function sessionGet(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } }
function sessionSet(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch {} }

async function load() {
  try {
    const r = await api('/remote/machines');
    machines.value = r.machines;canAdd.value = !!r.canAdd;error.value = '';
    for (const m of r.machines) if (!(m.id in shots)) shots[m.id] = localGet(shotKey(m.id)) || '';
  } catch (e) { error.value = e.message; }
}
onMounted(load);
onBeforeUnmount(() => { disconnect(); });
const onHidden = () => { if (document.visibilityState === 'hidden' && streaming.value) disconnect();else if (document.visibilityState === 'visible' && !streaming.value) load(); };
document.addEventListener('visibilitychange', onHidden);
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onHidden));

// A pass for a few hours, asked for with the admin's password (and code).
async function getPass(fresh = false) {
  const kept = sessionGet('castpane-remote-pass');
  if (!fresh && kept && Date.parse(kept.expiresAt) > Date.now() + 60000) return kept.pass;
  // A passkey first (Face ID, Touch ID): no password or code then (the owner's request,
  // 2026-10-28). Cancelled, refused or none: the password, as before.
  if (passkeysWork()) {
    try {
      const passkey = await passkeyAgain('/remote/pass/passkey');
      if (passkey) { const r = await api('/remote/pass', { method: 'POST', body: JSON.stringify({ passkey }) });sessionSet('castpane-remote-pass', r);return r.pass; }
    } catch (e) { if (!cancelled(e) && e.code !== 'PASSKEY_REFUSED') throw e; }
  }
  const r = await withAdminAgain(ct('連線到 Mac'), (again) => api('/remote/pass', { method: 'POST', body: JSON.stringify(again) }), ct('請輸入你自己的密碼，開始遠端操作。'));
  if (!r) return null;
  sessionSet('castpane-remote-pass', r);
  return r.pass;
}

function tileSub(m) {
  if (m.local) return m.running ? ct('這台 Mac') : ct('Castpane 沒有在執行');
  if (!m.online) return ct('離線');
  return m.running ? '' : ct('沒有在分享');
}
// A one-time code for another Mac, shown with this Mac's address and what to do there.
async function addMac() {
  let r;
  try { r = await api('/remote/members/code', { method: 'POST', body: '{}' }); } catch (e) {
    return f7.dialog.alert(e.code === 'NO_PUBLIC_ADDRESS' ? ct('要先讓這台 Mac 有固定的 HTTPS 網址（自己的網域或 Tailscale），其他 Mac 才能加入。快速通道的網址每次都會變。') : e.message);
  }
  const d = f7.dialog.create({
    title: ct('加入另一台 Mac'),
    content: '<div class="remote-join"><ol><li class="j1"></li><li class="j2"></li><li class="j3"></li></ol><div class="remote-join-label j4"></div><div class="remote-join-value hub"></div><div class="remote-join-label j5"></div><div class="remote-join-value code"></div><div class="remote-join-note j6"></div></div>',
    buttons: [{ text: ct('完成'), onClick: () => load() }],
  }).open();
  const put = (sel, text) => { const el = d.el.querySelector(sel);if (el) el.textContent = text; };
  put('.j1', ct('在另一台 Mac 安裝並打開 Castpane。'));
  put('.j2', ct('打開它的 Settings › Other Macs。'));
  put('.j3', ct('填入下面的網址和配對碼，按 Join。'));
  put('.j4', ct('網址'));put('.hub', r.hub);
  put('.j5', ct('配對碼'));put('.code', r.code.replace(/^(.{4})/, '$1-'));
  put('.j6', ct('配對碼 10 分鐘內有效，只能用一次。'));
}
function removeMac(m) {
  f7.dialog.confirm(ct('移除後，這台 Mac 就不會再出現在這裡；要再看到它，得在那台 Mac 重新加入。'), ct('移除「{name}」？').replace('{name}', () => m.name), async () => {
    try { await api(`/remote/members/${encodeURIComponent(m.id)}`, { method: 'DELETE' });localSet(shotKey(m.id), '');delete shots[m.id];load(); } catch (e) { f7.dialog.alert(e.message); }
  });
}

async function connect(m, retried = false) {
  if (!m.running || !supported) return;
  machine = m.local ? 'local' : m.id;
  let pass;
  try { pass = await getPass(retried); } catch (e) { return f7.dialog.alert(adminProblem(e) || e.message); }
  if (!pass) return;
  streaming.value = true;hasPicture.value = false;notice.value = '';permission.value = '';items.value = [];current.value = null;
  await nextTick();
  link = openRemote({
    pass, machine: machine === 'local' ? '' : machine, canvas: canvas.value,
    onState(state) {
      if (state === 'refused') { link = null;streaming.value = false;sessionSet('castpane-remote-pass', null);if (!retried) connect(m, true);else error.value = ct('無法連線，請重新整理頁面後再試。');return; }
      if (state === 'closed' && streaming.value) { saveShot();streaming.value = false;link = null; }
    },
    onMessage,
    onStats(s) { Object.assign(stats, s); },
  });
}

// Whether the last tap was on a text field: the Mac said so for the point under the
// finger, or the focus went into a field with this tap (a web page's field often answers
// the point with the text inside it, not the field; the owner's report, 2026-10-28), or
// the text cursor is now right where the finger was.
let focusWas = null;
const tappedFieldNow = (msg) => (probeAnswer?.n === probeN && !!probeAnswer.editable)
  || (msg?.editable && focusWas === false)
  || (msg?.editable && Array.isArray(msg.caret) && lastTap && Math.abs(msg.caret[0] + msg.caret[2] / 2 - lastTap.x) < 0.06 && Math.abs(msg.caret[1] + msg.caret[3] / 2 - lastTap.y) < 0.06);
function onMessage(msg) {
  if (msg.t === 'status') {
    const missing = [!msg.screen && ct('螢幕與系統錄音'), !msg.accessibility && ct('輔助使用')].filter(Boolean);
    permission.value = missing.join('、');
    if (msg.screen) list();
  } else if (msg.t === 'list') {
    items.value = msg.items || [];
    if (!current.value && items.value.length) show(items.value[0]);
  } else if (msg.t === 'started') {
    if (!current.value || current.value.kind !== msg.kind || current.value.id !== msg.id) resetView();
    current.value = { kind: msg.kind, id: msg.id };notice.value = '';
  } else if (msg.t === 'caret') {
    if (keyboardOpen.value && Array.isArray(msg.caret) && !zoomTo) keepInSight({ x: msg.caret[0] + msg.caret[2] / 2, y: msg.caret[1] + msg.caret[3] / 2 });
  } else if (msg.t === 'probe') {
    probeAnswer = msg;
  } else if (msg.t === 'clipboard') {
    clipWait?.resolve(msg);
  } else if (msg.t === 'clipboard-busy') {
    clipWait?.reject(new Error('busy'));
    toast(ct('太快了，請等一秒再試'));
  } else if (msg.t === 'clipboard-set') {
    toast(ct('已放到 Mac 的剪貼簿'));
  } else if (msg.t === 'focus') {
    // After a click: a text field has the focus, and the keyboard comes up (the hidden
    // field is already focused from the tap); out of one, it goes down again if it came
    // up by itself. Where that cannot happen, the keyboard button lights up instead.
    // Where the text cursor is: what the zoom aims at, rather than the tap.
    // At the start the capture core says where the focus is; nothing to open then.
    if (msg.initial) { focusWas = !!msg.editable;return; }
    const tappedField = tappedFieldNow(msg);
    focusWas = !!msg.editable;
    if (msg.editable && msg.caret && tappedField) {
      const c = { x: msg.caret[0] + msg.caret[2] / 2, y: msg.caret[1] + msg.caret[3] / 2, at: Date.now() };
      lastTap = c;
      if (keyboardOpen.value) { if (zoomTo) zoomTo = c;else keepInSight(c); }
    }
    // Only when the tap itself was on a text field: a field that already had the focus
    // (from before Remote, or a tap beside it) opens nothing and zooms nowhere.
    if (msg.editable && !keyboardOpen.value) {
      // Otherwise nothing lights up: a field keeping the focus while you tap elsewhere is
      // normal, and a light that stays on said nothing (the owner's report, 2026-10-28).
      if (tappedField && isTouch && document.activeElement === typing.value) { keyboardOpen.value = true;autoOpened = true; }
      else if (!isTouch) keyHint.value = true;
    } else if (!msg.editable && autoOpened) { keyboardOpen.value = false;autoOpened = false; }
    else if (!msg.editable) keyHint.value = false;
  } else if (msg.t === 'config') {
    hasPicture.value = true;
  } else if (msg.t === 'error') {
    notice.value = msg.message === 'not-running' ? ct('Castpane 沒有在執行') : msg.where === 'host' ? ct('Castpane 沒有回應，請稍後再試') : msg.message === 'gone' ? ct('這個視窗已經關閉') : msg.message;
    if (msg.where === 'start') list();
  } else if (msg.t === 'stopped') {
    notice.value = ct('畫面已停止：') + (msg.reason || '');
  } else if (msg.t === 'closed' && msg.reason === 'replaced') {
    error.value = ct('已在別的頁面打開遠端，這裡已中斷。');
  } else if (msg.t === 'closed' && msg.reason === 'ended on the Mac') {
    error.value = ct('這台 Mac 上停止了分享。');
  }
}

// The windows by desktop. A capture core that does not say (an older build) lists them all.
const groups = computed(() => {
  const all = items.value;
  if (!all.some((w) => w.kind === 'window' && w.desk !== undefined)) return all.length ? [{ key: 'all', label: '', items: all }] : [];
  const screens = all.filter((w) => w.kind === 'display');
  const displays = new Set(all.filter((w) => w.desk?.id).map((w) => w.desk.display));
  const byDesk = new Map();
  for (const w of all) {
    if (w.kind !== 'window') continue;
    const d = w.desk?.id ? w.desk : null, key = d ? 'd' + d.id : 'dock';
    if (!byDesk.has(key)) {
      const label = !d ? ct('Dock 裡') : d.fullscreen ? (w.app || ct('全螢幕')) + ' ' + ct('全螢幕') : (displays.size > 1 ? ct('螢幕') + ' ' + (d.display + 1) + ' · ' : '') + ct('桌面') + ' ' + d.number;
      byDesk.set(key, { key, label, current: !!d?.current, order: d ? d.display * 100 + (d.fullscreen ? 50 : d.number) : 9999, items: [] });
    }
    byDesk.get(key).items.push(w);
  }
  return [...(screens.length ? [{ key: 'screens', label: ct('整個螢幕'), order: -1, items: screens }] : []), ...[...byDesk.values()].sort((a, b) => a.order - b.order)];
});
const groupKey = ref('');
const shownItems = computed(() => (groups.value.find((g) => g.key === groupKey.value) || groups.value[0])?.items || []);
// Whichever holds what is shown, so the highlighted group matches the picture (opening,
// the whole screen is shown while the current desktop's tab used to be highlighted; a
// tester's report, 2026-10-29); the desktop shown now when nothing is shown yet.
watch(groups, (gs) => {
  if (gs.some((g) => g.key === groupKey.value)) return;
  const holding = current.value && gs.find((g) => g.items.some((w) => w.kind === current.value.kind && w.id === current.value.id));
  groupKey.value = (holding || gs.find((g) => g.current) || gs[0])?.key || '';
});
function list() { link?.send({ t: 'list' }); }
function show(w) {
  hasPicture.value = hasPicture.value && current.value?.kind === w.kind && current.value?.id === w.id;
  notice.value = ct('正在切換…');
  // Only values the server passes on (server/remote.js): a stale stored choice is left out.
  link?.send({ t: 'start', kind: w.kind, id: w.id, maxWidth: Object.hasOwn(RESOLUTION, prefs.resolution) ? RESOLUTION[prefs.resolution] : undefined, fps: prefs.fps === 30 ? 30 : 60, bitrate: Object.hasOwn(QUALITY, prefs.quality) ? QUALITY[prefs.quality] : undefined });
  current.value = { kind: w.kind, id: w.id };
}
function setPref(k, v) {
  prefs[k] = v;localSet('castpane-remote-prefs', JSON.stringify(prefs));
  const w = items.value.find((x) => current.value && x.kind === current.value.kind && x.id === current.value.id);
  if (w) show(w);
}
function askPermissions() { link?.send({ t: 'permissions' }); }
function saveShot() {
  try { const c = canvas.value;if (!c || !hasPicture.value) return;const s = document.createElement('canvas');s.width = 320;s.height = Math.round(320 * c.height / c.width);s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);shots[machine] = s.toDataURL('image/jpeg', 0.6);localSet(shotKey(machine), shots[machine]); } catch {}
}
function disconnect() {
  if (!streaming.value && !link) return;
  saveShot();
  try { link?.send({ t: 'stop' }); } catch {}
  link?.close();link = null;streaming.value = false;keyboardOpen.value = false;settingsOpen.value = false;menuOpen.value = false;held.clear();panel.value = false;compose.value = false;composeText.value = '';clipOpen.value = false;clipWait?.reject(new Error('closed'));
}
const headCollapsed = ref(localGet('castpane-remote-head') === 'folded');
function toggleHead() { headCollapsed.value = !headCollapsed.value;localSet('castpane-remote-head', headCollapsed.value ? 'folded' : 'open');menuOpen.value = false;settingsOpen.value = false; }
const MODES = [{ id: 'direct', label: '直接點', icon: 'hand_draw' }, { id: 'trackpad', label: '觸控板', icon: 'rectangle_on_rectangle' }, { id: 'pointer', label: '游標', icon: 'cursor_rays' }];
function setMode(m) { mode.value = m;localSet('castpane-remote-mode', m); }
function toggleMode() { setMode(mode.value === 'trackpad' ? 'direct' : 'trackpad'); }

// ---- pointer ----
const touches = new Map();
// Pinching zooms the picture here, on the device, and two fingers then move it around
// (a desktop is small on a phone); at full size two fingers scroll the Mac.
const view = reactive({ z: 1, x: 0, y: 0 });
function resetView() { view.z = 1;view.x = 0;view.y = 0; }
function clampView() {
  const r = area.value.getBoundingClientRect();
  view.z = Math.min(5, Math.max(1, view.z));
  view.x = Math.min(0, Math.max(r.width - r.width * view.z, view.x));view.y = Math.min(0, Math.max(r.height - r.height * view.z, view.y));
  if (view.z < 1.02) resetView();
}
function twoFingers() {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}
let probeN = 0, probeAnswer = null, autoOpened = false;
let pending = null, raf = 0, cursor = { x: 0.5, y: 0.5 }, gesture = null, longTimer = 0;
const mods = () => [...held];
// A move still waiting for the next frame goes now: before a button is let go, it must arrive first.
function flushMove() { if (raf) { cancelAnimationFrame(raf);raf = 0; } if (pending) { link?.send({ t: 'move', x: pending.x, y: pending.y });pending = null; } }
function sendMove(p) { pending = p;if (!raf) raf = requestAnimationFrame(() => { raf = 0;if (pending) link?.send({ t: 'move', x: pending.x, y: pending.y });pending = null; }); }
// With the phone's keyboard up, the stage fits what is left above it, and the text
// field just tapped is zoomed in and brought to the middle; the keyboard down, the
// picture goes back as it was (the owner's request, 2026-10-28).
const stageBox = ref(null);
let lastTap = null, beforeKeyboard = null, zoomTo = null, settle = 0;
// Zoomed once, to the field whose tap opened the keyboard, after the keyboard has
// finished coming up; later taps while it is up do not move the picture (the owner's
// report, 2026-10-28: a tap elsewhere zoomed to that place instead).
function fitViewport() {
  const vv = window.visualViewport;
  if (!vv || !isTouch) return;
  const covered = window.innerHeight - vv.height > 80;
  stageBox.value = covered ? { top: vv.offsetTop + 'px', height: vv.height + 'px', bottom: 'auto' } : null;
  clearTimeout(settle);
  if (covered && zoomTo) settle = setTimeout(() => { if (zoomTo && keyboardOpen.value) { focusOn(zoomTo);zoomTo = null; } }, 250);
}
// A point of the picture (0…1) in the area's own pixels, before any zoom.
function areaPoint(p) {
  const a = area.value, c = canvas.value;if (!a || !c) return null;
  const r = a.getBoundingClientRect(), vw = c.width || 1, vh = c.height || 1;
  const scale = Math.min(r.width / vw, r.height / vh), pw = vw * scale, ph = vh * scale;
  return { r, vw, px: (r.width - pw) / 2 + p.x * pw, py: (r.height - ph) / 2 + p.y * ph };
}
// The text cursor kept in sight while typing: moved back to the middle when it
// leaves the part shown (the owner's request, 2026-10-28: zoom by the cursor).
function keepInSight(p) {
  const at = areaPoint(p);if (!at || view.z <= 1) return;
  const sx = view.x + view.z * at.px, sy = view.y + view.z * at.py, m = 40;
  if (sx >= m && sx <= at.r.width - m && sy >= m && sy <= at.r.height - m) return;
  view.x = at.r.width / 2 - view.z * at.px;view.y = at.r.height * 0.45 - view.z * at.py;clampView();
}
// Puts a point of the picture (0…1) in the middle of the area, zoomed so text reads.
function focusOn(p) {
  const at = areaPoint(p);if (!at) return;
  const { r, vw, px, py } = at;
  if (!beforeKeyboard) beforeKeyboard = { ...view };
  // About 900 Mac pixels across the phone: a text field and its line are readable.
  view.z = Math.max(view.z, Math.min(5, Math.max(1.5, (vw / Math.max(1, Math.min(vw, 900))))));
  view.x = r.width / 2 - view.z * px;view.y = r.height * 0.45 - view.z * py;
  clampView();
}
watch(keyboardOpen, (open) => {
  // No keyboard came up over the page (a hardware keyboard): nothing waits to zoom.
  if (open) { zoomTo = lastTap && Date.now() - lastTap.at < 5000 ? { ...lastTap } : null;nextTick(fitViewport);setTimeout(() => { if (!stageBox.value) zoomTo = null; }, 1500); }
  else { zoomTo = null;if (beforeKeyboard) { Object.assign(view, beforeKeyboard);beforeKeyboard = null; } }
});
if (typeof window !== 'undefined' && window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitViewport);
  window.visualViewport.addEventListener('scroll', fitViewport);
  onBeforeUnmount(() => { window.visualViewport.removeEventListener('resize', fitViewport);window.visualViewport.removeEventListener('scroll', fitViewport); });
}
// The pointer and its ring, in the area's pixels; the ring sits below the pointer, or
// above it near the bottom edge.
const ring = reactive({ active: false, holding: false, dragging: false });
let ringSide = 'below';
const cursorTick = ref(0);
// The area's size: the ring is placed again when it changes (the keyboard going away
// left it above the pointer; the owner's report, 2026-10-28).
const areaSize = ref('');
let areaWatch = null;
watch(area, (el) => {
  areaWatch?.disconnect();areaWatch = null;
  if (el && typeof ResizeObserver === 'function') { areaWatch = new ResizeObserver(() => { const r = el.getBoundingClientRect();areaSize.value = r.width + 'x' + r.height; });areaWatch.observe(el); }
});
onBeforeUnmount(() => areaWatch?.disconnect());
const handle = computed(() => {
  // Read for the computed to follow them (Vue tracks what it reads).
  // oxlint-disable-next-line no-unused-expressions
  cursorTick.value;view.x;view.y;view.z;areaSize.value;
  const at = area.value && canvas.value ? areaPoint(cursor) : null;if (!at) return null;
  const cx = view.x + view.z * at.px, cy = view.y + view.z * at.py, R = 34, gap = 92;
  // Below the pointer when there is room, above it near the bottom; never switched while
  // the ring is being dragged, so the finger stays on it (the owner's reports, 2026-10-28).
  if (!ringPress) ringSide = cy + gap + R <= at.r.height ? 'below' : 'above';
  return { cx, cy, rx: Math.min(at.r.width - R, Math.max(R, cx)), ry: ringSide === 'below' ? Math.min(at.r.height - R, cy + gap) : Math.max(R, cy - gap) };
});
function moveCursor(p) { cursor = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };cursorTick.value++; }
let ringPress = null;
function ringDown(e) {
  if (!link) return;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  ringPress = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
  ring.active = true;
  probeAnswer = null;link.send({ t: 'probe', x: cursor.x, y: cursor.y, n: ++probeN });
  // Held still it turns orange: let go then for a right-click, or drag on to drag on
  // the Mac with the button held (the owner's question, 2026-10-28: left and right).
  clearTimeout(longTimer);
  longTimer = setTimeout(() => { if (ringPress && ringPress.moved < 8) ring.holding = true; }, 450);
}
function ringMove(e) {
  if (!ringPress) return;
  const dx = e.clientX - ringPress.x, dy = e.clientY - ringPress.y;ringPress.x = e.clientX;ringPress.y = e.clientY;
  ringPress.moved += Math.abs(dx) + Math.abs(dy);
  if (ring.holding && !ring.dragging && ringPress.moved >= 8) { ring.dragging = true;link?.send({ t: 'button', b: 0, down: true, x: cursor.x, y: cursor.y }); }
  const at = areaPoint(cursor);if (!at) return;
  const c = canvas.value, scale = Math.min(at.r.width / (c.width || 1), at.r.height / (c.height || 1));
  moveCursor({ x: cursor.x + dx / ((c.width || 1) * scale * view.z), y: cursor.y + dy / ((c.height || 1) * scale * view.z) });
  sendMove(cursor);
}
function ringUp() {
  if (!ringPress) return;
  clearTimeout(longTimer);
  const press = ringPress;ringPress = null;ring.active = false;
  if (ring.holding) {
    ring.holding = false;
    if (ring.dragging) { ring.dragging = false;flushMove();link?.send({ t: 'button', b: 0, down: false, x: cursor.x, y: cursor.y }); }
    else click(cursor, 1);
    return;
  }
  if (press.moved < 8 && performance.now() - press.t < 450) {
    click(cursor, 0);
    if (probeAnswer?.n === probeN && probeAnswer.editable && !keyboardOpen.value) keyboardOpen.value = true;
    if (document.activeElement !== typing.value) typing.value?.focus({ preventScroll: true });
  }
}
function click(p, b = 0) {
  if (b === 0) lastTap = { x: p.x, y: p.y, at: Date.now() }; link?.send({ t: 'move', x: p.x, y: p.y });link?.send({ t: 'button', b, down: true, x: p.x, y: p.y });link?.send({ t: 'button', b, down: false, x: p.x, y: p.y });releaseMods(); }
const pixelScale = () => { const r = canvas.value.getBoundingClientRect();return (canvas.value.width || 1) / Math.max(1, r.width); };

function down(e) {
  if (!link || settingsOpen.value || menuOpen.value) { settingsOpen.value = false;menuOpen.value = false;return; }
  // A button over the picture (asking for the permission) keeps its own tap.
  if (e.target.closest?.('button')) return;
  try { area.value.setPointerCapture?.(e.pointerId); } catch {}
  const p = toPicture(canvas.value, e.clientX, e.clientY);
  if (e.pointerType === 'mouse') {
    if (!p.inside) return;
    link.send({ t: 'move', x: p.x, y: p.y });
    link.send({ t: 'button', b: e.button === 2 ? 1 : e.button === 1 ? 2 : 0, down: true, x: p.x, y: p.y });
    typing.value?.focus({ preventScroll: true });
    return;
  }
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
  if (touches.size === 1) {
    // Ask now whether a text field is under the finger: by the time it lifts the answer
    // is here, and the keyboard can open in the tap itself (iOS allows no other time).
    probeAnswer = null;
    if (isTouch && mode.value !== 'pointer') { const at = mode.value === 'trackpad' ? cursor : p;link.send({ t: 'probe', x: at.x, y: at.y, n: ++probeN }); }
    gesture = { kind: 'tap', moved: 0 };
    clearTimeout(longTimer);
    if (mode.value === 'direct') longTimer = setTimeout(() => { if (gesture?.kind === 'tap' && gesture.moved < 10) { click(p, 1);gesture = { kind: 'done' }; } }, 550);
  } else if (touches.size === 2) { gesture = { kind: 'two', moved: 0, t: performance.now() };clearTimeout(longTimer); }
}
function move(e) {
  if (!link) return;
  if (e.pointerType === 'mouse') { const p = toPicture(canvas.value, e.clientX, e.clientY);if (p.inside || e.buttons) sendMove(p);return; }
  const t = touches.get(e.pointerId);if (!t) return;
  const dx = e.clientX - t.x, dy = e.clientY - t.y;t.x = e.clientX;t.y = e.clientY;
  if (!gesture) return;
  gesture.moved += Math.abs(dx) + Math.abs(dy);
  const scale = pixelScale();
  if (touches.size >= 2) {
    const now = twoFingers(), r = area.value.getBoundingClientRect();
    if (!gesture.pinch) gesture.pinch = { d0: now.d, cx0: now.cx, cy0: now.cy, d: now.d, cx: now.cx, cy: now.cy };
    const last = gesture.pinch;
    // Which it is shows once the fingers have moved: apart or together zooms, both the
    // same way scrolls (or moves a zoomed picture).
    if (!['zoom', 'pan', 'scroll2'].includes(gesture.kind)) {
      const spread = Math.abs(now.d - last.d0), travel = Math.hypot(now.cx - last.cx0, now.cy - last.cy0);
      if (spread > 24 && spread > travel) gesture.kind = 'zoom';
      else if (travel > 16) {
        gesture.kind = 'scroll2';
        // One axis for the whole scroll, the one it started along, as a Mac trackpad
        // does: a slightly slanted two-finger drag used to scroll nothing in many apps
        // (a tester's report, 2026-10-29).
        gesture.axis = Math.abs(now.cx - last.cx0) > Math.abs(now.cy - last.cy0) ? 'x' : 'y';
      }
    }
    if (gesture.kind === 'zoom' || gesture.kind === 'pan') {
      const z = view.z, nz = Math.min(5, Math.max(1, z * (gesture.kind === 'zoom' ? now.d / Math.max(1, last.d) : 1)));
      const ox = now.cx - r.left, oy = now.cy - r.top;
      view.x = ox - (ox - view.x) * (nz / z) + (now.cx - last.cx);view.y = oy - (oy - view.y) * (nz / z) + (now.cy - last.cy);view.z = nz;
      clampView();
    } else if (gesture.kind === 'scroll2') {
      const at = mode.value === 'trackpad' ? cursor : toPicture(canvas.value, now.cx, now.cy);
      const sx = gesture.axis === 'y' ? 0 : -(now.cx - last.cx) * scale, sy = gesture.axis === 'x' ? 0 : -(now.cy - last.cy) * scale;
      link.send({ t: 'scroll', dx: sx, dy: sy, x: at.x, y: at.y });
    }
    gesture.pinch = { ...last, d: now.d, cx: now.cx, cy: now.cy };
    clearTimeout(longTimer);
  } else if (mode.value !== 'trackpad' && view.z > 1 && gesture.moved > 10 && gesture.kind !== 'done') {
    // Zoomed in, one finger moves the picture around; two fingers scroll the Mac (the
    // owner's request, 2026-10-28).
    gesture.kind = 'pan1';
    view.x += dx;view.y += dy;clampView();
    clearTimeout(longTimer);
  } else if (mode.value !== 'trackpad' && gesture.moved > 10 && gesture.kind !== 'done') {
    // One finger dragged in direct mode scrolls, as on an iPhone.
    if (gesture.kind === 'tap') { gesture.kind = 'scroll';gesture.axis = Math.abs(e.clientX - t.sx) > Math.abs(e.clientY - t.sy) ? 'x' : 'y'; }
    const at = toPicture(canvas.value, t.sx, t.sy);
    link.send({ t: 'scroll', dx: gesture.axis === 'y' ? 0 : -dx * scale, dy: gesture.axis === 'x' ? 0 : -dy * scale, x: at.x, y: at.y });
    clearTimeout(longTimer);
  } else if (mode.value === 'trackpad' && gesture.moved > 3 && gesture.kind !== 'done') {
    gesture.kind = 'pad';
    const r = canvas.value.getBoundingClientRect();
    moveCursor({ x: cursor.x + dx * 1.6 / r.width, y: cursor.y + dy * 1.6 / r.height });
    sendMove(cursor);
  }
}
function up(e) {
  if (!link) return;
  if (e.pointerType === 'mouse') { const p = toPicture(canvas.value, e.clientX, e.clientY);link.send({ t: 'button', b: e.button === 2 ? 1 : e.button === 1 ? 2 : 0, down: false, x: p.x, y: p.y });return; }
  const t = touches.get(e.pointerId);touches.delete(e.pointerId);clearTimeout(longTimer);
  if (!t || !gesture) return;
  const quick = performance.now() - t.t < 350;
  if (gesture.kind === 'two' && quick && touches.size === 0) { click(mode.value !== 'direct' ? cursor : toPicture(canvas.value, t.sx, t.sy), 1);gesture = null;return; }
  if (gesture.kind === 'tap' && quick && gesture.moved < 10 && touches.size === 0) {
    const p = mode.value === 'trackpad' ? cursor : toPicture(canvas.value, t.sx, t.sy);
    // The black bars around the picture are not the Mac: a tap there clicks nothing
    // (it used to land on the picture's edge; the owner's report, 2026-10-28).
    if (mode.value !== 'trackpad' && !p.inside) { gesture = null;return; }
    // Pointer mode: a tap elsewhere only brings the pointer there; the ring clicks.
    if (mode.value === 'pointer') { moveCursor(p);sendMove(cursor);gesture = null;return; }
    if (mode.value === 'direct') cursor = p;
    click(p, 0);
    if (probeAnswer?.n === probeN && probeAnswer.editable && !keyboardOpen.value) keyboardOpen.value = true;
    // The hidden field takes the focus in the tap itself, with no keyboard (inputmode
    // none): when the Mac's answer comes a moment later, switching it to text brings
    // the keyboard up, which iOS would not do for a focus outside a tap.
    if (isTouch && document.activeElement !== typing.value) typing.value?.focus({ preventScroll: true });
  }
  // The finger left over from a pinch or a two-finger move does nothing until lifted.
  if (touches.size === 1 && ['two', 'zoom', 'pan', 'scroll2'].includes(gesture.kind)) gesture = { kind: 'done', moved: 0 };
  if (touches.size === 0) gesture = null;
}
function cancel(e) { touches.delete(e.pointerId);clearTimeout(longTimer);if (!touches.size) gesture = null; }
function wheel(e) {
  if (!link) return;
  const p = toPicture(canvas.value, e.clientX, e.clientY);if (!p.inside) return;
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  link.send({ t: 'scroll', dx: e.deltaX * unit, dy: e.deltaY * unit, x: p.x, y: p.y });
}

// ---- keys ----
function toggleKeyboard() {
  keyHint.value = false;autoOpened = false;
  keyboardOpen.value = !keyboardOpen.value;
  if (keyboardOpen.value) nextTick(() => typing.value?.focus({ preventScroll: true }));else typing.value?.blur();
}
// The Mac's desktops (Spaces), with its own shortcut ⌃← ⌃→; the windows are listed again
// after the switch.
function space(code) {
  menuOpen.value = false;
  link?.send({ t: 'key', code, down: true, mods: ['ctrl'] });link?.send({ t: 'key', code, down: false, mods: ['ctrl'] });
  setTimeout(list, 900);
}
function toggleMod(id) { if (held.has(id)) held.delete(id);else held.add(id); }
function releaseMods() { held.clear(); }
function tap(code) {
  link?.send({ t: 'key', code, down: true, mods: mods() });link?.send({ t: 'key', code, down: false, mods: mods() });releaseMods();
  if (keyboardOpen.value) typing.value?.focus({ preventScroll: true });
}
function sendText(s) {
  if (!s) return;
  // With ⌘ ⌃ ⌥ held from the keys row, a typed character is a shortcut, not text.
  if (held.size && [...s].length === 1 && codeOfChar(s) && (held.has('meta') || held.has('ctrl') || held.has('alt'))) return tap(codeOfChar(s));
  // In pieces of at most 1000 characters, whole characters each: the server passes on
  // at most 4000 UTF-16 units at once.
  const chars = [...s];
  for (let i = 0; i < chars.length; i += 1000) link?.send({ t: 'text', s: chars.slice(i, i + 1000).join('') });
  releaseMods();
}
function beforeInput(e) {
  if (e.isComposing || e.inputType === 'insertCompositionText') return;
  e.preventDefault();
  if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') sendText(e.data || e.dataTransfer?.getData('text') || '');
  else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') tap('Enter');
  else if (e.inputType === 'deleteContentBackward') tap('Backspace');
  else if (e.inputType === 'deleteContentForward') tap('Delete');
  else if (e.inputType === 'insertFromPaste') sendText(e.dataTransfer?.getData('text') || '');
}
// The panel takes the phone keyboard's place; closing it brings the keyboard back.
function togglePanel() {
  compose.value = false;
  if (panel.value) { panel.value = false;keyboardOpen.value = true;typing.value?.focus({ preventScroll: true });return; }
  panel.value = true;typing.value?.blur();composeField.value?.blur();
  nextTick(() => goPage(pageNo.value, false));
}
function goPage(i, smooth = true) { pageNo.value = i;const el = pagesEl.value;if (el) el.scrollTo({ left: i * el.clientWidth, behavior: smooth ? 'smooth' : 'auto' }); }
function pageScroll() { const el = pagesEl.value;if (el && el.clientWidth) pageNo.value = Math.round(el.scrollLeft / el.clientWidth); }
function press(k) {
  if (k.text) return sendText(k.text);
  if (!k.mods) return tap(k.code);
  const m = [...new Set([...k.mods, ...held])];
  link?.send({ t: 'key', code: k.code, down: true, mods: m });link?.send({ t: 'key', code: k.code, down: false, mods: m });releaseMods();
}
function toggleCompose() {
  panel.value = false;
  if (compose.value) { compose.value = false;composeField.value?.blur();return; }
  compose.value = true;
  nextTick(() => composeField.value?.focus({ preventScroll: true }));
}
function sendCompose() {
  const s = composeText.value;
  if (!s) return;
  const chars = [...s];
  for (let i = 0; i < chars.length; i += 1000) link?.send({ t: 'text', s: chars.slice(i, i + 1000).join('') });
  composeText.value = '';releaseMods();
  composeField.value?.focus({ preventScroll: true });
}
// ---- clipboard ----
const toast = (text) => f7.toast.create({ text, closeTimeout: 2200 }).open();
let clipWait = null;
// The Mac's answer to clipboard-get, or a rejection after five seconds.
function askClipboard() {
  clipWait?.reject(new Error('replaced'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => clipWait?.reject(new Error('timeout')), 5000);
    const done = () => { clearTimeout(timer);clipWait = null; };
    clipWait = { resolve: (m) => { done();resolve(m); }, reject: (e) => { done();reject(e); } };
    link?.send({ t: 'clipboard-get' });
  });
}
async function copyFromMac() {
  clipOpen.value = false;
  const answer = askClipboard();
  const textOf = (m) => { if (m.concealed || m.empty || !m.s) throw new Error('no text');return m.s; };
  try {
    // Written in the tap itself, with the text still on its way: what Safari allows.
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': answer.then((m) => new Blob([textOf(m)], { type: 'text/plain' })) })]);
    else await navigator.clipboard.writeText(textOf(await answer));
    const m = await answer;
    toast(m.truncated ? ct('已拷貝 Mac 的剪貼簿（太長，只拷了前面 100 000 字）') : ct('已拷貝 Mac 的剪貼簿'));
  } catch {
    let m = null, why = '';
    try { m = await answer; } catch (e) { why = e.message; }
    if (why === 'busy') return;
    if (!m) return toast(ct('Mac 沒有回應，請再試一次'));
    if (m.notAllowed) return f7.dialog.alert(ct('這台 Mac 還沒允許從遠端讀剪貼簿。請在 Mac 上打開 Castpane 的 Settings › General，按「Clipboard from afar」旁的「Allow…」，再到「系統設定 › 隱私權與安全性」的貼上權限，把 Castpane 設為允許。'));
    if (m.denied) return toast(ct('這台 Mac 設定不允許 Castpane 讀剪貼簿'));
    if (m.concealed) return toast(ct('Mac 剪貼簿裡是密碼工具標為隱藏的內容，不會傳出'));
    if (m.error) return toast(ct('Mac 的剪貼簿內容無法傳出'));
    if (m.truncated && !m.s) return toast(ct('Mac 剪貼簿的內容太長，無法傳出'));
    if (m.empty || !m.s) return toast(ct('Mac 的剪貼簿裡沒有文字'));
    // This browser would not take it: the text, to copy by hand.
    const d = f7.dialog.create({ title: ct('Mac 的剪貼簿'), content: '<textarea class="remote-clip-text" readonly></textarea>', buttons: [{ text: ct('關閉') }] }).open();
    const area = d.el.querySelector('.remote-clip-text');
    if (area) area.value = m.s;
  }
}
async function pasteToMac() {
  clipOpen.value = false;
  let s = null;
  try { s = await navigator.clipboard.readText(); } catch { /* refused or not there */ }
  const put = (v) => {
    if (!v) return toast(ct('這台裝置的剪貼簿裡沒有文字'));
    if (v.length > 100000) return toast(ct('文字太長，最多 100 000 字'));
    if (!v.isWellFormed()) v = v.toWellFormed();
    link?.send({ t: 'clipboard-set', s: v });
  };
  // This browser would not read it: a field to paste into.
  if (s === null) return f7.dialog.prompt(ct('貼上要放到 Mac 剪貼簿的文字。'), ct('把剪貼簿放到 Mac'), put);
  put(s);
}
// Return sends, except while the input method is still choosing characters.
function composeKey(e) {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();sendCompose();
}
function compositionEnd(e) { sendText(e.data || '');if (typing.value) typing.value.value = ''; }
const sentDown = new Set();
// A hardware keyboard: shortcuts and keys that type nothing go as keys; what types
// text goes through beforeinput, so input methods work.
function keyDown(e) {
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return;
  const special = e.key.length > 1 && e.key !== 'Unidentified';
  if (e.metaKey || e.ctrlKey || e.altKey || special) {
    if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'].includes(e.key)) return;
    e.preventDefault();
    const m = [e.shiftKey && 'shift', e.ctrlKey && 'ctrl', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean);
    for (const x of held) if (!m.includes(x)) m.push(x);
    link?.send({ t: 'key', code: e.code, down: true, mods: m });sentDown.add(e.code);
  }
}
// Leaving the field lets go of what the computer's keyboard held there.
function typingBlur() {
  // A press on the pointer's ring keeps the keyboard where it is.
  if (ringPress && keyboardOpen.value) { setTimeout(() => typing.value?.focus({ preventScroll: true }), 0);return; }
  keyboardOpen.value = false;
  for (const code of sentDown) link?.send({ t: 'key', code, down: false, mods: [] });
  sentDown.clear();
}
function keyUp(e) {
  if (!sentDown.has(e.code)) return;
  sentDown.delete(e.code);
  link?.send({ t: 'key', code: e.code, down: false, mods: [] });releaseMods();
}
</script>
<style>
.remote-note {font-size:13px;line-height:1.5;color:var(--dp-color-text-secondary,#8e8e93);margin:12px 32px;}
.remote-error {color:#ff453a;}
.remote-tiles {display:flex;flex-wrap:wrap;gap:16px;padding:0 16px;}
.remote-tile {width:min(260px,calc(50vw - 24px));background:var(--f7-list-bg-color,#1f1f21);border:0;border-radius:20px;padding:10px;color:inherit;text-align:left;cursor:pointer;}
.remote-tile.disabled {opacity:.5;cursor:default;}
.remote-tile-wrap {position:relative;}
.remote-tile-remove {position:absolute;top:16px;right:16px;width:26px;height:26px;border-radius:13px;border:0;background:rgba(0,0,0,.6);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.remote-tile.add .remote-tile-shot {background:rgba(255,255,255,.04);border:1.5px dashed rgba(142,142,147,.5);box-sizing:border-box;}
.remote-join ol {margin:0 0 10px;padding-left:20px;text-align:left;font-size:14px;line-height:1.5;}
.remote-join-label {font-size:12px;color:#8e8e93;margin-top:8px;text-align:left;}
.remote-join-value {font-size:15px;font-weight:600;text-align:left;word-break:break-all;-webkit-user-select:text;user-select:text;}
.remote-join-value.code {font-size:24px;letter-spacing:2px;font-variant-numeric:tabular-nums;}
.remote-join-note {font-size:12px;color:#8e8e93;margin-top:10px;text-align:left;}
.remote-tile-shot {aspect-ratio:16/10;border-radius:12px;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#8e8e93;}
.remote-tile-shot img {width:100%;height:100%;object-fit:cover;}
.remote-tile-name {margin-top:8px;font-weight:600;font-size:15px;}
.remote-tile-sub {font-size:12px;color:var(--dp-color-text-secondary,#8e8e93);}
.remote-stage {-webkit-touch-callout:none;position:fixed;inset:0;z-index:12000;background:#000;display:flex;flex-direction:column;color:#fff;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);user-select:none;-webkit-user-select:none;}
.remote-desks {display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:6px 8px 0;background:rgba(28,28,30,.96);}
.remote-desks::-webkit-scrollbar {display:none;}
.remote-stage .remote-desk {flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;width:auto;margin:0;padding:5px 10px;border-radius:14px;border:1px solid transparent;background:rgba(255,255,255,.08);color:#ddd;font-size:12px;white-space:nowrap;cursor:pointer;}
.remote-stage .remote-desk.current::before {content:'';width:6px;height:6px;border-radius:3px;background:#30d158;}
.remote-stage .remote-desk.active {background:rgba(10,132,255,.25);border-color:#0a84ff;color:#fff;}
.remote-desk-count {font-size:10px;color:#8e8e93;}
.remote-bar {display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(28,28,30,.96);border-bottom:1px solid rgba(255,255,255,.08);}
.remote-thumbs {flex:1;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;}
.remote-thumbs::-webkit-scrollbar {display:none;}
.remote-thumb {flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:3px;width:84px;padding:4px;border-radius:10px;border:1px solid transparent;background:rgba(255,255,255,.06);color:#ddd;font-size:11px;cursor:pointer;}
.remote-thumb img {width:76px;height:44px;object-fit:cover;border-radius:6px;background:#111;}
.remote-thumb span {max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.remote-thumb {position:relative;}
.remote-away {position:absolute;top:6px;left:6px;font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;background:rgba(0,0,0,.7);color:#ffd60a;}
.remote-thumb.active {border-color:#0a84ff;background:rgba(10,132,255,.18);color:#fff;}
.remote-actions {display:flex;gap:4px;}
.remote-btn {width:36px;height:36px;border-radius:18px;border:0;background:rgba(255,255,255,.1);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.remote-btn.on {background:#0a84ff;}
.remote-btn.hint {box-shadow:0 0 0 2px #0a84ff;animation:remote-hint 1.2s ease-in-out infinite;}
@keyframes remote-hint {50% {box-shadow:0 0 0 5px rgba(10,132,255,.35);}}
.remote-btn.danger {background:rgba(255,69,58,.25);color:#ff6961;}
.remote-area {position:relative;flex:1;min-height:0;touch-action:none;overflow:hidden;}
.remote-canvas {width:100%;height:100%;object-fit:contain;display:block;cursor:default;transform-origin:0 0;}
.remote-btn.zoom {font-size:12px;font-weight:600;}
.remote-canvas.hidden {visibility:hidden;}
.remote-notice {position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:24px;background:rgba(0,0,0,.6);font-size:14px;line-height:1.5;}
.remote-notice p {max-width:520px;margin:0;}
.remote-small {font-size:12px;color:#aaa;}
.remote-pill {border:0;border-radius:18px;padding:8px 16px;background:#0a84ff;color:#fff;font-size:14px;cursor:pointer;}
.remote-arrow {position:absolute;pointer-events:none;transform:translate(-2px,-2px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));z-index:1;}
.remote-ring {-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;position:absolute;width:68px;height:68px;margin:-34px 0 0 -34px;border-radius:50%;border:2.5px solid rgba(255,255,255,.9);background:rgba(255,255,255,.06);box-shadow:0 0 0 1px rgba(0,0,0,.35),0 2px 10px rgba(0,0,0,.4);touch-action:none;z-index:1;}
.remote-ring.active {background:rgba(10,132,255,.55);}
.remote-ring.holding {background:rgba(255,159,10,.65);}
.remote-menu-label {font-size:11px;color:#8e8e93;padding:6px 12px 2px;}
.remote-menu-sep {height:1px;background:rgba(255,255,255,.1);margin:4px 6px;}
.remote-stage .remote-menu-item .remote-menu-check {margin-left:auto;color:#0a84ff;}
.remote-pad-hint {position:absolute;left:0;right:0;bottom:8px;text-align:center;font-size:11px;color:rgba(255,255,255,.45);pointer-events:none;}
/* One slim row that scrolls sideways, above the phone's keyboard (the owner's report,
   2026-10-28: the keys had grown to one full-width row each). */
.remote-keys {display:flex;flex-wrap:nowrap;align-items:center;gap:5px;padding:5px 8px;overflow-x:auto;scrollbar-width:none;background:rgba(28,28,30,.96);border-top:1px solid rgba(255,255,255,.08);}
.remote-keys::-webkit-scrollbar {display:none;}
.remote-keys.desk .remote-key {display:none;}
.remote-stage .remote-key {display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:auto;min-width:36px;height:30px;padding:0 8px;margin:0;border-radius:7px;border:0;background:rgba(255,255,255,.12);color:#fff;font-size:13px;line-height:1;cursor:pointer;}
.remote-key.mod.on, .remote-key.tool.on {background:#0a84ff;}
.remote-clip {display:flex;gap:6px;padding:6px 8px;background:rgba(28,28,30,.96);border-top:1px solid rgba(255,255,255,.08);}
.remote-stage .remote-clip-btn {flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;width:auto;height:36px;margin:0;padding:0 8px;border:0;border-radius:9px;background:rgba(255,255,255,.12);color:#fff;font-size:13px;cursor:pointer;white-space:nowrap;}
.remote-keys.desk .remote-key.clip-btn {display:inline-flex;}
.remote-clip-text {width:100%;height:160px;box-sizing:border-box;font-size:14px;-webkit-user-select:text;user-select:text;}
.remote-compose {display:flex;gap:6px;padding:6px 8px;background:rgba(28,28,30,.96);border-top:1px solid rgba(255,255,255,.08);}
.remote-compose-field {flex:1;min-width:0;height:36px;box-sizing:border-box;padding:0 10px;border-radius:9px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.5);color:#fff;font-size:16px;-webkit-user-select:text;user-select:text;}
.remote-stage .remote-compose-send {flex:0 0 auto;width:auto;height:36px;margin:0;padding:0 14px;border:0;border-radius:9px;background:#0a84ff;color:#fff;font-size:14px;cursor:pointer;}
.remote-stage .remote-compose-send:disabled {opacity:.4;}
.remote-panel {background:rgba(28,28,30,.96);}
.remote-pages {display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;}
.remote-pages::-webkit-scrollbar {display:none;}
.remote-page-grid {flex:0 0 100%;scroll-snap-align:start;display:grid;grid-template-rows:repeat(4,46px);gap:1px;background:rgba(255,255,255,.08);}
.remote-page-grid.cols-3 {grid-template-columns:repeat(3,1fr);}
.remote-page-grid.cols-4 {grid-template-columns:repeat(4,1fr);}
.remote-page-grid.page-edit, .remote-page-grid.page-fn {grid-template-rows:repeat(3,61px);padding-bottom:2px;}
.remote-stage .remote-pkey {width:auto;height:auto;margin:0;padding:0;border:0;border-radius:0;background:#1c1c1e;color:#fff;font-size:15px;cursor:pointer;}
.remote-stage .remote-pkey:active {background:#3a3a3c;}
.remote-dots {display:flex;justify-content:center;gap:10px;padding:7px 0 5px;}
.remote-stage .remote-dots button {width:7px;height:7px;margin:0;padding:0;border:0;border-radius:50%;background:rgba(255,255,255,.3);cursor:pointer;}
.remote-stage .remote-dots button.on {background:#fff;}
.remote-stats {flex:0 0 auto;padding-left:6px;margin-left:auto;font-size:11px;color:#8e8e93;font-variant-numeric:tabular-nums;}
.remote-typing {position:absolute;left:-1000px;top:0;width:10px;height:10px;opacity:0;}
.remote-settings {position:absolute;right:8px;top:calc(100% + 6px);width:min(320px,calc(100vw - 16px));background:rgba(44,44,46,.98);border-radius:16px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.5);}
.remote-head {position:relative;z-index:2;}
.remote-head.collapsed {position:absolute;top:env(safe-area-inset-top);right:0;}
.remote-head.collapsed .remote-bar {background:transparent;border:0;padding:8px;}
.remote-head.collapsed .remote-btn {background:rgba(44,44,46,.85);box-shadow:0 2px 8px rgba(0,0,0,.4);}
.remote-menu {position:absolute;right:8px;top:calc(100% + 6px);min-width:200px;background:rgba(44,44,46,.98);border-radius:14px;padding:6px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;}
.remote-stage .remote-menu-item {display:flex;align-items:center;gap:10px;width:100%;margin:0;border:0;background:transparent;color:#fff;font-size:15px;text-align:left;padding:10px 12px;border-radius:9px;cursor:pointer;}
.remote-stage .remote-menu-item:active {background:rgba(255,255,255,.1);}
.remote-stage .remote-menu-item.disconnect {color:#ff6961;}
.remote-set-title {font-size:12px;color:#aaa;margin:8px 0 6px;}
.remote-seg {display:flex;gap:4px;background:rgba(255,255,255,.08);border-radius:10px;padding:3px;}
.remote-seg button {flex:1;border:0;border-radius:8px;padding:6px 0;background:transparent;color:#ddd;font-size:13px;cursor:pointer;}
.remote-seg button.on {background:#0a84ff;color:#fff;}
@media (min-width: 800px){.remote-note{max-width:min(828px,calc(100% - 32px));margin-left:auto;margin-right:auto;padding:0 16px;box-sizing:border-box;}}
</style>
