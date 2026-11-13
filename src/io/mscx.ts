// Importador de .mscx (MuseScore 2.x, 3.x e 4.x; 1.x no melhor esforço).
//
// O formato guarda altura em concert pitch (`pitch` + `tpc`) e a grafia transposta
// em `tpc2`. Nosso modelo guarda a nota ESCRITA (o que aparece na pauta), então
// instrumentos transpositores são convertidos aqui: escrito = concert − transposeChromatic.
import {
  type ClefType,
  type Event,
  type Measure,
  type Note,
  type Part,
  type Score,
  type Tuplet,
  TPQ,
  WHOLE,
  midiTpcToNote,
  timeSigTicks,
  tpcToStepAlter,
  transposeKey,
  transposeNote,
  uid,
  STEP_NAMES,
} from '../model';
import { kid, kids, num, parseXml, path, text } from './xml';
import { type Item, buildVoices, evTicks } from './common';

const DUR: Record<string, number> = {
  long: -2,
  breve: -1,
  whole: 0,
  half: 1,
  quarter: 2,
  eighth: 3,
  '16th': 4,
  '32nd': 5,
  '64th': 6,
  '128th': 7,
  '256th': 7,
  '512th': 7,
  '1024th': 7,
};

const GRACE_TAGS = ['acciaccatura', 'appoggiatura', 'grace4', 'grace16', 'grace32', 'grace8after', 'grace16after', 'grace32after'];

export function normalizeClef(s: string | undefined): ClefType | undefined {
  if (!s) return undefined;
  const v = s.trim();
  if (/^\d+$/.test(v)) {
    // MuseScore 1.x usava códigos numéricos
    const legacy: Record<string, ClefType> = { '0': 'G', '1': 'G8va', '3': 'G8vb', '4': 'F', '5': 'F8vb', '8': 'C3', '9': 'C4', '10': 'PERC', '11': 'G8vb' };
    return legacy[v] ?? 'G';
  }
  if (v.startsWith('G8vb') || v.startsWith('G15mb')) return 'G8vb';
  if (v.startsWith('G8va') || v.startsWith('G15ma')) return 'G8va';
  if (v.startsWith('G')) return 'G';
  if (v.startsWith('F8vb') || v.startsWith('F15mb')) return 'F8vb';
  if (v.startsWith('F')) return 'F';
  if (/^C[1-5]/.test(v)) return v.slice(0, 2) as ClefType;
  if (v.startsWith('PERC')) return 'PERC';
  if (v.startsWith('TAB')) return 'G8vb';
  return 'G';
}

function parseFrac(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(-?\d+)\/(\d+)$/);
  if (!m) return undefined;
  return Math.round((WHOLE * Number(m[1])) / Number(m[2]));
}

function tpcName(tpc: number): string {
  const { step, alter } = tpcToStepAlter(tpc);
  return STEP_NAMES[step] + (alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter));
}

function harmonyText(h: Element): string | undefined {
  const info = kid(h, 'harmonyInfo') ?? h;
  const root = num(info, 'root');
  const name = text(info, 'name') ?? '';
  const base = num(info, 'base');
  if (root === undefined) return name || undefined;
  return tpcName(root) + name + (base !== undefined ? '/' + tpcName(base) : '');
}

interface PartInfo {
  part: Part;
  transposing: boolean;
}

function parsePart(p: Element): PartInfo {
  const instr = kid(p, 'Instrument');
  const dia = num(instr, 'transposeDiatonic') ?? 0;
  const chrom = num(instr, 'transposeChromatic') ?? 0;
  const transposing = chrom !== 0;
  const staffEls = kids(p, 'Staff');
  const instrClefs = kids(instr, 'clef');
  const staves = staffEls.map((s, i) => {
    const group = kid(s, 'StaffType')?.getAttribute('group');
    let clef: ClefType | undefined;
    if (group === 'percussion') clef = 'PERC';
    else if (group === 'tablature') clef = 'G8vb';
    clef ??= normalizeClef(
      (transposing ? text(s, 'defaultTransposingClef') : undefined) ?? text(s, 'defaultConcertClef') ?? text(s, 'defaultClef'),
    );
    if (!clef) {
      const ic = instrClefs.find((c) => (c.getAttribute('staff') ?? '1') === String(i + 1));
      clef = normalizeClef(ic ? text(ic) : undefined);
    }
    clef ??= normalizeClef((transposing ? text(instr, 'transposingClef') : undefined) ?? text(instr, 'concertClef'));
    return { clef: clef ?? 'G' };
  });
  const program = Number(path(instr, 'Channel', 'program')?.getAttribute('value') ?? 0) || 0;
  const name = text(p, 'trackName') || text(instr, 'longName') || text(instr, 'trackName') || 'Instrumento';
  return {
    part: {
      id: uid('p'),
      name: name.replace(/\s+/g, ' '),
      abbr: text(instr, 'shortName'),
      program,
      transpose: { diatonic: dia, chromatic: chrom },
      staves: staves.map((s) => ({ clef: s.clef })),
    },
    transposing,
  };
}

interface StreamCtx {
  info: PartInfo;
  measureLen: number;
  /** MuseScore 2.x: tick absoluto do início do compasso na divisão do arquivo */
  measureStartRaw: number;
  division: number;
  items: Item[];
  clefAt: { pos: number; clef: ClefType }[];
  tempo?: number;
  keyConcert?: number;
  time?: { n: number; d: number };
  tupletById: Map<string, Tuplet>;
  /** MuseScore 1.x guardava a altura escrita, não a de concerto */
  writtenPitch: boolean;
  /** linhas de 8va/15ma: o .mscx guarda a altura SEM o deslocamento; o modelo guarda o som real */
  ottava: { shift: number; ids: Map<string, number> };
}

const OTTAVA: Record<string, number> = { '8va': 12, '8vb': -12, '15ma': 24, '15mb': -24, '22ma': 36, '22mb': -36 };
function ottavaShift(el: Element | undefined): number {
  const st = text(el, 'subtype') ?? '8va';
  return OTTAVA[st] ?? (/^\d+$/.test(st) ? [12, -12, 24, -24, 36, -36][Number(st)] ?? 0 : 0);
}

function parseChordOrRest(el: Element, ctx: StreamCtx, tuplet: Tuplet | undefined): Event | null {
  if (GRACE_TAGS.some((g) => kid(el, g))) return null;
  const isRest = el.nodeName === 'Rest';
  const dt = text(el, 'durationType') ?? 'quarter';
  const ev: Event = { id: uid(), rest: isRest, base: 2, dots: num(el, 'dots') ?? 0, notes: [] };
  if (dt === 'measure') {
    ev.measureRest = true;
    ev.base = 0;
    ev.dots = 0;
    (ev as Event & { _ticks?: number })._ticks = parseFrac(text(el, 'duration')) ?? ctx.measureLen;
  } else {
    ev.base = DUR[dt] ?? 2;
  }
  if (tuplet) ev.tuplet = tuplet;
  if (kid(el, 'visible')?.textContent?.trim() === '0' && isRest) ev.hidden = true;
  if (!isRest) {
    const { transposing, part } = ctx.info;
    for (const n of kids(el, 'Note')) {
      const rawPitch = num(n, 'pitch');
      if (rawPitch === undefined) continue;
      const pitch = rawPitch + ctx.ottava.shift;
      const tpc = num(n, 'tpc') ?? 14;
      const tpc2 = num(n, 'tpc2');
      let note: Note;
      if (transposing && !ctx.writtenPitch) {
        const written = pitch - part.transpose.chromatic;
        if (tpc2 !== undefined) note = midiTpcToNote(written, tpc2);
        else note = transposeNote(midiTpcToNote(pitch, tpc), -part.transpose.diatonic, -part.transpose.chromatic);
      } else {
        note = midiTpcToNote(pitch, tpc);
      }
      const tieSp = kids(n, 'Spanner').find((s) => s.getAttribute('type') === 'Tie' && kid(s, 'next'));
      if (tieSp || kid(n, 'Tie')) note.tie = true;
      ev.notes.push(note);
    }
    if (ev.notes.length === 0) {
      ev.rest = true;
    }
    ev.notes.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
    for (const sp of kids(el, 'Spanner')) {
      if (sp.getAttribute('type') !== 'Slur') continue;
      if (kid(sp, 'next')) ev.slurStart = true;
      if (kid(sp, 'prev')) ev.slurEnd = true;
    }
    const lyr = kids(el, 'Lyrics').find((l) => !num(l, 'no'));
    if (lyr) {
      const t = text(lyr, 'text');
      if (t) ev.lyric = t;
    }
  }
  return ev;
}

/**
 * Percorre a sequência de elementos de uma voz (3.x/4.x) ou do compasso inteiro (2.x),
 * gerando itens posicionados.
 */
function walkStream(elements: Element[], voice: number, ctx: StreamCtx, legacy: boolean) {
  let pos = 0;
  let curVoice = voice;
  const tupletStack: Tuplet[] = [];
  let pendingHarmony: string | undefined;
  for (const el of elements) {
    switch (el.nodeName) {
      case 'location': {
        const f = parseFrac(text(el, 'fractions'));
        if (f !== undefined) pos += f;
        break;
      }
      case 'tick': {
        if (legacy) {
          const t = Number(text(el));
          pos = Math.round(((t - ctx.measureStartRaw) * TPQ) / ctx.division);
        }
        break;
      }
      case 'Tuplet': {
        const actual = num(el, 'actualNotes') ?? 3;
        const normal = num(el, 'normalNotes') ?? 2;
        const outer = tupletStack[tupletStack.length - 1];
        const t: Tuplet = {
          id: uid('t'),
          actual: outer ? outer.actual * actual : actual,
          normal: outer ? outer.normal * normal : normal,
        };
        const id = el.getAttribute('id');
        if (id) ctx.tupletById.set(id, t);
        else tupletStack.push(t);
        break;
      }
      case 'endTuplet':
        tupletStack.pop();
        break;
      case 'Harmony':
        pendingHarmony = harmonyText(el);
        break;
      case 'Spanner': {
        if (el.getAttribute('type') !== 'Ottava') break;
        if (kid(el, 'next')) ctx.ottava.shift = ottavaShift(kid(el, 'Ottava'));
        else if (kid(el, 'prev')) ctx.ottava.shift = 0;
        break;
      }
      case 'Ottava': {
        // 2.x: <Ottava id="n"> abre, <endSpanner id="n"/> fecha
        const id = el.getAttribute('id');
        ctx.ottava.shift = ottavaShift(el);
        if (id) ctx.ottava.ids.set(id, ctx.ottava.shift);
        break;
      }
      case 'endSpanner': {
        const id = el.getAttribute('id');
        if (id && ctx.ottava.ids.has(id)) {
          ctx.ottava.ids.delete(id);
          ctx.ottava.shift = 0;
        }
        break;
      }
      case 'Chord':
      case 'Rest': {
        if (legacy) {
          const tr = num(el, 'track');
          if (tr !== undefined) curVoice = tr % 4;
          else curVoice = 0;
        }
        const ref = text(el, 'Tuplet');
        const tuplet = ref ? ctx.tupletById.get(ref) : tupletStack[tupletStack.length - 1];
        const ev = parseChordOrRest(el, ctx, tuplet);
        if (!ev) break;
        if (pendingHarmony) {
          ev.harmony = pendingHarmony;
          pendingHarmony = undefined;
        }
        ctx.items.push({ voice: curVoice, pos, ev });
        pos += evTicks(ev);
        break;
      }
      case 'Clef': {
        const tr = ctx.info.transposing;
        const c = normalizeClef(
          (tr ? text(el, 'transposingClefType') : undefined) ?? text(el, 'concertClefType') ?? text(el, 'subtype'),
        );
        if (c) ctx.clefAt.push({ pos, clef: c });
        break;
      }
      case 'KeySig': {
        const concert = num(el, 'concertKey');
        if (concert !== undefined) ctx.keyConcert ??= concert;
        else {
          const actual = num(el, 'actualKey') ?? num(el, 'accidental') ?? 0;
          const t = ctx.info.part.transpose;
          ctx.keyConcert ??= ctx.info.transposing ? transposeKey(actual, t.diatonic, t.chromatic) : actual;
        }
        break;
      }
      case 'TimeSig': {
        const n = num(el, 'sigN');
        const d = num(el, 'sigD');
        if (n && d) ctx.time ??= { n, d };
        break;
      }
      case 'Tempo': {
        const t = num(el, 'tempo');
        if (t && ctx.tempo === undefined) ctx.tempo = Math.round(t * 60);
        break;
      }
    }
  }
}

function findMeta(scoreEl: Element, name: string): string | undefined {
  const m = kids(scoreEl, 'metaTag').find((e) => e.getAttribute('name') === name);
  const v = m ? text(m) : undefined;
  return v || undefined;
}

function findFrameText(staffEl: Element | undefined, style: string): string | undefined {
  if (!staffEl) return undefined;
  for (const box of kids(staffEl, 'VBox')) {
    for (const t of kids(box, 'Text')) {
      const st = (text(t, 'style') ?? text(t, 'subtype') ?? '').toLowerCase();
      if (st === style.toLowerCase()) {
        const v = kid(t, 'text');
        const s = v ? (v.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
        if (s) return s;
      }
    }
  }
  return undefined;
}

export function parseMscx(src: string): Score {
  const doc = parseXml(src);
  const root = doc.documentElement;

  const scoreEl = kid(root, 'Score') ?? root;
  const version = parseFloat(root.getAttribute('version') ?? '3');
  const division = num(scoreEl, 'Division') ?? num(root, 'Division') ?? 480;

  const partInfos = kids(scoreEl, 'Part').map(parsePart);
  // As <Staff> de nível de score seguem a mesma ordem das pautas das partes. Casar por
  // posição em vez de id: no 4.6 as pautas dentro de <Part> nem têm atributo id.
  const scoreStaffEls = kids(scoreEl, 'Staff');

  // lista global de pautas, na ordem das partes
  const staffList: { el: Element | undefined; info: PartInfo; staffInPart: number }[] = [];
  for (const pi of partInfos)
    pi.part.staves.forEach((_, i) => staffList.push({ el: scoreStaffEls[staffList.length], info: pi, staffInPart: i }));
  if (staffList.length === 0) throw new Error('Nenhuma pauta encontrada no arquivo');

  // compassos com <multiMeasureRest> são o resumo visual da pausa multicompasso;
  // os compassos reais vêm logo depois, então o resumo é descartado
  const measureEls = staffList.map((s) => kids(s.el, 'Measure').filter((m) => !kid(m, 'multiMeasureRest')));
  const nMeasures = Math.max(...measureEls.map((m) => m.length));
  if (nMeasures === 0) throw new Error('Partitura sem compassos');

  const measures: Measure[] = [];
  let curTime = { n: 4, d: 4 };
  let startRaw = 0;
  const pendingClef: (ClefType | undefined)[] = staffList.map(() => undefined);
  const curClef: ClefType[] = staffList.map((s) => s.info.part.staves[s.staffInPart].clef);
  const ottavaState = staffList.map(() => ({ shift: 0, ids: new Map<string, number>() }));

  for (let j = 0; j < nMeasures; j++) {
    // fórmula de compasso: procura na primeira pauta que tiver
    let time: { n: number; d: number } | undefined;
    for (const ms of measureEls) {
      const m = ms[j];
      if (!m) continue;
      const ts = m.getElementsByTagName('TimeSig')[0];
      if (ts) {
        const n = num(ts, 'sigN');
        const d = num(ts, 'sigD');
        if (n && d) {
          time = { n, d };
          break;
        }
      }
    }
    if (time) curTime = time;
    const lenAttr = parseFrac(measureEls[0][j]?.getAttribute('len'));
    const nominal = timeSigTicks(curTime);
    const mLen = lenAttr && lenAttr > 0 ? lenAttr : nominal;

    const measure: Measure = { staves: [] };
    if (time) measure.time = time;
    if (lenAttr && lenAttr !== nominal) measure.len = lenAttr;

    staffList.forEach((st, si) => {
      const mEl = measureEls[si][j];
      const ctx: StreamCtx = {
        info: st.info,
        measureLen: mLen,
        measureStartRaw: startRaw,
        division,
        items: [],
        clefAt: [],
        tupletById: new Map(),
        writtenPitch: version < 2,
        ottava: ottavaState[si],
      };
      if (mEl) {
        const voiceEls = kids(mEl, 'voice');
        if (voiceEls.length > 0) voiceEls.forEach((v, vi) => walkStream(kids(v), vi, ctx, false));
        else walkStream(kids(mEl), 0, ctx, true);
        if (si === 0 || measure.tempo === undefined) if (ctx.tempo !== undefined) measure.tempo ??= ctx.tempo;
        if (ctx.keyConcert !== undefined && measure.key === undefined) measure.key = ctx.keyConcert;
        if (kid(mEl, 'startRepeat')) measure.repeatStart = true;
        if (kid(mEl, 'endRepeat')) measure.repeatEnd = true;
      }
      const sm = { voices: buildVoices(ctx.items, mLen) } as Measure['staves'][number];
      let clefHere = pendingClef[si];
      pendingClef[si] = undefined;
      for (const c of ctx.clefAt) {
        if (c.pos <= 0) clefHere = c.clef;
        else pendingClef[si] = c.clef; // troca no meio/fim do compasso vale a partir do próximo
      }
      if (clefHere && clefHere !== curClef[si]) {
        if (j === 0) st.info.part.staves[st.staffInPart].clef = clefHere;
        else sm.clef = clefHere;
        curClef[si] = clefHere;
      }
      measure.staves.push(sm);
    });
    measures.push(measure);
    startRaw += Math.round((mLen * division) / TPQ);
  }

  measures[0].time ??= { n: 4, d: 4 };
  measures[0].key ??= 0;
  measures[0].tempo ??= 100;
  // armadura repetida não é mudança
  let k = measures[0].key;
  for (let j = 1; j < measures.length; j++) {
    if (measures[j].key === undefined) continue;
    if (measures[j].key === k) delete measures[j].key;
    else k = measures[j].key!;
  }
  let t = measures[0].time!;
  for (let j = 1; j < measures.length; j++) {
    const mt = measures[j].time;
    if (!mt) continue;
    if (mt.n === t.n && mt.d === t.d) delete measures[j].time;
    else t = mt;
  }

  const firstStaff = staffList[0].el;
  const title =
    findMeta(scoreEl, 'workTitle') || findFrameText(firstStaff, 'Title') || findFrameText(firstStaff, 'title') || 'Sem título';
  const composer = findMeta(scoreEl, 'composer') || findFrameText(firstStaff, 'Composer') || '';
  const now = Date.now();
  return {
    concertPitch: text(scoreEl, 'concertPitch') === '1' || undefined,
    id: uid('s'),
    title,
    composer,
    parts: partInfos.map((p) => p.part),
    measures,
    createdAt: now,
    updatedAt: now,
  };
}
