// Key and mode changes over time (PLAN.md stage [7b]). Mirrors research/stoned_mango/timeline.py.

import { ambiguity, type Ambiguity } from './ambiguity.ts';
import { CnnLogits, logSoftmax } from './cnn.ts';
import { candidateLabel, scoreScales } from './engines.ts';
import type { Features } from './features.ts';
import { candidateFeatures, candidatesFrom, fusionLogProbs, keyConfidence, type Fusion } from './fusion.ts';
import { scale, scaleIds } from './scales.ts';
import { tonicCues } from './tonic.ts';

export const WINDOW_SECONDS = 12.0;
export const HOP_SECONDS = 3.0;
export const MIN_SEGMENT_SECONDS = 10.0;
export const CHANGE_COST = 18.0;
export const PER_NOTE_COST = 1.0;
const TEMPLATE_SHARPNESS = 20.0;
const REFINE_SECONDS = 6.0;
const BLOCK_SECONDS = 1.5;

/** Python's round(): halves go to the even neighbour (keeps frame indices identical to the research code). */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export const roundTo = (x: number, digits: number) => {
  const p = 10 ** digits;
  return pyRound(x * p) / p;
};

let NOTE_MATRIX: Uint8Array | null = null;
function noteMatrix(): Uint8Array {
  if (NOTE_MATRIX) return NOTE_MATRIX;
  const ids = scaleIds();
  const m = new Uint8Array(ids.length * 12 * 12);
  ids.forEach((sid, s) => {
    for (let t = 0; t < 12; t++) for (const p of scale(sid).semitones) m[(s * 12 + t) * 12 + ((t + p) % 12)] = 1;
  });
  return (NOTE_MATRIX = m);
}

const COSTS = new Map<string, Float64Array>();
/** [360 * 360] cost of moving from one answer to another (0 to stay). */
export function transitionCosts(change = CHANGE_COST, perNote = PER_NOTE_COST): Float64Array {
  const key = `${change}/${perNote}`;
  const hit = COSTS.get(key);
  if (hit) return hit;
  const m = noteMatrix();
  const n = m.length / 12;
  const cost = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let differ = 0;
      for (let p = 0; p < 12; p++) differ += m[i * 12 + p] !== m[j * 12 + p] ? 1 : 0;
      cost[i * n + j] = change + perNote * differ;
    }
  }
  COSTS.set(key, cost);
  return cost;
}

/** Best state path for [windows][states] log-likelihoods and a [states * states] cost. */
export function viterbi(emissions: Float64Array[], cost: Float64Array): Int32Array {
  const n = emissions.length;
  const k = emissions[0].length;
  let score = Float64Array.from(emissions[0]);
  const back: Int32Array[] = [new Int32Array(k)];
  for (let i = 1; i < n; i++) {
    const b = new Int32Array(k);
    const next = new Float64Array(k);
    for (let to = 0; to < k; to++) {
      let best = -Infinity;
      let arg = 0;
      for (let from = 0; from < k; from++) {
        const v = score[from] - cost[from * k + to];
        if (v > best) { best = v; arg = from; }
      }
      b[to] = arg;
      next[to] = best + emissions[i][to];
    }
    back.push(b);
    score = next;
  }
  const path = new Int32Array(n);
  let arg = 0;
  for (let s = 1; s < k; s++) if (score[s] > score[arg]) arg = s;
  path[n - 1] = arg;
  for (let i = n - 1; i > 0; i--) path[i - 1] = back[i][path[i]];
  return path;
}

/** Scores for any stretch of a song, from features (and CNN logits) computed once. */
export class RangeScorer {
  readonly f: Features;
  readonly fusion: Fusion | null;
  readonly logits: CnnLogits | null;

  constructor(f: Features, fusion: Fusion | null, logits: CnnLogits | null) {
    this.f = f;
    this.fusion = fusion;
    this.logits = logits;
  }

  /** [360] log-probabilities for frames [a, b), or null if that stretch is silent. */
  logProbs(a: number, b: number): Float64Array | null {
    const f = this.f;
    const chroma = f.chroma(false, a, b);
    if (f.voiced(a, b).length === 0 || Math.max(...chroma) <= 0) return null;
    const cnnLp = this.logits ? this.logits.logProbs(a, b) : null;
    if (this.fusion && cnnLp) {
      const bass = f.chroma(true, a, b);
      return fusionLogProbs(this.fusion, candidateFeatures(cnnLp, chroma, tonicCues(f.logspecRows(a, b), bass)));
    }
    if (cnnLp) return cnnLp;
    const ids = new Map(scaleIds().map((sid, i) => [sid, i]));
    const scores = new Float64Array(12 * ids.size).fill(-1);
    for (const c of scoreScales(chroma, f.chroma(true, a, b))) {
      const s = ids.get(c.scale);
      if (s !== undefined) scores[s * 12 + c.tonic] = c.score;
    }
    return logSoftmax(scores.map((v) => TEMPLATE_SHARPNESS * v));
  }
}

interface Seg { start: number; end: number; state: number }

export function windows(f: Features, window = WINDOW_SECONDS, hop = HOP_SECONDS): [number, number][] {
  const w = Math.max(1, pyRound(window / f.hopSeconds));
  const h = Math.max(1, pyRound(hop / f.hopSeconds));
  if (f.frames <= w) return [[0, f.frames]];
  const starts: number[] = [];
  for (let s = 0; s <= f.frames - w; s += h) starts.push(s);
  if (starts[starts.length - 1] + w < f.frames) starts.push(f.frames - w); // cover the tail
  return starts.map((s) => [s, s + w]);
}

function segmentPath(f: Features, bounds: [number, number][], path: Int32Array): Seg[] {
  const centres = bounds.map(([a, b]) => ((a + b) / 2) * f.hopSeconds);
  const segs: Seg[] = [{ start: 0, end: f.duration, state: path[0] }];
  for (let i = 1; i < path.length; i++) {
    if (path[i] !== path[i - 1]) {
      const t = (centres[i - 1] + centres[i]) / 2;
      segs[segs.length - 1].end = t;
      segs.push({ start: t, end: f.duration, state: path[i] });
    }
  }
  return segs;
}

function joinEqual(segs: Seg[]): Seg[] {
  const out = [segs[0]];
  for (const s of segs.slice(1)) {
    if (s.state === out[out.length - 1].state) out[out.length - 1].end = s.end;
    else out.push(s);
  }
  return out;
}

function mergeShort(input: Seg[], minSeconds: number, cost: Float64Array): Seg[] {
  const n = Math.sqrt(cost.length);
  let segs = input.map((s) => ({ ...s }));
  while (segs.length > 1) {
    let i = 0;
    for (let j = 1; j < segs.length; j++) if (segs[j].end - segs[j].start < segs[i].end - segs[i].start) i = j;
    if (segs[i].end - segs[i].start >= minSeconds) break;
    const nbrs = [i - 1, i + 1].filter((j) => j >= 0 && j < segs.length);
    // closer key first, then the longer neighbour
    nbrs.sort((x, y) => cost[segs[i].state * n + segs[x].state] - cost[segs[i].state * n + segs[y].state]
      || (segs[y].end - segs[y].start) - (segs[x].end - segs[x].start));
    const j = nbrs[0];
    if (j < i) segs[j].end = segs[i].end;
    else segs[j].start = segs[i].start;
    segs.splice(i, 1);
    segs = joinEqual(segs);
  }
  return segs;
}

function refineBoundaries(f: Features, segs: Seg[], scorer: RangeScorer, reach = REFINE_SECONDS, block = BLOCK_SECONDS): Seg[] {
  const bl = Math.max(1, pyRound(block / f.hopSeconds));
  for (let i = 1; i < segs.length; i++) {
    const left = segs[i - 1];
    const right = segs[i];
    const lo = Math.max(left.start + block, right.start - reach);
    const hi = Math.min(right.end - block, right.start + reach);
    if (hi <= lo) continue;
    const a0 = pyRound(lo / f.hopSeconds);
    const nBlocks = Math.max(1, pyRound((hi - lo) / block));
    let gain = 0;
    let best = 0;
    let bestK = 0;
    for (let k = 0; k < nBlocks; k++) {
      const lp = scorer.logProbs(a0 + k * bl, a0 + (k + 1) * bl);
      gain += lp ? lp[left.state] - lp[right.state] : 0;
      if (gain > best) { best = gain; bestK = k + 1; } // boundary after k + 1 blocks
    }
    const t = (a0 + bestK * bl) * f.hopSeconds;
    left.end = right.start = Math.min(Math.max(t, left.start + block), right.end - block);
  }
  return segs;
}

export interface Section {
  start: number;
  end: number;
  key: { tonic: number; scale: string; third: string } | null;
  label: string;
  confidence: number;
  key_confidence: number;
  ambiguity?: Ambiguity | null;
  best_guess?: string;
  parent?: string | null;
}

export interface TimelineOptions {
  change?: number;
  perNote?: number;
  minSeconds?: number;
  window?: number;
  hop?: number;
  maxTier?: number;
}

/** The song's sections, each with its own key, confidence and ambiguity note. */
export function timeline(f: Features, fusion: Fusion | null, logits: CnnLogits | null, opts: TimelineOptions = {}): Section[] {
  const { change = CHANGE_COST, perNote = PER_NOTE_COST, minSeconds = MIN_SEGMENT_SECONDS, maxTier = 2 } = opts;
  const scorer = new RangeScorer(f, fusion, logits);
  const bounds = windows(f, opts.window, opts.hop);
  const ids = scaleIds();
  const allowed = ids.flatMap((sid) => Array(12).fill(scale(sid).tier <= maxTier) as boolean[]);
  const masked = (lp: Float64Array) => lp.map((v, i) => (allowed[i] ? v : -Infinity));
  const emissions = bounds.map(([a, b]) => {
    const lp = scorer.logProbs(a, b) ?? new Float64Array(12 * ids.length);
    return lp.map((v, i) => (allowed[i] ? v : -1e9));
  });
  const cost = transitionCosts(change, perNote);
  let segs = refineBoundaries(f, mergeShort(segmentPath(f, bounds, viterbi(emissions, cost)), minSeconds, cost), scorer);
  const frame = (t: number) => pyRound(t / f.hopSeconds);
  const range = (s: Seg): [number, number] => [frame(s.start), Math.max(frame(s.end), frame(s.start) + 1)];

  // Score each section over all of its audio; neighbours that agree on the answer join up.
  for (;;) {
    for (const s of segs) {
      const lp = scorer.logProbs(...range(s));
      if (lp) {
        const m = masked(lp);
        let arg = 0;
        for (let i = 1; i < m.length; i++) if (m[i] > m[arg]) arg = i;
        s.state = arg;
      }
    }
    const joined = joinEqual(segs);
    if (joined.length === segs.length) break;
    segs = joined;
  }

  const floor = fusion ? fusion.noKeyBelow : 0;
  return segs.map((s) => {
    const [a, b] = range(s);
    const lp = scorer.logProbs(a, b);
    const base = { start: roundTo(s.start, 2), end: roundTo(s.end, 2) };
    if (!lp) return { ...base, key: null, label: 'No clear key', confidence: 0, key_confidence: 0 };
    const cands = candidatesFrom(masked(lp)).filter((c) => Number.isFinite(c.score));
    const best = cands[0];
    const kc = keyConfidence(cands);
    const common = { confidence: roundTo(best.prob, 3), key_confidence: roundTo(kc, 3) };
    if (kc < floor) return { ...base, key: null, label: 'No clear key', best_guess: candidateLabel(best), ...common };
    return {
      ...base, key: { tonic: best.tonic, scale: best.scale, third: scale(best.scale).third }, label: candidateLabel(best),
      ambiguity: ambiguity(cands, f.chroma(false, a, b)), ...common,
    };
  });
}
