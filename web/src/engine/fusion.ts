// Engine fusion (phase 3), inference only: one calibrated answer from the CNN, the
// template engine and the tonic cues. Mirrors research/stoned_mango/fusion.py;
// the weights are fitted in Python and shipped in shared/fusion.json.

import shipped from '../../../shared/fusion.json' with { type: 'json' };
import type { Candidate } from './engines.ts';
import { scoreScales } from './engines.ts';
import { scale, scaleIds } from './scales.ts';
import { cueAt, type TonicCues } from './tonic.ts';

export const FEATURES = ['cnn', 'template', 'bass', 'ending', 'drone'] as const;
const CNN_FLOOR = -20; // log-probabilities below this carry no extra information

export interface Fusion {
  weights: Record<string, number>;
  noKeyBelow: number; // "No clear key" floor on the key confidence
}

export const SHIPPED_FUSION: Fusion = { weights: shipped.weights, noKeyBelow: shipped.no_key_below };

/** [360 * 5] feature matrix, row ``scale * 12 + tonic``. */
export function candidateFeatures(cnnLp: Float64Array | null, chroma: ArrayLike<number>, cues: TonicCues): Float64Array {
  const ids = scaleIds();
  const n = 12 * ids.length;
  const k = FEATURES.length;
  const f = new Float64Array(n * k);
  if (cnnLp) for (let i = 0; i < n; i++) f[i * k] = Math.max(cnnLp[i], CNN_FLOOR);
  const index = new Map(ids.map((sid, i) => [sid, i]));
  for (const c of scoreScales(chroma, null, 0, 2)) f[(index.get(c.scale)! * 12 + c.tonic) * k + 1] = c.score;
  for (let t = 0; t < 12; t++) {
    const at = cueAt(cues, t); // same cue values for every scale at tonic t
    for (let s = 0; s < ids.length; s++) for (let j = 0; j < at.length; j++) f[(s * 12 + t) * k + 2 + j] = at[j];
  }
  return f;
}

export function fusionLogProbs(fusion: Fusion, feats: Float64Array): Float64Array {
  const k = FEATURES.length;
  const w = FEATURES.map((name) => fusion.weights[name] ?? 0);
  const n = feats.length / k;
  const s = new Float64Array(n);
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < k; j++) acc += feats[i * k + j] * w[j];
    s[i] = acc;
    if (acc > max) max = acc;
  }
  let z = 0;
  for (let i = 0; i < n; i++) z += Math.exp(s[i] - max);
  const lz = Math.log(z);
  for (let i = 0; i < n; i++) s[i] = s[i] - max - lz;
  return s;
}

/** Sorted candidates from a [360] log-probability vector (index scale * 12 + tonic). */
export function candidatesFrom(lp: Float64Array): Candidate[] {
  const ids = scaleIds();
  const out: Candidate[] = [];
  for (let s = 0; s < ids.length; s++) {
    for (let t = 0; t < 12; t++) out.push({ tonic: t, scale: ids[s], score: lp[s * 12 + t], prob: Math.exp(lp[s * 12 + t]) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Probability that the best answer's home note and major/minor family are right. */
export function keyConfidence(cands: Candidate[]): number {
  if (!cands.length) return 0;
  const best = cands[0];
  const third = scale(best.scale).third;
  let p = 0;
  for (const c of cands) if (c.tonic === best.tonic && scale(c.scale).third === third) p += c.prob;
  return p;
}
