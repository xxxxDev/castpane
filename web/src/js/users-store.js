import { ref } from 'vue';
import { api } from './auth.js';
import { ct } from './text.js';

// Shared users state: the Manage Users list loads it, the user popup looks
// entries up by id, and edits refresh through the same loader.
export const users = ref([]);
export const usersLoading = ref(false);
// Which saved order the list was loaded in, sent back with a new one (USER_ORDER_STALE
// when another admin saved one meanwhile).
export const usersOrderVersion = ref('');

// A list that never answers ends: the page says so, and the next entry, pull or poll
// asks again.
const USERS_TIMEOUT_MS = 20000;

export async function loadUsers() {
  usersLoading.value = true;
  try {
    let data;
    try { data = await api('/auth/users', { signal: AbortSignal.timeout(USERS_TIMEOUT_MS) }); }
    catch (e) { throw e?.name === 'TimeoutError' ? new Error(ct('連線逾時，請再試一次。')) : e; }
    users.value = data.users || [];
    usersOrderVersion.value = data.orderVersion || '';
  } finally {
    usersLoading.value = false;
  }
}

// A saved order refused because another admin changed it meanwhile, in the page's words.
export function orderProblem(err) {
  if (err?.code === 'USER_ORDER_STALE') return ct('清單剛剛變了，已重新載入，請再排一次。');
  return err?.message || '';
}

export function findUser(id) {
  return users.value.find((u) => String(u.id) === String(id));
}

// Presence polling for the Manage Users page: re-fetch the list (which carries
// each user's server-computed `online` flag) on an interval. Started on page-in,
// stopped on page-out, so it never runs in the background.
let pollTimer = null;
export function startUsersPoll(intervalMs = 10000) {
  stopUsersPoll();
  pollTimer = setInterval(() => {
    loadUsers().catch(() => {});
  }, intervalMs);
}
export function stopUsersPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
