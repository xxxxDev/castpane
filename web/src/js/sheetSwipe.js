// Phone sheets pushed as an iOS card: a popup with :swipe-to-close="sheetSwipe"
// :push="sheetSwipe", class sheet-swipe and a <div class="sheet-grabber"> (styled once in
// skin.css) closes with a finger pulled down from its top, and the page behind steps back as
// the card comes up. Framework7's own swipeToClose pulls the sheet only while its page is
// scrolled to the top, so a long list still scrolls.
// framework7-vue reads both only when the popup mounts, so the choice is made once: on
// wherever there is touch, off for a mouse, where a drag in a popup would close it.
export const sheetSwipe=typeof window!=='undefined'&&('ontouchstart' in window||(window.DocumentTouch&&document instanceof window.DocumentTouch))?'to-bottom':false;
