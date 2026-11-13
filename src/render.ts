// Layout + desenho com VexFlow. Cada sistema vira um <svg> independente, com cache por
// assinatura (conteúdo dos compassos + largura): editar uma nota só redesenha o sistema
// afetado, o que mantém o toque responsivo no iPad mesmo em partituras longas.
import {
  Accidental,
  Annotation,
  AnnotationVerticalJustify,
  Barline,
  Beam,
  Curve,
  Dot,
  Formatter,
  GhostNote,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Tuplet as VFTuplet,
  Voice,
} from 'vexflow';
import { beamGroups } from './beams';
import {
  type Attrs,
  type ClefType,
  type Event,
  type Note,
  type Part,
  type Score,
  STEP_NAMES,
  allStaves,
  computeAttrs,
  eventTicks,
  keyAlter,
  measureTicks,
  noteMidi,
  transposeKey,
  transposeNote,
} from './model';

export const STAFF_GAP = 100; // distância entre linhas superiores de pautas do mesmo sistema
export const SYSTEM_GAP = 50; // espaço entre a última pauta de um sistema e a primeira do próximo
const MARGIN_X = 12;
const TOP_PAD = 50; // espaço acima da 1ª pauta do sistema (ledger lines, cifras)

const VF_CLEF: Record<ClefType, string> = {
  G: 'treble',
  G8vb: 'treble',
  G8va: 'treble',
  F: 'bass',
  F8vb: 'bass',
  C1: 'soprano',
  C2: 'mezzo-soprano',
  C3: 'alto',
  C4: 'tenor',
  C5: 'baritone-c',
  PERC: 'percussion',
};
/** índice diatônico (oct*7+step) da linha superior da pauta, por clave (posição de desenho) */
export const TOP_LINE: Record<ClefType, number> = {
  G: 38,
  G8vb: 38,
  G8va: 38,
  F: 26,
  F8vb: 26,
  C1: 36,
  C2: 34,
  C3: 32,
  C4: 30,
  C5: 28,
  PERC: 38,
};
/** deslocamento de oitava entre a nota escrita e onde ela é desenhada */
export const CLEF_OCT: Record<ClefType, number> = { G: 0, G8vb: 1, G8va: -1, F: 0, F8vb: 1, C1: 0, C2: 0, C3: 0, C4: 0, C5: 0, PERC: 0 };

const KEY_NAMES = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const VF_DUR: Record<number, string> = { [-2]: 'w', [-1]: 'w', 0: 'w', 1: 'h', 2: 'q', 3: '8', 4: '16', 5: '32', 6: '64', 7: '128' };

export interface RenderOpts {
  width: number; // largura útil em unidades de pauta (px antes do zoom)
  concert: boolean;
}

export interface HitEvent {
  v: number;
  e: number;
  id: string;
  x: number; // centro da cabeça de nota (coordenadas do sistema)
  tick: number;
  ys: number[]; // y das cabeças (na ordem das notas do evento)
}

export interface HitStaff {
  s: number;
  topY: number; // y da linha superior
  clef: ClefType;
  events: HitEvent[];
}

export interface HitMeasure {
  m: number;
  x: number;
  w: number;
  noteStartX: number;
  staves: HitStaff[];
}

export interface SystemLayout {
  measures: number[];
  widths: number[];
  xs: number[];
  height: number;
  top: number; // y do sistema na página (antes do zoom)
  header: boolean[];
}

export interface RenderedSystem {
  layout: SystemLayout;
  svg: SVGSVGElement;
  hits: HitMeasure[];
  sig: string;
}

// ---------------------------------------------------------------- conversão de alturas

export function staffKey(score: Score, part: Part, a: Attrs, concert: boolean): number {
  if (concert || part.transpose.chromatic === 0) return a.key;
  return transposeKey(a.key, -part.transpose.diatonic, -part.transpose.chromatic);
}

/** Nota escrita → nota desenhada (aplica concert pitch e o 8vb da clave). */
export function toDisplay(n: Note, part: Part, clef: ClefType, concert: boolean): Note {
  let d = n;
  if (concert && part.transpose.chromatic !== 0) d = transposeNote(n, part.transpose.diatonic, part.transpose.chromatic);
  return { ...d, oct: d.oct + CLEF_OCT[clef] };
}

/** Inverso de toDisplay: a partir de um índice diatônico desenhado, a nota escrita. */
export function fromDisplay(diatonic: number, alter: number, part: Part, clef: ClefType, concert: boolean): Note {
  const dd = diatonic - CLEF_OCT[clef] * 7;
  const oct = Math.floor(dd / 7);
  let n: Note = { step: dd - oct * 7, alter, oct };
  if (concert && part.transpose.chromatic !== 0) n = transposeNote(n, -part.transpose.diatonic, -part.transpose.chromatic);
  return n;
}

function vfKey(n: Note): string {
  return `${STEP_NAMES[n.step].toLowerCase()}/${n.oct}`;
}

function restKey(clef: ClefType): string {
  const mid = TOP_LINE[clef] - 4;
  const oct = Math.floor(mid / 7);
  return `${STEP_NAMES[mid - oct * 7].toLowerCase()}/${oct}`;
}

function accSymbol(alter: number): string {
  return alter === 2 ? '##' : alter === 1 ? '#' : alter === -1 ? 'b' : alter === -2 ? 'bb' : 'n';
}

// ---------------------------------------------------------------- layout

function eventWidth(e: Event): number {
  if (e.hidden) return 0;
  if (e.measureRest) return 50;
  const base = e.base <= 0 ? 40 : e.base === 1 ? 34 : e.base === 2 ? 30 : e.base === 3 ? 26 : e.base === 4 ? 23 : 21;
  let w = base + (e.dots ? 7 : 0);
  if (!e.rest) w += e.notes.some((n) => n.alter !== 0) ? 10 : 0;
  if (e.lyric) w = Math.max(w, e.lyric.length * 7 + 6);
  if (e.harmony) w = Math.max(w, e.harmony.length * 7 + 4);
  if (e.tuplet) w *= 0.85;
  return w;
}

function measureMinWidth(score: Score, j: number): number {
  let max = 0;
  for (const sm of score.measures[j].staves) {
    for (const v of sm.voices) {
      // vozes extras com pausas ocultas não ocupam espaço
      const w = v.reduce((s, e) => s + eventWidth(e), 0);
      if (w > max) max = w;
    }
  }
  return Math.max(60, max + 26);
}

function headerWidth(score: Score, a: Attrs, showTime: boolean, concert: boolean): number {
  let maxKey = 0;
  for (const p of score.parts) maxKey = Math.max(maxKey, Math.abs(staffKey(score, p, a, concert)));
  return 38 + maxKey * 10 + (showTime ? 30 : 0) + 6;
}

function changeWidth(score: Score, j: number, attrs: Attrs[], concert: boolean): number {
  if (j === 0) return 0;
  const m = score.measures[j];
  let w = 0;
  if (m.time) w += 30;
  if (m.key !== undefined) {
    let k = 0;
    for (const p of score.parts) k = Math.max(k, Math.abs(staffKey(score, p, attrs[j], concert)), Math.abs(staffKey(score, p, attrs[j - 1], concert)));
    w += k * 10 + 10;
  }
  if (m.staves.some((s) => s.clef)) w += 30;
  return w;
}

export function layoutSystems(score: Score, opts: RenderOpts): SystemLayout[] {
  const attrs = computeAttrs(score);
  const avail = opts.width - MARGIN_X * 2;
  const nStaves = allStaves(score).length;
  const sysHeight = TOP_PAD + (nStaves - 1) * STAFF_GAP + 40 + SYSTEM_GAP;
  const systems: SystemLayout[] = [];
  let cur: { measures: number[]; widths: number[]; header: boolean[] } = { measures: [], widths: [], header: [] };
  let used = 0;
  const flush = () => {
    if (!cur.measures.length) return;
    systems.push({ ...cur, xs: [], height: sysHeight, top: 0 });
    cur = { measures: [], widths: [], header: [] };
    used = 0;
  };
  for (let j = 0; j < score.measures.length; j++) {
    const first = cur.measures.length === 0;
    const hdr = first ? headerWidth(score, attrs[j], j === 0 || !!score.measures[j].time, opts.concert) : changeWidth(score, j, attrs, opts.concert);
    const w = measureMinWidth(score, j) + hdr;
    if (!first && used + w > avail) {
      flush();
      j--;
      continue;
    }
    cur.measures.push(j);
    cur.widths.push(w);
    cur.header.push(first);
    used += w;
  }
  flush();
  // justificação: distribui a sobra proporcionalmente (último sistema só se estiver quase cheio)
  let y = 0;
  systems.forEach((s, i) => {
    const total = s.widths.reduce((a, b) => a + b, 0);
    const last = i === systems.length - 1;
    const fill = total / avail;
    if (!last || fill > 0.7) {
      const k = avail / total;
      s.widths = s.widths.map((w) => w * k);
    } else {
      // último sistema: estica um pouco pra não ficar espremido
      const k = Math.min(1.35, avail / total);
      s.widths = s.widths.map((w) => w * k);
    }
    let x = MARGIN_X;
    s.xs = s.widths.map((w) => {
      const r = x;
      x += w;
      return r;
    });
    s.top = y;
    y += s.height;
  });
  return systems;
}

// ---------------------------------------------------------------- desenho de um sistema

interface TieState {
  // nota de origem por pauta/voz/altura midi
  [key: string]: { note: StaveNote | null; index: number };
}

/** Notas que chegam ligadas no início do compasso j (vindas do compasso anterior). */
function incomingTies(score: Score, j: number, s: number, v: number): Set<number> {
  const out = new Set<number>();
  if (j === 0) return out;
  const prev = score.measures[j - 1]?.staves[s]?.voices[v];
  const last = prev?.[prev.length - 1];
  if (last && !last.rest) for (const n of last.notes) if (n.tie) out.add(noteMidi(n));
  return out;
}

export function systemSignature(score: Score, sys: SystemLayout, opts: RenderOpts, attrs: Attrs[]): string {
  const parts = score.parts.map((p) => [p.transpose.chromatic, p.staves.map((s) => s.clef).join()].join(':')).join('|');
  const ms = sys.measures.map((j) => {
    const prevLast = j > 0 ? score.measures[j - 1].staves.map((sm) => sm.voices.map((v) => v[v.length - 1]?.notes.map((n) => (n.tie ? noteMidi(n) : '')).join())) : null;
    return JSON.stringify([score.measures[j], attrs[j], j > 0 ? attrs[j - 1] : null, prevLast, j === score.measures.length - 1]);
  });
  return [opts.concert, parts, sys.widths.map((w) => w.toFixed(1)).join(','), sys.measures[0], ...ms].join('#');
}

export function renderSystem(score: Score, sys: SystemLayout, opts: RenderOpts, attrs: Attrs[]): RenderedSystem {
  const staves = allStaves(score);
  const div = document.createElement('div');
  const renderer = new Renderer(div, Renderer.Backends.SVG);
  renderer.resize(opts.width, sys.height);
  const ctx = renderer.getContext();
  const hits: HitMeasure[] = [];
  const pendingTies: TieState = {};
  const pendingSlurs: Record<string, StaveNote> = {};
  const lastMeasure = score.measures.length - 1;

  const firstStaves: Stave[] = [];
  const lastStaves: Stave[] = [];

  sys.measures.forEach((j, k) => {
    const m = score.measures[j];
    const a = attrs[j];
    const prevA = j > 0 ? attrs[j - 1] : undefined;
    const x = sys.xs[k];
    const w = sys.widths[k];
    const hm: HitMeasure = { m: j, x, w, noteStartX: x, staves: [] };
    const vfStaves: Stave[] = [];

    // 1) pautas com modificadores
    staves.forEach((st, s) => {
      const part = score.parts[st.partIdx];
      const clef = a.clefs[s];
      const y = TOP_PAD + s * STAFF_GAP - 40;
      const stave = new Stave(x, y, w);
      const key = staffKey(score, part, a, opts.concert);
      if (sys.header[k]) {
        stave.addClef(VF_CLEF[clef], 'default', clef === 'G8vb' || clef === 'F8vb' ? '8vb' : clef === 'G8va' ? '8va' : undefined);
        if (key !== 0) stave.addKeySignature(KEY_NAMES[key + 7]);
        if (j === 0 || m.time) stave.addTimeSignature(`${a.time.n}/${a.time.d}`);
      } else {
        if (m.staves[s]?.clef) stave.addClef(VF_CLEF[clef], 'small', clef === 'G8vb' || clef === 'F8vb' ? '8vb' : undefined);
        if (m.key !== undefined && prevA) {
          const prevKey = staffKey(score, part, prevA, opts.concert);
          if (key !== prevKey) stave.addKeySignature(KEY_NAMES[key + 7], KEY_NAMES[prevKey + 7]);
        }
        if (m.time) stave.addTimeSignature(`${a.time.n}/${a.time.d}`);
      }
      if (m.repeatStart) stave.setBegBarType(Barline.type.REPEAT_BEGIN);
      else if (!sys.header[k]) stave.setBegBarType(Barline.type.NONE);
      if (m.repeatEnd) stave.setEndBarType(Barline.type.REPEAT_END);
      else if (j === lastMeasure) stave.setEndBarType(Barline.type.END);
      vfStaves.push(stave);
    });
    // alinha o começo das notas entre as pautas
    const noteStart = Math.max(...vfStaves.map((st) => st.getNoteStartX()));
    vfStaves.forEach((st) => st.setNoteStartX(noteStart));
    hm.noteStartX = noteStart;
    vfStaves.forEach((st) => st.setContext(ctx).draw());
    if (k === 0) firstStaves.push(...vfStaves);
    if (k === sys.measures.length - 1) lastStaves.push(...vfStaves);
    if (m.tempo !== undefined && (j === 0 || m.tempo !== attrs[j - 1].tempo)) {
      ctx.save();
      ctx.setFont('Arial', 12, 'bold');
      ctx.fillText(`♩ = ${m.tempo}`, x + (sys.header[k] ? 4 : 2), TOP_PAD - 28);
      ctx.restore();
    }

    // 2) notas
    const allVoices: Voice[] = [];
    const drawLater: (() => void)[] = [];
    const staffVoices: { s: number; vi: number; voice: Voice; notes: (StaveNote | GhostNote)[]; events: Event[] }[] = [];
    staves.forEach((st, s) => {
      const part = score.parts[st.partIdx];
      const clef = a.clefs[s];
      const key = staffKey(score, part, a, opts.concert);
      const sm = m.staves[s];
      if (!sm) return;
      const multi = sm.voices.filter((v) => v.some((e) => !e.hidden)).length > 1;
      const accState = new Map<number, number>();
      sm.voices.forEach((events, vi) => {
        if (!events.length) return;
        const incoming = incomingTies(score, j, s, vi);
        const notes: (StaveNote | GhostNote)[] = [];
        events.forEach((ev, ei) => {
          const dur = VF_DUR[ev.base] ?? 'q';
          if (ev.hidden) {
            const g = new GhostNote({ duration: dur, dots: ev.dots });
            notes.push(g);
            return;
          }
          let sn: StaveNote;
          if (ev.rest) {
            const rk = restKey(clef);
            sn = new StaveNote({
              keys: [ev.measureRest ? shiftKey(rk, 2) : rk],
              duration: (ev.measureRest ? 'w' : dur) + 'r',
              dots: ev.measureRest ? 0 : ev.dots,
              clef: VF_CLEF[clef],
              align_center: !!ev.measureRest,
            });
          } else {
            const disp = ev.notes.map((n) => toDisplay(n, part, clef, opts.concert));
            sn = new StaveNote({
              keys: disp.map(vfKey),
              duration: dur,
              dots: ev.dots,
              clef: VF_CLEF[clef],
              ...(multi ? { stem_direction: vi % 2 === 0 ? 1 : -1 } : { auto_stem: true }),
            });
            disp.forEach((dn, ni) => {
              const di = dn.oct * 7 + dn.step;
              const implied = accState.has(di) ? accState.get(di)! : keyAlter(key, dn.step);
              const tiedIn = ei === 0 && incoming.has(noteMidi(ev.notes[ni]));
              if (dn.alter !== implied && !tiedIn) sn.addModifier(new Accidental(accSymbol(dn.alter)), ni);
              accState.set(di, dn.alter);
            });
          }
          if (ev.dots && !ev.measureRest) Dot.buildAndAttach([sn], { all: true });
          sn.setAttribute('id', ev.id);
          if (ev.harmony) {
            sn.addModifier(
              new Annotation(ev.harmony).setFont('Arial', 13, 'bold').setVerticalJustification(AnnotationVerticalJustify.TOP),
              0,
            );
          }
          if (ev.lyric) {
            sn.addModifier(new Annotation(ev.lyric).setFont('Arial', 12).setVerticalJustification(AnnotationVerticalJustify.BOTTOM), 0);
          }
          notes.push(sn);
        });
        // tercinas antes de montar a Voice (elas alteram os ticks das notas)
        let i = 0;
        while (i < events.length) {
          const t = events[i].tuplet;
          if (!t) {
            i++;
            continue;
          }
          let k2 = i;
          while (k2 < events.length && events[k2].tuplet?.id === t.id) k2++;
          const group = notes.slice(i, k2);
          const tup = new VFTuplet(group as StaveNote[], {
            num_notes: t.actual,
            notes_occupied: t.normal,
            bracketed: group.some((n) => n instanceof StaveNote && n.isRest()) || group.length < t.actual,
            ratioed: false,
          });
          drawLater.push(() => tup.setContext(ctx).draw());
          i = k2;
        }
        const voice = new Voice({ num_beats: a.time.n, beat_value: a.time.d }).setMode(Voice.Mode.SOFT);
        voice.addTickables(notes);
        allVoices.push(voice);
        staffVoices.push({ s, vi, voice, notes, events });
        // barras de ligação
        for (const grp of beamGroups(events, a.time)) {
          const bnotes = grp.map((idx) => notes[idx]).filter((n): n is StaveNote => n instanceof StaveNote);
          if (bnotes.length < 2) continue;
          try {
            const beam = new Beam(bnotes, !multi);
            drawLater.push(() => beam.setContext(ctx).draw());
          } catch {
            /* grupo inválido pro VexFlow: desenha sem barra */
          }
        }
      });
    });

    // 3) formatação conjunta (alinha as pautas do compasso)
    try {
      const fmt = new Formatter();
      const byStaff = new Map<number, Voice[]>();
      for (const sv of staffVoices) {
        const list = byStaff.get(sv.s) ?? [];
        list.push(sv.voice);
        byStaff.set(sv.s, list);
      }
      for (const [, vs] of byStaff) fmt.joinVoices(vs);
      const avail = x + w - noteStart - 12;
      fmt.format(allVoices, Math.max(20, avail), { align_rests: true });
      for (const sv of staffVoices) sv.voice.draw(ctx, vfStaves[sv.s]);
      drawLater.forEach((f) => f());
    } catch (err) {
      ctx.save();
      ctx.setFillStyle('#c00');
      ctx.setFont('Arial', 11);
      ctx.fillText('⚠ erro ao desenhar', x + 6, TOP_PAD + 20);
      ctx.restore();
      console.warn('render measure', j, err);
    }

    // 4) hit map + ligaduras
    staves.forEach((st, s) => {
      hm.staves.push({ s, topY: vfStaves[s].getYForLine(0), clef: a.clefs[s], events: [] });
    });
    for (const sv of staffVoices) {
      let tick = 0;
      sv.events.forEach((ev, ei) => {
        const n = sv.notes[ei];
        const t = tick;
        tick += eventTicks(ev);
        let cx = x + w / 2;
        let ys: number[] = [];
        try {
          if (ev.measureRest) {
            // pausa de compasso é desenhada centralizada; pra entrada, conta como início do compasso
            cx = noteStart + 8;
          } else if (n instanceof StaveNote) {
            cx = n.getAbsoluteX() + n.getGlyphWidth() / 2;
            ys = n.getYs();
          } else {
            cx = n.getAbsoluteX();
          }
        } catch {
          /* nota não formatada */
        }
        hm.staves[sv.s].events.push({ v: sv.vi, e: ei, id: ev.id, x: cx, tick: t, ys });
        if (!(n instanceof StaveNote) || ev.rest) return;
        const part = score.parts[staves[sv.s].partIdx];
        ev.notes.forEach((note, ni) => {
          const key = `${sv.s}:${sv.vi}:${noteMidi(note)}`;
          const pend = pendingTies[key];
          if (pend) {
            new StaveTie({ first_note: pend.note, last_note: n, first_indices: [pend.index], last_indices: [ni] }).setContext(ctx).draw();
            delete pendingTies[key];
          } else if (ei === 0 && k === 0 && incomingTies(score, j, sv.s, sv.vi).has(noteMidi(note))) {
            // ligadura vinda do sistema anterior: meia ligadura no começo
            new StaveTie({ first_note: null, last_note: n, first_indices: [ni], last_indices: [ni] }).setContext(ctx).draw();
          }
          if (note.tie) pendingTies[key] = { note: n, index: ni };
          void part;
        });
        const sk = `${sv.s}:${sv.vi}`;
        if (ev.slurEnd && pendingSlurs[sk]) {
          try {
            new Curve(pendingSlurs[sk], n, { cps: [{ x: 0, y: 10 }, { x: 0, y: 10 }] }).setContext(ctx).draw();
          } catch {
            /* ignore */
          }
          delete pendingSlurs[sk];
        }
        if (ev.slurStart) pendingSlurs[sk] = n;
      });
      // nota ligada que não encontrou a seguinte neste compasso: espera o próximo
    }
    // ligaduras pendentes ao fim do sistema viram meia ligadura até a margem
    if (k === sys.measures.length - 1) {
      for (const key of Object.keys(pendingTies)) {
        const p = pendingTies[key];
        new StaveTie({ first_note: p.note, last_note: null, first_indices: [p.index], last_indices: [p.index] }).setContext(ctx).draw();
        delete pendingTies[key];
      }
    }
    // barra de compasso atravessando as pautas da mesma parte
    let base = 0;
    for (const part of score.parts) {
      if (part.staves.length > 1) {
        const c = new StaveConnector(vfStaves[base], vfStaves[base + part.staves.length - 1]);
        c.setType(j === lastMeasure ? StaveConnector.type.BOLD_DOUBLE_RIGHT : StaveConnector.type.SINGLE_RIGHT);
        c.setContext(ctx).draw();
      }
      base += part.staves.length;
    }
    hits.push(hm);
  });

  // conectores do início do sistema
  if (firstStaves.length > 1) {
    new StaveConnector(firstStaves[0], firstStaves[firstStaves.length - 1]).setType(StaveConnector.type.SINGLE_LEFT).setContext(ctx).draw();
  }
  let base = 0;
  for (const part of score.parts) {
    if (part.staves.length > 1) {
      new StaveConnector(firstStaves[base], firstStaves[base + part.staves.length - 1]).setType(StaveConnector.type.BRACE).setContext(ctx).draw();
    }
    base += part.staves.length;
  }
  if (score.parts.length > 1 && firstStaves.length > 1) {
    new StaveConnector(firstStaves[0], firstStaves[firstStaves.length - 1]).setType(StaveConnector.type.BRACKET).setContext(ctx).draw();
  }
  void lastStaves;

  // número do compasso no início do sistema
  if (sys.measures[0] > 0) {
    ctx.save();
    ctx.setFont('Arial', 10, 'italic');
    ctx.setFillStyle('#666');
    ctx.fillText(String(sys.measures[0] + 1), sys.xs[0], TOP_PAD - 14);
    ctx.restore();
  }

  const svg = div.querySelector('svg') as SVGSVGElement;
  svg.removeAttribute('style');
  return { layout: sys, svg, hits, sig: '' };
}

function shiftKey(k: string, steps: number): string {
  const [l, o] = k.split('/');
  const d = Number(o) * 7 + STEP_NAMES.indexOf(l.toUpperCase()) + steps;
  const oct = Math.floor(d / 7);
  return `${STEP_NAMES[d - oct * 7].toLowerCase()}/${oct}`;
}

// ---------------------------------------------------------------- render completo com cache

export class ScoreView {
  private cache = new Map<string, RenderedSystem>();
  systems: RenderedSystem[] = [];

  render(score: Score, opts: RenderOpts): RenderedSystem[] {
    const attrs = computeAttrs(score);
    const layouts = layoutSystems(score, opts);
    const next = new Map<string, RenderedSystem>();
    this.systems = layouts.map((l) => {
      const sig = systemSignature(score, l, opts, attrs);
      let r = this.cache.get(sig) ?? next.get(sig);
      if (r) {
        r = { ...r, layout: { ...r.layout, top: l.top } };
      } else {
        r = renderSystem(score, l, opts, attrs);
        r.sig = sig;
      }
      next.set(sig, r);
      return r;
    });
    this.cache = next;
    return this.systems;
  }

  clear() {
    this.cache.clear();
  }
}

export function measureCount(score: Score) {
  return score.measures.length;
}

export function measureDuration(score: Score, j: number, attrs = computeAttrs(score)) {
  return measureTicks(score.measures[j], attrs[j]);
}
