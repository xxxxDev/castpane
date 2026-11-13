<template>
  <!-- The apps whose windows Labs leaves at their own size (js/noFit.js): those put on the
       list here or from an app's menu, and those found too wide to be a phone's shape. -->
  <f7-page name="no-fit" class="page-large-static" @page:afterin="query = ''">
    <f7-navbar :title="ct('不調整視窗的 App')" :back-link="t('back')"></f7-navbar>
    <f7-block-title>{{ ct('永不調整') }}</f7-block-title>
    <f7-list inset strong-ios class="nofit-never">
      <f7-list-item v-for="[bundle, name] in neverList" :key="bundle" :title="name" :footer="bundle">
        <template #after><a href="#" class="nofit-remove" @click.prevent="setNever(bundle, name, false)">{{ ct('移除') }}</a></template>
      </f7-list-item>
      <f7-list-item link no-chevron :title="ct('＋ 新增 App')" class="nofit-add" @click.prevent="picking = true"/>
    </f7-list>
    <f7-block-title>{{ ct('縮不到這麼窄的 App') }}</f7-block-title>
    <f7-block v-if="!narrowList.length" class="nofit-empty">{{ ct('還沒有。實驗頁打開一個 App 時，縮不到這台裝置寬度的會記在這裡。') }}</f7-block>
    <f7-list v-else inset strong-ios class="nofit-narrow">
      <f7-list-item v-for="[bundle, n] in narrowList" :key="bundle" :title="n.name" :footer="`${ct('最窄')} ${n.width} ${ct('點')}`">
        <template #after><a v-if="!neverFits(bundle)" href="#" class="nofit-never-add" @click.prevent="setNever(bundle, n.name, true)">{{ ct('加入') }}</a><span v-else class="nofit-on">{{ ct('已加入') }}</span></template>
      </f7-list-item>
    </f7-list>
    <f7-block-footer>{{ ct('縮不到的 App 會盡量調整，留下一點黑邊；加到「永不調整」就完全照原本的大小。清單只存在這台裝置。') }}</f7-block-footer>

    <f7-sheet class="nofit-sheet" :opened="picking" swipe-to-close push backdrop @sheet:closed="picking = false">
      <f7-page-content>
        <f7-block-title>{{ ct('新增 App') }}</f7-block-title>
        <f7-list inset class="nofit-search"><f7-list-input v-model:value="query" type="search" :placeholder="ct('搜尋 App')" clear-button/></f7-list>
        <f7-block v-if="!knownList.length" class="nofit-empty">{{ ct('先在實驗頁連線到 Mac 一次，這裡才會有它的 App 清單。') }}</f7-block>
        <f7-list v-else inset strong-ios class="nofit-pick">
          <f7-list-item v-for="[bundle, name] in knownList" :key="bundle" link no-chevron :title="name" :after="neverFits(bundle) ? ct('已加入') : ''" @click.prevent="setNever(bundle, name, true);picking = false"/>
        </f7-list>
      </f7-page-content>
    </f7-sheet>
  </f7-page>
</template>

<script setup>
import { computed, ref } from 'vue';
import { t } from '../js/i18n.js';
import { ct } from '../js/text.js';
import { noFit, neverFits, setNever } from '../js/noFit.js';

const picking = ref(false), query = ref('');
const byName = (a, b) => String(a[1]?.name ?? a[1]).localeCompare(String(b[1]?.name ?? b[1]));
const neverList = computed(() => Object.entries(noFit.never).sort(byName));
const narrowList = computed(() => Object.entries(noFit.narrow).sort(byName));
const knownList = computed(() => {
  const q = query.value.trim().toLowerCase();
  return Object.entries(noFit.known).filter(([, name]) => !q || name.toLowerCase().includes(q)).sort(byName);
});
</script>

<style>
.nofit-remove {color:var(--f7-color-red);font-size:15px;}
.nofit-never-add {font-size:15px;}
.nofit-on, .nofit-empty {font-size:14px;opacity:.65;}
.nofit-sheet {height:75vh;}
</style>
