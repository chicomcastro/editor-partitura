import { type Event, eventTicks, restsFor } from '../model';

export interface Item {
  voice: number;
  pos: number;
  ev: Event;
}

/** Duração em ticks; pausas de compasso inteiro carregam a duração real em `_ticks`. */
export function evTicks(ev: Event): number {
  return (ev as Event & { _ticks?: number })._ticks ?? eventTicks(ev);
}

/** Monta as vozes de um compasso a partir de itens posicionados, preenchendo buracos com pausas. */
export function buildVoices(items: Item[], measureLen: number): Event[][] {
  const byVoice: Item[][] = [[], [], [], []];
  for (const it of items) byVoice[Math.min(3, Math.max(0, it.voice))].push(it);
  const voices: Event[][] = [];
  for (let v = 0; v < 4; v++) {
    const list = byVoice[v].sort((a, b) => a.pos - b.pos);
    if (v > 0 && list.every((i) => i.ev.rest)) {
      // vozes extras só com pausas não carregam informação musical
      continue;
    }
    const out: Event[] = [];
    let fill = 0;
    for (const it of list) {
      if (it.pos < fill) continue; // sobreposição (arquivo corrompido ou nota de voz duplicada)
      if (it.pos >= measureLen) break;
      if (it.pos > fill) out.push(...restsFor(it.pos - fill, v > 0));
      const t = evTicks(it.ev);
      if (it.ev.measureRest) {
        const rests = restsFor(Math.min(t, measureLen - it.pos), v > 0 || it.ev.hidden);
        if (rests.length === 1) rests[0].measureRest = true;
        out.push(...rests);
        fill = it.pos + Math.min(t, measureLen - it.pos);
        continue;
      }
      out.push(it.ev);
      fill = it.pos + t;
    }
    if (fill < measureLen) out.push(...restsFor(measureLen - fill, v > 0));
    if (v === 0 || out.some((e) => !e.rest)) {
      while (voices.length < v) voices.push([]);
      voices[v] = out;
    }
  }
  if (!voices[0] || voices[0].length === 0) voices[0] = restsFor(measureLen);
  // vozes intermediárias vazias ficam como pausas ocultas
  for (let v = 1; v < voices.length; v++) if (!voices[v] || voices[v].length === 0) voices[v] = restsFor(measureLen, true);
  return voices;
}
