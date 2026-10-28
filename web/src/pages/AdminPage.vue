<template>
  <!-- An admin's own tab: the accounts, the sign-in defence and this account's
       signed-in devices. -->
  <f7-page name="admin" class="page-large-static">
    <f7-navbar large :title="t('tabAdmin')" />

    <f7-block-title>{{ t('sectionAccount') }}</f7-block-title>
    <f7-list inset class="cc-settings-list">
      <f7-list-item link class="users-row" :title="t('manageUsers')" @click.prevent="go('/users/')">
        <template #media><f7-icon f7="person_2" /></template>
      </f7-list-item>
    </f7-list>

    <f7-block-title>{{ t('sectionSystem') }}</f7-block-title>
    <f7-list inset class="cc-settings-list">
      <f7-list-item link class="security-row" :title="ct('登入防禦')" @click.prevent="go('/security/')"><template #media><f7-icon f7="shield_lefthalf_fill"/></template></f7-list-item>
      <f7-list-item link class="devices-row" :title="ct('裝置')" @click.prevent="go('/devices/')"><template #media><f7-icon f7="device_phone_portrait"/></template></f7-list-item>
    </f7-list>
    <p class="admin-note">{{ ct('遠端連線的開始與結束，以及每次登入，也會列在這台 Mac 上 Castpane 設定的「活動」分頁。') }}</p>
  </f7-page>
</template>

<script setup>
import { ct } from '../js/text.js';
import { f7 } from 'framework7-vue';
import { t } from '../js/i18n.js';

function go(path) {
  f7.views.get('#view-admin').router.navigate(path);
}
</script>

<style scoped>
.cc-settings-list {
  user-select: none;
  -webkit-user-select: none;
}
.admin-note {font-size:13px;line-height:1.5;color:var(--dp-color-text-secondary,#8e8e93);margin:8px 32px 24px;}
@media (min-width: 800px){.admin-note{max-width:min(828px,calc(100% - 32px));margin-left:auto;margin-right:auto;padding:0 16px;box-sizing:border-box;}}
</style>
