// Whether the whole screen lists the Mac's app windows beside its desktops
// (pages/RemotePage.vue). Off by default: the apps have their own home. Kept on each device.
import {ref} from 'vue';
import {PRODUCT} from './productConfig.js';

const KEY = PRODUCT.storageKeys.deskWindows;
function read() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
export const deskWindows = ref(read());
export function setDeskWindows(on) {
  deskWindows.value = !!on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
}
