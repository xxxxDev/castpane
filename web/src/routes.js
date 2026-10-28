import RemotePage from './pages/RemotePage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import AdminPage from './pages/AdminPage.vue';
import ChangePasswordPage from './pages/ChangePasswordPage.vue';
import ScanLoginPage from './pages/ScanLoginPage.vue';
import DevicesPage from './pages/DevicesPage.vue';
import TwoStepPage from './pages/TwoStepPage.vue';
import PasskeysPage from './pages/PasskeysPage.vue';
import UsersPage from './pages/UsersPage.vue';
import UserEditPage from './pages/UserEditPage.vue';
import SecurityPage from './pages/SecurityPage.vue';

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
  // Two-step sign-in and passkeys for this account.
  { path: '/two-step/', component: TwoStepPage },
  { path: '/passkeys/', component: PasskeysPage },

  // The admin's tab; everything below is pushed within the #view-admin stack.
  { path: '/admin/', component: AdminPage },
  { path: '/users/', component: UsersPage },
  // User edit, opened from Manage Users rows.
  { path: '/user/', component: UserEditPage },
  // Sign-in defence: what was tried and which addresses are blocked.
  { path: '/security/', component: SecurityPage },
];
