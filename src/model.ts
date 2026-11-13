// Modelo interno da partitura. Tudo em ticks inteiros com TPQ = 10080 por semínima
// (divisível por 2^5·3^2·5·7) pra que tercinas, quintinas e sétimas de até 128ª
// fiquem exatas — evita a deriva de ponto flutuante na hora de somar compassos.
export const TPQ = 10080;
export const WHOLE = TPQ * 4;

/** 0 = semibreve, 1 = mínima, 2 = semínima, 3 = colcheia ... 7 = 128ª. -1 = breve. */
export type DurBase = number;

export type ClefType = 'G' | 'G8vb' | 'G8va' | 'F' | 'F8vb' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'PERC';

export interface Tuplet {
  id: string;
  actual: number; // ex.: 3 em uma tercina
  normal: number; // ex.: 2 em uma tercina
}

export interface Note {
  step: number; // 0..6 = C D E F G A B
  alter: number; // -2..2
  oct: number; // oitava científica (C4 = dó central)
  tie?: boolean; // ligadura de prolongamento para a próxima nota de mesma altura
}

export interface Event {
  id: string;
  rest: boolean;
  base: DurBase;
  dots: number;
  tuplet?: Tuplet;
  notes: Note[]; // vazio quando rest
  /** pausa de preenchimento em vozes 2-4 (não desenhada, vira <forward> no MusicXML) */
  hidden?: boolean;
  /** pausa de compasso inteiro (semibreve centralizada independente da fórmula) */
  measureRest?: boolean;
  lyric?: string;
  harmony?: string;
  slurStart?: boolean;
  slurEnd?: boolean;
}

export interface StaffMeasure {
  clef?: ClefType; // mudança de clave no início do compasso
  voices: Event[][]; // voices[0] sempre preenchida
}

export interface Measure {
  time?: { n: number; d: number }; // só quando muda
  key?: number; // armadura (quintas: -7..7), só quando muda
  tempo?: number; // semínimas por minuto, só quando muda
  /** duração real quando difere da fórmula (anacruse) */
  len?: number;
  repeatStart?: boolean;
  repeatEnd?: boolean;
  staves: StaffMeasure[];
}

export interface Part {
  id: string;
  name: string;
  abbr?: string;
  program: number; // GM 0..127
  /** escrito → soando: soando = escrito + chromatic */
  transpose: { diatonic: number; chromatic: number };
  staves: { clef: ClefType }[];
}

export interface Score {
  id: string;
  title: string;
  composer: string;
  parts: Part[];
  measures: Measure[];
  /** exibir em concert pitch (alturas soando) em vez de transposto */
  concertPitch?: boolean;
  createdAt: number;
  updatedAt: number;
}

let idCounter = 0;
export function uid(prefix = 'e'): string {
  idCounter = (idCounter + 1) % 1e9;
  return prefix + Date.now().toString(36) + idCounter.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// ---------- durações ----------

export function baseTicks(base: DurBase): number {
  return WHOLE / Math.pow(2, base);
}

export function dottedTicks(base: DurBase, dots: number): number {
  const b = baseTicks(base);
  let t = b;
  for (let i = 1; i <= dots; i++) t += b / Math.pow(2, i);
  return t;
}

export function eventTicks(ev: Pick<Event, 'base' | 'dots' | 'tuplet'>): number {
  const t = dottedTicks(ev.base, ev.dots);
  if (!ev.tuplet) return t;
  return Math.round((t * ev.tuplet.normal) / ev.tuplet.actual);
}

/** Decompõe uma duração (sem tercina) em figuras pontuadas, maiores primeiro. */
export function ticksToDurations(ticks: number): { base: DurBase; dots: number }[] {
  const out: { base: DurBase; dots: number }[] = [];
  let rem = ticks;
  while (rem > 0) {
    let found = false;
    for (let base = 0; base <= 7; base++) {
      for (let dots = 2; dots >= 0; dots--) {
        const t = dottedTicks(base, dots);
        if (t <= rem && Number.isInteger(t)) {
          out.push({ base, dots });
          rem -= t;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) break; // resto menor que 128ª: descarta
  }
  return out;
}

export function timeSigTicks(t: { n: number; d: number }): number {
  return Math.round((WHOLE * t.n) / t.d);
}

// ---------- alturas ----------

const STEP_SEMI = [0, 2, 4, 5, 7, 9, 11];
export const STEP_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
export const STEP_NAMES_PT = ['Dó', 'Ré', 'Mi', 'Fá', 'Sol', 'Lá', 'Si'];

export function noteMidi(n: Pick<Note, 'step' | 'alter' | 'oct'>): number {
  return (n.oct + 1) * 12 + STEP_SEMI[n.step] + n.alter;
}

export function diatonicIndex(n: Pick<Note, 'step' | 'oct'>): number {
  return n.oct * 7 + n.step;
}

export function fromDiatonic(d: number, alter = 0): Note {
  const oct = Math.floor(d / 7);
  return { step: d - oct * 7, alter, oct };
}

/** MuseScore TPC (tonal pitch class): 14 = C, ordem de quintas F C G D A E B, -1 = Fbb. */
export function tpcToStepAlter(tpc: number): { step: number; alter: number } {
  const letter = 'FCGDAEB'[(((tpc + 1) % 7) + 7) % 7];
  const alter = Math.floor((tpc + 1) / 7) - 2;
  return { step: STEP_NAMES.indexOf(letter), alter };
}

export function midiTpcToNote(midi: number, tpc: number): Note {
  const { step, alter } = tpcToStepAlter(tpc);
  const natural = midi - alter;
  const oct = Math.floor((natural - STEP_SEMI[step]) / 12) - 1;
  return { step, alter, oct };
}

/** Grafia padrão de um número MIDI, preferindo sustenidos ou bemóis conforme a armadura. */
export function midiToNote(midi: number, preferFlats: boolean): Note {
  const pc = ((midi % 12) + 12) % 12;
  const sharp: [number, number][] = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
  const flat: [number, number][] = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
  const [step, alter] = (preferFlats ? flat : sharp)[pc];
  const oct = Math.floor((midi - alter - STEP_SEMI[step]) / 12) - 1;
  return { step, alter, oct };
}

/** Alteração implícita da armadura para um grau. */
export function keyAlter(key: number, step: number): number {
  const sharpsOrder = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
  const flatsOrder = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
  if (key > 0) return sharpsOrder.slice(0, key).includes(step) ? 1 : 0;
  if (key < 0) return flatsOrder.slice(0, -key).includes(step) ? -1 : 0;
  return 0;
}

/** Transpõe uma nota por (passos diatônicos, semitons), mantendo a grafia correta. */
export function transposeNote(n: Note, diatonic: number, chromatic: number): Note {
  const target = fromDiatonic(diatonicIndex(n) + diatonic);
  const wantMidi = noteMidi(n) + chromatic;
  target.alter = wantMidi - noteMidi({ ...target, alter: 0 });
  return { ...n, step: target.step, oct: target.oct, alter: target.alter };
}

export function transposeKey(key: number, diatonic: number, chromatic: number): number {
  // tônica da armadura maior: key quintas a partir de C
  const tonicTpc = 14 + key;
  const { step, alter } = tpcToStepAlter(tonicTpc);
  const t = transposeNote({ step, alter, oct: 4 }, diatonic, chromatic);
  let k = (t.step === 0 ? 0 : [0, 2, 4, -1, 1, 3, 5][t.step]) + t.alter * 7;
  // normaliza para o enarmônico mais simples
  while (k > 7) k -= 12;
  while (k < -7) k += 12;
  return k;
}

// ---------- navegação no score ----------

export interface Attrs {
  time: { n: number; d: number };
  key: number;
  tempo: number;
  clefs: ClefType[];
}

/** Atributos efetivos no início de cada compasso (herdando mudanças anteriores). */
export function computeAttrs(score: Score): Attrs[] {
  const out: Attrs[] = [];
  let cur: Attrs = {
    time: { n: 4, d: 4 },
    key: 0,
    tempo: 100,
    clefs: allStaves(score).map((s) => s.clef),
  };
  for (const m of score.measures) {
    cur = {
      time: m.time ?? cur.time,
      key: m.key ?? cur.key,
      tempo: m.tempo ?? cur.tempo,
      clefs: cur.clefs.map((c, i) => m.staves[i]?.clef ?? c),
    };
    out.push(cur);
  }
  return out;
}

export function measureTicks(m: Measure, a: Attrs): number {
  return m.len ?? timeSigTicks(a.time);
}

export function allStaves(score: Score): { clef: ClefType; partIdx: number; staffInPart: number }[] {
  const out: { clef: ClefType; partIdx: number; staffInPart: number }[] = [];
  score.parts.forEach((p, pi) => p.staves.forEach((s, si) => out.push({ clef: s.clef, partIdx: pi, staffInPart: si })));
  return out;
}

export function voiceTicks(voice: Event[]): number {
  return voice.reduce((s, e) => s + eventTicks(e), 0);
}

export function restsFor(ticks: number, hidden = false): Event[] {
  return ticksToDurations(ticks).map((d) => ({ id: uid(), rest: true, base: d.base, dots: d.dots, notes: [], hidden: hidden || undefined }));
}

export function emptyMeasure(nStaves: number, ticks: number): Measure {
  return {
    staves: Array.from({ length: nStaves }, () => ({ voices: [measureRest(ticks)] })),
  };
}

export function measureRest(ticks: number): Event[] {
  const evs = restsFor(ticks);
  if (evs.length === 1) evs[0].measureRest = true;
  return evs;
}

export function cloneScore(s: Score): Score {
  return JSON.parse(JSON.stringify(s));
}

export function newScore(opts: {
  title: string;
  composer?: string;
  parts: { name: string; program: number; clefs: ClefType[]; transpose?: { diatonic: number; chromatic: number } }[];
  time: { n: number; d: number };
  key: number;
  tempo: number;
  measures: number;
  pickup?: number;
}): Score {
  const parts: Part[] = opts.parts.map((p) => ({
    id: uid('p'),
    name: p.name,
    program: p.program,
    transpose: p.transpose ?? { diatonic: 0, chromatic: 0 },
    staves: p.clefs.map((c) => ({ clef: c })),
  }));
  const nStaves = parts.reduce((s, p) => s + p.staves.length, 0);
  const full = timeSigTicks(opts.time);
  const measures: Measure[] = [];
  for (let i = 0; i < opts.measures; i++) {
    const len = i === 0 && opts.pickup ? opts.pickup : undefined;
    const m = emptyMeasure(nStaves, len ?? full);
    if (len) m.len = len;
    measures.push(m);
  }
  measures[0].time = opts.time;
  measures[0].key = opts.key;
  measures[0].tempo = opts.tempo;
  const now = Date.now();
  return { id: uid('s'), title: opts.title, composer: opts.composer ?? '', parts, measures, createdAt: now, updatedAt: now };
}
