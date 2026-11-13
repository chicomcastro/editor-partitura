// MusicXML (partwise) — exportação é o caminho de volta pro MuseScore (Arquivo › Abrir),
// importação cobre .musicxml/.xml/.mxl e o reabrir dos próprios arquivos exportados.
import { beamGroups } from '../beams';
import {
  type ClefType,
  type Event,
  type Measure,
  type Note,
  type Part,
  type Score,
  type Tuplet,
  STEP_NAMES,
  TPQ,
  computeAttrs,
  eventTicks,
  measureTicks,
  ticksToDurations,
  timeSigTicks,
  transposeKey,
  uid,
} from '../model';
import { type Item, buildVoices } from './common';
import { esc, kid, kids, num, parseXml, text } from './xml';

const TYPE_NAMES: Record<number, string> = {
  [-2]: 'long',
  [-1]: 'breve',
  0: 'whole',
  1: 'half',
  2: 'quarter',
  3: 'eighth',
  4: '16th',
  5: '32nd',
  6: '64th',
  7: '128th',
};
const TYPE_BY_NAME: Record<string, number> = Object.fromEntries(Object.entries(TYPE_NAMES).map(([k, v]) => [v, Number(k)]));
TYPE_BY_NAME['256th'] = 7;
TYPE_BY_NAME['512th'] = 7;

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

function clefXml(c: ClefType, number?: number): string {
  const n = number ? ` number="${number}"` : '';
  const map: Record<ClefType, [string, number, number?]> = {
    G: ['G', 2],
    G8vb: ['G', 2, -1],
    G8va: ['G', 2, 1],
    F: ['F', 4],
    F8vb: ['F', 4, -1],
    C1: ['C', 1],
    C2: ['C', 2],
    C3: ['C', 3],
    C4: ['C', 4],
    C5: ['C', 5],
    PERC: ['percussion', 2],
  };
  const [sign, line, oct] = map[c];
  return `<clef${n}><sign>${sign}</sign><line>${line}</line>${oct ? `<clef-octave-change>${oct}</clef-octave-change>` : ''}</clef>`;
}

const HARMONY_KINDS: [RegExp, string][] = [
  [/^(maj7|Maj7|ma7|M7|Δ7?|j7)$/, 'major-seventh'],
  [/^(m7b5|mi7b5|min7b5|ø7?)$/, 'half-diminished'],
  [/^(m7|mi7|min7|-7)$/, 'minor-seventh'],
  [/^(dim7|o7|°7)$/, 'diminished-seventh'],
  [/^(dim|o|°)$/, 'diminished'],
  [/^(aug|\+)$/, 'augmented'],
  [/^(m|mi|min|-)$/, 'minor'],
  [/^7$/, 'dominant'],
  [/^9$/, 'dominant-ninth'],
  [/^(maj9|M9)$/, 'major-ninth'],
  [/^(m9|mi9|min9)$/, 'minor-ninth'],
  [/^6$/, 'major-sixth'],
  [/^(m6|mi6|min6)$/, 'minor-sixth'],
  [/^sus4?$/, 'suspended-fourth'],
  [/^sus2$/, 'suspended-second'],
  [/^7sus4?$/, 'suspended-fourth'],
  [/^5$/, 'power'],
  [/^$/, 'major'],
];

function stepAlterXml(tag: string, s: string): string {
  const m = s.match(/^([A-G])([#b]*)$/);
  if (!m) return '';
  const alter = m[2].split('').reduce((a, c) => a + (c === '#' ? 1 : -1), 0);
  return `<${tag}-step>${m[1]}</${tag}-step>${alter ? `<${tag}-alter>${alter}</${tag}-alter>` : ''}`;
}

function harmonyXml(h: string): string {
  const m = h.match(/^([A-G][#b]*)(.*?)(?:\/([A-G][#b]*))?$/);
  if (!m) return '';
  const [, root, suffix, bass] = m;
  const kind = HARMONY_KINDS.find(([re]) => re.test(suffix))?.[1] ?? 'major';
  const textAttr = suffix ? ` text="${esc(suffix)}"` : '';
  return `<harmony><root>${stepAlterXml('root', root)}</root><kind${textAttr}>${kind}</kind>${bass ? `<bass>${stepAlterXml('bass', bass)}</bass>` : ''}</harmony>`;
}

function noteKey(n: Pick<Note, 'step' | 'alter' | 'oct'>) {
  return `${n.step}:${n.alter}:${n.oct}`;
}

export function exportMusicXml(score: Score): string {
  const attrs = computeAttrs(score);
  // divisões: mdc de todas as durações, pra gerar números pequenos e exatos
  let g = TPQ;
  for (const m of score.measures) for (const sm of m.staves) for (const v of sm.voices) for (const e of v) g = gcd(g, eventTicks(e));
  for (let j = 0; j < score.measures.length; j++) g = gcd(g, measureTicks(score.measures[j], attrs[j]));
  const div = TPQ / g;
  const d = (ticks: number) => Math.round(ticks / g);

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
  );
  out.push('<score-partwise version="3.1">');
  out.push(`<work><work-title>${esc(score.title)}</work-title></work>`);
  out.push('<identification>');
  if (score.composer) out.push(`<creator type="composer">${esc(score.composer)}</creator>`);
  out.push(`<encoding><software>Pauta</software><encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date></encoding>`);
  out.push('</identification>');
  out.push('<part-list>');
  score.parts.forEach((p, i) => {
    const id = `P${i + 1}`;
    out.push(`<score-part id="${id}"><part-name>${esc(p.name)}</part-name>`);
    if (p.abbr) out.push(`<part-abbreviation>${esc(p.abbr)}</part-abbreviation>`);
    out.push(`<score-instrument id="${id}-I1"><instrument-name>${esc(p.name)}</instrument-name></score-instrument>`);
    out.push(
      `<midi-instrument id="${id}-I1"><midi-channel>${(i % 15) + (i >= 9 ? 2 : 1)}</midi-channel><midi-program>${p.program + 1}</midi-program></midi-instrument>`,
    );
    out.push('</score-part>');
  });
  out.push('</part-list>');

  let staffBase = 0;
  score.parts.forEach((part, pi) => {
    out.push(`<part id="P${pi + 1}">`);
    const nSt = part.staves.length;
    const transposing = part.transpose.chromatic !== 0;
    // ligaduras pendentes por pauta/voz para gerar o <tie type="stop">
    const pendingTies = new Map<string, Set<string>>();
    const lastClef: ClefType[] = part.staves.map((s) => s.clef);
    for (let j = 0; j < score.measures.length; j++) {
      const m = score.measures[j];
      const a = attrs[j];
      const mTicks = measureTicks(m, a);
      const implicit = j === 0 && m.len !== undefined && m.len < timeSigTicks(a.time);
      const hasPickup = score.measures[0].len !== undefined && score.measures[0].len < timeSigTicks(attrs[0].time);
      out.push(`<measure number="${hasPickup ? j : j + 1}"${implicit ? ' implicit="yes"' : ''}>`);
      if (m.repeatStart) out.push('<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>');
      const at: string[] = [];
      if (j === 0) at.push(`<divisions>${div}</divisions>`);
      if (m.key !== undefined || j === 0) {
        const k = transposing ? transposeKey(a.key, -part.transpose.diatonic, -part.transpose.chromatic) : a.key;
        at.push(`<key><fifths>${k}</fifths></key>`);
      }
      if (m.time || j === 0) at.push(`<time><beats>${a.time.n}</beats><beat-type>${a.time.d}</beat-type></time>`);
      if (j === 0 && nSt > 1) at.push(`<staves>${nSt}</staves>`);
      for (let s = 0; s < nSt; s++) {
        const c = j === 0 ? part.staves[s].clef : m.staves[staffBase + s]?.clef;
        if (c && (j === 0 || c !== lastClef[s])) {
          at.push(clefXml(c, nSt > 1 ? s + 1 : undefined));
          lastClef[s] = c;
        }
      }
      if (j === 0 && transposing) {
        const oct = Math.trunc(part.transpose.chromatic / 12);
        at.push(
          `<transpose><diatonic>${part.transpose.diatonic - 7 * oct}</diatonic><chromatic>${part.transpose.chromatic - 12 * oct}</chromatic>${oct ? `<octave-change>${oct}</octave-change>` : ''}</transpose>`,
        );
      }
      if (at.length) out.push(`<attributes>${at.join('')}</attributes>`);
      if (m.tempo !== undefined && pi === 0) {
        out.push(
          `<direction placement="above"><direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>${m.tempo}</per-minute></metronome></direction-type><sound tempo="${m.tempo}"/></direction>`,
        );
      }
      let first = true;
      for (let s = 0; s < nSt; s++) {
        const sm = m.staves[staffBase + s];
        if (!sm) continue;
        sm.voices.forEach((voice, vi) => {
          if (voice.length === 0) return;
          if (vi > 0 && voice.every((e) => e.rest)) return;
          if (!first) out.push(`<backup><duration>${d(mTicks)}</duration></backup>`);
          first = false;
          const vnum = s * 4 + vi + 1;
          const staffTag = nSt > 1 ? `<staff>${s + 1}</staff>` : '';
          const tieKey = `${s}:${vi}`;
          const incoming = pendingTies.get(tieKey) ?? new Set<string>();
          const beams = beamGroups(voice, a.time);
          const beamPos = new Map<number, string>();
          for (const grp of beams) grp.forEach((idx, k) => beamPos.set(idx, k === 0 ? 'begin' : k === grp.length - 1 ? 'end' : 'continue'));
          let filled = 0;
          voice.forEach((ev, ei) => {
            const t = Math.min(eventTicks(ev), mTicks - filled);
            if (t <= 0) return;
            filled += t;
            if (ev.harmony) out.push(harmonyXml(ev.harmony));
            if (ev.hidden) {
              out.push(`<forward><duration>${d(t)}</duration><voice>${vnum}</voice>${staffTag}</forward>`);
              incoming.clear();
              return;
            }
            const prevT = ei > 0 ? voice[ei - 1].tuplet?.id : undefined;
            const nextT = ei < voice.length - 1 ? voice[ei + 1].tuplet?.id : undefined;
            const tupStart = ev.tuplet && prevT !== ev.tuplet.id;
            const tupStop = ev.tuplet && nextT !== ev.tuplet.id;
            const common = (isFirst: boolean, n?: Note) => {
              const parts: string[] = [];
              parts.push(`<duration>${d(t)}</duration>`);
              if (n) {
                const k = noteKey(n);
                if (incoming.has(k)) parts.push('<tie type="stop"/>');
                if (n.tie) parts.push('<tie type="start"/>');
              }
              parts.push(`<voice>${vnum}</voice>`);
              if (!ev.measureRest) parts.push(`<type>${TYPE_NAMES[ev.base] ?? 'quarter'}</type>`);
              for (let i = 0; i < ev.dots; i++) parts.push('<dot/>');
              if (ev.tuplet) {
                parts.push(
                  `<time-modification><actual-notes>${ev.tuplet.actual}</actual-notes><normal-notes>${ev.tuplet.normal}</normal-notes></time-modification>`,
                );
              }
              if (nSt > 1) parts.push(staffTag);
              const bp = beamPos.get(ei);
              if (bp && isFirst) parts.push(`<beam number="1">${bp}</beam>`);
              const nots: string[] = [];
              if (n) {
                const k = noteKey(n);
                if (incoming.has(k)) nots.push('<tied type="stop"/>');
                if (n.tie) nots.push('<tied type="start"/>');
              }
              if (isFirst) {
                if (tupStart) nots.push('<tuplet type="start" bracket="yes"/>');
                if (tupStop) nots.push('<tuplet type="stop"/>');
                if (ev.slurEnd) nots.push('<slur type="stop" number="1"/>');
                if (ev.slurStart) nots.push('<slur type="start" number="1"/>');
              }
              if (nots.length) parts.push(`<notations>${nots.join('')}</notations>`);
              if (isFirst && ev.lyric) parts.push(`<lyric number="1"><syllabic>single</syllabic><text>${esc(ev.lyric)}</text></lyric>`);
              return parts.join('');
            };
            if (ev.rest) {
              out.push(`<note><rest${ev.measureRest ? ' measure="yes"' : ''}/>${common(true)}</note>`);
            } else {
              ev.notes.forEach((n, ni) => {
                const pitch = `<pitch><step>${STEP_NAMES[n.step]}</step>${n.alter ? `<alter>${n.alter}</alter>` : ''}<octave>${n.oct}</octave></pitch>`;
                out.push(`<note>${ni > 0 ? '<chord/>' : ''}${pitch}${common(ni === 0, n)}</note>`);
              });
            }
            incoming.clear();
            if (!ev.rest) for (const n of ev.notes) if (n.tie) incoming.add(noteKey(n));
          });
          pendingTies.set(tieKey, incoming);
        });
      }
      if (m.repeatEnd) out.push('<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>');
      else if (j === score.measures.length - 1) out.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
      out.push('</measure>');
    }
    out.push('</part>');
    staffBase += nSt;
  });
  out.push('</score-partwise>');
  return out.join('\n');
}

// ------------------------------------------------------------------ importação

function clefFromXml(c: Element): ClefType {
  const sign = text(c, 'sign') ?? 'G';
  const line = num(c, 'line');
  const oct = num(c, 'clef-octave-change') ?? 0;
  if (sign === 'G') return oct < 0 ? 'G8vb' : oct > 0 ? 'G8va' : 'G';
  if (sign === 'F') return oct < 0 ? 'F8vb' : 'F';
  if (sign === 'C') return `C${Math.min(5, Math.max(1, line ?? 3))}` as ClefType;
  if (sign === 'percussion') return 'PERC';
  if (sign === 'TAB') return 'G8vb';
  return 'G';
}

function harmonyFromXml(h: Element): string | undefined {
  const root = kid(h, 'root');
  if (!root) return undefined;
  const acc = (alter?: number) => (alter && alter > 0 ? '#'.repeat(alter) : alter ? 'b'.repeat(-alter) : '');
  let s = (text(root, 'root-step') ?? 'C') + acc(num(root, 'root-alter'));
  const kindEl = kid(h, 'kind');
  const kindText = kindEl?.getAttribute('text');
  const kind = text(kindEl) ?? 'major';
  const KIND_SUFFIX: Record<string, string> = {
    major: '',
    minor: 'm',
    dominant: '7',
    'major-seventh': 'maj7',
    'minor-seventh': 'm7',
    diminished: 'dim',
    'diminished-seventh': 'dim7',
    'half-diminished': 'm7b5',
    augmented: 'aug',
    'major-sixth': '6',
    'minor-sixth': 'm6',
    'dominant-ninth': '9',
    'major-ninth': 'maj9',
    'minor-ninth': 'm9',
    'suspended-fourth': 'sus4',
    'suspended-second': 'sus2',
    power: '5',
  };
  s += kindText ?? KIND_SUFFIX[kind] ?? '';
  const bass = kid(h, 'bass');
  if (bass) s += '/' + (text(bass, 'bass-step') ?? 'C') + acc(num(bass, 'bass-alter'));
  return s;
}

export function parseMusicXml(src: string): Score {
  const doc = parseXml(src);
  const root = doc.documentElement;
  if (root.nodeName === 'score-timewise') throw new Error('MusicXML "timewise" não suportado — exporte como partwise');
  if (root.nodeName !== 'score-partwise') throw new Error('Arquivo não é MusicXML');

  const title =
    text(kid(root, 'work'), 'work-title') ||
    text(root, 'movement-title') ||
    kids(root, 'credit')
      .flatMap((c) => kids(c, 'credit-words'))
      .map((c) => text(c))
      .find(Boolean) ||
    'Sem título';
  const composer =
    kids(kid(root, 'identification'), 'creator')
      .filter((c) => c.getAttribute('type') === 'composer')
      .map((c) => text(c))
      .find(Boolean) ?? '';

  const partList = kid(root, 'part-list');
  const scoreParts = kids(partList, 'score-part');
  const partEls = kids(root, 'part');

  interface PartBuild {
    part: Part;
    measures: { staves: Item[][]; clefs: (ClefType | undefined)[]; maxFill: number; key?: number; time?: { n: number; d: number }; tempo?: number; repeatStart?: boolean; repeatEnd?: boolean; implicit?: boolean }[];
  }
  const builds: PartBuild[] = [];

  for (const pEl of partEls) {
    const id = pEl.getAttribute('id');
    const sp = scoreParts.find((s) => s.getAttribute('id') === id);
    const name = text(sp, 'part-name') || 'Instrumento';
    const program = Math.max(0, (num(kid(sp, 'midi-instrument'), 'midi-program') ?? 1) - 1);
    const part: Part = { id: uid('p'), name, abbr: text(sp, 'part-abbreviation'), program, transpose: { diatonic: 0, chromatic: 0 }, staves: [{ clef: 'G' }] };
    const build: PartBuild = { part, measures: [] };
    let divisions = 1;
    let nStaves = 1;
    const voiceMaps: Map<string, number>[] = [];
    const voiceIdx = (staff: number, v: string) => {
      voiceMaps[staff] ??= new Map();
      const m = voiceMaps[staff];
      if (!m.has(v)) m.set(v, Math.min(3, m.size));
      return m.get(v)!;
    };
    let firstMeasure = true;
    for (const mEl of kids(pEl, 'measure')) {
      const mb: PartBuild['measures'][number] = { staves: [], clefs: [], maxFill: 0 };
      if (mEl.getAttribute('implicit') === 'yes') mb.implicit = true;
      let pos = 0;
      let lastEv: Event | undefined;
      const openTuplets = new Map<string, Tuplet>();
      const tupletSum = new Map<string, number>();
      const items = (s: number) => (mb.staves[s] ??= []);
      let pendingHarmony: string | undefined;
      for (const el of kids(mEl)) {
        switch (el.nodeName) {
          case 'attributes': {
            const dv = num(el, 'divisions');
            if (dv) divisions = dv;
            const st = num(el, 'staves');
            if (st) nStaves = st;
            const key = kid(el, 'key');
            if (key) mb.key = num(key, 'fifths') ?? 0;
            const time = kid(el, 'time');
            if (time) {
              const n = Number((text(time, 'beats') ?? '4').split('+').reduce((a, b) => a + Number(b), 0));
              const dd = num(time, 'beat-type') ?? 4;
              mb.time = { n: n || 4, d: dd };
            }
            for (const c of kids(el, 'clef')) {
              const sn = Number(c.getAttribute('number') ?? 1) - 1;
              mb.clefs[sn] = clefFromXml(c);
            }
            const tr = kid(el, 'transpose');
            if (tr) {
              const oc = num(tr, 'octave-change') ?? 0;
              part.transpose = { diatonic: (num(tr, 'diatonic') ?? 0) + 7 * oc, chromatic: (num(tr, 'chromatic') ?? 0) + 12 * oc };
            }
            break;
          }
          case 'backup':
            pos -= Math.round(((num(el, 'duration') ?? 0) * TPQ) / divisions);
            if (pos < 0) pos = 0;
            break;
          case 'forward':
            pos += Math.round(((num(el, 'duration') ?? 0) * TPQ) / divisions);
            break;
          case 'direction': {
            const snd = kid(el, 'sound');
            const t = snd?.getAttribute('tempo');
            if (t && mb.tempo === undefined) mb.tempo = Math.round(Number(t));
            if (mb.tempo === undefined) {
              const met = el.getElementsByTagName('per-minute')[0];
              if (met) {
                const v = Number(met.textContent);
                if (v) mb.tempo = Math.round(v);
              }
            }
            break;
          }
          case 'harmony':
            pendingHarmony = harmonyFromXml(el);
            break;
          case 'barline': {
            const rep = kid(el, 'repeat');
            if (rep?.getAttribute('direction') === 'forward') mb.repeatStart = true;
            if (rep?.getAttribute('direction') === 'backward') mb.repeatEnd = true;
            break;
          }
          case 'note': {
            if (kid(el, 'grace') || kid(el, 'cue')) break;
            const dur = Math.round(((num(el, 'duration') ?? 0) * TPQ) / divisions);
            const isChord = !!kid(el, 'chord');
            const staff = (num(el, 'staff') ?? 1) - 1;
            const voice = voiceIdx(staff, text(el, 'voice') ?? '1');
            const restEl = kid(el, 'rest');
            const pitchEl = kid(el, 'pitch') ?? kid(el, 'unpitched');
            let note: Note | undefined;
            if (pitchEl) {
              const step = STEP_NAMES.indexOf(text(pitchEl, 'step') ?? text(pitchEl, 'display-step') ?? 'C');
              note = {
                step: Math.max(0, step),
                alter: Math.round(num(pitchEl, 'alter') ?? 0),
                oct: (num(pitchEl, 'octave') ?? num(pitchEl, 'display-octave') ?? 4),
              };
              const ties = kids(el, 'tie').map((t) => t.getAttribute('type'));
              const tied = kids(kid(el, 'notations'), 'tied').map((t) => t.getAttribute('type'));
              if (ties.includes('start') || tied.includes('start')) note.tie = true;
            }
            if (isChord && lastEv && note) {
              lastEv.notes.push(note);
              lastEv.notes.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
              break;
            }
            const typeName = text(el, 'type');
            const ev: Event = { id: uid(), rest: !note, base: 2, dots: kids(el, 'dot').length, notes: note ? [note] : [] };
            const tm = kid(el, 'time-modification');
            if (tm) {
              const actual = num(tm, 'actual-notes') ?? 3;
              const normal = num(tm, 'normal-notes') ?? 2;
              const key = `${staff}:${voice}:${actual}:${normal}`;
              const tupNots = kids(kid(el, 'notations'), 'tuplet').map((t) => t.getAttribute('type'));
              let t = openTuplets.get(key);
              if (!t || tupNots.includes('start')) {
                t = { id: uid('t'), actual, normal };
                openTuplets.set(key, t);
                tupletSum.set(t.id, 0);
              }
              ev.tuplet = t;
              const sum = (tupletSum.get(t.id) ?? 0) + dur;
              tupletSum.set(t.id, sum);
              const typeTicks = TYPE_BY_NAME[typeName ?? ''] !== undefined ? (TPQ * 4) / Math.pow(2, TYPE_BY_NAME[typeName!]) : dur;
              const span = Math.round((typeTicks * actual * normal) / actual);
              // sem marcação de stop: fecha o grupo quando completa a duração "normal"
              if (tupNots.includes('stop') || (!tupNots.length && sum >= span)) openTuplets.delete(key);
            }
            if (typeName && TYPE_BY_NAME[typeName] !== undefined) ev.base = TYPE_BY_NAME[typeName];
            else if (restEl?.getAttribute('measure') === 'yes' || !typeName) {
              const parts = ticksToDurations(dur);
              if (restEl && (restEl.getAttribute('measure') === 'yes' || parts.length !== 1)) {
                ev.measureRest = true;
                (ev as Event & { _ticks?: number })._ticks = dur;
              } else if (parts[0]) {
                ev.base = parts[0].base;
                ev.dots = parts[0].dots;
              }
            }
            if (restEl && restEl.getAttribute('measure') === 'yes') {
              ev.measureRest = true;
              (ev as Event & { _ticks?: number })._ticks = dur;
            }
            if (!ev.measureRest && ev.tuplet === undefined && eventTicks(ev) !== dur && dur > 0) {
              // tipo e duração discordam: confia na duração
              const parts = ticksToDurations(dur);
              if (parts.length === 1) {
                ev.base = parts[0].base;
                ev.dots = parts[0].dots;
              }
            }
            if (kid(el, 'print-object') || el.getAttribute('print-object') === 'no') ev.hidden = ev.rest || undefined;
            const slurs = kids(kid(el, 'notations'), 'slur').map((s) => s.getAttribute('type'));
            if (slurs.includes('start')) ev.slurStart = true;
            if (slurs.includes('stop')) ev.slurEnd = true;
            const lyr = kid(el, 'lyric');
            if (lyr) ev.lyric = text(lyr, 'text');
            if (pendingHarmony) {
              ev.harmony = pendingHarmony;
              pendingHarmony = undefined;
            }
            items(staff).push({ voice, pos, ev });
            lastEv = ev;
            pos += dur;
            if (pos > mb.maxFill) mb.maxFill = pos;
            break;
          }
        }
      }
      if (firstMeasure) {
        part.staves = Array.from({ length: nStaves }, (_, i) => ({ clef: mb.clefs[i] ?? 'G' }));
        firstMeasure = false;
      }
      build.measures.push(mb);
    }
    if (part.staves.length < nStaves) part.staves = Array.from({ length: nStaves }, (_, i) => part.staves[i] ?? { clef: 'G' });
    builds.push(build);
  }

  const nMeasures = Math.max(...builds.map((b) => b.measures.length));
  const measures: Measure[] = [];
  let curTime = { n: 4, d: 4 };
  const curClefs = builds.flatMap((b) => b.part.staves.map((s) => s.clef));
  for (let j = 0; j < nMeasures; j++) {
    const time = builds.map((b) => b.measures[j]?.time).find(Boolean);
    if (time) curTime = time;
    const nominal = timeSigTicks(curTime);
    const fills = builds.map((b) => b.measures[j]?.maxFill ?? 0);
    const maxFill = Math.max(...fills);
    let len: number | undefined;
    const implicit = builds.some((b) => b.measures[j]?.implicit);
    if (maxFill > 0 && maxFill < nominal && (j === 0 || implicit || j === nMeasures - 1)) len = maxFill;
    if (maxFill > nominal) len = maxFill;
    const mLen = len ?? nominal;
    const m: Measure = { staves: [] };
    if (time) m.time = time;
    if (len !== undefined) m.len = len;
    let gi = 0;
    for (const b of builds) {
      const mb = b.measures[j];
      if (mb) {
        if (mb.key !== undefined && m.key === undefined) {
          const t = b.part.transpose;
          m.key = t.chromatic ? transposeKey(mb.key, t.diatonic, t.chromatic) : mb.key;
        }
        if (mb.tempo !== undefined) m.tempo ??= mb.tempo;
        if (mb.repeatStart) m.repeatStart = true;
        if (mb.repeatEnd) m.repeatEnd = true;
      }
      for (let s = 0; s < b.part.staves.length; s++) {
        const items = mb?.staves[s] ?? [];
        const sm: Measure['staves'][number] = { voices: buildVoices(items, mLen) };
        const c = mb?.clefs[s];
        if (j > 0 && c && c !== curClefs[gi]) sm.clef = c;
        if (c) curClefs[gi] = c;
        m.staves.push(sm);
        gi++;
      }
    }
    measures.push(m);
  }
  if (measures.length === 0) throw new Error('MusicXML sem compassos');
  measures[0].time ??= { n: 4, d: 4 };
  measures[0].key ??= 0;
  measures[0].tempo ??= 100;
  let k = measures[0].key;
  for (let j = 1; j < measures.length; j++) {
    if (measures[j].key === undefined) continue;
    if (measures[j].key === k) delete measures[j].key;
    else k = measures[j].key!;
  }
  for (let j = 1; j < measures.length; j++) {
    const prev = measures.slice(0, j).reverse().find((x) => x.time)!.time!;
    const mt = measures[j].time;
    if (mt && mt.n === prev.n && mt.d === prev.d) delete measures[j].time;
  }
  const now = Date.now();
  return { id: uid('s'), title, composer, parts: builds.map((b) => b.part), measures, createdAt: now, updatedAt: now };
}
