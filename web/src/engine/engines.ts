// Key/mode engines that work on pitch profiles (PLAN.md stages [5b] and [5c]).
// Mirrors research/stoned_mango/engines.py.

import type { Essentia } from './features.ts';
import { label, library, scale, type Scale } from './scales.ts';

const ROLE_WEIGHTS = { tonic: 1.0, fifth: 0.8, third: 0.72, scale: 0.55, outside: 0.15 };
export const ESSENTIA_PROFILES = ['edma', 'bgate', 'temperley', 'krumhansl'];

export interface Candidate {
  tonic: number; // pitch class, 0 = C
  scale: string; // id in shared/scales.json
  score: number;
  prob: number;
}

export const candidateLabel = (c: Candidate) => label(c.tonic, c.scale);

export function template(s: Scale): Float64Array {
  const pcs = new Set(s.semitones);
  const t = new Float64Array(12).fill(ROLE_WEIGHTS.outside);
  for (const pc of pcs) t[pc] = ROLE_WEIGHTS.scale;
  for (const pc of [3, 4]) if (pcs.has(pc)) t[pc] = ROLE_WEIGHTS.third;
  const fifth = pcs.has(7) ? 7 : pcs.has(6) ? 6 : pcs.has(8) ? 8 : null;
  if (fifth !== null) t[fifth] = ROLE_WEIGHTS.fifth;
  t[0] = ROLE_WEIGHTS.tonic;
  return t;
}

function zscore(v: ArrayLike<number>): Float64Array {
  const n = v.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += v[i];
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (v[i] - mean) ** 2;
  const sd = Math.sqrt(ss / n);
  const out = new Float64Array(n);
  if (sd > 1e-12) for (let i = 0; i < n; i++) out[i] = (v[i] - mean) / sd;
  return out;
}

/** Softmax of scores/temperature into ``prob``, best first (stable for ties, like Python's sort). */
export function sortWithProbs(out: Candidate[], temperature = 1): Candidate[] {
  out.sort((a, b) => b.score - a.score);
  const top = out[0]?.score ?? 0;
  let z = 0;
  for (const c of out) z += (c.prob = Math.exp((c.score - top) / temperature));
  for (const c of out) c.prob /= z;
  return out;
}

/** [5c] Correlate a C-first 12-bin chroma with every (tonic, scale) template. */
export function scoreScales(chroma: ArrayLike<number>, bass?: ArrayLike<number> | null, bassWeight = 0,
  maxTier = 2, temperature = 0.03): Candidate[] {
  const ids = [...library().values()].filter((s) => s.tier <= maxTier).map((s) => s.id);
  const z = zscore(chroma);
  let b: Float64Array | null = null;
  if (bass && bassWeight) {
    const max = Math.max(...Array.from(bass));
    b = Float64Array.from(bass, (v) => (max > 0 ? v / max : v));
  }
  const out: Candidate[] = [];
  for (const sid of ids) {
    const zt = zscore(template(scale(sid)));
    for (let tonic = 0; tonic < 12; tonic++) {
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += z[i] * zt[(((i - tonic) % 12) + 12) % 12];
      let score = dot / 12;
      if (b) score += bassWeight * b[tonic];
      out.push({ tonic, scale: sid, score, prob: 0 });
    }
  }
  return sortWithProbs(out, temperature);
}

const PC: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7,
  'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

/** [5b] Essentia's Key algorithm (major/minor only) on the same C-first chroma: profile -> label. */
export function essentiaKeys(e: Essentia, chroma: ArrayLike<number>, profiles = ESSENTIA_PROFILES): Record<string, string> {
  const pcp = new Float32Array(12);
  for (let i = 0; i < 12; i++) pcp[i] = chroma[(i + 9) % 12]; // Essentia's PCP starts at A
  const max = Math.max(...pcp);
  if (max > 0) for (let i = 0; i < 12; i++) pcp[i] /= max;
  const out: Record<string, string> = {};
  for (const profile of profiles) {
    const v = e.arrayToVector(pcp);
    // numHarmonics, pcpSize, profileType, slope, useMajMin, usePolyphony, useThreeChords
    const r = e.Key(v, 4, 12, profile, 0.6, false, true, true);
    v.delete();
    if (!(r.key in PC)) continue;
    out[profile] = `${r.key} ${r.scale}`;
  }
  return out;
}
