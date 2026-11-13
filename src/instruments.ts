import type { ClefType } from './model';

export interface InstrumentPreset {
  name: string;
  program: number;
  clefs: ClefType[];
  transpose?: { diatonic: number; chromatic: number };
}

export const INSTRUMENTS: InstrumentPreset[] = [
  { name: 'Piano', program: 0, clefs: ['G', 'F'] },
  { name: 'Melodia (clave de sol)', program: 73, clefs: ['G'] },
  { name: 'Melodia (clave de fá)', program: 42, clefs: ['F'] },
  { name: 'Violino', program: 40, clefs: ['G'] },
  { name: 'Viola', program: 41, clefs: ['C3'] },
  { name: 'Violoncelo', program: 42, clefs: ['F'] },
  { name: 'Contrabaixo', program: 43, clefs: ['F8vb'] },
  { name: 'Flauta', program: 73, clefs: ['G'] },
  { name: 'Clarinete em Si♭', program: 71, clefs: ['G'], transpose: { diatonic: -1, chromatic: -2 } },
  { name: 'Sax Alto em Mi♭', program: 65, clefs: ['G'], transpose: { diatonic: -5, chromatic: -9 } },
  { name: 'Sax Tenor em Si♭', program: 66, clefs: ['G'], transpose: { diatonic: -8, chromatic: -14 } },
  { name: 'Trompete em Si♭', program: 56, clefs: ['G'], transpose: { diatonic: -1, chromatic: -2 } },
  { name: 'Trompa em Fá', program: 60, clefs: ['G'], transpose: { diatonic: -4, chromatic: -7 } },
  { name: 'Trombone', program: 57, clefs: ['F'] },
  { name: 'Bombardino (clave de fá)', program: 58, clefs: ['F'] },
  { name: 'Bombardino (clave de sol, Si♭)', program: 58, clefs: ['G'], transpose: { diatonic: -8, chromatic: -14 } },
  { name: 'Tuba', program: 58, clefs: ['F'] },
  { name: 'Violão', program: 24, clefs: ['G8vb'] },
  { name: 'Guitarra', program: 27, clefs: ['G8vb'] },
  { name: 'Baixo elétrico', program: 33, clefs: ['F8vb'] },
  { name: 'Voz soprano', program: 52, clefs: ['G'] },
  { name: 'Voz contralto', program: 52, clefs: ['G'] },
  { name: 'Voz tenor', program: 52, clefs: ['G8vb'] },
  { name: 'Voz baixo', program: 52, clefs: ['F'] },
  { name: 'Órgão', program: 19, clefs: ['G', 'F'] },
  { name: 'Cordas (naipe)', program: 48, clefs: ['G', 'F'] },
];

export const CLEF_LABELS: Record<ClefType, string> = {
  G: 'Sol',
  G8vb: 'Sol 8vb (violão/tenor)',
  G8va: 'Sol 8va',
  F: 'Fá',
  F8vb: 'Fá 8vb (contrabaixo)',
  C1: 'Dó 1ª linha',
  C2: 'Dó 2ª linha',
  C3: 'Dó 3ª linha (viola)',
  C4: 'Dó 4ª linha (tenor)',
  C5: 'Dó 5ª linha',
  PERC: 'Percussão',
};

export const KEY_LABELS: Record<number, string> = {
  [-7]: 'Dó♭ / lá♭m (7♭)',
  [-6]: 'Sol♭ / mi♭m (6♭)',
  [-5]: 'Ré♭ / si♭m (5♭)',
  [-4]: 'Lá♭ / fám (4♭)',
  [-3]: 'Mi♭ / dóm (3♭)',
  [-2]: 'Si♭ / solm (2♭)',
  [-1]: 'Fá / rém (1♭)',
  0: 'Dó / lám',
  1: 'Sol / mim (1♯)',
  2: 'Ré / sim (2♯)',
  3: 'Lá / fá♯m (3♯)',
  4: 'Mi / dó♯m (4♯)',
  5: 'Si / sol♯m (5♯)',
  6: 'Fá♯ / ré♯m (6♯)',
  7: 'Dó♯ / lá♯m (7♯)',
};
