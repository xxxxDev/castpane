// Your own password again, and the code when two-step is on: opening Remote and trusting
// a device, after their own passkey was not used (RemotePage.vue, trust.js).
import {f7} from 'framework7-vue';
import {t} from './i18n.js';
import {ct} from './text.js';
import {currentUser} from './auth.js';

export function adminAgain(title, then, text = ct('請輸入你自己的密碼確認。'), cancel = () => {}) {
  byPassword(title, then, text, cancel);
}
function byPassword(title, then, text, cancel) {
  f7.dialog.password(text, title, (adminPassword) => {
    if (!adminPassword) return cancel();
    if (!currentUser.value?.twoStep) return then({adminPassword});
    f7.dialog.prompt(ct('請輸入你的驗證碼或備用碼。'), title, (adminCode) => { if ((adminCode || '').trim()) then({adminPassword, adminCode: adminCode.trim()});else cancel(); }, cancel);
  }, cancel);
}
export const adminProblem = (err) => (err.code === 'NEED_CODE' ? ct('你的帳號已開啟兩步驟驗證，請重新整理頁面後再試一次') : err.code === 'CODES_SPENT' ? ct('今天驗證碼輸錯太多次，今天不再接受驗證器的碼，請改用備用碼') : err.status === 429 ? t('tooManyAttempts') : err.code === 'WRONG_PASSWORD' ? ct('密碼不正確') : err.code === 'WRONG_CODE' ? ct('驗證碼不正確') : err.code === 'PASSKEY_REFUSED' ? ct('通行密鑰沒有通過，請再試一次或改用密碼') : null);
// Asked first without: where the server answers NEED_PASSWORD (it widens something),
// the password (and code) is asked for and the call made again with it. Resolves to
// the call's answer, or null when the admin cancelled.
export async function withAdminAgain(title, call, text) {
  try { return await call({}); } catch (e) { if (e.code !== 'NEED_PASSWORD') throw e; }
  const again = await new Promise((done) => adminAgain(title, done, text, () => done(null)));
  return again ? call(again) : null;
}
