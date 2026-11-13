import { type Event, TPQ, eventTicks } from './model';

/** Tamanho do grupo de barras de ligação por fórmula de compasso (em ticks). */
export function beamGroupTicks(time: { n: number; d: number }): number {
  if (time.d === 8 && time.n % 3 === 0) return (TPQ / 2) * 3; // compostos: semínima pontuada
  if (time.d === 8) return TPQ; // 2/8, 5/8, 7/8: agrupa por semínima
  if (time.d === 2) return TPQ * 2;
  if (time.d === 16) return TPQ / 2;
  return TPQ;
}

/** Grupos de índices de eventos que recebem barra (só colcheias ou menores, sem pausas). */
export function beamGroups(events: Event[], time: { n: number; d: number }): number[][] {
  const g = beamGroupTicks(time);
  const groups: number[][] = [];
  let cur: number[] = [];
  let curBucket = -1;
  let pos = 0;
  const flush = () => {
    if (cur.length > 1) groups.push(cur);
    cur = [];
  };
  events.forEach((e, i) => {
    const t = eventTicks(e);
    const bucket = Math.floor(pos / g);
    const beamable = !e.rest && !e.hidden && e.base >= 3;
    if (!beamable || bucket !== curBucket) flush();
    // tercinas ficam juntas mesmo cruzando o grupo
    if (beamable && cur.length > 0 && e.tuplet && events[cur[cur.length - 1]].tuplet?.id !== e.tuplet.id) flush();
    if (beamable) {
      if (cur.length === 0) curBucket = bucket;
      cur.push(i);
    }
    pos += t;
  });
  flush();
  return groups;
}
