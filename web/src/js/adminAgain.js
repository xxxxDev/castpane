// The acting admin's own password again, and the code when their two-step is on:
// making an administrator, resetting a password, enabling or renaming an
// administrator, and what widens the peer link. One helper for every page that asks
// for it.
import {f7} from 'framework7-vue';
import {t} from './i18n.js';
import {ct} from './text.js';
import {currentUser} from './auth.js';

export function adminAgain(title, then, text = ct('請輸入你自己的密碼確認。'), cancel = () => {}) {
  f7.dialog.password(text, title, (adminPassword) => {
    if (!adminPassword) return cancel();
    if (!currentUser.value?.twoStep) return then({adminPassword});
    f7.dialog.prompt(ct('請輸入你的驗證碼或備用碼。'), title, (adminCode) => { if ((adminCode || '').trim()) then({adminPassword, adminCode: adminCode.trim()});else cancel(); }, cancel);
  }, cancel);
}
export const adminProblem = (err) => (err.code === 'NEED_CODE' ? ct('你的帳號已開啟兩步驟驗證，請重新整理頁面後再試一次') : err.code === 'CODES_SPENT' ? ct('今天驗證碼輸錯太多次，今天不再接受驗證器的碼，請改用備用碼') : err.status === 429 ? t('tooManyAttempts') : err.code === 'WRONG_PASSWORD' ? ct('密碼不正確') : err.code === 'WRONG_CODE' ? ct('驗證碼不正確') : null);
// Asked first without: where the server answers NEED_PASSWORD (it widens something),
// the password (and code) is asked for and the call made again with it. Resolves to
// the call's answer, or null when the admin cancelled.
export async function withAdminAgain(title, call, text) {
  try { return await call({}); } catch (e) { if (e.code !== 'NEED_PASSWORD') throw e; }
  const again = await new Promise((done) => adminAgain(title, done, text, () => done(null)));
  return again ? call(again) : null;
}
