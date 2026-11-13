// Síntese 100% offline com Web Audio (sem samples): timbres simples por família GM.
// O agendamento usa look-ahead (setInterval + horário do AudioContext) pra que o Stop seja
// imediato e o cursor de reprodução acompanhe sem drift.
import { type Score, TPQ, allStaves, computeAttrs, eventTicks, measureTicks, noteMidi } from './model';

type Timbre = 'piano' | 'pluck' | 'sustain' | 'reed' | 'perc';

function timbreFor(program: number, perc: boolean): Timbre {
  if (perc) return 'perc';
  if (program >= 24 && program <= 39) return 'pluck';
  if (program >= 104 && program <= 111) return 'pluck';
  if ((program >= 16 && program <= 23) || (program >= 40 && program <= 55) || (program >= 88 && program <= 103)) return 'sustain';
  if (program >= 56 && program <= 87) return 'reed';
  return 'piano';
}

export interface PlayNote {
  time: number; // segundos desde o início
  dur: number;
  midi: number;
  timbre: Timbre;
  vel: number;
}

export interface PlayCue {
  time: number;
  m: number;
  ids: string[];
}

/** Linha do tempo de reprodução a partir de um compasso (com ritornelos simples). */
export function buildTimeline(score: Score, fromMeasure = 0): { notes: PlayNote[]; cues: PlayCue[]; end: number } {
  const attrs = computeAttrs(score);
  const staves = allStaves(score);
  // ordem de execução com ritornelos (cada |: :| repetido uma vez)
  const order: number[] = [];
  let repStart = 0;
  const done = new Set<number>();
  for (let j = 0; j < score.measures.length; j++) {
    const m = score.measures[j];
    if (m.repeatStart) repStart = j;
    order.push(j);
    if (m.repeatEnd && !done.has(j) && order.length < 5000) {
      done.add(j);
      j = repStart - 1;
    }
  }
  const startIdx = Math.max(0, order.indexOf(fromMeasure));
  const notes: PlayNote[] = [];
  const cues = new Map<number, PlayCue>();
  let t = 0;
  // ligaduras: nota em andamento por pauta/voz/midi
  const open = new Map<string, PlayNote>();
  for (const j of order.slice(startIdx)) {
    const m = score.measures[j];
    const a = attrs[j];
    const secPerTick = 60 / a.tempo / TPQ;
    const len = measureTicks(m, a);
    m.staves.forEach((sm, s) => {
      const part = score.parts[staves[s].partIdx];
      const perc = a.clefs[s] === 'PERC';
      const timbre = timbreFor(part.program, perc);
      sm.voices.forEach((v, vi) => {
        let tick = 0;
        for (const e of v) {
          const d = eventTicks(e);
          const time = t + tick * secPerTick;
          const dur = d * secPerTick;
          if (!e.hidden) {
            const cue = cues.get(Math.round(time * 1000)) ?? { time, m: j, ids: [] };
            cue.ids.push(e.id);
            cues.set(Math.round(time * 1000), cue);
          }
          if (!e.rest) {
            for (const n of e.notes) {
              const midi = noteMidi(n) + part.transpose.chromatic;
              const key = `${s}:${vi}:${midi}`;
              const prev = open.get(key);
              if (prev && Math.abs(prev.time + prev.dur - time) < 1e-6) {
                prev.dur += dur;
                if (!n.tie) open.delete(key);
              } else {
                const pn: PlayNote = { time, dur, midi, timbre, vel: 0.8 };
                notes.push(pn);
                if (n.tie) open.set(key, pn);
                else open.delete(key);
              }
            }
          }
          tick += d;
        }
      });
    });
    t += len * secPerTick;
  }
  return { notes, cues: [...cues.values()].sort((a, b) => a.time - b.time), end: t };
}

export class Player {
  ctx?: AudioContext;
  private master?: GainNode;
  private timer?: number;
  private raf?: number;
  private startAt = 0;
  playing = false;
  metronome = false;
  onCue?: (cue: PlayCue | null) => void;
  onEnd?: () => void;

  /** Precisa ser chamado dentro de um gesto do usuário (iOS). */
  unlock() {
    if (!this.ctx) {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      // iOS 17+: toca mesmo com a chave de silencioso ligada
      if (nav.audioSession) {
        try {
          nav.audioSession.type = 'playback';
        } catch {
          /* ignore */
        }
      }
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 4;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(comp).connect(this.ctx.destination);
      // buffer silencioso destrava o áudio no Safari
      const b = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = b;
      src.connect(this.ctx.destination);
      src.start(0);
    }
    if (this.ctx.state !== 'running') void this.ctx.resume();
    return this.ctx;
  }

  setVolume(v: number) {
    if (this.master) this.master.gain.value = v;
  }

  /** Toca uma nota isolada (pré-escuta ao inserir). */
  preview(midi: number, program = 0, perc = false) {
    const ctx = this.unlock();
    this.voice({ time: 0, dur: 0.45, midi, timbre: timbreFor(program, perc), vel: 0.7 }, ctx.currentTime + 0.01);
  }

  previewChord(midis: number[], program = 0) {
    const ctx = this.unlock();
    for (const m of midis) this.voice({ time: 0, dur: 0.6, midi: m, timbre: timbreFor(program, false), vel: 0.6 }, ctx.currentTime + 0.01);
  }

  private voice(n: PlayNote, at: number) {
    const ctx = this.ctx!;
    const freq = 440 * Math.pow(2, (n.midi - 69) / 12);
    const g = ctx.createGain();
    g.connect(this.master!);
    const v = n.vel * 0.35;
    const end = at + n.dur;
    const oscs: OscillatorNode[] = [];
    const mk = (type: OscillatorType, f: number, gain: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = gain;
      o.connect(og).connect(g);
      oscs.push(o);
      return o;
    };
    let stopAt = end + 0.05;
    switch (n.timbre) {
      case 'piano': {
        mk('triangle', freq, 1);
        mk('sine', freq * 2, 0.35);
        mk('sine', freq * 3, 0.12);
        const decay = Math.min(3, 0.6 + (90 - Math.min(n.midi, 90)) * 0.03);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(v, at + 0.005);
        g.gain.setTargetAtTime(v * 0.25, at + 0.01, decay / 3);
        g.gain.setTargetAtTime(0, end, 0.08);
        stopAt = end + 0.5;
        break;
      }
      case 'pluck': {
        mk('triangle', freq, 1);
        mk('sine', freq * 2, 0.25);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(v, at + 0.004);
        g.gain.setTargetAtTime(0, at + 0.01, 0.35);
        g.gain.setTargetAtTime(0, end, 0.05);
        stopAt = end + 0.3;
        break;
      }
      case 'sustain':
      case 'reed': {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = Math.min(8000, freq * (n.timbre === 'reed' ? 6 : 4));
        filter.Q.value = 0.7;
        filter.connect(g);
        const o1 = ctx.createOscillator();
        o1.type = n.timbre === 'reed' ? 'square' : 'sawtooth';
        o1.frequency.value = freq;
        const o2 = ctx.createOscillator();
        o2.type = 'sawtooth';
        o2.frequency.value = freq * 1.003;
        const og = ctx.createGain();
        og.gain.value = 0.5;
        o1.connect(og).connect(filter);
        o2.connect(og);
        oscs.push(o1, o2);
        // vibrato leve
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5;
        const lg = ctx.createGain();
        lg.gain.value = freq * 0.004;
        lfo.connect(lg).connect(o1.frequency);
        oscs.push(lfo);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(v * 0.8, at + 0.04);
        g.gain.setValueAtTime(v * 0.8, Math.max(at + 0.04, end - 0.02));
        g.gain.linearRampToValueAtTime(0, end + 0.08);
        stopAt = end + 0.12;
        break;
      }
      case 'perc': {
        const len = 0.12;
        const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const f = ctx.createBiquadFilter();
        f.type = n.midi < 40 ? 'lowpass' : 'highpass';
        f.frequency.value = n.midi < 40 ? 200 : 2000 + (n.midi - 40) * 80;
        src.connect(f).connect(g);
        g.gain.value = v * 1.4;
        src.start(at);
        src.stop(at + len);
        return;
      }
    }
    for (const o of oscs) {
      o.start(at);
      o.stop(stopAt);
    }
  }

  private click(at: number, strong: boolean) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.value = strong ? 1600 : 1100;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
    o.connect(g).connect(this.master!);
    o.start(at);
    o.stop(at + 0.06);
  }

  play(score: Score, fromMeasure = 0) {
    this.stop();
    const ctx = this.unlock();
    const { notes, cues, end } = buildTimeline(score, fromMeasure);
    const clicks: { time: number; strong: boolean }[] = [];
    if (this.metronome) {
      const attrs = computeAttrs(score);
      let t = 0;
      for (let j = fromMeasure; j < score.measures.length; j++) {
        const a = attrs[j];
        const beat = (TPQ * 4) / a.time.d;
        const len = measureTicks(score.measures[j], a);
        const spt = 60 / a.tempo / TPQ;
        for (let b = 0; b * beat < len; b++) clicks.push({ time: t + b * beat * spt, strong: b === 0 });
        t += len * spt;
      }
    }
    this.playing = true;
    this.startAt = ctx.currentTime + 0.12;
    let ni = 0;
    let ci = 0;
    const tick = () => {
      const horizon = ctx.currentTime - this.startAt + 0.25;
      while (ni < notes.length && notes[ni].time < horizon) this.voice(notes[ni], this.startAt + notes[ni++].time);
      while (ci < clicks.length && clicks[ci].time < horizon) this.click(this.startAt + clicks[ci].time, clicks[ci++].strong);
      if (ctx.currentTime - this.startAt > end + 0.3) {
        this.stop();
        this.onEnd?.();
      }
    };
    notes.sort((a, b) => a.time - b.time);
    tick();
    this.timer = window.setInterval(tick, 40);
    let lastCue = -1;
    const frame = () => {
      if (!this.playing) return;
      const now = ctx.currentTime - this.startAt;
      let idx = lastCue;
      while (idx + 1 < cues.length && cues[idx + 1].time <= now) idx++;
      if (idx !== lastCue && idx >= 0) {
        lastCue = idx;
        this.onCue?.(cues[idx]);
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.timer = undefined;
    if (this.playing && this.ctx && this.master) {
      // corta o que já foi agendado: troca o master por um novo
      const old = this.master;
      old.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 4;
      this.master = this.ctx.createGain();
      this.master.gain.value = old.gain.value || 0.5;
      this.master.connect(comp).connect(this.ctx.destination);
      setTimeout(() => old.disconnect(), 200);
    }
    this.playing = false;
    this.onCue?.(null);
  }
}
