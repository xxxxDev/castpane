# Contributing

Thanks for helping. Castpane is a small project, so a short, focused change is the easiest to review.

## Before you start

- For a bug, open an issue with what you did, what you expected and what happened, plus the
  Castpane version (Settings › About in the Mac app) and your Mac, macOS version and browser.
- For a larger change or a new feature, open an issue first so we can agree on the approach.
- For a security problem, follow [SECURITY.md](SECURITY.md) instead.

## Development

You need the Command Line Tools (Swift 6) and Node.js 22.18 or later.

```sh
npm run setup      # npm ci at the root (web, tools) and in server/
npm run build      # web/dist
npm run lint       # oxlint
mac/build-app.sh   # mac/build/Castpane.app
```

To run the server from source, keep it out of `~/Library/Application Support/Castpane` with a
folder of its own, such as `CASTPANE_HOME=$PWD/.castpane`. `npm run build` writes `web/dist`,
which a running server serves; to check that a change builds without touching it, build into a
scratch folder. [docs/development.md](docs/development.md) has the layout, running from source,
hot reload, packaging and signing.

The project's test suite is maintained separately and is not part of this repository. In your
pull request, describe how you checked the change: what you ran, on which Mac and macOS, and
what you saw. Never capture a screen or post input you have not meant to, and keep checks away
from a Castpane you use.

## Guidelines

- Match the style of the code around your change.
- Keep one place for each rule: Host and Origin in `server/siteConfig.js`, product names and
  storage keys in `server/siteConfig.js`, `web/src/js/productConfig.js` and
  `web/public/push-config.js`.
- The Remote page's comments record what was found on a real iPhone. Keep them when you change
  the code they explain.
- Text shown to people comes in English and Traditional Chinese.
- Code comments are in English and say why, not what.
