// An iPhone can report a visual viewport of -47 and stay there: use another app sideways, go
// to the home screen upright, open the installed app (measured on the owner's iPhone,
// 2026-10-31). A height of 0 or less says nothing: the page then counts as uncovered.
export const viewportBroken = (viewport = window.visualViewport) => !!viewport && !(viewport.height > 0);
export const visibleHeight = (viewport = window.visualViewport) => (viewport && viewport.height > 0 ? viewport.height : window.innerHeight);
