// PWA アイコン PNG を favicon.svg 相当のデザインから Chromium で生成する（node scripts/gen-icons.mjs）
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public', 'icons');
const svg = (pad, rounded) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${rounded ? 14 : 0}" fill="#1f4f8f"/>
  <g transform="translate(${pad} ${pad}) scale(${(64 - pad * 2) / 64})">
    <path d="M16 24l16-8 16 8v18l-16 8-16-8z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
    <path d="M16 24l16 8 16-8M32 32v18" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
    <circle cx="48" cy="46" r="9" fill="#f5a623"/>
    <path d="M44 46l3 3 5-6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </g></svg>`;

const targets = [
  { file: 'icon-192.png', size: 192, pad: 0, rounded: true },
  { file: 'icon-512.png', size: 512, pad: 0, rounded: true },
  { file: 'icon-maskable-512.png', size: 512, pad: 8, rounded: false },
  { file: 'apple-touch-icon.png', size: 180, pad: 4, rounded: false },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg(t.pad, t.rounded)).toString('base64')}" width="${t.size}" height="${t.size}" style="display:block"/>
  </body></html>`);
  await page.screenshot({ path: join(out, t.file), omitBackground: true });
  console.log('wrote', t.file);
}
await browser.close();
