import { ref } from 'vue';
import { TAB_IDS as TABS, HOME_TAB } from './navigation.js';

// Which tabs there are is the product's (js/navigation.js); a stored tab that is no
// longer one falls back to the home tab.
const TAB_IDS = new Set(TABS);

function storedTab() {
  try {
    const value = localStorage.getItem('activeTab');
    return TAB_IDS.has(value) ? value : HOME_TAB;
  } catch {
    return HOME_TAB;
  }
}

export const activeTab = ref(storedTab());

export function setActiveTab(id) {
  if (!TAB_IDS.has(id)) return;
  activeTab.value = id;
  try {
    localStorage.setItem('activeTab', id);
  } catch {
    // Storage is optional in private/restricted browsing contexts.
  }
}
