import { Player } from './audio';
import * as E from './edit';
import { INSTRUMENTS, CLEF_LABELS, KEY_LABELS } from './instruments';
import { loadScoreFromBytes } from './io/files';
import { exportMusicXml } from './io/musicxml';
import {
  type ClefType,
  type Event,
  type Measure,
  type Note,
  type Score,
  STEP_NAMES_PT,
  TPQ,
  allStaves,
  computeAttrs,
  eventTicks,
  keyAlter,
  midiToNote,
  newScore,
  noteMidi,
  timeSigTicks,
  uid,
} from './model';
import { type HitMeasure, type HitStaff, type RenderedSystem, ScoreView, TOP_LINE, fromDisplay, staffKey } from './render';
import { deleteScore, listScores, loadScore, requestPersistence, saveScore } from './storage';
import { icons, noteIcon } from './ui/icons';

// ------------------------------------------------------------------ estado

type Mode = 'input' | 'select';

interface Sel {
  m: number;
  s: number;
  v: number;
  e: number;
  n?: number;
}

interface Cursor {
  m: number;
  s: number;
  v: number;
  tick: number;
}

const DUR_LABELS = ['Semibreve', 'Mínima', 'Semínima', 'Colcheia', 'Semicolcheia', 'Fusa'];

const st = {
  score: null as Score | null,
  mode: 'input' as Mode,
  dur: 2,
  dots: 0,
  rest: false,
  chord: false,
  voice: 0,
  sel: null as Sel | null,
  cursor: null as Cursor | null,
  zoom: Number(localStorage.getItem('pauta.zoom') ?? 1.5) || 1.5,
  history: [] as string[],
  future: [] as string[],
  clipboard: null as Measure[] | null,
  piano: localStorage.getItem('pauta.piano') === '1',
  pianoOct: 4,
};

const view = new ScoreView();
const player = new Player();
let systems: RenderedSystem[] = [];
let saveTimer: number | undefined;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ------------------------------------------------------------------ util

function toast(msg: string, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout((t as HTMLElement & { _t?: number })._t);
  (t as HTMLElement & { _t?: number })._t = window.setTimeout(() => t.classList.remove('show'), ms);
}

function noteName(n: Note): string {
  const acc = n.alter === 1 ? '♯' : n.alter === -1 ? '♭' : n.alter === 2 ? '𝄪' : n.alter === -2 ? '𝄫' : '';
  return `${STEP_NAMES_PT[n.step]}${acc}${n.oct}`;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function scoreOrThrow(): Score {
  if (!st.score) throw new Error('sem partitura');
  return st.score;
}

function voiceOf(sel: { m: number; s: number; v: number }) {
  return E.getVoice(scoreOrThrow(), sel);
}

function selEvent(): Event | undefined {
  if (!st.sel) return undefined;
  return voiceOf(st.sel)?.[st.sel.e];
}

function partOfStaff(s: number) {
  const score = scoreOrThrow();
  return score.parts[allStaves(score)[s].partIdx];
}

// ------------------------------------------------------------------ histórico

function mutate(fn: (s: Score) => void, opts: { keepFuture?: boolean } = {}) {
  const score = scoreOrThrow();
  st.history.push(JSON.stringify(score));
  if (st.history.length > 150) st.history.shift();
  if (!opts.keepFuture) st.future = [];
  fn(score);
  score.updatedAt = Date.now();
  afterChange();
}

function afterChange() {
  clampSel();
  render();
  scheduleSave();
  updateToolbar();
}

function undo() {
  if (!st.history.length || !st.score) return;
  st.future.push(JSON.stringify(st.score));
  st.score = JSON.parse(st.history.pop()!);
  afterChange();
}

function redo() {
  if (!st.future.length || !st.score) return;
  st.history.push(JSON.stringify(st.score));
  st.score = JSON.parse(st.future.pop()!);
  afterChange();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (st.score) saveScore(st.score).catch((e) => toast('Erro ao salvar: ' + e));
  }, 400);
}

function clampSel() {
  const score = st.score;
  if (!score) return;
  const nSt = allStaves(score).length;
  for (const k of ['sel', 'cursor'] as const) {
    const s = st[k];
    if (!s) continue;
    if (s.m >= score.measures.length) s.m = score.measures.length - 1;
    if (s.s >= nSt) s.s = nSt - 1;
  }
  if (st.sel) {
    const v = voiceOf(st.sel);
    if (!v || !v.length) st.sel = null;
    else if (st.sel.e >= v.length) st.sel.e = v.length - 1;
    const ev = selEvent();
    if (ev && st.sel && st.sel.n !== undefined && (ev.rest || st.sel.n >= ev.notes.length)) st.sel.n = undefined;
  }
}

// ------------------------------------------------------------------ render

function layoutWidth() {
  const sc = $('#scroller');
  return Math.max(320, (sc.clientWidth - 8) / st.zoom);
}

function render() {
  const score = st.score;
  if (!score) return;
  const width = layoutWidth();
  systems = view.render(score, { width, concert: !!score.concertPitch });
  const host = $('#systems');
  const z = st.zoom;
  const total = systems.reduce((h, s) => Math.max(h, s.layout.top + s.layout.height), 0);
  const keep = new Set(systems.map((s) => s.svg));
  for (const child of [...host.children]) if (!keep.has(child as unknown as SVGSVGElement)) child.remove();
  systems.forEach((s, i) => {
    const svg = s.svg;
    svg.setAttribute('viewBox', `0 0 ${width} ${s.layout.height}`);
    svg.setAttribute('width', String(width * z));
    svg.setAttribute('height', String(s.layout.height * z));
    svg.style.top = `${s.layout.top * z}px`;
    svg.dataset.sys = String(i);
    if (svg.parentNode !== host) host.appendChild(svg);
  });
  host.style.height = `${total * z}px`;
  host.style.width = `${width * z}px`;
  const ov = $('#overlay') as unknown as SVGSVGElement;
  ov.setAttribute('viewBox', `0 0 ${width} ${total}`);
  ov.setAttribute('width', String(width * z));
  ov.setAttribute('height', String(total * z));
  $('#title-block').innerHTML = `<h1>${esc(score.title || 'Sem título')}</h1>${score.composer ? `<div class="composer">${esc(score.composer)}</div>` : ''}`;
  ($('#title-block') as HTMLElement).style.width = `${width * z}px`;
  drawOverlay();
}

let highlighted: Element[] = [];
function setHighlight(ids: string[], cls: string) {
  for (const el of highlighted) if (el.classList.contains(cls)) el.classList.remove(cls);
  highlighted = highlighted.filter((e) => e.classList.contains('sel') || e.classList.contains('playing'));
  const host = $('#systems');
  for (const id of ids) {
    const el = host.querySelector(`[id="vf-${id}"]`);
    if (el) {
      el.classList.add(cls);
      highlighted.push(el);
    }
  }
}

function findHit(m: number, s: number): { sys: RenderedSystem; hm: HitMeasure; hs: HitStaff } | undefined {
  for (const sys of systems) {
    const hm = sys.hits.find((h) => h.m === m);
    if (hm) return { sys, hm, hs: hm.staves[s] };
  }
  return undefined;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag: string, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function drawOverlay() {
  const ov = $('#overlay');
  ov.innerHTML = '';
  // seleção
  const ev = selEvent();
  setHighlight(ev && st.sel ? [ev.id] : [], 'sel');
  if (st.sel && ev) {
    const h = findHit(st.sel.m, st.sel.s);
    const he = h?.hs.events.find((x) => x.v === st.sel!.v && x.e === st.sel!.e);
    if (h && he && st.sel.n !== undefined && he.ys[st.sel.n] !== undefined && ev.notes.length > 1) {
      ov.appendChild(svgEl('circle', { cx: he.x, cy: h.sys.layout.top + he.ys[st.sel.n], r: 9, class: 'sel-note' }));
    }
  }
  // cursor de entrada
  if (st.mode === 'input' && st.cursor) {
    const h = findHit(st.cursor.m, st.cursor.s);
    if (h) {
      const x = tickToX(h.hm, h.hs, st.cursor.tick);
      const y = h.sys.layout.top + h.hs.topY;
      ov.appendChild(svgEl('rect', { x: x - 9, y: y - 14, width: 18, height: 68, rx: 4, class: `cursor v${st.cursor.v}` }));
    }
  }
}

function tickToX(hm: HitMeasure, hs: HitStaff, tick: number): number {
  const evs = [...hs.events].sort((a, b) => a.tick - b.tick);
  const exact = evs.find((e) => e.tick === tick);
  if (exact) return exact.x;
  const before = [...evs].reverse().find((e) => e.tick < tick);
  const after = evs.find((e) => e.tick > tick);
  const len = E.measureLen(scoreOrThrow(), hm.m);
  const x0 = before?.x ?? hm.noteStartX;
  const t0 = before?.tick ?? 0;
  const x1 = after?.x ?? hm.x + hm.w - 12;
  const t1 = after?.tick ?? len;
  return x0 + ((x1 - x0) * (tick - t0)) / Math.max(1, t1 - t0);
}

// ------------------------------------------------------------------ hit test

interface Hit {
  sys: RenderedSystem;
  hm: HitMeasure;
  hs: HitStaff;
  x: number;
  y: number; // relativos ao sistema
}

function pagePoint(clientX: number, clientY: number) {
  const r = $('#systems').getBoundingClientRect();
  return { x: (clientX - r.left) / st.zoom, y: (clientY - r.top) / st.zoom };
}

function hitTest(clientX: number, clientY: number, slack = 40): Hit | undefined {
  const p = pagePoint(clientX, clientY);
  const sys = systems.find((s) => p.y >= s.layout.top && p.y < s.layout.top + s.layout.height);
  if (!sys) return undefined;
  const y = p.y - sys.layout.top;
  const hm = sys.hits.find((h) => p.x >= h.x && p.x < h.x + h.w) ?? (p.x < (sys.hits[0]?.x ?? 0) ? sys.hits[0] : undefined);
  if (!hm) return undefined;
  let best: HitStaff | undefined;
  let bd = Infinity;
  for (const hs of hm.staves) {
    const d = Math.abs(y - (hs.topY + 20));
    if (d < bd) {
      bd = d;
      best = hs;
    }
  }
  if (!best || bd > 20 + slack) return undefined;
  return { sys, hm, hs: best, x: p.x, y };
}

function diatonicAtY(hs: HitStaff, y: number): number {
  const steps = Math.round((y - hs.topY) / 5);
  return TOP_LINE[hs.clef] - steps;
}

/** Posições candidatas (tick, x) pra entrada: inícios de eventos + grade da figura atual dentro de pausas. */
function candidates(hit: Hit, voice: number): { tick: number; x: number }[] {
  const score = scoreOrThrow();
  const len = E.measureLen(score, hit.hm.m);
  const out = new Map<number, number>();
  const evs = [...hit.hs.events].sort((a, b) => a.tick - b.tick || a.v - b.v);
  for (const e of evs) if (!out.has(e.tick)) out.set(e.tick, e.x);
  const v = E.getVoice(score, { m: hit.hm.m, s: hit.hs.s, v: voice });
  const step = eventTicks({ base: st.dur, dots: 0 });
  if (v) {
    const starts = E.starts(v);
    v.forEach((ev, i) => {
      if (!ev.rest || ev.tuplet) return;
      const t0 = starts[i];
      const t1 = t0 + eventTicks(ev);
      for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) if (!out.has(t)) out.set(t, tickToX(hit.hm, hit.hs, t));
    });
  } else {
    for (let t = 0; t < len; t += step) if (!out.has(t)) out.set(t, tickToX(hit.hm, hit.hs, t));
  }
  return [...out.entries()].map(([tick, x]) => ({ tick, x })).filter((c) => c.tick < len);
}

function nearestCandidate(hit: Hit, voice: number) {
  const cs = candidates(hit, voice);
  let best = cs[0];
  for (const c of cs) if (Math.abs(c.x - hit.x) < Math.abs(best.x - hit.x)) best = c;
  return best ?? { tick: 0, x: hit.hm.noteStartX };
}

// ------------------------------------------------------------------ gestos

interface Gesture {
  kind: 'input' | 'drag';
  hit: Hit;
  tick: number;
  x: number;
  diatonic: number;
  startY: number;
  startDiatonic: number;
  moved: boolean;
  lastPreview: number;
}
let gesture: Gesture | null = null;

function ghostDraw(g: Gesture) {
  const ov = $('#overlay');
  ov.querySelectorAll('.ghost').forEach((e) => e.remove());
  const top = g.hit.sys.layout.top;
  const hs = g.hit.hs;
  const steps = TOP_LINE[hs.clef] - g.diatonic;
  const y = top + hs.topY + steps * 5;
  const grp = svgEl('g', { class: 'ghost' });
  // linhas suplementares
  if (steps < 0) for (let s = -2; s >= steps; s -= 2) grp.appendChild(svgEl('line', { x1: g.x - 11, x2: g.x + 11, y1: top + hs.topY + s * 5, y2: top + hs.topY + s * 5 }));
  if (steps > 8) for (let s = 10; s <= steps; s += 2) grp.appendChild(svgEl('line', { x1: g.x - 11, x2: g.x + 11, y1: top + hs.topY + s * 5, y2: top + hs.topY + s * 5 }));
  grp.appendChild(svgEl('ellipse', { cx: g.x, cy: y, rx: 6.5, ry: 5, transform: `rotate(-20 ${g.x} ${y})` }));
  grp.appendChild(svgEl('line', { class: 'col', x1: g.x, x2: g.x, y1: top + hs.topY - 30, y2: top + hs.topY + 70 }));
  const n = ghostNote(g);
  const label = svgEl('text', { x: g.x, y: Math.min(y, top + hs.topY) - 34, 'text-anchor': 'middle' });
  label.textContent = st.rest ? 'pausa' : noteName(n);
  const bg = svgEl('rect', { x: g.x - 30, y: Math.min(y, top + hs.topY) - 52, width: 60, height: 24, rx: 6 });
  grp.appendChild(bg);
  grp.appendChild(label);
  ov.appendChild(grp);
}

function ghostNote(g: Gesture): Note {
  const score = scoreOrThrow();
  const part = partOfStaff(g.hit.hs.s);
  const a = computeAttrs(score)[g.hit.hm.m];
  const key = staffKey(score, part, a, !!score.concertPitch);
  const di = g.diatonic;
  const step = ((di % 7) + 7) % 7;
  return fromDisplay(di, keyAlter(key, step), part, g.hit.hs.clef, !!score.concertPitch);
}

function previewNote(n: Note, s: number) {
  const part = partOfStaff(s);
  const score = scoreOrThrow();
  const perc = computeAttrs(score)[0].clefs[s] === 'PERC';
  player.preview(noteMidi(n) + part.transpose.chromatic, part.program, perc);
}

function beginGesture(clientX: number, clientY: number): boolean {
  if (!st.score) return false;
  player.unlock();
  if (st.mode === 'input') {
    const hit = hitTest(clientX, clientY, 35);
    if (!hit) return false;
    const c = nearestCandidate(hit, st.voice);
    const d = diatonicAtY(hit.hs, hit.y);
    gesture = { kind: 'input', hit, tick: c.tick, x: c.x, diatonic: d, startY: clientY, startDiatonic: d, moved: false, lastPreview: -999 };
    ghostDraw(gesture);
    if (!st.rest) {
      const n = ghostNote(gesture);
      previewNote(n, hit.hs.s);
      gesture.lastPreview = gesture.diatonic;
    }
    return true;
  }
  // modo seleção: arrastar a nota já selecionada muda a altura
  const ev = selEvent();
  if (!st.sel || !ev || ev.rest) return false;
  const h = findHit(st.sel.m, st.sel.s);
  const he = h?.hs.events.find((x) => x.v === st.sel!.v && x.e === st.sel!.e);
  if (!h || !he) return false;
  const p = pagePoint(clientX, clientY);
  const y = p.y - h.sys.layout.top;
  const ni = st.sel.n ?? 0;
  const ny = he.ys[ni] ?? he.ys[0];
  if (Math.abs(p.x - he.x) > 22 || Math.abs(y - ny) > 18) return false;
  const hit: Hit = { sys: h.sys, hm: h.hm, hs: h.hs, x: p.x, y };
  const d = diatonicAtY(h.hs, ny);
  gesture = { kind: 'drag', hit, tick: 0, x: he.x, diatonic: d, startY: clientY, startDiatonic: d, moved: false, lastPreview: d };
  st.history.push(JSON.stringify(st.score));
  st.future = [];
  return true;
}

function moveGesture(clientX: number, clientY: number) {
  const g = gesture;
  if (!g) return;
  if (g.kind === 'input') {
    const p = pagePoint(clientX, clientY);
    const y = p.y - g.hit.sys.layout.top;
    g.diatonic = diatonicAtY(g.hit.hs, y);
    // permite deslizar na horizontal pra escolher o tempo dentro do mesmo compasso
    if (p.x >= g.hit.hm.x && p.x < g.hit.hm.x + g.hit.hm.w) {
      const c = nearestCandidate({ ...g.hit, x: p.x, y }, st.voice);
      g.tick = c.tick;
      g.x = c.x;
    }
    if (Math.abs(clientY - g.startY) > 4) g.moved = true;
    ghostDraw(g);
    if (!st.rest && g.diatonic !== g.lastPreview) {
      previewNote(ghostNote(g), g.hit.hs.s);
      g.lastPreview = g.diatonic;
    }
    return;
  }
  // arrastar nota: 1 passo diatônico a cada meio espaço (5 unidades)
  const delta = -Math.round((clientY - g.startY) / (5 * st.zoom));
  const target = g.startDiatonic + delta;
  if (target === g.diatonic) return;
  const steps = target - g.diatonic;
  g.diatonic = target;
  g.moved = true;
  const score = scoreOrThrow();
  const ev = selEvent();
  if (!ev || !st.sel) return;
  const key = computeAttrs(score)[st.sel.m].key;
  const part = partOfStaff(st.sel.s);
  const wkey = staffKey(score, part, computeAttrs(score)[st.sel.m], false);
  const idxs = st.sel.n !== undefined ? [st.sel.n] : ev.notes.map((_, i) => i);
  for (const i of idxs) ev.notes[i] = E.moveDiatonic(ev.notes[i], steps, wkey ?? key);
  const moved = st.sel.n !== undefined ? ev.notes[st.sel.n] : undefined;
  E.sortNotes(ev.notes);
  if (moved) st.sel.n = ev.notes.indexOf(moved);
  score.updatedAt = Date.now();
  render();
  previewNote(ev.notes[st.sel.n ?? 0], st.sel.s);
}

function endGesture() {
  const g = gesture;
  gesture = null;
  $('#overlay')
    .querySelectorAll('.ghost')
    .forEach((e) => e.remove());
  if (!g) return;
  if (g.kind === 'drag') {
    if (!g.moved) st.history.pop();
    afterChange();
    return;
  }
  commitInput(g.hit.hm.m, g.hit.hs.s, g.tick, st.rest ? null : ghostNote(g));
}

/** Escreve nota/pausa na posição (ou acrescenta ao acorde). */
function commitInput(m: number, s: number, tick: number, note: Note | null) {
  const p = { m, s, v: st.voice };
  mutate((score) => {
    const voice = E.getVoice(score, p, true)!;
    const idx = E.eventIndexAt(voice, tick);
    const starts = E.starts(voice);
    const existing = voice[idx];
    if (note && st.chord && existing && starts[idx] === tick && !existing.rest) {
      const ni = E.addNoteToChord(existing, note);
      st.sel = { ...p, e: idx, n: ni };
      st.cursor = { ...p, tick: tick + eventTicks(existing) };
    } else {
      const ev = note ? E.makeNoteEvent([note], st.dur, st.dots) : E.makeRestEvent(st.dur, st.dots);
      const i = E.writeEvent(score, p, tick, ev);
      const written = E.getVoice(score, p)![i];
      st.sel = { ...p, e: i, n: note ? 0 : undefined };
      const end = E.starts(E.getVoice(score, p)!)[i] + eventTicks(written);
      const len = E.measureLen(score, m);
      if (end >= len) {
        if (m + 1 >= score.measures.length) E.appendMeasures(score, 1);
        st.cursor = { ...p, m: m + 1, tick: 0 };
      } else st.cursor = { ...p, tick: end };
    }
  });
  ensureVisible(st.cursor?.m ?? m);
}

function ensureVisible(m: number) {
  const h = findHit(m, 0);
  if (!h) return;
  const sc = $('#scroller');
  const top = h.sys.layout.top * st.zoom + ($('#systems').offsetTop ?? 0);
  const bottom = top + h.sys.layout.height * st.zoom;
  if (bottom > sc.scrollTop + sc.clientHeight - 20) sc.scrollTo({ top: bottom - sc.clientHeight + 40, behavior: 'smooth' });
  else if (top < sc.scrollTop) sc.scrollTo({ top: top - 20, behavior: 'smooth' });
}

function selectAt(clientX: number, clientY: number) {
  const hit = hitTest(clientX, clientY, 30);
  if (!hit) {
    st.sel = null;
    drawOverlay();
    updateToolbar();
    return;
  }
  let best: (typeof hit.hs.events)[number] | undefined;
  let bd = Infinity;
  for (const e of hit.hs.events) {
    const ev = E.getVoice(scoreOrThrow(), { m: hit.hm.m, s: hit.hs.s, v: e.v })?.[e.e];
    if (!ev || ev.hidden) continue;
    let d = Math.abs(e.x - hit.x);
    // preferir a voz cuja nota está mais perto na vertical
    if (e.ys.length) d += Math.min(...e.ys.map((y) => Math.abs(y - hit.y))) * 0.3;
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  if (!best || bd > 40) {
    st.sel = null;
  } else {
    let n: number | undefined;
    if (best.ys.length) {
      let nd = Infinity;
      best.ys.forEach((y, i) => {
        if (Math.abs(y - hit.y) < nd) {
          nd = Math.abs(y - hit.y);
          n = i;
        }
      });
    }
    st.sel = { m: hit.hm.m, s: hit.hs.s, v: best.v, e: best.e, n };
    st.cursor = { m: hit.hm.m, s: hit.hs.s, v: best.v, tick: best.tick };
    const ev = selEvent();
    if (ev && !ev.rest) {
      const part = partOfStaff(hit.hs.s);
      player.previewChord(
        (n !== undefined ? [ev.notes[n]] : ev.notes).map((x) => noteMidi(x) + part.transpose.chromatic),
        part.program,
      );
    }
  }
  drawOverlay();
  updateToolbar();
}

function bindPointer() {
  const host = $('#page');
  let touchStart: { x: number; y: number; t: number } | null = null;
  host.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) {
        if (gesture) {
          gesture = null;
          $('#overlay').querySelectorAll('.ghost').forEach((x) => x.remove());
        }
        return;
      }
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY, t: Date.now() };
      if (beginGesture(t.clientX, t.clientY)) e.preventDefault();
    },
    { passive: false },
  );
  host.addEventListener(
    'touchmove',
    (e) => {
      if (!gesture) return;
      e.preventDefault();
      const t = e.touches[0];
      moveGesture(t.clientX, t.clientY);
    },
    { passive: false },
  );
  host.addEventListener('touchend', (e) => {
    if (gesture) {
      e.preventDefault();
      endGesture();
      return;
    }
    // toque simples no modo seleção (sem rolagem)
    const t = e.changedTouches[0];
    if (st.mode === 'select' && touchStart && Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y) < 10 && Date.now() - touchStart.t < 500) {
      e.preventDefault();
      selectAt(t.clientX, t.clientY);
    }
    touchStart = null;
  });
  host.addEventListener('touchcancel', () => {
    gesture = null;
    $('#overlay').querySelectorAll('.ghost').forEach((x) => x.remove());
  });
  // mouse (desktop / trackpad do Magic Keyboard)
  let mouseDown = false;
  host.addEventListener('mousedown', (e) => {
    if ((e as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } }).sourceCapabilities?.firesTouchEvents) return;
    mouseDown = true;
    if (!beginGesture(e.clientX, e.clientY) && st.mode === 'select') selectAt(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', (e) => {
    if (mouseDown && gesture) moveGesture(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    if (mouseDown && gesture) endGesture();
    mouseDown = false;
  });
}

// ------------------------------------------------------------------ ações

function needSel(): Sel | null {
  if (!st.sel) toast('Selecione uma nota primeiro (modo 👆 ou toque na nota recém-escrita)');
  return st.sel;
}

const actions = {
  setDur(base: number) {
    st.dur = base;
    if (st.mode === 'select' && st.sel) {
      const s = st.sel;
      mutate((score) => {
        s.e = E.setDuration(score, s, s.e, base, st.dots && selEvent()?.dots ? selEvent()!.dots : 0);
      });
    }
    updateToolbar();
  },
  toggleDot() {
    if (st.mode === 'select' && st.sel) {
      const s = st.sel;
      mutate((score) => {
        s.e = E.toggleDot(score, s, s.e);
      });
    } else st.dots = st.dots ? 0 : 1;
    updateToolbar();
  },
  toggleRest() {
    if (st.mode === 'select') {
      const s = needSel();
      if (!s) return;
      mutate((score) => E.deleteAt(score, s, s.e));
      return;
    }
    st.rest = !st.rest;
    updateToolbar();
  },
  accidental(alter: number) {
    const s = needSel();
    const ev = selEvent();
    if (!s || !ev || ev.rest) return;
    mutate(() => {
      const idxs = s.n !== undefined ? [s.n] : ev.notes.map((_, i) => i);
      for (const i of idxs) ev.notes[i] = E.setAlter(ev.notes[i], alter);
    });
    previewNote(ev.notes[s.n ?? 0], s.s);
  },
  pitch(semis: number, diatonic = false) {
    const s = needSel();
    const ev = selEvent();
    if (!s || !ev || ev.rest) return;
    mutate((score) => {
      const a = computeAttrs(score)[s.m];
      const key = staffKey(score, partOfStaff(s.s), a, false);
      const idxs = s.n !== undefined ? [s.n] : ev.notes.map((_, i) => i);
      const moved = idxs.map((i) => ev.notes[i]);
      for (const i of idxs) {
        const n = ev.notes[i];
        ev.notes[i] = Math.abs(semis) === 12 ? { ...n, oct: n.oct + Math.sign(semis) } : diatonic ? E.moveDiatonic(n, semis, key) : E.moveChromatic(n, semis, key);
      }
      const keepIdx = s.n !== undefined ? ev.notes[s.n] : undefined;
      E.sortNotes(ev.notes);
      if (keepIdx) s.n = ev.notes.indexOf(keepIdx);
      void moved;
    });
    const part = partOfStaff(s.s);
    player.previewChord((s.n !== undefined ? [ev.notes[s.n]] : ev.notes).map((x) => noteMidi(x) + part.transpose.chromatic), part.program);
  },
  tie() {
    const s = needSel();
    if (!s) return;
    mutate((score) => {
      E.toggleTie(score, s, s.e, s.n);
    });
  },
  triplet() {
    const s = needSel();
    if (!s) return;
    mutate((score) => {
      E.makeTuplet(score, s, s.e, 3);
    });
  },
  del() {
    const s = needSel();
    if (!s) return;
    mutate((score) => E.deleteAt(score, s, s.e, s.n));
  },
  toggleChord() {
    st.chord = !st.chord;
    updateToolbar();
  },
  setVoice(v: number) {
    st.voice = v;
    if (st.cursor) st.cursor.v = v;
    updateToolbar();
    drawOverlay();
  },
  setMode(m: Mode) {
    st.mode = m;
    if (m === 'input' && !st.cursor && st.sel) st.cursor = { ...st.sel, v: st.voice, tick: E.starts(voiceOf(st.sel) ?? [])[st.sel.e] ?? 0 };
    if (m === 'input' && !st.cursor) st.cursor = { m: 0, s: 0, v: st.voice, tick: 0 };
    updateToolbar();
    drawOverlay();
  },
  move(dir: 1 | -1) {
    const score = scoreOrThrow();
    if (!st.sel) {
      st.sel = { m: 0, s: 0, v: 0, e: 0 };
    } else {
      const r = dir > 0 ? E.nextEvent(score, st.sel, st.sel.e) : E.prevPos(score, st.sel, st.sel.e);
      if (r) st.sel = { ...r.p, e: r.e, n: undefined };
    }
    const v = voiceOf(st.sel);
    st.cursor = { ...st.sel, tick: E.starts(v ?? [])[st.sel.e] ?? 0 };
    drawOverlay();
    updateToolbar();
    ensureVisible(st.sel.m);
  },
  /** Entrada por nome de nota (teclado físico ou piano virtual), na posição do cursor. */
  enterMidi(midi: number, addToChord = false) {
    const score = scoreOrThrow();
    const cur = st.cursor ?? (st.sel ? { ...st.sel, tick: E.starts(voiceOf(st.sel) ?? [])[st.sel.e] ?? 0 } : { m: 0, s: 0, v: st.voice, tick: 0 });
    const a = computeAttrs(score)[cur.m];
    const part = partOfStaff(cur.s);
    const key = staffKey(score, part, a, false);
    // piano soa em concert pitch; a nota escrita compensa a transposição
    const written = midi - part.transpose.chromatic;
    let n = E.moveChromatic(midiToNote(written, key < 0), 0, key);
    if (noteMidi(n) !== written) n = midiToNote(written, key < 0);
    player.preview(midi, part.program);
    if ((addToChord || st.chord) && st.sel) {
      const s = st.sel;
      const ev = selEvent();
      if (ev) {
        mutate(() => {
          s.n = E.addNoteToChord(ev, n);
        });
        return;
      }
    }
    st.cursor = { ...cur, v: st.voice };
    commitInput(cur.m, cur.s, cur.tick, n);
  },
  enterLetter(step: number, addToChord: boolean) {
    const score = scoreOrThrow();
    const cur = st.cursor ?? { m: 0, s: 0, v: st.voice, tick: 0 };
    const a = computeAttrs(score)[cur.m];
    const part = partOfStaff(cur.s);
    const key = staffKey(score, part, a, false);
    // oitava mais próxima da nota anterior (como no MuseScore)
    const prev = selEvent();
    const ref = prev && !prev.rest ? prev.notes[st.sel?.n ?? 0] : { step: 0, alter: 0, oct: [4, 4, 3, 3, 4, 4][['G', 'G8vb', 'F', 'F8vb', 'C3', 'C4'].indexOf(a.clefs[cur.s])] ?? 4 };
    let best: Note | undefined;
    for (const oct of [ref.oct - 1, ref.oct, ref.oct + 1]) {
      const n = { step, alter: keyAlter(key, step), oct };
      if (!best || Math.abs(noteMidi(n) - noteMidi(ref)) < Math.abs(noteMidi(best) - noteMidi(ref))) best = n;
    }
    this.enterMidi(noteMidi(best!) + part.transpose.chromatic, addToChord);
  },
  play() {
    if (player.playing) {
      player.stop();
      updateToolbar();
      return;
    }
    player.unlock();
    player.play(scoreOrThrow(), st.sel?.m ?? st.cursor?.m ?? 0);
    updateToolbar();
  },
  zoom(f: number) {
    st.zoom = Math.max(0.6, Math.min(2.6, Math.round(st.zoom * f * 100) / 100));
    localStorage.setItem('pauta.zoom', String(st.zoom));
    view.clear();
    render();
  },
};

player.onCue = (cue) => {
  setHighlight(cue ? cue.ids : [], 'playing');
  if (cue) ensureVisible(cue.m);
};
player.onEnd = () => updateToolbar();

// ------------------------------------------------------------------ toolbar

function btn(id: string, html: string, title: string, onClick: () => void, cls = '') {
  const b = document.createElement('button');
  b.id = id;
  b.className = 'tb ' + cls;
  b.innerHTML = html;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    player.unlock();
    onClick();
  });
  return b;
}

function buildPalette() {
  const pal = $('#palette');
  pal.innerHTML = '';
  const group = (...els: HTMLElement[]) => {
    const g = document.createElement('div');
    g.className = 'grp';
    g.append(...els);
    pal.appendChild(g);
  };
  group(
    btn('mode-input', icons.pencil + '<span>Escrever</span>', 'Modo escrever: toque na pauta pra pôr notas', () => actions.setMode('input'), 'wide'),
    btn('mode-select', icons.hand + '<span>Selecionar</span>', 'Modo selecionar: toque numa nota pra editar; arraste pra mudar a altura', () => actions.setMode('select'), 'wide'),
  );
  group(...[0, 1, 2, 3, 4, 5].map((b) => btn(`dur-${b}`, noteIcon(b), DUR_LABELS[b], () => actions.setDur(b))), btn('dot', icons.dot, 'Ponto de aumento', () => actions.toggleDot()), btn('rest', icons.rest, 'Pausa', () => actions.toggleRest()));
  group(
    btn('acc-sharp', icons.sharp, 'Sustenido', () => actions.accidental(1)),
    btn('acc-flat', icons.flat, 'Bemol', () => actions.accidental(-1)),
    btn('acc-natural', icons.natural, 'Bequadro', () => actions.accidental(0)),
    btn('up', icons.up, 'Subir meio tom', () => actions.pitch(1)),
    btn('down', icons.down, 'Descer meio tom', () => actions.pitch(-1)),
  );
  group(
    btn('tie', icons.tie, 'Ligadura de prolongamento', () => actions.tie()),
    btn('triplet', icons.triplet, 'Tercina', () => actions.triplet()),
    btn('chord', icons.chord, 'Modo acorde: novas notas entram no acorde', () => actions.toggleChord()),
    btn('del', icons.trash, 'Apagar', () => actions.del()),
  );
  group(...[0, 1, 2, 3].map((v) => btn(`voice-${v}`, `<b>${v + 1}</b>`, `Voz ${v + 1}`, () => actions.setVoice(v), `voice v${v}`)));
  group(
    btn('piano-toggle', icons.piano, 'Teclado de piano', () => togglePiano()),
    btn('measure-menu', icons.measure + '<span>Compasso</span>', 'Compasso: inserir, apagar, fórmula, armadura…', () => openMeasureDialog(), 'wide'),
  );
}

function buildTopbar() {
  const tb = $('#topbar');
  tb.innerHTML = '';
  const left = document.createElement('div');
  left.className = 'left';
  left.append(btn('back', icons.back, 'Voltar à biblioteca', () => void showLibrary()));
  const title = document.createElement('button');
  title.id = 'title-btn';
  title.className = 'title';
  title.addEventListener('click', () => openScoreDialog());
  left.append(title);
  const right = document.createElement('div');
  right.className = 'right';
  right.append(
    btn('undo', icons.undo, 'Desfazer', () => undo()),
    btn('redo', icons.redo, 'Refazer', () => redo()),
    btn('play', icons.play, 'Tocar / parar', () => actions.play(), 'accent'),
    btn('metro', icons.metronome, 'Metrônomo', () => {
      player.metronome = !player.metronome;
      updateToolbar();
    }),
    btn('zoom-out', icons.zoomOut, 'Diminuir', () => actions.zoom(1 / 1.15)),
    btn('zoom-in', icons.zoomIn, 'Aumentar', () => actions.zoom(1.15)),
    btn('export', icons.share + '<span>Exportar</span>', 'Exportar MusicXML (abre no MuseScore)', () => void exportCurrent(), 'wide accent2'),
  );
  tb.append(left, right);
}

function updateToolbar() {
  const set = (id: string, on: boolean) => document.getElementById(id)?.classList.toggle('on', on);
  set('mode-input', st.mode === 'input');
  set('mode-select', st.mode === 'select');
  const ev = st.mode === 'select' ? selEvent() : undefined;
  for (let b = 0; b <= 5; b++) set(`dur-${b}`, ev ? ev.base === b : st.dur === b);
  set('dot', ev ? ev.dots > 0 : st.dots > 0);
  set('rest', st.mode === 'input' && st.rest);
  set('chord', st.chord);
  for (let v = 0; v < 4; v++) set(`voice-${v}`, st.voice === v);
  set('piano-toggle', st.piano);
  set('metro', player.metronome);
  const play = document.getElementById('play');
  if (play) play.innerHTML = player.playing ? icons.stop : icons.play;
  (document.getElementById('undo') as HTMLButtonElement | null)?.toggleAttribute('disabled', !st.history.length);
  (document.getElementById('redo') as HTMLButtonElement | null)?.toggleAttribute('disabled', !st.future.length);
  const t = document.getElementById('title-btn');
  if (t && st.score) t.textContent = st.score.title || 'Sem título';
  document.body.classList.toggle('mode-input', st.mode === 'input');
  const status = document.getElementById('status');
  if (status && st.score) {
    const sel = selEvent();
    let s = '';
    if (sel && st.sel) {
      s = `Comp. ${st.sel.m + 1} · voz ${st.sel.v + 1} · `;
      s += sel.rest ? 'pausa' : sel.notes.map(noteName).join(' ');
    } else if (st.cursor && st.mode === 'input') s = `Comp. ${st.cursor.m + 1}`;
    status.textContent = s;
  }
}

// ------------------------------------------------------------------ piano

function togglePiano() {
  st.piano = !st.piano;
  localStorage.setItem('pauta.piano', st.piano ? '1' : '0');
  buildPiano();
  updateToolbar();
  setTimeout(render, 50);
}

function buildPiano() {
  const el = $('#piano');
  el.classList.toggle('hidden', !st.piano);
  if (!st.piano) return;
  el.innerHTML = '';
  const ctrl = document.createElement('div');
  ctrl.className = 'piano-ctrl';
  const lbl = document.createElement('span');
  lbl.textContent = `Dó${st.pianoOct}`;
  ctrl.append(
    btn('oct-down', '−8ª', 'Oitava abaixo', () => {
      st.pianoOct = Math.max(1, st.pianoOct - 1);
      buildPiano();
    }),
    lbl,
    btn('oct-up', '+8ª', 'Oitava acima', () => {
      st.pianoOct = Math.min(7, st.pianoOct + 1);
      buildPiano();
    }),
  );
  const keys = document.createElement('div');
  keys.className = 'keys';
  const startMidi = (st.pianoOct + 1) * 12 - 0;
  const whites = [0, 2, 4, 5, 7, 9, 11];
  const nOct = window.innerWidth > 900 ? 3 : 2;
  for (let o = 0; o < nOct; o++) {
    for (const w of whites) {
      const midi = startMidi + o * 12 + w;
      const k = document.createElement('button');
      k.className = 'white';
      k.dataset.midi = String(midi);
      if (w === 0) k.innerHTML = `<small>Dó${st.pianoOct + o}</small>`;
      keys.appendChild(k);
      if ([0, 2, 5, 7, 9].includes(w)) {
        const b = document.createElement('button');
        b.className = 'black';
        b.dataset.midi = String(midi + 1);
        k.appendChild(b);
      }
    }
  }
  keys.addEventListener('pointerdown', (e) => {
    const t = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!t?.dataset.midi) return;
    e.preventDefault();
    e.stopPropagation();
    t.classList.add('down');
    setTimeout(() => t.classList.remove('down'), 160);
    actions.enterMidi(Number(t.dataset.midi));
  });
  el.append(ctrl, keys);
}

// ------------------------------------------------------------------ teclado físico

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (!st.score || $('#editor').classList.contains('hidden')) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, dialog[open]')) return;
    const k = e.key;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && k.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && k.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (k === ' ') {
      e.preventDefault();
      actions.play();
      return;
    }
    if (k === 'n' || k === 'N' || k === 'Escape') {
      actions.setMode(st.mode === 'input' && k !== 'n' && k !== 'N' ? 'select' : st.mode === 'input' ? 'select' : 'input');
      return;
    }
    const letter = 'cdefgab'.indexOf(k.toLowerCase());
    if (letter >= 0 && !mod) {
      e.preventDefault();
      if (st.mode !== 'input') actions.setMode('input');
      actions.enterLetter(letter, e.shiftKey);
      return;
    }
    const durMap: Record<string, number> = { '7': 0, '6': 1, '5': 2, '4': 3, '3': 4, '2': 5 };
    if (k in durMap && !mod) {
      actions.setDur(durMap[k]);
      return;
    }
    if (k === '.') return actions.toggleDot();
    if (k === '0') {
      if (st.mode === 'input' && st.cursor) commitInput(st.cursor.m, st.cursor.s, st.cursor.tick, null);
      return;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      const d = k === 'ArrowUp' ? 1 : -1;
      if (mod) actions.pitch(12 * d);
      else if (e.altKey) actions.pitch(d, true);
      else actions.pitch(d);
      return;
    }
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault();
      actions.move(k === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      actions.del();
      return;
    }
    if (k === '+' || k === 't') return actions.tie();
    if (k === '#') return actions.accidental(1);
    if (k === '-') return actions.accidental(-1);
    if (k === '=') return actions.accidental(0);
  });
}

// ------------------------------------------------------------------ diálogos

function dialog(html: string, onMount?: (d: HTMLDialogElement) => void): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog">${html}</form>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => setTimeout(() => d.remove(), 300));
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  onMount?.(d);
  d.showModal();
  return d;
}

function keyOptions(sel: number) {
  return Object.entries(KEY_LABELS)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, l]) => `<option value="${k}" ${Number(k) === sel ? 'selected' : ''}>${l}</option>`)
    .join('');
}

function clefOptions(sel: ClefType) {
  return (Object.keys(CLEF_LABELS) as ClefType[]).map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${CLEF_LABELS[c]}</option>`).join('');
}

function openMeasureDialog() {
  const score = scoreOrThrow();
  const m = st.sel?.m ?? st.cursor?.m ?? 0;
  const s = st.sel?.s ?? st.cursor?.s ?? 0;
  const a = computeAttrs(score)[m];
  const meas = score.measures[m];
  const staffName = (() => {
    const info = allStaves(score)[s];
    const p = score.parts[info.partIdx];
    return p.staves.length > 1 ? `${p.name} (pauta ${info.staffInPart + 1})` : p.name;
  })();
  const d = dialog(
    `<h2>Compasso ${m + 1}</h2>
    <div class="row wrap">
      <button value="ins-before" class="b">+ Inserir antes</button>
      <button value="ins-after" class="b">+ Inserir depois</button>
      <button value="append4" class="b">+ 4 no final</button>
      <button value="copy" class="b">Copiar</button>
      <button value="paste" class="b" ${st.clipboard ? '' : 'disabled'}>Colar${st.clipboard ? ` (${st.clipboard.length})` : ''}</button>
      <button value="clear" class="b">Limpar</button>
      <button value="delete" class="b danger">Apagar compasso</button>
    </div>
    <div class="row wrap">
      <button value="tr-up" class="b">Transpor +½ tom</button>
      <button value="tr-down" class="b">Transpor −½ tom</button>
      <button value="tr-oct-up" class="b">+8ª</button>
      <button value="tr-oct-down" class="b">−8ª</button>
    </div>
    <label>Fórmula de compasso
      <span class="row"><input name="tn" type="number" min="1" max="32" value="${a.time.n}"> / <select name="td">${[1, 2, 4, 8, 16].map((x) => `<option ${x === a.time.d ? 'selected' : ''}>${x}</option>`).join('')}</select></span>
    </label>
    <label>Armadura (a partir daqui) <select name="key">${keyOptions(a.key)}</select></label>
    <label>Clave — ${esc(staffName)} <select name="clef">${clefOptions(a.clefs[s])}</select></label>
    <label>Andamento (♩ por minuto) <input name="tempo" type="number" min="20" max="400" value="${a.tempo}"></label>
    <label class="check"><input name="repS" type="checkbox" ${meas.repeatStart ? 'checked' : ''}> Início de ritornelo ‖:</label>
    <label class="check"><input name="repE" type="checkbox" ${meas.repeatEnd ? 'checked' : ''}> Fim de ritornelo :‖</label>
    ${m === 0 ? `<label>Anacruse (tempos no 1º compasso, 0 = completo) <input name="pickup" type="number" min="0" max="${a.time.n - 1}" value="${meas.len ? Math.round((meas.len / timeSigTicks(a.time)) * a.time.n) : 0}"></label>` : ''}
    <div class="row end"><button value="cancel" class="b">Cancelar</button><button value="apply" class="b primary">Aplicar</button></div>`,
  );
  d.addEventListener('close', () => {
    const v = d.returnValue;
    const f = d.querySelector('form')!;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.value;
    const checked = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.checked;
    switch (v) {
      case 'ins-before':
        return mutate((sc) => E.insertMeasure(sc, m));
      case 'ins-after':
        return mutate((sc) => E.insertMeasure(sc, m + 1));
      case 'append4':
        return mutate((sc) => E.appendMeasures(sc, 4));
      case 'copy':
        st.clipboard = E.copyMeasures(score, m, m);
        return toast('Compasso copiado');
      case 'paste':
        if (st.clipboard) mutate((sc) => E.pasteMeasures(sc, m, st.clipboard!));
        return;
      case 'clear':
        return mutate((sc) => E.clearMeasure(sc, m));
      case 'delete':
        st.sel = null;
        return mutate((sc) => E.deleteMeasure(sc, m));
      case 'tr-up':
        return mutate((sc) => E.transposeMeasures(sc, m, m, 1));
      case 'tr-down':
        return mutate((sc) => E.transposeMeasures(sc, m, m, -1));
      case 'tr-oct-up':
        return mutate((sc) => E.transposeMeasures(sc, m, m, 12));
      case 'tr-oct-down':
        return mutate((sc) => E.transposeMeasures(sc, m, m, -12));
      case 'apply':
        mutate((sc) => {
          const tn = Number(val('tn'));
          const td = Number(val('td'));
          if (tn > 0 && td > 0 && (tn !== a.time.n || td !== a.time.d)) E.setTimeSig(sc, m, { n: tn, d: td });
          const key = Number(val('key'));
          if (key !== a.key) E.setKey(sc, m, key);
          const clef = val('clef') as ClefType;
          if (clef && clef !== a.clefs[s]) E.setClef(sc, m, s, clef);
          const tempo = Number(val('tempo'));
          if (tempo && tempo !== a.tempo) E.setTempo(sc, m, tempo);
          sc.measures[m].repeatStart = checked('repS') || undefined;
          sc.measures[m].repeatEnd = checked('repE') || undefined;
          if (m === 0) {
            const pk = Number(val('pickup') ?? 0);
            const at = computeAttrs(sc)[0];
            const ticks = pk > 0 ? Math.round((timeSigTicks(at.time) * pk) / at.time.n) : undefined;
            const cur = sc.measures[0].len;
            if ((ticks ?? 0) !== (cur ?? 0)) E.setPickup(sc, ticks);
          }
        });
        return;
    }
  });
}

function instrumentOptions() {
  return INSTRUMENTS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
}

function openScoreDialog() {
  const score = scoreOrThrow();
  const partsHtml = () =>
    score.parts
      .map(
        (p, i) =>
          `<li><span>${esc(p.name)}</span><button value="up-${i}" class="b sm">↑</button><button value="down-${i}" class="b sm">↓</button><button value="rm-${i}" class="b sm danger" ${score.parts.length < 2 ? 'disabled' : ''}>Remover</button></li>`,
      )
      .join('');
  const d = dialog(
    `<h2>Partitura</h2>
    <label>Título <input name="title" value="${esc(score.title)}"></label>
    <label>Compositor <input name="composer" value="${esc(score.composer)}"></label>
    <h3>Instrumentos</h3>
    <ul class="parts">${partsHtml()}</ul>
    <label>Adicionar instrumento <span class="row"><select name="add">${instrumentOptions()}</select><button value="add" class="b">Adicionar</button></span></label>
    <label class="check"><input name="concert" type="checkbox" ${score.concertPitch ? 'checked' : ''}> Mostrar em concert pitch (alturas reais)</label>
    <div class="row end"><button value="cancel" class="b">Fechar</button><button value="apply" class="b primary">Salvar</button></div>`,
  );
  d.addEventListener('close', () => {
    const v = d.returnValue;
    const f = d.querySelector('form')!;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
    const applyMeta = (sc: Score) => {
      sc.title = val('title').trim() || 'Sem título';
      sc.composer = val('composer').trim();
      sc.concertPitch = (f.elements.namedItem('concert') as HTMLInputElement).checked || undefined;
    };
    if (v === 'apply') return mutate(applyMeta);
    if (v === 'add') {
      const p = INSTRUMENTS[Number(val('add'))];
      mutate((sc) => {
        applyMeta(sc);
        E.addPart(sc, p);
      });
      return openScoreDialog();
    }
    const m = v.match(/^(up|down|rm)-(\d+)$/);
    if (m) {
      const i = Number(m[2]);
      st.sel = null;
      st.cursor = null;
      mutate((sc) => {
        applyMeta(sc);
        if (m[1] === 'rm') E.removePart(sc, i);
        else E.movePart(sc, i, m[1] === 'up' ? -1 : 1);
      });
      openScoreDialog();
    }
  });
}

// ------------------------------------------------------------------ exportar / importar

function safeName(s: string) {
  return (s || 'partitura').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
}

async function shareOrDownload(blob: Blob, filename: string) {
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (nav.canShare?.({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}

async function exportScore(score: Score) {
  const xml = exportMusicXml(score);
  await shareOrDownload(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), `${safeName(score.title)}.musicxml`);
}

async function exportCurrent() {
  if (!st.score) return;
  await saveScore(st.score);
  await exportScore(st.score);
}

async function importFiles(files: FileList | File[]) {
  let last: Score | undefined;
  let ok = 0;
  for (const f of Array.from(files)) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const score = loadScoreFromBytes(bytes, f.name);
      await saveScore(score);
      last = score;
      ok++;
    } catch (e) {
      console.error(e);
      toast(`Não consegui abrir ${f.name}: ${(e as Error).message}`, 5000);
    }
  }
  if (ok > 1) {
    toast(`${ok} partituras importadas`);
    await showLibrary();
  } else if (last) await openScore(last.id);
}

// ------------------------------------------------------------------ biblioteca

async function showLibrary() {
  player.stop();
  if (st.score) await saveScore(st.score);
  st.score = null;
  $('#editor').classList.add('hidden');
  $('#library').classList.remove('hidden');
  const list = await listScores();
  const ul = $('#lib-list');
  if (!list.length) {
    ul.innerHTML = `<li class="empty">Nenhuma partitura ainda. Crie uma nova ou importe um arquivo do MuseScore (.mscz) ou MusicXML.</li>`;
    return;
  }
  const fmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  ul.innerHTML = list
    .map(
      (s) => `<li data-id="${s.id}">
        <button class="open" data-act="open">
          <strong>${esc(s.title || 'Sem título')}</strong>
          <small>${esc(s.parts.join(', '))} · ${s.measures} compassos · ${fmt.format(s.updatedAt)}</small>
        </button>
        <div class="acts">
          <button class="b sm" data-act="export">Exportar</button>
          <button class="b sm" data-act="dup">Duplicar</button>
          <button class="b sm danger" data-act="del">Apagar</button>
        </div>
      </li>`,
    )
    .join('');
}

async function openScore(id: string) {
  const score = await loadScore(id);
  if (!score) return toast('Partitura não encontrada');
  st.score = score;
  st.history = [];
  st.future = [];
  st.sel = null;
  st.cursor = { m: 0, s: 0, v: 0, tick: 0 };
  st.voice = 0;
  view.clear();
  $('#library').classList.add('hidden');
  $('#editor').classList.remove('hidden');
  $('#scroller').scrollTop = 0;
  buildPiano();
  render();
  updateToolbar();
}

function openNewDialog() {
  const d = dialog(
    `<h2>Nova partitura</h2>
    <label>Título <input name="title" value="Ideia ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date())}"></label>
    <label>Compositor <input name="composer" value=""></label>
    <label>Instrumento <select name="inst">${instrumentOptions()}</select></label>
    <label>Instrumento 2 (opcional) <select name="inst2"><option value="">—</option>${instrumentOptions()}</select></label>
    <div class="row">
      <label>Compasso <span class="row"><input name="tn" type="number" value="4" min="1" max="32"> / <select name="td"><option>2</option><option selected>4</option><option>8</option></select></span></label>
      <label>Andamento <input name="tempo" type="number" value="90" min="20" max="400"></label>
    </div>
    <label>Armadura <select name="key">${keyOptions(0)}</select></label>
    <div class="row">
      <label>Compassos <input name="measures" type="number" value="16" min="1" max="999"></label>
      <label>Anacruse (tempos) <input name="pickup" type="number" value="0" min="0" max="16"></label>
    </div>
    <div class="row end"><button value="cancel" class="b">Cancelar</button><button value="create" class="b primary">Criar</button></div>`,
  );
  d.addEventListener('close', async () => {
    if (d.returnValue !== 'create') return;
    const f = d.querySelector('form')!;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
    const insts = [val('inst'), val('inst2')].filter((x) => x !== '').map((i) => INSTRUMENTS[Number(i)]);
    const time = { n: Number(val('tn')) || 4, d: Number(val('td')) || 4 };
    const pickupBeats = Number(val('pickup')) || 0;
    const score = newScore({
      title: val('title').trim() || 'Sem título',
      composer: val('composer').trim(),
      parts: insts,
      time,
      key: Number(val('key')),
      tempo: Number(val('tempo')) || 90,
      measures: Math.max(1, Math.min(999, Number(val('measures')) || 16)),
      pickup: pickupBeats > 0 && pickupBeats < time.n ? Math.round((timeSigTicks(time) * pickupBeats) / time.n) : undefined,
    });
    await saveScore(score);
    await openScore(score.id);
  });
}

function bindLibrary() {
  $('#new-btn').addEventListener('click', () => openNewDialog());
  const input = $('#file-input') as HTMLInputElement;
  $('#import-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files?.length) void importFiles(input.files);
    input.value = '';
  });
  $('#lib-list').addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
    const li = (e.target as HTMLElement).closest('li[data-id]') as HTMLElement | null;
    if (!b || !li) return;
    const id = li.dataset.id!;
    switch (b.dataset.act) {
      case 'open':
        return openScore(id);
      case 'export': {
        const s = await loadScore(id);
        if (s) await exportScore(s);
        return;
      }
      case 'dup': {
        const s = await loadScore(id);
        if (!s) return;
        const c: Score = JSON.parse(JSON.stringify(s));
        c.id = uid('s');
        c.title = s.title + ' (cópia)';
        c.updatedAt = Date.now();
        await saveScore(c);
        return showLibrary();
      }
      case 'del':
        if (confirm('Apagar esta partitura do iPad? (não tem como desfazer)')) {
          await deleteScore(id);
          return showLibrary();
        }
    }
  });
  // arrastar arquivos (desktop)
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files);
  });
}

// ------------------------------------------------------------------ boot

export function boot() {
  buildTopbar();
  buildPalette();
  bindPointer();
  bindKeys();
  bindLibrary();
  let rt: number | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => {
      if (st.score) render();
    }, 150);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && st.score) void saveScore(st.score);
    if (document.hidden) player.stop();
  });
  void requestPersistence();
  void showLibrary();
  // exposto pra testes e2e
  (window as unknown as { __pauta: unknown }).__pauta = { st, actions, get systems() { return systems; }, render, openScore, importFiles, exportMusicXml, undo, redo };
}

// mantém referências que só os testes usam
void TPQ;
