import { strFromU8, unzipSync } from 'fflate';
import type { Score } from '../model';
import { parseMscx } from './mscx';
import { parseMusicXml } from './musicxml';

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function isZip(b: Uint8Array) {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function parseXmlText(src: string): Score {
  const head = src.slice(0, 2000);
  if (head.includes('<museScore')) return parseMscx(src);
  if (head.includes('score-partwise') || head.includes('score-timewise')) return parseMusicXml(src);
  throw new Error('Formato não reconhecido (esperado .mscz, .mscx, .musicxml, .mxl ou .xml)');
}

/** Lê .mscz, .mscx, .mxl, .musicxml ou .xml — detecta pelo conteúdo, não pela extensão. */
export function loadScoreFromBytes(bytes: Uint8Array, filename = ''): Score {
  let score: Score;
  if (isZip(bytes)) {
    const files = unzipSync(bytes, { filter: (f) => !/\.(png|jpe?g|ogg|wav|mp3)$/i.test(f.name) });
    const names = Object.keys(files);
    const mscx = names.find((n) => /\.mscx$/i.test(n) && !n.includes('/'));
    if (mscx) score = parseMscx(decode(files[mscx]));
    else {
      // .mxl: META-INF/container.xml aponta o arquivo principal
      let root: string | undefined;
      const container = files['META-INF/container.xml'];
      if (container) root = strFromU8(container).match(/full-path="([^"]+)"/)?.[1];
      root ??= names.find((n) => /\.(musicxml|xml)$/i.test(n) && !n.startsWith('META-INF'));
      const anyMscx = names.find((n) => /\.mscx$/i.test(n));
      if (root && files[root]) score = parseXmlText(decode(files[root]));
      else if (anyMscx) score = parseMscx(decode(files[anyMscx]));
      else throw new Error('Arquivo compactado sem partitura dentro');
    }
  } else {
    score = parseXmlText(decode(bytes));
  }
  if ((!score.title || score.title === 'Sem título') && filename) score.title = filename.replace(/\.[^.]+$/, '');
  return score;
}
