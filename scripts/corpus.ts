// Valida os importadores contra um corpus real de .mscz.
// Para cada NNNN.mscz no diretório, compara:
//   A = nosso parse do .mscz
//   B = nosso parse do NNNN.musicxml gerado pelo próprio MuseScore (referência)
//   C = parse do MusicXML que NÓS exportamos a partir de A (roundtrip)
// Uso: npx tsx scripts/corpus.ts <dir> [--verbose]
import { DOMParser } from '@xmldom/xmldom';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setXmlParser } from '../src/io/xml';
import { loadScoreFromBytes } from '../src/io/files';
import { exportMusicXml, parseMusicXml } from '../src/io/musicxml';
import { type Score, computeAttrs, eventTicks, measureTicks, noteMidi } from '../src/model';

setXmlParser((src) => new DOMParser({ onError: () => {} }).parseFromString(src, 'text/xml') as unknown as Document);

const dir = process.argv[2];
const verbose = process.argv.includes('--verbose');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

function signature(s: Score): Map<string, number> {
  // multiconjunto de "pauta|compasso|posição|midi" para notas soando
  const out = new Map<string, number>();
  const chrom = s.parts.flatMap((p) => p.staves.map(() => p.transpose.chromatic));
  s.measures.forEach((m, j) => {
    m.staves.forEach((sm, si) => {
      for (const v of sm.voices) {
        let pos = 0;
        for (const e of v) {
          if (!e.rest) for (const n of e.notes) {
            const k = `${si}|${j}|${pos}|${noteMidi(n) + chrom[si]}`;
            out.set(k, (out.get(k) ?? 0) + 1);
          }
          pos += eventTicks(e);
        }
      }
    });
  });
  return out;
}

function compare(a: Map<string, number>, b: Map<string, number>): { common: number; total: number; diff: string[] } {
  let common = 0;
  let total = 0;
  const diff: string[] = [];
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    common += Math.min(x, y);
    total += Math.max(x, y);
    if (x !== y && diff.length < 8) diff.push(`${k} A=${x} B=${y}`);
  }
  return { common, total, diff };
}

function invariants(s: Score): string[] {
  const errs: string[] = [];
  const attrs = computeAttrs(s);
  s.measures.forEach((m, j) => {
    const len = measureTicks(m, attrs[j]);
    m.staves.forEach((sm, si) => {
      sm.voices.forEach((v, vi) => {
        const t = v.reduce((x, e) => x + eventTicks(e), 0);
        if (t !== len && errs.length < 5) errs.push(`m${j + 1} st${si} v${vi}: ${t} != ${len}`);
      });
    });
  });
  return errs;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.mscz') && (!only || f.startsWith(only))).sort();
let ok = 0;
let failed = 0;
const refScores: number[] = [];
const rtScores: number[] = [];
const bad: string[] = [];
const invBad: string[] = [];
const index = existsSync(join(dir, 'index.tsv'))
  ? new Map(readFileSync(join(dir, 'index.tsv'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string]))
  : new Map<string, string>();

for (const f of files) {
  const n = f.replace('.mscz', '');
  let A: Score;
  try {
    A = loadScoreFromBytes(readFileSync(join(dir, f)), f);
  } catch (e) {
    failed++;
    bad.push(`${n} PARSE ${(e as Error).message} (${index.get(n)})`);
    continue;
  }
  ok++;
  const inv = invariants(A);
  if (inv.length) invBad.push(`${n} ${inv.join('; ')}`);
  const sa = signature(A);
  // roundtrip
  try {
    const C = parseMusicXml(exportMusicXml(A));
    const r = compare(sa, signature(C));
    const ratio = r.total ? r.common / r.total : 1;
    rtScores.push(ratio);
    const invC = invariants(C);
    if (ratio < 1 || invC.length) bad.push(`${n} ROUNDTRIP ${(ratio * 100).toFixed(1)}% ${r.diff.slice(0, 3).join(' | ')} ${invC.slice(0, 2).join(';')}`);
  } catch (e) {
    bad.push(`${n} ROUNDTRIP-ERR ${(e as Error).stack?.split('\n').slice(0, 3).join(' ')}`);
  }
  const ref = join(dir, n + '.musicxml');
  if (existsSync(ref)) {
    try {
      const B = parseMusicXml(readFileSync(ref, 'utf8'));
      const r = compare(sa, signature(B));
      const ratio = r.total ? r.common / r.total : 1;
      refScores.push(ratio);
      if (ratio < 0.98) bad.push(`${n} REF ${(ratio * 100).toFixed(1)}% notes=${r.total} ${r.diff.slice(0, 4).join(' | ')} (${index.get(n)})`);
    } catch (e) {
      bad.push(`${n} REF-ERR ${(e as Error).message}`);
    }
  }
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const perfect = (xs: number[]) => xs.filter((x) => x === 1).length;
console.log(`parse ok: ${ok}/${ok + failed}`);
console.log(`vs MuseScore ref: ${refScores.length} arquivos, média ${(avg(refScores) * 100).toFixed(2)}%, 100%: ${perfect(refScores)}, >=98%: ${refScores.filter((x) => x >= 0.98).length}`);
console.log(`roundtrip: ${rtScores.length} arquivos, média ${(avg(rtScores) * 100).toFixed(3)}%, 100%: ${perfect(rtScores)}`);
console.log(`invariantes violadas: ${invBad.length}`);
if (verbose) {
  console.log('\n--- problemas');
  for (const b of bad) console.log(b);
  console.log('\n--- invariantes');
  for (const b of invBad.slice(0, 30)) console.log(b);
}
