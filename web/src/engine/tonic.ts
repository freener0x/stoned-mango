// Tonic cues (PLAN.md stage [5d]): bass, ending and drone evidence for the home note.
// Mirrors research/stoned_mango/tonic.py.

import { LOGSPEC_BANDS, LOGSPEC_BANDS_PER_OCTAVE } from './features.ts';

export const CUES = ['bass', 'ending', 'drone'] as const;
const ENDING_FRACTION = 0.15; // the last 15% of the voiced frames
const BANDS_PER_SEMITONE = LOGSPEC_BANDS_PER_OCTAVE / 12;

/** [frames * 12] chroma per frame (C first) from [frames * 105] log-spectrogram rows. */
export function frameChroma(logspec: Float32Array): Float64Array {
  const frames = logspec.length / LOGSPEC_BANDS;
  const out = new Float64Array(frames * 12);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < LOGSPEC_BANDS; k++) {
      const v = logspec[f * LOGSPEC_BANDS + k];
      const lo = Math.floor(k / BANDS_PER_SEMITONE);
      if (k % BANDS_PER_SEMITONE === 0) out[f * 12 + (lo % 12)] += v;
      else {
        out[f * 12 + (lo % 12)] += 0.5 * v;
        out[f * 12 + ((lo + 1) % 12)] += 0.5 * v;
      }
    }
  }
  return out;
}

function unitMax(v: Float64Array): Float64Array {
  const m = v.length ? Math.max(...v) : 0;
  return m > 0 ? v.map((x) => x / m) : new Float64Array(v.length);
}

export interface TonicCues {
  bass: Float64Array;
  ending: Float64Array;
  drone: Float64Array;
}

export const cueAt = (c: TonicCues, tonic: number) => CUES.map((k) => c[k][((tonic % 12) + 12) % 12]);

export function tonicCues(logspec: Float32Array, bassChroma: ArrayLike<number>): TonicCues {
  const chroma = frameChroma(logspec);
  const frames = chroma.length / 12;
  if (frames === 0) return { bass: new Float64Array(12), ending: new Float64Array(12), drone: new Float64Array(12) };
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) for (let p = 0; p < 12; p++) energy[f] += chroma[f * 12 + p];
  const thr = 0.05 * Math.max(Math.max(...energy), 1e-9);
  let voiced: number[] = [];
  for (let f = 0; f < frames; f++) if (energy[f] > thr) voiced.push(f);
  if (voiced.length === 0) voiced = Array.from({ length: frames }, (_, i) => i);
  const tail = voiced.slice(voiced.length - Math.max(1, Math.floor(voiced.length * ENDING_FRACTION)));
  const ending = new Float64Array(12);
  for (const f of tail) for (let p = 0; p < 12; p++) ending[p] += chroma[f * 12 + p];
  for (let p = 0; p < 12; p++) ending[p] /= tail.length;
  // Each voiced frame's two loudest notes (ties: lower pitch class first, as numpy's argsort of the negation).
  const counts = new Float64Array(12);
  for (const f of voiced) {
    const order = Array.from({ length: 12 }, (_, p) => p).sort((a, b) => chroma[f * 12 + b] - chroma[f * 12 + a] || a - b);
    counts[order[0]]++;
    counts[order[1]]++;
  }
  return {
    bass: unitMax(Float64Array.from(bassChroma)),
    ending: unitMax(ending),
    drone: counts.map((c) => c / voiced.length),
  };
}
