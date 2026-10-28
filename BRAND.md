# Brand assets

The Castpane logo (the desktop screen with a blue pointer cutting in from its corner) belongs to
[V-AX](https://v-ax.com). It is © V-AX, all rights reserved, and it is **not** licensed under
the MIT License that covers the code. It appears in these files:

- `docs/assets/logo/`: the logo with its wordmark (at the top of `README.md`), the mark alone,
  for light and dark backgrounds, and two square icons, each as SVG and a 1024-pixel PNG;
- `web/icon/castpane.svg`;
- `web/public/castpane-*.png`, the web app's icons;
- `mac/AppIcon.svg`, `mac/MenuIcon.svg` and the files in `mac/Resources/` made from them.

You may keep these files in your copy of the repository and use them to refer to this project.
If you publish your own product or fork built on Castpane, replace the logo and the icons with
your own: change the files above (`node tools/icons.mjs` renders the PNGs and the macOS icons
from the SVGs), the icon paths in `web/public/push-config.js`, and the name in
`server/siteConfig.js`, `web/src/js/productConfig.js`, `web/index.html`, the PWA manifest in
`web/vite.config.js`, `web/public/reset-sw.html` and the app's `Info.plist` in
`mac/build-app.sh`.
