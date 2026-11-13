// Operações de edição. Todas mutam o score in-place; quem chama tira o snapshot pro undo.
// Semântica de entrada igual à do MuseScore: escrever uma figura SOBRESCREVE o tempo a
// partir da posição, quebrando o que sobrar em pausas — a voz 1 nunca fica com buraco.
import {
  type ClefType,
  type Event,
  type Measure,
  type Note,
  type Score,
  allStaves,
  computeAttrs,
  emptyMeasure,
  eventTicks,
  keyAlter,
  measureRest,
  measureTicks,
  midiToNote,
  noteMidi,
  restsFor,
  ticksToDurations,
  timeSigTicks,
  uid,
} from './model';

export interface Pos {
  m: number;
  s: number;
  v: number;
}

export function starts(voice: Event[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const e of voice) {
    out.push(t);
    t += eventTicks(e);
  }
  return out;
}

export function measureLen(score: Score, m: number): number {
  return measureTicks(score.measures[m], computeAttrs(score)[m]);
}

export function getVoice(score: Score, p: Pos, create = false): Event[] | undefined {
  const sm = score.measures[p.m]?.staves[p.s];
  if (!sm) return undefined;
  if (!sm.voices[p.v] && create) {
    const len = measureLen(score, p.m);
    for (let v = sm.voices.length; v <= p.v; v++) sm.voices[v] = v === p.v ? restsFor(len) : restsFor(len, true);
  }
  return sm.voices[p.v];
}

export function eventIndexAt(voice: Event[], tick: number): number {
  const st = starts(voice);
  for (let i = 0; i < voice.length; i++) if (tick >= st[i] && tick < st[i] + eventTicks(voice[i])) return i;
  return voice.length - 1;
}

/** Divide uma duração em pedaços; se for nota, os pedaços ficam ligados entre si. */
function piecesOf(ev: Event, ticks: number, keepHead: boolean): Event[] {
  const durs = ticksToDurations(ticks);
  return durs.map((d, i) => {
    const notes = ev.rest
      ? []
      : ev.notes.map((n) => ({ ...n, tie: i < durs.length - 1 ? true : keepHead ? n.tie : undefined }));
    return { ...ev, id: i === 0 ? ev.id : uid(), base: d.base, dots: d.dots, tuplet: undefined, notes, measureRest: undefined, lyric: i === 0 ? ev.lyric : undefined, harmony: i === 0 ? ev.harmony : undefined };
  });
}

/**
 * Escreve `ev` na voz a partir de `tick`, sobrescrevendo o que estiver lá.
 * Dentro de uma tercina, só troca o conteúdo do membro (mantém a duração do grupo).
 * Retorna o índice do evento escrito.
 */
export function writeEvent(score: Score, p: Pos, tick: number, ev: Event): number {
  const voice = getVoice(score, p, true)!;
  const len = measureLen(score, p.m);
  const idx = eventIndexAt(voice, tick);
  const target = voice[idx];
  if (target?.tuplet) {
    voice[idx] = { ...ev, id: ev.id, base: target.base, dots: target.dots, tuplet: target.tuplet };
    return idx;
  }
  const remaining = len - tick;
  let d = eventTicks(ev);
  if (d > remaining) {
    const fit = ticksToDurations(remaining)[0];
    if (!fit) return idx;
    ev = { ...ev, base: fit.base, dots: fit.dots };
    d = eventTicks(ev);
  }
  // tercinas que cruzam o intervalo viram pausas inteiras primeiro
  let st = starts(voice);
  const end = tick + d;
  const touched = new Set<string>();
  voice.forEach((e, i) => {
    if (e.tuplet && st[i] < end && st[i] + eventTicks(e) > tick) touched.add(e.tuplet.id);
  });
  if (touched.size) {
    const rebuilt: Event[] = [];
    for (let i = 0; i < voice.length; ) {
      const e = voice[i];
      if (e.tuplet && touched.has(e.tuplet.id)) {
        let t = 0;
        const id = e.tuplet.id;
        while (i < voice.length && voice[i].tuplet?.id === id) t += eventTicks(voice[i++]);
        rebuilt.push(...restsFor(t));
      } else {
        rebuilt.push(e);
        i++;
      }
    }
    voice.splice(0, voice.length, ...rebuilt);
    st = starts(voice);
  }
  const out: Event[] = [];
  let newIdx = -1;
  voice.forEach((e, i) => {
    const s = st[i];
    const eEnd = s + eventTicks(e);
    if (eEnd <= tick || s >= end) {
      if (s >= end && newIdx < 0) {
        newIdx = out.length;
        out.push(ev);
      }
      out.push(e);
      return;
    }
    if (s < tick) out.push(...piecesOf(e, tick - s, false));
    if (newIdx < 0) {
      newIdx = out.length;
      out.push(ev);
    }
    if (eEnd > end) out.push(...restsFor(eEnd - end));
  });
  if (newIdx < 0) {
    newIdx = out.length;
    out.push(ev);
  }
  voice.splice(0, voice.length, ...out);
  return newIdx;
}

/** Próxima posição de entrada depois do evento `e` (avança compasso e cria um se preciso). */
export function nextPos(score: Score, p: Pos, e: number): { p: Pos; e: number } {
  const voice = getVoice(score, p)!;
  if (e + 1 < voice.length) return { p, e: e + 1 };
  if (p.m + 1 >= score.measures.length) appendMeasures(score, 1);
  const np = { ...p, m: p.m + 1 };
  getVoice(score, np, true);
  return { p: np, e: 0 };
}

export function prevPos(score: Score, p: Pos, e: number): { p: Pos; e: number } {
  if (e > 0) return { p, e: e - 1 };
  if (p.m === 0) return { p, e: 0 };
  const np = { ...p, m: p.m - 1 };
  const v = getVoice(score, np, true)!;
  return { p: np, e: v.length - 1 };
}

export function makeNoteEvent(notes: Note[], base: number, dots: number): Event {
  return { id: uid(), rest: false, base, dots, notes: notes.map((n) => ({ ...n })) };
}

export function makeRestEvent(base: number, dots: number): Event {
  return { id: uid(), rest: true, base, dots, notes: [] };
}

function sameNote(a: Note, b: Note) {
  return a.step === b.step && a.oct === b.oct;
}

export function sortNotes(notes: Note[]) {
  notes.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step) || a.alter - b.alter);
}

/** Acrescenta uma nota ao acorde (ou transforma a pausa em nota). Retorna o índice da nota. */
export function addNoteToChord(ev: Event, n: Note): number {
  if (ev.rest) {
    ev.rest = false;
    ev.hidden = undefined;
    ev.measureRest = undefined;
    ev.notes = [{ ...n }];
    return 0;
  }
  const existing = ev.notes.findIndex((x) => sameNote(x, n));
  if (existing >= 0) {
    ev.notes[existing] = { ...ev.notes[existing], alter: n.alter };
    return existing;
  }
  const copy = { ...n };
  ev.notes.push(copy);
  sortNotes(ev.notes);
  return ev.notes.indexOf(copy);
}

/** Apaga nota (se acorde) ou transforma o evento em pausa. */
export function deleteAt(score: Score, p: Pos, e: number, noteIdx?: number) {
  const voice = getVoice(score, p);
  if (!voice?.[e]) return;
  const ev = voice[e];
  if (!ev.rest && noteIdx !== undefined && ev.notes.length > 1) {
    ev.notes.splice(noteIdx, 1);
    return;
  }
  ev.rest = true;
  ev.notes = [];
  ev.lyric = undefined;
  ev.slurStart = ev.slurEnd = undefined;
  // voz extra só com pausas: remove a voz
  const sm = score.measures[p.m].staves[p.s];
  if (p.v > 0 && sm.voices[p.v].every((x) => x.rest)) {
    sm.voices[p.v] = restsFor(measureLen(score, p.m), true);
    while (sm.voices.length > 1 && sm.voices[sm.voices.length - 1].every((x) => x.rest)) sm.voices.pop();
  }
  // compasso só com pausas na voz 1: volta pra pausa de compasso
  if (p.v === 0 && sm.voices[0].every((x) => x.rest && !x.tuplet)) {
    sm.voices[0] = measureRest(measureLen(score, p.m));
  }
}

/** Troca a duração mantendo o conteúdo; retorna o novo índice. */
export function setDuration(score: Score, p: Pos, e: number, base: number, dots: number): number {
  const voice = getVoice(score, p)!;
  const ev = voice[e];
  if (!ev) return e;
  const tick = starts(voice)[e];
  const copy: Event = { ...ev, base, dots, measureRest: undefined };
  // mudar a figura de um membro de tercina quebraria o grupo; não suportado
  if (ev.tuplet) return e;
  return writeEvent(score, p, tick, copy);
}

/** Transforma o evento numa tercina de 3 figuras do valor imediatamente menor. */
export function makeTuplet(score: Score, p: Pos, e: number, actual = 3): number {
  const voice = getVoice(score, p)!;
  const ev = voice[e];
  if (!ev || ev.tuplet || ev.base >= 7) return e;
  const normal = actual === 3 ? 2 : actual === 5 ? 4 : actual === 6 ? 4 : actual === 7 ? 4 : 2;
  // figura base dentro do grupo: duração total / normal
  const base = ev.base + (normal === 4 ? 2 : 1);
  const t = { id: uid('t'), actual, normal };
  const members: Event[] = [];
  for (let i = 0; i < actual; i++) {
    members.push(
      i === 0 && !ev.rest
        ? { ...ev, id: uid(), base, dots: ev.dots, tuplet: t, measureRest: undefined, notes: ev.notes.map((n) => ({ ...n, tie: undefined })) }
        : { id: uid(), rest: true, base, dots: ev.dots, notes: [], tuplet: t },
    );
  }
  voice.splice(e, 1, ...members);
  return e;
}

export function toggleDot(score: Score, p: Pos, e: number): number {
  const ev = getVoice(score, p)?.[e];
  if (!ev) return e;
  return setDuration(score, p, e, ev.base, ev.dots ? 0 : 1);
}

/** Próximo evento na mesma voz (atravessando compasso). */
export function nextEvent(score: Score, p: Pos, e: number): { p: Pos; e: number } | undefined {
  const v = getVoice(score, p);
  if (!v) return undefined;
  if (e + 1 < v.length) return { p, e: e + 1 };
  if (p.m + 1 >= score.measures.length) return undefined;
  const np = { ...p, m: p.m + 1 };
  const nv = getVoice(score, np, true);
  return nv && nv.length ? { p: np, e: 0 } : undefined;
}

/**
 * Liga (prolonga) as notas do evento com o próximo. Se o próximo não tiver a mesma altura,
 * ele vira a mesma nota — igual ao comando de ligadura do MuseScore durante a entrada.
 */
export function toggleTie(score: Score, p: Pos, e: number, noteIdx?: number): boolean {
  const ev = getVoice(score, p)?.[e];
  if (!ev || ev.rest) return false;
  const targets = noteIdx !== undefined && ev.notes[noteIdx] ? [ev.notes[noteIdx]] : ev.notes;
  const turnOn = !targets.every((n) => n.tie);
  for (const n of targets) n.tie = turnOn || undefined;
  if (!turnOn) return true;
  let nx = nextEvent(score, p, e);
  if (!nx) {
    appendMeasures(score, 1);
    nx = nextEvent(score, p, e);
  }
  if (!nx) return true;
  const next = getVoice(score, nx.p)![nx.e];
  for (const n of targets) {
    if (next.rest || !next.notes.some((x) => noteMidi(x) === noteMidi(n))) {
      if (next.rest) {
        next.rest = false;
        next.measureRest = undefined;
        if (next.base < 0) next.base = 0;
        next.notes = [];
        next.hidden = undefined;
      }
      if (!next.notes.some((x) => noteMidi(x) === noteMidi(n))) {
        next.notes.push({ step: n.step, alter: n.alter, oct: n.oct });
        sortNotes(next.notes);
      }
    }
  }
  return true;
}

/** Move a altura diatonicamente (passos na pauta), aplicando a armadura. */
export function moveDiatonic(n: Note, steps: number, key: number): Note {
  const d = n.oct * 7 + n.step + steps;
  const oct = Math.floor(d / 7);
  const step = d - oct * 7;
  return { ...n, step, oct, alter: keyAlter(key, step) };
}

/** Move cromaticamente (semitons), com grafia preferindo a direção do movimento. */
export function moveChromatic(n: Note, semis: number, key: number): Note {
  const midi = noteMidi(n) + semis;
  // se a nota da escala da armadura cobre o midi, usa ela
  for (let step = 0; step < 7; step++) {
    const alter = keyAlter(key, step);
    const base = noteMidi({ step, alter, oct: 0 });
    const diff = midi - base;
    if (diff % 12 === 0) return { ...n, step, alter, oct: diff / 12 };
  }
  const prefer = key < 0 || (key === 0 && semis < 0);
  return { ...midiToNote(midi, prefer), tie: n.tie };
}

export function setAlter(n: Note, alter: number): Note {
  return { ...n, alter: n.alter === alter ? 0 : alter };
}

// ---------------- compassos

function staffCount(score: Score) {
  return allStaves(score).length;
}

export function appendMeasures(score: Score, count: number) {
  const attrs = computeAttrs(score);
  const last = attrs[attrs.length - 1];
  const len = timeSigTicks(last.time);
  for (let i = 0; i < count; i++) score.measures.push(emptyMeasure(staffCount(score), len));
}

export function insertMeasure(score: Score, at: number) {
  const attrs = computeAttrs(score);
  const a = attrs[Math.min(at, attrs.length - 1)];
  const m = emptyMeasure(staffCount(score), timeSigTicks(a.time));
  // as mudanças de atributo ficam no compasso que já as tinha
  if (at === 0) {
    const first = score.measures[0];
    m.time = first.time;
    m.key = first.key;
    m.tempo = first.tempo;
    delete first.time;
    delete first.key;
    delete first.tempo;
    if (first.len) {
      // anacruse deixa de ser o primeiro compasso: vira compasso cheio
      fitMeasure(score, 1, timeSigTicks(a.time));
    }
  }
  score.measures.splice(at, 0, m);
}

export function deleteMeasure(score: Score, at: number) {
  if (score.measures.length <= 1) {
    const len = measureLen(score, 0);
    score.measures[0].staves = score.measures[0].staves.map(() => ({ voices: [measureRest(len)] }));
    return;
  }
  const removed = score.measures[at];
  score.measures.splice(at, 1);
  const next = score.measures[at];
  if (next) {
    // mudanças de atributo do compasso apagado passam pro seguinte
    next.time ??= removed.time;
    next.key ??= removed.key;
    next.tempo ??= removed.tempo;
    removed.staves.forEach((sm, i) => {
      if (sm.clef && next.staves[i]) next.staves[i].clef ??= sm.clef;
    });
  }
  if (at === 0) {
    const a = computeAttrs({ ...score, measures: [removed] })[0];
    score.measures[0].time ??= a.time;
    score.measures[0].key ??= a.key;
    score.measures[0].tempo ??= a.tempo;
  }
}

export function clearMeasure(score: Score, at: number, staff?: number) {
  const len = measureLen(score, at);
  score.measures[at].staves.forEach((sm, i) => {
    if (staff !== undefined && i !== staff) return;
    sm.voices = [measureRest(len)];
  });
}

/** Ajusta o conteúdo de um compasso pra uma nova duração (corta ou completa com pausas). */
export function fitMeasure(score: Score, at: number, newLen: number) {
  const m = score.measures[at];
  if (!m) return;
  delete m.len;
  for (const sm of m.staves) {
    sm.voices = sm.voices.map((voice, vi) => {
      if (voice.length === 1 && voice[0].measureRest) return measureRest(newLen);
      const out: Event[] = [];
      let t = 0;
      for (const e of voice) {
        const d = eventTicks(e);
        if (t + d <= newLen) {
          out.push(e);
          t += d;
          continue;
        }
        if (t < newLen) {
          if (e.tuplet) out.push(...restsFor(newLen - t, vi > 0));
          else out.push(...piecesOf(e, newLen - t, false));
          t = newLen;
        }
        break;
      }
      if (t < newLen) out.push(...restsFor(newLen - t, vi > 0));
      return out;
    });
  }
}

export function setTimeSig(score: Score, at: number, time: { n: number; d: number }) {
  const m = score.measures[at];
  m.time = time;
  const len = timeSigTicks(time);
  for (let j = at; j < score.measures.length; j++) {
    if (j > at && score.measures[j].time) break;
    fitMeasure(score, j, len);
  }
  normalizeAttrs(score);
}

export function setKey(score: Score, at: number, key: number) {
  score.measures[at].key = key;
  normalizeAttrs(score);
}

export function setTempo(score: Score, at: number, bpm: number) {
  score.measures[at].tempo = Math.max(20, Math.min(400, Math.round(bpm)));
  normalizeAttrs(score);
}

export function setClef(score: Score, at: number, staff: number, clef: ClefType) {
  if (at === 0) {
    const st = allStaves(score)[staff];
    score.parts[st.partIdx].staves[st.staffInPart].clef = clef;
    delete score.measures[0].staves[staff].clef;
  } else score.measures[at].staves[staff].clef = clef;
  normalizeAttrs(score);
}

/** Remove mudanças redundantes (mesmo valor que já vigora). */
export function normalizeAttrs(score: Score) {
  let time = score.measures[0].time ?? { n: 4, d: 4 };
  let key = score.measures[0].key ?? 0;
  let tempo = score.measures[0].tempo ?? 100;
  const clefs = allStaves(score).map((s) => s.clef);
  for (let j = 1; j < score.measures.length; j++) {
    const m = score.measures[j];
    if (m.time && m.time.n === time.n && m.time.d === time.d) delete m.time;
    else if (m.time) time = m.time;
    if (m.key === key) delete m.key;
    else if (m.key !== undefined) key = m.key;
    if (m.tempo === tempo) delete m.tempo;
    else if (m.tempo !== undefined) tempo = m.tempo;
    m.staves.forEach((sm, i) => {
      if (sm.clef === clefs[i]) delete sm.clef;
      else if (sm.clef) clefs[i] = sm.clef;
    });
  }
}

export function setPickup(score: Score, ticks: number | undefined) {
  const a = computeAttrs(score)[0];
  const full = timeSigTicks(a.time);
  const len = ticks && ticks < full ? ticks : full;
  fitMeasure(score, 0, len);
  if (len < full) score.measures[0].len = len;
}

// ---------------- partes

export function addPart(score: Score, opts: { name: string; program: number; clefs: ClefType[]; transpose?: { diatonic: number; chromatic: number } }) {
  const attrs = computeAttrs(score);
  score.parts.push({
    id: uid('p'),
    name: opts.name,
    program: opts.program,
    transpose: opts.transpose ?? { diatonic: 0, chromatic: 0 },
    staves: opts.clefs.map((c) => ({ clef: c })),
  });
  score.measures.forEach((m, j) => {
    const len = measureTicks(m, attrs[j]);
    for (let i = 0; i < opts.clefs.length; i++) m.staves.push({ voices: [measureRest(len)] });
  });
}

export function removePart(score: Score, partIdx: number) {
  if (score.parts.length <= 1) return;
  const staves = allStaves(score);
  const first = staves.findIndex((s) => s.partIdx === partIdx);
  const count = score.parts[partIdx].staves.length;
  score.parts.splice(partIdx, 1);
  for (const m of score.measures) m.staves.splice(first, count);
}

export function movePart(score: Score, partIdx: number, dir: -1 | 1) {
  const to = partIdx + dir;
  if (to < 0 || to >= score.parts.length) return;
  const staves = allStaves(score);
  const firstA = staves.findIndex((s) => s.partIdx === Math.min(partIdx, to));
  const a = score.parts[Math.min(partIdx, to)];
  const b = score.parts[Math.max(partIdx, to)];
  const na = a.staves.length;
  const nb = b.staves.length;
  score.parts.splice(Math.min(partIdx, to), 2, b, a);
  for (const m of score.measures) {
    const seg = m.staves.splice(firstA, na + nb);
    m.staves.splice(firstA, 0, ...seg.slice(na), ...seg.slice(0, na));
  }
}

// ---------------- copiar / colar compassos

export function copyMeasures(score: Score, from: number, to: number): Measure[] {
  return JSON.parse(JSON.stringify(score.measures.slice(from, to + 1)));
}

/** Cola compassos copiados a partir de `at`, sobrescrevendo o conteúdo das pautas. */
export function pasteMeasures(score: Score, at: number, clip: Measure[]) {
  const n = staffCount(score);
  for (let i = 0; i < clip.length; i++) {
    if (at + i >= score.measures.length) appendMeasures(score, 1);
    const target = score.measures[at + i];
    const len = measureLen(score, at + i);
    clip[i].staves.forEach((sm, si) => {
      if (si >= n) return;
      const voices = sm.voices.map((v) => v.map((e) => ({ ...e, id: uid(), notes: e.notes.map((x) => ({ ...x })) })));
      target.staves[si] = { ...target.staves[si], voices };
    });
    fitMeasure(score, at + i, len);
    if (score.measures[at + i].len === undefined && at + i === 0 && len !== timeSigTicks(computeAttrs(score)[0].time)) score.measures[0].len = len;
  }
}

/** Transpõe notas de um intervalo de compassos por semitons. */
export function transposeMeasures(score: Score, from: number, to: number, semis: number) {
  const attrs = computeAttrs(score);
  for (let j = from; j <= to; j++) {
    for (const sm of score.measures[j].staves) for (const v of sm.voices) for (const e of v) {
      e.notes = e.notes.map((n) => moveChromatic(n, semis, attrs[j].key));
    }
  }
}
