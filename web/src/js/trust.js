// A device the admin trusts to open Remote without the password or passkey each time
// (server/services/trustedDevices.js). The trust itself is a cookie this page cannot read;
// these only ask the server about it.
import { api } from './api.js';
import { ct } from './text.js';
import { withAdminAgain } from './adminAgain.js';
import { passkeysWork, passkeyAgain, cancelled } from './passkeys.js';

export const trustState = () => api('/remote/trust');
export const untrust = () => api('/remote/trust', { method: 'DELETE' });

// Asked again first, as a Remote pass is: a passkey when there is one, else the password.
export async function trustThisDevice() {
  if (passkeysWork()) {
    try {
      const passkey = await passkeyAgain('/remote/pass/passkey');
      if (passkey) return await api('/remote/trust', { method: 'POST', body: JSON.stringify({ passkey }) });
    } catch (e) { if (!cancelled(e) && e.code !== 'PASSKEY_REFUSED') throw e; }
  }
  return withAdminAgain(ct('信任這台裝置'), (again) => api('/remote/trust', { method: 'POST', body: JSON.stringify(again) }), ct('請輸入你自己的密碼，信任這台裝置。'), { passkey: false });
}

// A pass from this device's trust, or null when it is not trusted (or no longer).
export async function trustedPass() {
  try { return await api('/remote/pass', { method: 'POST', body: JSON.stringify({ trusted: true }) }); }
  catch (e) { if (e.code === 'NOT_TRUSTED') return null; throw e; }
}
