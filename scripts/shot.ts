// Exploração visual: abre o app no WebKit como iPad e tira screenshots.
// Uso: npx tsx scripts/shot.ts <outdir> [arquivo.mscz]
import { webkit, devices } from '@playwright/test';
const out = process.argv[2];
const file = process.argv[3];
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
const page = await ctx.newPage();
const logs: string[] = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}\n${e.stack}`));
await page.goto('http://localhost:4173/');
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/01-library.png` });
if (file) {
  const t0 = Date.now();
  await page.setInputFiles('#file-input', file);
  await page.waitForSelector('#systems svg', { timeout: 30000 });
  logs.push(`import+render ms: ${Date.now() - t0}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/02-imported.png` });
} else {
  await page.click('#new-btn');
  await page.click('dialog button[value=create]');
  await page.waitForSelector('#systems svg');
  await page.screenshot({ path: `${out}/02-new.png` });
  // toca na pauta: terceira linha do primeiro compasso
  const box = await page.locator('#systems svg').first().boundingBox();
  const z = await page.evaluate(() => (window as any).__pauta.st.zoom);
  const tap = async (ux: number, uy: number) => {
    await page.touchscreen.tap(box!.x + ux * z, box!.y + uy * z);
    await page.waitForTimeout(150);
  };
  // linha superior em y = 50 (TOP_PAD) no sistema; notas em 50 + passos*5
  await tap(150, 50 + 20); // B4 (linha do meio)
  await tap(200, 50 + 15); // C5
  await tap(260, 50 + 10); // D5
  await tap(320, 50 + 25); // A4
  await page.screenshot({ path: `${out}/03-notes.png` });
}
console.log(logs.join('\n'));
await browser.close();
