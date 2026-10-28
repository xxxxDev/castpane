// Whether a new build interrupts with a dialog on a computer, as it does on a
// phone. Off by default: the computer's sidebar shows it quietly at its foot. Kept on each device, since it is about that screen.
import {ref} from 'vue';
import {PRODUCT} from './productConfig.js';

const KEY = PRODUCT.storageKeys.updateDialog;
function read() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
export const updateDialog = ref(read());
export function setUpdateDialog(on) {
  updateDialog.value = !!on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
}
