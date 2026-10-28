import {TAB_PAGES as PRODUCT_PAGES, oldPath, tabAddress, specialScreen} from './navigation.js';

// Every screen has an address, and an address opens its screen. Addresses are only ever swapped with replaceState: the app
// never adds a history entry, a settled decision so that the edge swipe is exactly
// the navbar back link.
//
// Generic. The Settings tab is everyone's and its
// pages are here; the product's own tabs and addresses are in js/navigation.js. A
// tab's pages live in its own F7 router: each row is its route there, its address,
// whether it is an admin's, and the page it is opened from, so a deep link builds the
// same stack a tap would and the back link works.
const ID = '[A-Za-z0-9_-]{1,64}';
const SETTINGS_PAGES = [
  {route: '/settings/', path: '/settings'},
  {route: '/change-password/', path: '/settings/password', parent: '/settings/'},
  {route: '/scan-login/', path: '/settings/scan-login', parent: '/settings/'},
  {route: '/devices/', path: '/settings/devices', parent: '/settings/'},
];
const TAB_PAGES = {...PRODUCT_PAGES, 'view-settings': SETTINGS_PAGES};
const byRoute = new Map(Object.values(TAB_PAGES).flat().map((page) => [page.route, page]));

// The path without its trailing slashes, '/' for none left. A loop, not /\/+$/: that
// pattern takes quadratic time on a long run of slashes followed by anything else.
function withoutTrailingSlashes(path) {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(0, end) || '/';
}

const routeUrl = (page, id) => (page.id ? `${page.route}?id=${encodeURIComponent(id)}` : page.route);

// The address of what a tab shows. `route` is that tab's F7 currentRoute.
export function addressFor({tab, route}) {
  const pages = TAB_PAGES[tab];
  if (!pages) return tabAddress({tab, route});
  const page = pages.find((p) => p.route === route?.path) || pages[0];
  const id = route?.query?.id;
  if (page.id && !(typeof id === 'string' && new RegExp(`^${page.id}$`).test(id))) return pages[0].path;
  return page.id ? page.path.replace(':id', encodeURIComponent(id)) : page.path;
}

// The screen an address names: its tab and the F7 routes to open in that tab, in
// order. null for an address the home tab resolves itself, and for anything not
// recognised.
export function screenFor(href) {
  const url = new URL(href, 'http://localhost');
  // A computer's QR sign-in link opened on the phone: the scan page, to scan it
  // there; the link alone approves nothing.
  const qr = url.searchParams.get('qr');
  if (qr && /^[A-Za-z0-9_-]{24}$/.test(qr)) return {tab: 'view-settings', stack: ['/scan-login/']};
  const trimmed = withoutTrailingSlashes(url.pathname);
  const special = specialScreen(url, trimmed);
  if (special !== undefined) return special;
  const path = oldPath(trimmed);
  for (const [tab, pages] of Object.entries(TAB_PAGES)) {
    for (const page of pages) {
      const pattern = new RegExp(`^${page.path.replace(':id', `(${page.id || ID})`)}$`);
      const match = pattern.exec(path);
      if (!match) continue;
      const id = match[1] && decodeURIComponent(match[1]);
      const stack = [];
      for (let at = page; at && at !== pages[0]; at = byRoute.get(at.parent)) stack.unshift(routeUrl(at, id));
      return {tab, admin: !!page.admin, stack};
    }
  }
  return null;
}
