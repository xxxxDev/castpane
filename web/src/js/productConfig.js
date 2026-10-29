// What is this product's own on the page's side: the generic files read these values
// from here. The server's is server/siteConfig.js (PRODUCT), the service worker's
// public/push-config.js.
export const PRODUCT = Object.freeze({
  name: 'Castpane',
  // components/InstallScreen.vue: the picture beside the name.
  installIcon: '/castpane-128.png',
  // pages/LoginPage.vue: a picture before the name in the title; '' for none.
  loginLogo: '/castpane-128.png',
  // What each browser keeps here, by name: renaming one makes every browser forget it.
  storageKeys: Object.freeze({
    pushDeviceId: 'castpane-push-id', // push.js
    loginKey: 'castpane-login-key', // qrLogin.js
    passkeyOffer: 'castpane-passkey-offer', // passkeys.js
    updateDialog: 'castpane-update-dialog', // updatePrompt.js
    sidebarFolded: 'castpane-sidebar-folded', // sidebarState.js
    sidebarAuto: 'castpane-sidebar-auto', // sidebarState.js
    language: 'castpane-lang', // i18n.js
  }),
  // push.js: the kinds of notification a device has before it says otherwise
  // (server/pushEvents.js).
  pushPreferences: Object.freeze({ remote: true }),
  // public/push-config.js names the same cache, where a tapped notification is left.
  intentCache: 'castpane-intent',
  // live-connection.js: the window event that carries the build the server names.
  buildEvent: 'castpane-build',
});
