// This product's screens: which tabs there are, the pages of its own tabs' routers and
// the address of each. js/appUrl.js (which holds the Settings tab's pages) and
// js/tab-session.js read it and are generic; what is here is Castpane's own.

export const ID = '[A-Za-z0-9_-]{1,64}';

// Every tab, and the one a stored tab that is no longer there falls back to.
// 'view-remote' and 'view-admin' are an admin's only; App.vue moves anyone else to
// Settings.
export const TAB_IDS = ['view-remote', 'view-settings', 'view-admin'];
export const HOME_TAB = 'view-remote';
// Where someone who is not an admin goes.
export const MEMBER_TAB = 'view-settings';
export const ADMIN_TABS = new Set(['view-remote', 'view-admin']);
// The tab that holds Manage Users (pages/UsersPage.vue opens an account in it).
export const ADMIN_TAB = 'view-admin';

// The product's tabs whose pages live in their own F7 router, rows as in appUrl.js's
// Settings pages.
export const TAB_PAGES = {
  'view-remote': [
    {route: '/remote/', path: '/', admin: true},
  ],
  'view-admin': [
    {route: '/admin/', path: '/admin', admin: true},
    {route: '/users/', path: '/admin/users', parent: '/admin/', admin: true},
    {route: '/user/', path: '/admin/users/:id', id: ID, parent: '/users/', admin: true},
    {route: '/security/', path: '/admin/security', parent: '/admin/', admin: true},
    {route: '/devices/', path: '/admin/devices', parent: '/admin/', admin: true},
  ],
};

export const oldPath = (path) => (path === '/remote' ? '/' : path);

// The address of a tab with no page table (appUrl.js asks only for those).
export function tabAddress() { return '/'; }

// An address that opens something other than a page of TAB_PAGES: none in Castpane.
export function specialScreen() { return undefined; }
