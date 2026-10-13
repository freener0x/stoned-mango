// Renders the PNG app icons from the SVGs in public/icons (run after changing them):
//   node scripts/icons.mjs        (CHROMIUM_PATH=... to use a specific Chromium)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = fileURLToPath(new URL('../public/icons/', import.meta.url));
const outputs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['maskable.svg', 'maskable-512.png', 512],
  ['maskable.svg', 'apple-touch-icon.png', 180], // iOS rounds the corners itself
];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const [svg, png, size] of outputs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const data = `data:image/svg+xml;base64,${readFileSync(dir + svg).toString('base64')}`;
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${data}" width="${size}" height="${size}"></body></html>`);
  await page.screenshot({ path: dir + png, omitBackground: true });
  await page.close();
  console.log(png);
}
await browser.close();
