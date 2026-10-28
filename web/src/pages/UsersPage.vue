<template>
  <f7-page name="users" class="page-large-static" ptr :ptr-mousewheel="true" @ptr:refresh="refresh" @page:afterin="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar large>
      <f7-nav-left :back-link="true"></f7-nav-left>
      <f7-nav-title sliding>{{ t('manageUsers') }}</f7-nav-title>
      <f7-nav-right>
        <!-- Edit puts the accounts in order by drag, as a list's Edit does elsewhere. -->
        <f7-link v-if="users.length > 1" class="users-order" :class="{ disabled: ordering }" :aria-label="ct('拖曳調整順序')" @click="toggleEditing">{{ editing ? 'Done' : 'Edit' }}</f7-link>
        <f7-link v-if="!editing" icon-only icon-f7="plus" @click="addUser" />
      </f7-nav-right>
      <f7-nav-title-large>{{ t('manageUsers') }}</f7-nav-title-large>
    </f7-navbar>

    <f7-block-footer>{{ t('usersIntro') }}</f7-block-footer>

    <f7-block v-if="usersLoading && !users.length" class="state-block">
      <f7-preloader></f7-preloader>
    </f7-block>

    <f7-list v-else media-list inset sortable :sortable-enabled="editing && !ordering" :sortable-move-elements="false" class="users-list" @sortable:sort="onSort">
      <f7-list-item
        v-for="u in users"
        :key="u.id"
        :data-user="u.id"
        :title="u.name"
        :footer="`${u.username} · ${u.role} · ${lifecycleLabel(u.lifecycleStatus)}${u.id === currentUser?.id ? ` · ${t('you')}` : ''}`"
      >
        <template #media>
          <div class="user-avatar" :class="{ 'user-admin': u.role === 'admin', 'user-disabled': u.lifecycleStatus === 'disabled', 'user-deleted': u.lifecycleStatus === 'deleted_tombstone' }">
            <i class="icon f7-icons">{{ u.role === 'admin' ? 'star_fill' : 'person_fill' }}</i>
            <span class="presence-dot" :class="{ online: u.lifecycleStatus === 'active' && u.online }"></span>
          </div>
        </template>
        <template #after>
          <div v-if="!editing" class="user-actions">
            <f7-link
              icon-only
              icon-f7="gear_alt_fill"
              class="activity-action"
              @click.stop="openUser(u)"
            />
          </div>
        </template>
      </f7-list-item>
    </f7-list>
  </f7-page>
</template>

<script setup>
import { f7 } from 'framework7-vue';
import { t } from '../js/i18n.js';
import { api, currentUser } from '../js/auth.js';
import { users, usersLoading, usersOrderVersion, loadUsers, startUsersPoll, stopUsersPoll, orderProblem } from '../js/users-store.js';
import { ref } from 'vue';
import { ct } from '../js/text.js';
import { ADMIN_TAB } from '../js/navigation.js';

async function load() {
  try {
    await loadUsers();
  } catch (err) {
    f7.dialog.alert(err.message);
  }
}

function refresh(done) {
  load().finally(done);
}

// poll presence only while the page is on-screen (and not while rows are being dragged)
function onPageIn() {
  load();
  if (!editing.value) startUsersPoll(10000);
}

function onPageOut() {
  stopUsersPoll();
  editing.value = false;
}

// The list's order, dragged in Edit: saved on the
// server for every admin.
const editing = ref(false);
const ordering = ref(false);
function toggleEditing() {
  if (ordering.value) return;
  editing.value = !editing.value;
  if (editing.value) stopUsersPoll();
  else { load(); startUsersPoll(10000); }
}
async function onSort({ from, to }) {
  if (from === to || ordering.value) return;
  const next = [...users.value];
  next.splice(to, 0, next.splice(from, 1)[0]);
  users.value = next;
  ordering.value = true;
  try {
    const data = await api('/auth/users/order', { method: 'PUT', body: JSON.stringify({ ids: next.map((u) => u.id), version: usersOrderVersion.value }) });
    usersOrderVersion.value = data.orderVersion || '';
  } catch (err) {
    f7.dialog.alert(orderProblem(err) || t('settingsFailed'));
    await load();
  } finally { ordering.value = false; }
}

const toast = (text) => f7.toast.create({ text, closeTimeout: 1800 }).open();

function lifecycleLabel(status = 'active') {
  return ({
    active: t('userStatusActive'),
    disabled: t('userStatusDisabled'),
    deleted_tombstone: t('userStatusDeleted'),
  })[status] || t('unknown');
}

// two-step prompt keeps it native-dialog simple (username, then password).
// Validate locally before the request: a short password once bounced off the
// server with no visible feedback on iOS, and empty inputs used to bail out
// silently. Validation alerts re-open the step they refused, so the user
// keeps typing instead of restarting the whole flow.
function promptNewPassword(name) {
  f7.dialog.password(t('addUserPassword'), t('addUser'), async (password) => {
    if (!password || password.length < 8) {
      f7.dialog.alert(t('addUserPasswordTooShort'), () => promptNewPassword(name));
      return;
    }
    try {
      await api('/auth/users', {
        method: 'POST',
        body: JSON.stringify({ username: name, password }),
      });
      toast(t('userAdded'));
      load();
    } catch (err) {
      // Server refusals (duplicate name, …) end the flow: re-prompting the
      // password cannot fix them.
      f7.dialog.alert(err?.message || t('settingsFailed'));
    }
  });
}

function addUser() {
  f7.dialog.prompt(t('addUserName'), t('addUser'), (username) => {
    const name = (username || '').trim();
    if (!name) {
      f7.dialog.alert(t('addUserNameRequired'), () => addUser());
      return;
    }
    promptNewPassword(name);
  });
}

function openUser(u) {
  f7.views.get('#' + ADMIN_TAB).router.navigate(`/user/?id=${encodeURIComponent(u.id)}`);
}
</script>

<style scoped>
.user-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.state-block {
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* 45px round tile */
.user-avatar {
  position: relative;
  width: 45px;
  height: 45px;
  border-radius: 38%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--cc-surface-card);
  box-shadow:
    var(--cc-glass-ring) 2px 2px 2px -2px inset,
    var(--cc-glass-ring) -2px -2px 2px -2px inset;
}
.presence-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #8e8e93; /* grey = offline */
  box-shadow: 0 0 0 2px var(--cc-color-page); /* ring to separate the dot from the list bg */
}
.presence-dot.online {
  background: #34c759; /* green = active within the last 5 min */
}
.user-avatar .icon {
  font-size: 22px;
  color: var(--cc-color-text);
}
.user-admin .icon {
  color: #ffcc00;
}
.user-disabled,
.user-deleted {
  opacity: 0.58;
}
</style>
