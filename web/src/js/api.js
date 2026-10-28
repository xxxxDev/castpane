// Double-submit CSRF: the server mints a JS-readable csrf_token cookie on any
// /api request that lacks one (server/middlewares/requestGuards.js), and every
// unsafe method has to echo it back in this header. This module is the single
// fetch client for mutations and deliberately has no Vue/browser-startup side effects.
const UNSAFE_METHOD = /^(?:POST|PUT|PATCH|DELETE)$/i;

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export async function api(endpoint, options = {}) {
  const method = options.method || 'GET';
  const res = await fetch(`/api${endpoint}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(UNSAFE_METHOD.test(method) ? { 'X-CSRF-Token': csrfToken() } : {}),
      ...(options.headers || {}),
    },
    ...Object.fromEntries(Object.entries(options).filter(([key])=>key!=='headers')),
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON body (proxy/CORS error pages) — fall through to status error
  }
  if (!res.ok) {
    const error = new Error(data.message || `Request failed: ${res.status}`);
    error.status = res.status;
    error.code = data.code;
    // The rest of the answer, for a page that reads more than the message (the
    // the details of a refused account change).
    error.data = data;
    throw error;
  }
  return data;
}
