// QR sign-in, the page's side (server/services/qrLogin.js): a login page shows a request as a QR code and waits; a phone bound as
// a login key scans it, shows who is asking, and approves or refuses.
import qrcode from 'qrcode-generator';
import { api } from './api.js';
import { PRODUCT } from './productConfig.js';

// This phone's login key: its id and secret, kept on this device only.
const KEY = PRODUCT.storageKeys.loginKey;
export function loginKey() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && typeof v.id === 'string' && typeof v.secret === 'string' ? v : null; } catch { return null; }
}
function keepKey(v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch {} }

export const isInstalledApp = () => !!(window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true);
// A phone or tablet (an iPad reports itself as a Mac, but has touch): only these
// scan a code; a computer is the one signed in by one.
export const isHandheld = () => /iPhone|iPad|Android/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const defaultDeviceName = () => (/iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'Phone');

export async function bindThisPhone(name, password, code) {
  const { device } = await api('/auth/devices', { method: 'POST', body: JSON.stringify({ name, password, ...(code ? { code } : {}) }) });
  keepKey({ id: device.id, secret: device.secret, name: device.name });
  return device;
}
export async function unbindThisPhone() {
  const key = loginKey();
  if (key) await api(`/auth/devices/${encodeURIComponent(key.id)}`, { method: 'DELETE' }).catch((e) => { if (e.status !== 404) throw e; });
  keepKey(null);
}
export const forgetLoginKey = () => keepKey(null);

// The login page's side.
// username: the account the login page was given, so a phone signed in to another
// account cannot approve it.
export const startRequest = (username = '') => api('/auth/qr/start', { method: 'POST', body: JSON.stringify(username ? { username } : {}) });
export const pollRequest = (id, poll) => api(`/auth/qr/poll?id=${encodeURIComponent(id)}`, { headers: { 'X-QR-Poll': poll } });
export const requestUrl = (id) => `${location.origin}/?qr=${encodeURIComponent(id)}`;
// A QR code as an SVG, drawn here: the request never leaves the page for a service.
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

// The phone's side.
const REQUEST_ID = /^[A-Za-z0-9_-]{24}$/;
// The request a scanned code names: this site's own sign-in link only.
export function requestIdFrom(text) {
  try {
    const url = new URL(String(text));
    if (url.origin !== location.origin) return null;
    const id = url.searchParams.get('qr');
    return id && REQUEST_ID.test(id) ? id : null;
  } catch { return null; }
}
export async function peekRequest(id) {
  const key = loginKey();
  if (!key) throw Object.assign(new Error('not bound'), { code: 'DEVICE_NOT_BOUND' });
  try { return await api(`/auth/qr/${encodeURIComponent(id)}`, { headers: { 'X-Device-Id': key.id, 'X-Device-Secret': key.secret } }); }
  catch (e) { if (e.code === 'DEVICE_NOT_BOUND') keepKey(null);throw e; }
}
export async function decideRequest(id, approve, code) {
  const key = loginKey();
  if (!key) throw Object.assign(new Error('not bound'), { code: 'DEVICE_NOT_BOUND' });
  try {
    return await api(`/auth/qr/${encodeURIComponent(id)}/decide`, { method: 'POST', body: JSON.stringify({ approve, code, deviceId: key.id, secret: key.secret }) });
  } catch (e) {
    // Unbound elsewhere (from the device list, or a password change): forget it here too.
    if (e.code === 'DEVICE_NOT_BOUND') keepKey(null);
    throw e;
  }
}
export const listDevices = () => api('/auth/devices');
export const removeDevice = (id) => api(`/auth/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => { if (loginKey()?.id === id) keepKey(null); return r; });
export const signOutSession = (id) => api(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });

// A short, readable name for a browser's user agent: "Mac · Chrome".
export function describeAgent(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ') || ua.slice(0, 40) || '?';
}
