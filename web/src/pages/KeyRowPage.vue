<template>
  <!-- Settings › Remote › Key row: the phone's key row as set here (js/remotePrefs.js): one
       round button at most at its left, two at its right, four pages of keys between. Any key
       can be in any of them; within one they are dragged into order, and a tap moves one to
       another. Kept on the account (js/remotePrefs.js). -->
  <f7-page name="key-row" class="page-large-static">
    <f7-navbar :title="ct('按鈕列')" back-link :back-link-text="t('tabSettings')">
      <f7-nav-right><f7-link class="key-row-edit" @click="editing = !editing">{{ editing ? ct('完成') : ct('編輯') }}</f7-link></f7-nav-right>
    </f7-navbar>
    <p class="key-row-note">{{ ct('遠端畫面下方的按鈕列：左側最多一顆獨立圓鈕，右側最多兩顆，中間是左右滑動的四頁。點一顆按鈕可以移到別的位置；按「編輯」後可以拖曳把手，跨頁、跨左右調整。存在帳號上，每台裝置都一樣。') }}</p>
    <!-- Not editing: the places as lists, a tap moves a key. Editing: the whole row as one list,
         the places as titles in it, so a key is dragged within its place or across to another. -->
    <template v-if="!editing">
      <template v-for="sec in sections" :key="sec.where">
        <f7-block-title>{{ sec.title }}</f7-block-title>
        <f7-list inset class="cc-settings-list key-row-list" :data-where="sec.where">
          <f7-list-item v-for="id in sec.ids" :key="id" link no-chevron :title="ct(KEY_NAMES[id])" :data-key="id" @click="moveMenu(id, sec.where)">
            <template #after><span class="key-row-move">{{ ct('移到…') }}</span></template>
          </f7-list-item>
          <f7-list-item v-if="!sec.ids.length" :title="ct('（沒有）')" class="key-row-empty"/>
        </f7-list>
      </template>
    </template>
    <f7-list v-else inset sortable sortable-enabled :sortable-move-elements="false" class="cc-settings-list key-row-all" @sortable:sort="dragged">
      <template v-for="(x, i) in flat" :key="'place' in x ? 'p' + x.place : x.id">
        <f7-list-item v-if="'place' in x" :title="placeTitle(x.place)" class="key-row-place" :data-where="x.place"/>
        <f7-list-item v-else :title="ct(KEY_NAMES[x.id])" :data-key="x.id"/>
      </template>
    </f7-list>
    <p v-if="editing && refused" class="key-row-note key-row-refused">{{ ct('左側最多 1 顆、右側最多 2 顆，那一顆放回原位了。') }}</p>
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
import { KEY_NAMES, KEY_LIMITS, keyLayout, setKeyLayout, moveKey, flatLayout, setFlatLayout } from '../js/remotePrefs.js';
const editing = ref(false);
const PAGE_TITLES = ['第 1 頁', '第 2 頁', '第 3 頁', '第 4 頁'];
const sections = computed(() => [
  { where: 'left', title: ct('左側獨立按鈕（最多 1 顆）'), ids: keyLayout.value.left },
  ...keyLayout.value.pages.map((ids, i) => ({ where: i, title: ct(PAGE_TITLES[i]), ids })),
  { where: 'right', title: ct('右側獨立按鈕（最多 2 顆）'), ids: keyLayout.value.right },
]);
const flat = computed(() => flatLayout(keyLayout.value));
const refused = ref(false);
const placeTitle = (w) => sections.value.find((x) => x.where === w)?.title || '';
// A key dragged anywhere in the row: the places are rows of the list, so a key lands in the
// place above it. One that would put a third button at the right (a second at the left) or
// above the first place is put back, and said.
function dragged({ from, to }) {
  if (from === to) return;
  const next = [...flat.value], [moved] = next.splice(from, 1);
  if ('place' in moved) return;
  next.splice(to, 0, moved);
  // After Framework7 has finished with the drag: the list is changed, and made again, only then.
  setTimeout(() => {
    const ok = 'place' in next[0] && setFlatLayout(next);
    refused.value = !ok;
  }, 60);
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
/* The places' rows in the one list: titles, never dragged (no handle). */
.key-row-all :deep(li.key-row-place), .key-row-all :deep(li.key-row-place .item-content), .key-row-all :deep(li.key-row-place .item-inner) {background:transparent !important;box-shadow:none !important;}
.key-row-all :deep(li.key-row-place .item-content) {min-height:30px;padding-top:12px;}
.key-row-all :deep(.key-row-place .item-title) {font-size:13px;font-weight:600;color:var(--dp-color-text-secondary,#8e8e93);}
.key-row-all :deep(.key-row-place .sortable-handler) {display:none;}
</style>
