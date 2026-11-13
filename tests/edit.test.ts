import { describe, expect, it } from 'vitest';
import {
  addNoteToChord,
  deleteAt,
  insertMeasure,
  makeNoteEvent,
  makeTuplet,
  moveChromatic,
  moveDiatonic,
  nextPos,
  setDuration,
  setTimeSig,
  toggleTie,
  writeEvent,
  deleteMeasure,
  pasteMeasures,
  copyMeasures,
} from '../src/edit';
import { TPQ, computeAttrs, eventTicks, measureTicks, newScore, noteMidi, transposeKey, type Score } from '../src/model';

const C4 = { step: 0, alter: 0, oct: 4 };
const E4 = { step: 2, alter: 0, oct: 4 };

function score(measures = 2): Score {
  return newScore({
    title: 't',
    parts: [{ name: 'Piano', program: 0, clefs: ['G', 'F'] }],
    time: { n: 4, d: 4 },
    key: 0,
    tempo: 100,
    measures,
  });
}

function sums(s: Score) {
  const a = computeAttrs(s);
  return s.measures.every((m, j) => m.staves.every((sm) => sm.voices.every((v) => v.reduce((x, e) => x + eventTicks(e), 0) === measureTicks(m, a[j]))));
}

const p0 = { m: 0, s: 0, v: 0 };

describe('writeEvent', () => {
  it('sobrescreve a pausa de compasso e completa com pausas', () => {
    const s = score();
    const i = writeEvent(s, p0, 0, makeNoteEvent([C4], 2, 0));
    const v = s.measures[0].staves[0].voices[0];
    expect(i).toBe(0);
    expect(v[0].rest).toBe(false);
    expect(v.slice(1).every((e) => e.rest)).toBe(true);
    expect(sums(s)).toBe(true);
  });

  it('escreve no meio de uma figura longa quebrando a parte de antes', () => {
    const s = score();
    writeEvent(s, p0, 0, makeNoteEvent([C4], 1, 0)); // mínima
    writeEvent(s, p0, TPQ, makeNoteEvent([E4], 3, 0)); // colcheia no 2º tempo
    const v = s.measures[0].staves[0].voices[0];
    expect(v[0].base).toBe(2); // mínima virou semínima
    expect(noteMidi(v[1].notes[0])).toBe(64);
    expect(sums(s)).toBe(true);
  });

  it('corta a figura que não cabe no fim do compasso', () => {
    const s = score();
    const i = writeEvent(s, p0, 3 * TPQ, makeNoteEvent([C4], 1, 0));
    expect(eventTicks(s.measures[0].staves[0].voices[0][i])).toBe(TPQ);
    expect(sums(s)).toBe(true);
  });

  it('cria voz 2 com pausas quando necessário', () => {
    const s = score();
    writeEvent(s, { m: 0, s: 0, v: 1 }, 0, makeNoteEvent([C4], 2, 0));
    expect(s.measures[0].staves[0].voices[1][0].rest).toBe(false);
    expect(sums(s)).toBe(true);
  });
});

describe('navegação', () => {
  it('nextPos cria compasso novo no fim da partitura', () => {
    const s = score(1);
    writeEvent(s, p0, 0, makeNoteEvent([C4], 0, 0));
    const n = nextPos(s, p0, 0);
    expect(n.p.m).toBe(1);
    expect(s.measures.length).toBe(2);
  });
});

describe('edições', () => {
  it('acorde, apagar nota e apagar evento', () => {
    const s = score();
    writeEvent(s, p0, 0, makeNoteEvent([C4], 2, 0));
    const ev = s.measures[0].staves[0].voices[0][0];
    addNoteToChord(ev, E4);
    expect(ev.notes.map(noteMidi)).toEqual([60, 64]);
    deleteAt(s, p0, 0, 1);
    expect(ev.notes.length).toBe(1);
    deleteAt(s, p0, 0, 0);
    expect(s.measures[0].staves[0].voices[0][0].measureRest).toBe(true);
  });

  it('mudar duração mantém a soma do compasso', () => {
    const s = score();
    writeEvent(s, p0, 0, makeNoteEvent([C4], 2, 0));
    setDuration(s, p0, 0, 1, 1); // mínima pontuada
    expect(eventTicks(s.measures[0].staves[0].voices[0][0])).toBe(3 * TPQ);
    expect(sums(s)).toBe(true);
    setDuration(s, p0, 0, 3, 0);
    expect(sums(s)).toBe(true);
  });

  it('tercina ocupa a duração original', () => {
    const s = score();
    writeEvent(s, p0, 0, makeNoteEvent([C4], 2, 0));
    makeTuplet(s, p0, 0);
    const v = s.measures[0].staves[0].voices[0];
    expect(v.slice(0, 3).every((e) => e.tuplet?.actual === 3)).toBe(true);
    expect(sums(s)).toBe(true);
    // escrever dentro da tercina mantém o grupo
    writeEvent(s, p0, eventTicks(v[0]), makeNoteEvent([E4], 2, 0));
    expect(s.measures[0].staves[0].voices[0][1].tuplet).toBeDefined();
    expect(sums(s)).toBe(true);
  });

  it('ligadura transforma a pausa seguinte na mesma nota', () => {
    const s = score();
    writeEvent(s, p0, 0, makeNoteEvent([C4], 2, 0));
    toggleTie(s, p0, 0);
    const v = s.measures[0].staves[0].voices[0];
    expect(v[0].notes[0].tie).toBe(true);
    expect(noteMidi(v[1].notes[0])).toBe(60);
  });

  it('mudar fórmula de compasso reajusta o conteúdo', () => {
    const s = score(3);
    writeEvent(s, { m: 1, s: 0, v: 0 }, 0, makeNoteEvent([C4], 0, 0));
    setTimeSig(s, 1, { n: 3, d: 4 });
    expect(sums(s)).toBe(true);
    expect(computeAttrs(s)[2].time).toEqual({ n: 3, d: 4 });
  });

  it('inserir e apagar compasso preserva atributos iniciais', () => {
    const s = score(2);
    insertMeasure(s, 0);
    expect(s.measures[0].time).toEqual({ n: 4, d: 4 });
    deleteMeasure(s, 0);
    expect(s.measures[0].key).toBe(0);
    expect(s.measures.length).toBe(2);
  });

  it('copiar/colar', () => {
    const s = score(2);
    writeEvent(s, p0, 0, makeNoteEvent([C4], 2, 0));
    pasteMeasures(s, 1, copyMeasures(s, 0, 0));
    expect(noteMidi(s.measures[1].staves[0].voices[0][0].notes[0])).toBe(60);
    expect(s.measures[1].staves[0].voices[0][0].id).not.toBe(s.measures[0].staves[0].voices[0][0].id);
  });
});

describe('alturas', () => {
  it('movimento diatônico respeita a armadura', () => {
    expect(moveDiatonic({ step: 2, alter: 0, oct: 4 }, 1, -1)).toMatchObject({ step: 3, alter: 0 });
    expect(moveDiatonic({ step: 5, alter: 0, oct: 4 }, 1, -1)).toMatchObject({ step: 6, alter: -1 });
  });
  it('movimento cromático usa grafia da armadura', () => {
    expect(noteMidi(moveChromatic(C4, 1, 0))).toBe(61);
    expect(moveChromatic({ step: 5, alter: 0, oct: 4 }, 1, -1)).toMatchObject({ step: 6, alter: -1 });
  });
  it('transposeKey', () => {
    expect(transposeKey(0, 1, 2)).toBe(2); // C -> D
    expect(transposeKey(0, -1, -2)).toBe(-2); // C -> Bb
    expect(transposeKey(-1, 1, 2)).toBe(1); // F -> G
  });
});
