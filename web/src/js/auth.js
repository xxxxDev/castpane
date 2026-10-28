import { ref, computed } from 'vue';
import { setLang } from './i18n.js';
import { api } from './api.js';
export { api } from './api.js';

export const currentUser = ref(null);
export const authLoading = ref(true);
export const authError = ref(null);

export const isAuthenticated = computed(() => Boolean(currentUser.value));

function applyUser(user) {
  currentUser.value = user;
  if (user?.language) setLang(user.language, { persist: false });
}

const VERIFY_TIMEOUT_MS = 8000, VERIFY_TRIES = 2;

export async function verifyAuth() {
  authLoading.value = true;
  authError.value = null;
  try {
    // A request that never answers (a phone back from the background, a network just
    // changed) would leave the app on its start page for good: each check gets a time
    // limit, and one that runs out is asked again.
    let data;
    for (let tries = 1; ; tries++) {
      try { data = await api('/auth/verify', { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) }); break; }
      catch (e) { if (e?.name !== 'TimeoutError' || tries >= VERIFY_TRIES) throw e; }
    }
    applyUser(data.user);
  } catch {
    currentUser.value = null;
  } finally {
    authLoading.value = false;
  }
}

export async function login(username, password) {
  authError.value = null;
  const data = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  // Two-step sign-in is on for the account: no session yet, a ticket to hand back
  // with the code (loginCode below).
  if (data.step === 'code') return { step: 'code', ticket: data.ticket };
  applyUser(data.user);
  return data.user;
}
export async function loginCode(ticket, code) {
  const data = await api('/auth/login/code', { method: 'POST', body: JSON.stringify({ ticket, code }) });
  applyUser(data.user);
  return data.user;
}

// Signed in by a phone approving this page's QR request (src/js/qrLogin.js).
export function signedInByQr(user) { authError.value = null;applyUser(user); }

export async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } finally {
    currentUser.value = null;
  }
}

export async function updateCurrentUser(patch) {
  const data = await api('/auth/me', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  applyUser(data.user);
  return data.user;
}

export async function changePassword(oldPassword, newPassword, code) {
  return api('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword, ...(code ? { code } : {}) }),
  });
}
