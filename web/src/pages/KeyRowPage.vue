<template>
  <!-- Settings › Remote › Key row: the phone's key row as set here (js/remotePrefs.js): one
       round button at most at its left, two at its right, four pages of keys between. Any key
       can be in any of them; within one they are dragged into order, and a tap moves one to
       another. Kept on this device. -->
  <f7-page name="key-row" class="page-large-static">
    <f7-navbar :title="ct('按鈕列')" back-link :back-link-text="t('tabSettings')">
      <f7-nav-right><f7-link class="key-row-edit" @click="editing = !editing">{{ editing ? ct('完成') : ct('排序') }}</f7-link></f7-nav-right>
    </f7-navbar>
    <p class="key-row-note">{{ ct('遠端畫面下方的按鈕列：左側最多一顆獨立圓鈕，右側最多兩顆，中間是左右滑動的四頁。點一顆按鈕可以移到別的位置；按「排序」後拖曳把手調整順序。只影響這台裝置。') }}</p>
    <template v-for="sec in sections" :key="sec.where">
      <f7-block-title>{{ sec.title }}</f7-block-title>
      <f7-list inset sortable :sortable-enabled="editing" :sortable-move-elements="false" class="cc-settings-list key-row-list" :data-where="sec.where" @sortable:sort="(d) => sorted(sec.where, d)">
        <f7-list-item v-for="id in sec.ids" :key="id" :link="!editing" no-chevron :title="ct(KEY_NAMES[id])" :data-key="id" @click="editing || moveMenu(id, sec.where)">
          <template #after><span v-if="!editing" class="key-row-move">{{ ct('移到…') }}</span></template>
        </f7-list-item>
        <f7-list-item v-if="!sec.ids.length" :title="ct('（沒有）')" class="key-row-empty"/>
      </f7-list>
    </template>
    <f7-list inset class="cc-settings-list">
      <f7-list-item link no-chevron :title="ct('恢復預設')" class="key-row-reset" @click.prevent="setKeyLayout(null)"/>
    </f7-list>
  </f7-page>
</template>
<script setup>
import { computed, ref } from 'vue';
import { f7 } from 'framework7-vue';
import { t } from '../js/i18n.js';
import { ct } from '../js/text.js';
import { KEY_NAMES, KEY_LIMITS, keyLayout, setKeyLayout, moveKey, reorderKeys } from '../js/remotePrefs.js';
const editing = ref(false);
const PAGE_TITLES = ['第 1 頁', '第 2 頁', '第 3 頁', '第 4 頁'];
const sections = computed(() => [
  { where: 'left', title: ct('左側獨立按鈕（最多 1 顆）'), ids: keyLayout.value.left },
  ...keyLayout.value.pages.map((ids, i) => ({ where: i, title: ct(PAGE_TITLES[i]), ids })),
  { where: 'right', title: ct('右側獨立按鈕（最多 2 顆）'), ids: keyLayout.value.right },
]);
function sorted(where, { from, to }) {
  const list = where === 'left' || where === 'right' ? keyLayout.value[where] : keyLayout.value.pages[where];
  if (from !== to && from < list.length && to < list.length) reorderKeys(where, from, to);
}
function moveMenu(id, from) {
  const full = (w) => KEY_LIMITS[w] && keyLayout.value[w].length >= KEY_LIMITS[w];
  const to = [['left', ct('左側獨立按鈕')], [0, ct('第 1 頁')], [1, ct('第 2 頁')], [2, ct('第 3 頁')], [3, ct('第 4 頁')], ['right', ct('右側獨立按鈕')]].filter(([w]) => w !== from);
  f7.actions.create({ buttons: [
    [{ text: ct('「{name}」移到').replace('{name}', () => ct(KEY_NAMES[id])), label: true },
      ...to.map(([w, name]) => ({ text: full(w) ? name + ct('（已滿）') : name, disabled: full(w), onClick: () => moveKey(id, w) }))],
    [{ text: ct('取消'), bold: true }],
  ] }).open();
}
</script>
<style scoped>
.key-row-note {font-size:13px;line-height:1.5;color:var(--dp-color-text-secondary,#8e8e93);margin:8px calc(var(--f7-block-padding-horizontal,16px) + 16px) 0;}
.key-row-move {font-size:14px;color:var(--f7-theme-color,#0a84ff);}
.key-row-empty {opacity:.5;}
</style>
