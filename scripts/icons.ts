// Gera os PNGs do ícone a partir do SVG (roda uma vez: npx tsx scripts/icons.ts)
import { webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
const svg = readFileSync('public/icon.svg', 'utf8');
const browser = await webkit.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['apple-touch-icon.png', 180, 0]] as const) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#1f3a5f">${svg.replace('<svg ', `<svg width="${size - pad * 2}" height="${size - pad * 2}" style="margin:${pad}px;display:block" `)}</body></html>`);
  await page.screenshot({ path: `public/${name}`, omitBackground: false });
}
await browser.close();
