// Whether this device shows the Labs tab: features still being tried (the Mac's apps used as
// a phone's own, pages/RemotePage.vue with labs). Off by default, kept on each device.
import {ref} from 'vue';
import {PRODUCT} from './productConfig.js';

const KEY = PRODUCT.storageKeys.labs;
function read() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
export const labsOn = ref(read());
export function setLabs(on) {
  labsOn.value = !!on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
}
