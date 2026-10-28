// A computer's scrollbar shows while scrolling and fades out over 300ms after 900ms still; scrolling again restores it at once.
// skin.css decides the shown and hidden colours; this only adds the fade and leaves phones' native scrollbars alone.
const SHOW_MS = 900;
const FADE_MS = 300;

export function showScrollbarsWhileScrolling(doc = document) {
  const timers = new WeakMap(), fades = new WeakMap();
  const win = doc.defaultView;
  doc.addEventListener('scroll', event => {
    const el = event.target === doc ? doc.documentElement : event.target;
    if (!el || el.nodeType !== 1) return;
    // An attribute, not a class: Vue rewrites the class of an element it binds.
    el.setAttribute('data-scrolling', '');
    fades.get(el)?.cancel();
    fades.delete(el);
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => {
      const fade = win.matchMedia('(hover: hover) and (pointer: fine)').matches
        && !win.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof el.animate === 'function';
      const from = fade ? win.getComputedStyle(el).scrollbarColor : null;
      el.removeAttribute('data-scrolling');
      if (!fade || from === 'auto') return;
      // Only the scrollbar colour is animated; the element's own transition and its width are left as they are.
      const animation = el.animate([
        {scrollbarColor: from},
        {scrollbarColor: win.getComputedStyle(el).scrollbarColor},
      ], {duration: FADE_MS, easing: 'ease-out'});
      fades.set(el, animation);
      animation.onfinish = () => fades.delete(el);
    }, SHOW_MS));
  }, {capture: true, passive: true});
}
