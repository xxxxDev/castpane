// Tapping the tab you are already on goes back one page inside that tab's own
// history stack, so the bottom tabbar doubles as a back affordance. Tapping a
// different tab is an ordinary tab switch, and a tab already at its root has
// nothing to go back to.
export function resolveTabTap({ tappedId, activeId, historyLength = 0 } = {}) {
  if (!tappedId) return 'none';
  if (tappedId !== activeId) return 'switch';
  // At the tab's first page, a second tap scrolls it back to the top, as iOS tab bars do.
  return historyLength > 1 ? 'back' : 'top';
}
