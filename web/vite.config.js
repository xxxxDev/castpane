// The PWA's build: npm run build writes web/dist (the server serves it, and
// Castpane.app bundles it as Contents/Resources/web). Checks build into a scratch
// folder with --outDir.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
import {VitePWA} from 'vite-plugin-pwa';
import {describeSourceBuild, resolveBuildId} from './buildId.js';
import {createRequire} from 'node:module';
// The service's port (server/siteConfig.js, one place).
const site = createRequire(import.meta.url)('../server/siteConfig.js');

// Build id: `git describe` of the last commit that could change the output
// (`v0.1.0`, `v0.1.0-3-gabc1234`, `-dirty` for unsaved source). One marker for the
// Settings footer, the update prompt and /version.json (buildId.js).
const BUILD_ID = resolveBuildId({describe: describeSourceBuild});
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Publishes the build id the server is serving so a running app can tell it is on an
// older build. Excluded from the precache below: a cached copy would make the app
// compare itself against its own stale answer.
const versionEndpoint = () => ({
  name: 'version-endpoint',
  apply: 'build',
  generateBundle() {
    this.emitFile({type: 'asset', fileName: 'version.json', source: `${JSON.stringify({buildId: BUILD_ID})}\n`});
  },
});

// The dev server passes the API, the live socket and the remote relay on to a server
// started with npm run server, so a page it serves works the same.
const target = 'http://127.0.0.1:' + site.servicePort();

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  // One bundle for the whole app: Framework7 and Vue are most of it.
  build: {outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true, chunkSizeWarningLimit: 1600},
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    versionEndpoint(),
    vue({
      // Keep absolute "/..." URLs (public/ assets) as literal runtime paths.
      template: {transformAssetUrls: {includeAbsolute: false}},
    }),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['castpane-64.png', 'castpane-128.png', 'castpane-256.png', 'castpane-app-180.png', 'castpane-app-1024.png'],
      manifest: {
        name: 'Castpane',
        short_name: 'Castpane',
        description: 'See and control your own Mac from a phone or another computer',
        lang: 'en-US',
        display: 'standalone',
        background_color: '#121212',
        theme_color: '#121212',
        start_url: '/',
        scope: '/',
        // Opaque on the app's own dark background: macOS puts a transparent icon on a
        // default light tile.
        icons: [
          {src: '/castpane-app-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'any'},
          {src: '/castpane-app-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'maskable'},
        ],
      },
      workbox: {
        // Activate and claim at once so a fresh update cannot be shadowed by a stale precache.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,jpeg,webp,ico,woff,woff2,json}'],
        // version.json must always come from the network.
        globIgnores: ['version.json'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/live$/, /^\/remote$/, /\.[a-z0-9]+$/i],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 4194304,
        // The generated Workbox worker owns caching; this sidecar adds only Web Push
        // display and click handling, its product values first (public/push-config.js).
        importScripts: ['/push-config.js', '/push-handler.js'],
      },
      // A service worker registered by the dev server keeps stale pages on a phone.
      devOptions: {enabled: false},
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: site.DEV_PORT,
    strictPort: true,
    headers: {'Cache-Control': 'no-store'},
    proxy: {'/api': {target, changeOrigin: true}, '/live': {target, changeOrigin: true, ws: true}, '/remote': {target, changeOrigin: true, ws: true}},
  },
  // The preview serves a build alone, for the page tests: it passes nothing on to a
  // server (left unset, it would take the dev server's proxy).
  preview: {
    host: '127.0.0.1',
    port: site.DEV_PORT,
    headers: {'Cache-Control': 'no-store'},
    proxy: {},
  },
});
