import RemotePage from './pages/RemotePage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import ChangePasswordPage from './pages/ChangePasswordPage.vue';
import ScanLoginPage from './pages/ScanLoginPage.vue';
import DevicesPage from './pages/DevicesPage.vue';
import TwoStepPage from './pages/TwoStepPage.vue';
import PasskeysPage from './pages/PasskeysPage.vue';
import SecurityPage from './pages/SecurityPage.vue';
import TrustedDevicesPage from './pages/TrustedDevicesPage.vue';
import NoFitPage from './pages/NoFitPage.vue';

// Tab-view roots. Each F7 view owns its own router stack and resolves its url here.
export default [
  // Remote: this Mac's screen and input, for an admin (server/remote.js).
  { path: '/remote/', component: RemotePage },

  { path: '/settings/', component: SettingsPage },
  // Settings detail push (within the #view-settings router stack).
  { path: '/change-password/', component: ChangePasswordPage },
  // QR sign-in: this phone as a login key, and the account's devices.
  { path: '/scan-login/', component: ScanLoginPage },
  { path: '/devices/', component: DevicesPage },
  // The apps whose windows are left at their own size.
  { path: '/no-fit/', component: NoFitPage },
  // Two-step sign-in and passkeys for this account.
  { path: '/two-step/', component: TwoStepPage },
  { path: '/passkeys/', component: PasskeysPage },

  // Sign-in defence: what was tried and which addresses are blocked.
  { path: '/security/', component: SecurityPage },
  // Devices trusted to open Remote without asking each time.
  { path: '/trusted/', component: TrustedDevicesPage },
];
