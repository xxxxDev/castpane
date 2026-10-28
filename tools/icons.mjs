// The icons, drawn with Playwright and the installed Chrome:
// - web/public: from web/icon/castpane.svg, the app icons opaque and square (iOS rounds them),
//   the small ones rounded;
// - mac/Resources/AppIcon.icns: from mac/AppIcon.svg, through iconutil;
// - mac/Resources/MenuIcon.png and MenuIcon@2x.png: from mac/MenuIcon.svg, 18 points tall.
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage();

async function draw(svg, width, height, file, radius = 0) {
  // A small viewport draws the SVG wrong (repeated slices), so the page is at least 512 wide.
  await page.setViewportSize({width: Math.max(width, 512), height: Math.max(height, 512)});
  await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${width}px;height:${height}px;border-radius:${radius}px;overflow:hidden">${svg.replace('<svg ', `<svg width="${width}" height="${height}" `)}</div></body></html>`);
  await page.screenshot({path: file, omitBackground: true, clip: {x: 0, y: 0, width, height}});
}

const web = read('web/icon/castpane.svg');
for (const [name, size, round] of [['castpane-app-1024.png', 1024, false], ['castpane-app-180.png', 180, false], ['castpane-256.png', 256, true], ['castpane-128.png', 128, true], ['castpane-64.png', 64, true]]) {
  await draw(web, size, size, path.join(root, 'web/public', name), round ? size * 0.22 : 0);
}

const resources = path.join(root, 'mac/Resources');
fs.mkdirSync(resources, {recursive: true});
const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'castpane-')) + '/AppIcon.iconset';
fs.mkdirSync(iconset);
const app = read('mac/AppIcon.svg');
for (const size of [16, 32, 128, 256, 512]) {
  await draw(app, size, size, path.join(iconset, `icon_${size}x${size}.png`));
  await draw(app, size * 2, size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AppIcon.icns')]);
fs.rmSync(path.dirname(iconset), {recursive: true});

// The mark is 433 by 363 in its viewBox; the menu bar shows it 18 points tall.
const menu = read('mac/MenuIcon.svg');
await draw(menu, 22, 18, path.join(resources, 'MenuIcon.png'));
await draw(menu, 43, 36, path.join(resources, 'MenuIcon@2x.png'));

await browser.close();
console.log('icons written to web/public and mac/Resources');
