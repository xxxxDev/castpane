// Passkeys, the page's side (server/services/passkeys.js; the owner's request,
// 2026-10-08): the browser asks the device (Touch ID, Face ID, Windows Hello, a
// phone or a password manager) to make a key for this site, or to sign with one.
import { api } from './api.js';
import { PRODUCT } from './productConfig.js';

const b64u = (buf) => { let s = '';for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (text) => Uint8Array.from(atob(String(text).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
// A passkey belongs to a site's name: it cannot be made for a bare IP address, and
// the server takes one only for its public https address (localhost is offered for
// a test instance, which says so to its server).
export const passkeysWork = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials && window.isSecureContext && (location.protocol === 'https:' || location.hostname === 'localhost') && !/^[\d.]+$|:/.test(location.hostname);
// The person closing the device's sheet is not an error to show.
export const cancelled = (e) => e?.name === 'NotAllowedError' || e?.name === 'AbortError';

export const listPasskeys = () => api('/auth/passkeys');
export const removePasskey = (id) => api(`/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
// The password, and the two-step code when that is on, every time; and only on the
// public HTTPS address (the server refuses with PASSKEY_ORIGIN elsewhere).
export async function addPasskey({ name, password, code } = {}) {
  const o = await api('/auth/passkeys/options', { method: 'POST', body: JSON.stringify({ password, code }) });
  const made = await navigator.credentials.create({ publicKey: {
    challenge: unb64u(o.challenge),
    rp: { id: location.hostname, name: PRODUCT.name },
    user: { id: unb64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.algs.map((alg) => ({ type: 'public-key', alg })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: o.exclude.map((id) => ({ type: 'public-key', id: unb64u(id) })),
    attestation: 'none',
  } });
  const r = made.response;
  const { passkey } = await api('/auth/passkeys', { method: 'POST', body: JSON.stringify({
    name, code, id: made.id, clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.getAuthenticatorData()),
    publicKey: b64u(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
  }) });
  passkeyOfferDone('made');
  return passkey;
}
// The offer after a password sign-in: asked once a device, until a passkey is made
// here or the offer is turned down.
const OFFER = PRODUCT.storageKeys.passkeyOffer;
export function shouldOfferPasskey() { try { return passkeysWork() && !localStorage.getItem(OFFER); } catch { return false; } }
export function passkeyOfferDone(how) { try { localStorage.setItem(OFFER, how); } catch {} }
// Sign in: the device shows the passkeys it holds for this site, and the one
// picked signs the server's challenge. Returns the signed-in user.
// conditional: nothing is shown until the username field is used, where the browser
// then lists the passkeys beside its saved names; it waits until one is picked or
// the signal ends it.
export const passkeyAutofillWorks = async () => { try { return passkeysWork() && !!(await window.PublicKeyCredential.isConditionalMediationAvailable?.()); } catch { return false; } };
export async function signInWithPasskey({ conditional = false, signal } = {}) {
  const { challenge } = await api('/auth/passkey/start', { method: 'POST', body: '{}' });
  const got = await navigator.credentials.get({ ...(conditional ? { mediation: 'conditional' } : {}), ...(signal ? { signal } : {}), publicKey: { challenge: unb64u(challenge), rpId: location.hostname, userVerification: 'required' } });
  const r = got.response;
  const data = await api('/auth/passkey/finish', { method: 'POST', body: JSON.stringify({
    id: got.id, clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature),
  }) });
  passkeyOfferDone('made');
  return data.user;
}
// The signed-in admin's own passkey in place of the password and code for an action
// that asks for them again (server: adminPasskeyAgain). The answer to send, or null
// when the account has no passkey.
export async function passkeyAgain(startPath) {
  const { challenge, allow } = await api(startPath, { method: 'POST', body: '{}' });
  if (!challenge) return null;
  const got = await navigator.credentials.get({ publicKey: { challenge: unb64u(challenge), rpId: location.hostname, userVerification: 'required', allowCredentials: (allow || []).map((id) => ({ type: 'public-key', id: unb64u(id) })) } });
  const r = got.response;
  return { id: got.id, clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature) };
}
