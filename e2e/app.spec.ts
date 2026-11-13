import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// fixture local (não versionada): qualquer .mscz copiado pra e2e/fixtures/sample.mscz
const FIXTURE = join(process.cwd(), 'e2e', 'fixtures', 'sample.mscz');

async function newScore(page: Page) {
  await page.goto('/');
  await page.click('#new-btn');
  await page.click('dialog button[value=create]');
  await page.waitForSelector('#systems svg');
}

/** Toca num ponto em coordenadas de pauta (antes do zoom) do primeiro sistema.
 * `ux` é relativo ao início das notas do 1º compasso. */
async function tapStaff(page: Page, ux: number, uy: number) {
  const box = (await page.locator('#systems svg').first().boundingBox())!;
  const { z, start } = await page.evaluate(() => {
    const p = (window as any).__pauta;
    return { z: p.st.zoom, start: p.systems[0].hits[0].noteStartX };
  });
  await page.touchscreen.tap(box.x + (start + ux) * z, box.y + uy * z);
  await page.waitForTimeout(80);
}

function voice0(page: Page, m: number, s = 0) {
  return page.evaluate(
    ([m, s]) =>
      (window as any).__pauta.st.score.measures[m].staves[s].voices[0].map((e: any) =>
        e.rest ? 'r' : e.notes.map((n: any) => 'CDEFGAB'[n.step] + (n.alter > 0 ? '#' : n.alter < 0 ? 'b' : '') + n.oct).join('+'),
      ),
    [m, s],
  );
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as any)._errors = errors;
});

test.afterEach(async ({ page }) => {
  expect((page as any)._errors).toEqual([]);
});

test('escreve notas tocando na pauta (nota pela altura do toque)', async ({ page }) => {
  await newScore(page);
  // linha superior da clave de sol = Fá5 em y=50; cada meio espaço = 5
  await tapStaff(page, 8, 50 + 20); // Si4 (linha do meio), 1º tempo
  await tapStaff(page, 60, 50 + 10); // Ré5, um pouco adiante
  const v = await voice0(page, 0);
  expect(v[0]).toBe('B4');
  expect(v).toContain('D5');
  expect(v.length).toBeGreaterThanOrEqual(3);
});

test('arrastar o dedo antes de soltar ajusta a altura', async ({ page }) => {
  await newScore(page);
  const box = (await page.locator('#systems svg').first().boundingBox())!;
  const { z, start } = await page.evaluate(() => {
    const p = (window as any).__pauta;
    return { z: p.st.zoom, start: p.systems[0].hits[0].noteStartX };
  });
  const x = box.x + (start + 8) * z;
  const y0 = box.y + 70 * z;
  // gesto touch manual via CDP não existe no WebKit; usa os eventos de mouse (mesmo caminho)
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y0 - 15 * z, { steps: 5 }); // 3 passos acima: Mi5
  await page.mouse.up();
  expect((await voice0(page, 0))[0]).toBe('E5');
});

test('modo seleção: acidente, apagar, desfazer e refazer', async ({ page }) => {
  await newScore(page);
  await tapStaff(page, 8, 70); // Si4
  await page.click('#mode-select');
  // seleciona a nota tocando nela
  const hit = await page.evaluate(() => {
    const p = (window as any).__pauta;
    return p.st.score.measures[0].staves[0].voices[0][0].id;
  });
  const el = page.locator(`[id="vf-${hit}"]`);
  const b = (await el.boundingBox())!;
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height - 6);
  await page.click('#acc-flat');
  expect((await voice0(page, 0))[0]).toBe('Bb4');
  await page.click('#del');
  expect((await voice0(page, 0))[0]).toBe('r');
  await page.click('#undo');
  expect((await voice0(page, 0))[0]).toBe('Bb4');
  await page.click('#redo');
  expect((await voice0(page, 0))[0]).toBe('r');
});

test('piano virtual escreve e avança; acorde e ligadura', async ({ page }) => {
  await newScore(page);
  await page.click('#piano-toggle');
  await page.click('#dur-3'); // colcheia
  await page.locator('.keys button[data-midi="60"]').dispatchEvent('pointerdown');
  await page.locator('.keys button[data-midi="62"]').dispatchEvent('pointerdown');
  await page.click('#chord');
  await page.locator('.keys button[data-midi="66"]').dispatchEvent('pointerdown');
  await page.click('#chord');
  await page.click('#tie');
  const v = await voice0(page, 0);
  // ligadura vale pra nota selecionada (a recém-adicionada ao acorde), como no MuseScore
  expect(v.slice(0, 3)).toEqual(['C4', 'D4+F#4', 'F#4']);
});

test('importa .mscz real, toca e exporta MusicXML', async ({ page }) => {
  test.skip(!existsSync(FIXTURE), 'sem fixture');
  await page.goto('/');
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#systems svg');
  const n = await page.evaluate(() => (window as any).__pauta.st.score.measures.length);
  expect(n).toBeGreaterThan(4);
  await page.click('#play');
  await page.waitForTimeout(600);
  expect(await page.locator('#systems .playing').count()).toBeGreaterThan(0);
  await page.click('#play');
  const xml = await page.evaluate(() => (window as any).__pauta.exportMusicXml((window as any).__pauta.st.score));
  expect(xml).toContain('<score-partwise');
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/exported.musicxml', xml);
});

test('compasso: muda fórmula e armadura pelo diálogo', async ({ page }) => {
  await newScore(page);
  await page.click('#measure-menu');
  await page.fill('dialog input[name=tn]', '3');
  await page.selectOption('dialog select[name=key]', '-2');
  await page.click('dialog button[value=apply]');
  const a = await page.evaluate(() => {
    const s = (window as any).__pauta.st.score;
    return [s.measures[0].time, s.measures[0].key];
  });
  expect(a).toEqual([{ n: 3, d: 4 }, -2]);
});

test('funciona offline e mantém as partituras salvas', async ({ page, context }) => {
  await newScore(page);
  await tapStaff(page, 8, 70);
  await page.waitForTimeout(600); // salvamento com debounce
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // segunda carga já controlada pelo SW
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#lib-list li[data-id]')).toHaveCount(1);
  await page.click('#lib-list li[data-id] button[data-act=open]');
  await page.waitForSelector('#systems svg');
  expect((await voice0(page, 0))[0]).toBe('B4');
  await context.setOffline(false);
});
