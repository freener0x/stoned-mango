// Tier 3: Arabic maqam, Turkish makam and Indian raga families. Mirrors
// research/stoned_mango/world.py (see there for the method); the golden files check the two agree.
//
// The scales use notes between the piano's keys, so they're matched on the 120-bin pitch
// profile of the lead line, with home notes on a quarter-tone grid. In "auto" mode a tier 3
// answer replaces the Western one only when the audio shows these traditions' intonation or a
// drone, and a tier 3 scale fits better than any Western scale.

import ragasDoc from '../../../shared/ragas.json' with { type: 'json' };
import scalesDoc from '../../../shared/scales.json' with { type: 'json' };
import { BINS_PER_SEMITONE, HPCP_BINS, type Features } from './features.ts';
import type { Ambiguity } from './ambiguity.ts';
import { library, scale } from './scales.ts';
import { pyRound, roundTo } from './timeline.ts';

export const TRADITIONS = ['arabic', 'turkish', 'indian'] as const;
export type Tradition = (typeof TRADITIONS)[number];
export type TraditionsSetting = 'auto' | 'western' | 'all' | string;

const STEPS = 24;
const BINS_PER_STEP = HPCP_BINS / STEPS; // 5
const SIGMA_BINS = 1.5;
const ROLE = { tonic: 1.0, dominant: 0.85, degree: 0.55, outside: 0.12 };
const BASS_WEIGHT = 0.15;
const DRONE_WEIGHT = 0.25;
const ENDING_WEIGHT = 0.1;
export const ENDING_SECONDS = 5;
const TEMPERATURE = 0.012;
const BACKGROUND_PERCENTILE = 30;
export const DEVIATION_MIN = 2.5;
export const DRONE_MIN = 0.55;
const FIT_MIN = 0.6;
// "auto" mode, fitted on real music (world.py AUTO_MARGIN, AUTO_FIT_MIN)
const AUTO_MARGIN: Record<string, number> = { arabic: 0.1, turkish: 0.1, indian: 0.0 };
const AUTO_FIT_MIN = 0.65;
const QUARTER_TONES_MIN = 0.05;
const ON_KEYS_DEVIATION_MIN = 5.0;
const WESTERN_SURE = 0.9;
const PEAK_LEVEL = 0.1;

interface RawTier3 {
  id: string;
  name: string;
  tier: number;
  tradition?: string;
  cents: number[];
  dominant?: number;
  thaat?: string;
  ordinal?: string;
}

const RAW = new Map((scalesDoc.scales as RawTier3[]).map((s) => [s.id, s]));
const RAGAS = ragasDoc.ragas as { name: string; tradition: string; parent: string; notes: number[] }[];

export interface Tier3Candidate {
  tonicStep: number; // quarter tones above C, 0..23
  scale: string;
  score: number;
  prob: number;
  fit?: number; // the template's fit alone, without the home-note cues
}

const tonicCents = (c: Tier3Candidate) => c.tonicStep * 50;

function bumpTemplate(cents: number[], dominant: number | undefined): Float64Array {
  const t = new Float64Array(HPCP_BINS).fill(ROLE.outside);
  cents.forEach((c, i) => {
    const w = i === 0 ? ROLE.tonic : dominant !== undefined && i === dominant - 1 ? ROLE.dominant : ROLE.degree;
    for (let x = 0; x < HPCP_BINS; x++) {
      let d = Math.abs(x - c / 10);
      d = Math.min(d, HPCP_BINS - d);
      t[x] = Math.max(t[x], w * Math.exp(-0.5 * (d / SIGMA_BINS) ** 2));
    }
  });
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

export function tier3Ids(traditions: readonly string[] = TRADITIONS): string[] {
  return [...library().values()].filter((s) => s.tier === 3 && traditions.includes(RAW.get(s.id)?.tradition ?? '')).map((s) => s.id);
}

const TEMPLATES = new Map<string, Float64Array>();
function template(id: string): Float64Array {
  let t = TEMPLATES.get(id);
  if (!t) {
    const raw = RAW.get(id)!;
    t = zscore(bumpTemplate(raw.cents, raw.dominant));
    TEMPLATES.set(id, t);
  }
  return t;
}

let WESTERN: Float64Array[] | null = null;
function westernTemplates(): Float64Array[] {
  if (WESTERN) return WESTERN;
  WESTERN = [...library().values()].filter((s) => s.tier <= 2).map((s) => {
    const cents = [...new Set(s.cents.map((c) => (pyRound(c / 100) % 12) * 100))].sort((a, b) => a - b);
    const k = cents.indexOf(700);
    return zscore(bumpTemplate(cents, k >= 0 ? k + 1 : undefined));
  });
  return WESTERN;
}

/** Fit of a template rolled by ``shift`` bins against z-scored profile zp, / 120. */
function fitAt(t: Float64Array, zp: Float64Array, shift: number): number {
  let acc = 0;
  for (let i = 0; i < HPCP_BINS; i++) acc += t[(i - shift + HPCP_BINS) % HPCP_BINS] * zp[i];
  return acc / HPCP_BINS;
}

function pool(p: ArrayLike<number>, offset = 0): Float64Array {
  const out = new Float64Array(STEPS);
  for (let i = 0; i < HPCP_BINS; i++) out[Math.floor(((i + BINS_PER_STEP / 2 - 0.5) % HPCP_BINS) / BINS_PER_STEP) % STEPS] += p[offset + i];
  return out;
}

function unitMax(v: Float64Array): Float64Array {
  let m = 0;
  for (const x of v) m = Math.max(m, x);
  return m > 0 ? v.map((x) => x / m) : new Float64Array(v.length);
}

/** Voiced 120-bin frames (row-major), rotated to the nearest bin so bin 0 is C at the tuning. */
function tunedFrames(f: Features): { data: Float64Array; n: number } {
  const idx = f.voiced();
  const shift = -pyRound(f.tuningCents / 10) - 3 * BINS_PER_SEMITONE;
  const data = new Float64Array(idx.length * HPCP_BINS);
  idx.forEach((fi, r) => {
    for (let b = 0; b < HPCP_BINS; b++) data[r * HPCP_BINS + (((b + shift) % HPCP_BINS) + HPCP_BINS) % HPCP_BINS] = f.hpcp[fi * HPCP_BINS + b];
  });
  return { data, n: idx.length };
}

/** numpy.percentile (linear) of each column. */
function columnPercentile(fr: { data: Float64Array; n: number }, q: number): Float64Array {
  const out = new Float64Array(HPCP_BINS);
  const col = new Float64Array(fr.n);
  const pos = (q / 100) * (fr.n - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  for (let b = 0; b < HPCP_BINS; b++) {
    for (let r = 0; r < fr.n; r++) col[r] = fr.data[r * HPCP_BINS + b];
    col.sort();
    out[b] = lo + 1 < fr.n ? col[lo] + frac * (col[lo + 1] - col[lo]) : col[lo];
  }
  return out;
}

type Frames = { data: Float64Array; n: number };

/** Per frame, the strongest bin above the steady background, and its strength (world.py lead_line). */
function leadLine(fr: Frames): { top: Int32Array; weight: Float64Array } {
  const top = new Int32Array(fr.n);
  const weight = new Float64Array(fr.n);
  if (fr.n === 0) return { top, weight };
  const base = columnPercentile(fr, BACKGROUND_PERCENTILE);
  for (let r = 0; r < fr.n; r++) {
    let best = 0;
    let bestV = -Infinity;
    for (let b = 0; b < HPCP_BINS; b++) {
      const v = Math.max(fr.data[r * HPCP_BINS + b] - base[b], 0);
      if (v > bestV) [best, bestV] = [b, v];
    }
    top[r] = best;
    weight[r] = bestV;
  }
  return { top, weight };
}

function histogram(top: Int32Array, weight: Float64Array, from = 0): Float64Array {
  const h = new Float64Array(HPCP_BINS);
  for (let r = from; r < top.length; r++) h[top[r]] += weight[r];
  const out = new Float64Array(HPCP_BINS);
  for (let i = 0; i < HPCP_BINS; i++) out[i] = 0.5 * h[i] + 0.25 * h[(i + HPCP_BINS - 1) % HPCP_BINS] + 0.25 * h[(i + 1) % HPCP_BINS];
  return out;
}

/** The lead line's pitch histogram (see world.py lead_profile). */
export function leadProfile(fr: Frames): Float64Array {
  const { top, weight } = leadLine(fr);
  return histogram(top, weight);
}

/** The lead line over the last ENDING_SECONDS of sound (world.py ending_profile). */
export function endingProfile(fr: Frames, hopSeconds: number): Float64Array {
  const { top, weight } = leadLine(fr);
  const n = Math.max(1, pyRound(ENDING_SECONDS / hopSeconds));
  return histogram(top, weight, Math.max(0, top.length - n));
}

export interface Evidence {
  deviation: number;
  quarterTones: number;
  drone: number;
}

function drone(fr: { data: Float64Array; n: number }): { drone: number; share: Float64Array } {
  const share = new Float64Array(STEPS);
  if (fr.n === 0) return { drone: 0, share };
  for (let r = 0; r < fr.n; r++) {
    const p = pool(fr.data, r * HPCP_BINS);
    // the two largest, the lower index first on ties (numpy's stable argsort of -p)
    let a = 0;
    for (let q = 1; q < STEPS; q++) if (p[q] > p[a]) a = q;
    let b = a === 0 ? 1 : 0;
    for (let q = 0; q < STEPS; q++) if (q !== a && p[q] > p[b]) b = q;
    share[a] += 1;
    share[b] += 1;
  }
  for (let q = 0; q < STEPS; q++) share[q] /= fr.n;
  let best = 0;
  for (let q = 0; q < STEPS; q++) {
    const v = Math.min(share[q], Math.max(share[(q + 14) % STEPS], share[(q + 10) % STEPS]));
    if (v > best + 1e-12) best = v;
  }
  return { drone: best, share };
}

function peaks(p: Float64Array, level = PEAK_LEVEL): [number, number][] {
  let max = 0;
  for (const x of p) max = Math.max(max, x);
  if (max <= 0) return [];
  const out: [number, number][] = [];
  for (let i = 0; i < HPCP_BINS; i++) {
    const a = p[(i + HPCP_BINS - 1) % HPCP_BINS], b = p[i], c = p[(i + 1) % HPCP_BINS];
    if (b > a && b >= c && b >= level * max) {
      const den = a - 2 * b + c;
      out.push([(i + (den ? (0.5 * (a - c)) / den : 0)) * 10, b]);
    }
  }
  return out;
}

const pmod = (a: number, n: number) => ((a % n) + n) % n;

export function intonation(p: Float64Array): [number, number] {
  const pk = peaks(p);
  if (!pk.length) return [0, 0];
  const offs = pk.map(([c]) => pmod(c, 100));
  const h = pk.map(([, w]) => w);
  const dist = (g: number) => offs.map((o) => Math.min(pmod(Math.abs(o - g), 100), 100 - pmod(Math.abs(o - g), 100)));
  let grid = 0;
  let bestSum = -Infinity;
  for (let g = 0; g < 100; g++) {
    const d = dist(g);
    let s = 0;
    d.forEach((x, i) => (s += x <= 8 ? h[i] : 0));
    if (s > bestSum) [grid, bestSum] = [g, s];
  }
  const d = dist(grid);
  let total = 0, wd = 0, far = 0;
  d.forEach((x, i) => {
    total += h[i];
    wd += h[i] * x;
    far += x >= 30 ? h[i] : 0;
  });
  return [wd / total, far / total];
}

function normalise(cands: Tier3Candidate[]): Tier3Candidate[] {
  cands.sort((x, y) => y.score - x.score);
  if (!cands.length) return cands;
  const top = cands[0].score;
  let z = 0;
  const w = cands.map((c) => {
    const e = Math.exp((c.score - top) / TEMPERATURE);
    z += e;
    return e;
  });
  cands.forEach((c, i) => (c.prob = w[i] / z));
  return cands;
}

/** Per quarter tone, the home-note cues added to every template's fit: bass, drone, ending. */
function cues(bass: Float64Array, droneShare: Float64Array, ending: Float64Array): Float64Array {
  const b = unitMax(pool(bass));
  const d = unitMax(droneShare);
  const e = unitMax(pool(ending));
  return b.map((_, q) => BASS_WEIGHT * b[q] + DRONE_WEIGHT * d[q] + ENDING_WEIGHT * e[q]);
}

function rank(p: Float64Array, cue: Float64Array, traditions: readonly string[]): Tier3Candidate[] {
  const ids = tier3Ids(TRADITIONS.filter((t) => traditions.includes(t)));
  if (!ids.length || Math.max(...p) <= 0) return [];
  const zp = zscore(p);
  const out: Tier3Candidate[] = [];
  for (let q = 0; q < STEPS; q++) {
    for (const id of ids) {
      const fit = fitAt(template(id), zp, q * BINS_PER_STEP);
      out.push({ tonicStep: q, scale: id, score: fit + cue[q], prob: 0, fit });
    }
  }
  return normalise(out);
}

function westernFit(p: Float64Array, cue: Float64Array): number {
  const zp = zscore(p);
  let best = -Infinity;
  for (let s = 0; s < 12; s++) {
    const q = 2 * s;
    let fit = -Infinity;
    for (const t of westernTemplates()) fit = Math.max(fit, fitAt(t, zp, q * BINS_PER_STEP));
    best = Math.max(best, fit + cue[q]);
  }
  return best;
}

export function parseTraditions(value: TraditionsSetting): { mode: 'auto' | 'western' | 'all' | 'only'; picked: string[] } {
  const v = value.trim().toLowerCase();
  if (v === 'auto' || v === 'all') return { mode: v, picked: [...TRADITIONS] };
  if (v === 'western') return { mode: 'western', picked: [] };
  const want = new Set(v.split(',').map((x) => x.trim()));
  const picked = TRADITIONS.filter((t) => want.has(t));
  if (!picked.length) throw new Error(`unknown traditions: ${value}`);
  return { mode: 'only', picked };
}

export interface Decision {
  cands: Tier3Candidate[];
  evidence: Evidence;
  western: number;
  use: boolean;
  lead: Float64Array;
}

/** How far each note of this scale at this home note is from the nearest piano key, in cents. */
function offKeys(c: Tier3Candidate): number[] {
  return RAW.get(c.scale)!.cents.map((x) => {
    const r = pmod(tonicCents(c) + x, 100);
    return Math.min(r, 100 - r);
  });
}

export const needsQuarterTones = (c: Tier3Candidate) => Math.max(...offKeys(c)) >= 30;
const onKeys = (c: Tier3Candidate) => Math.max(...offKeys(c)) <= 10;

/** In "auto" mode, a scale must match the evidence (world.py _plausible). */
function plausible(c: Tier3Candidate, e: Evidence, westernConfidence?: number | null): boolean {
  if (c.fit! < AUTO_FIT_MIN || (needsQuarterTones(c) && e.quarterTones < QUARTER_TONES_MIN)) return false;
  if (RAW.get(c.scale)!.tradition === 'indian') return e.drone >= DRONE_MIN;
  if (e.deviation < DEVIATION_MIN || (westernConfidence != null && westernConfidence >= WESTERN_SURE)) return false;
  return !onKeys(c) || e.quarterTones >= QUARTER_TONES_MIN || e.deviation >= ON_KEYS_DEVIATION_MIN;
}

/** ``westernConfidence``: the Western engine's key confidence for this audio, when known (analysis.ts). */
export function decide(f: Features, traditions: TraditionsSetting = 'auto', westernConfidence?: number | null): Decision | null {
  const { mode, picked } = parseTraditions(traditions);
  if (mode === 'western' || f.voiced().length === 0) return null;
  const fr = tunedFrames(f);
  const lead = leadProfile(fr);
  const [deviation, quarterTones] = intonation(lead);
  const dr = drone(fr);
  const evidence: Evidence = { deviation, quarterTones, drone: dr.drone };
  const cue = cues(f.profile120(true), dr.share, endingProfile(fr, f.hopSeconds));
  let cands = rank(lead, cue, picked);
  const western = cands.length ? westernFit(lead, cue) : 0;
  let use: boolean;
  if (!cands.length || cands[0].fit! < FIT_MIN) use = false;
  else if (mode === 'only') use = true;
  else if (mode === 'all') use = cands[0].score > western;
  else {
    // Each tradition's best scale must match the evidence; the best of those must beat the Western
    // scales by its tradition's margin. Shown: the plausible scales from there down (world.py).
    const best = new Map<string, Tier3Candidate>();
    for (const c of cands) if (!best.has(RAW.get(c.scale)!.tradition!)) best.set(RAW.get(c.scale)!.tradition!, c);
    let top: Tier3Candidate | null = null;
    for (const c of best.values()) if (plausible(c, evidence, westernConfidence) && (!top || c.score > top.score)) top = c;
    use = top !== null && top.score >= western + AUTO_MARGIN[RAW.get(top.scale)!.tradition!];
    cands = normalise(cands.filter((c) => top !== null && c.score <= top.score && plausible(c, evidence, westernConfidence)));
  }
  return { cands, evidence, western, use, lead };
}

// ---- names ---------------------------------------------------------------------------------

const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SHARP_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

export function tonicName(step: number, tradition: string): string {
  step = pmod(step, STEPS);
  if (step % 2 === 0) return (tradition === 'indian' ? SHARP_NAMES : FLAT_NAMES)[step / 2];
  return `${FLAT_NAMES[((step + 1) / 2) % 12]} half-flat`;
}

/** 'arabic', 'turkish', 'indian', or undefined for a Western scale. */
export function traditionOf(scaleId: string): Tradition | undefined {
  return RAW.get(scaleId)?.tradition as Tradition | undefined;
}

export function tier3Label(c: Tier3Candidate): string {
  const raw = RAW.get(c.scale)!;
  const tonic = tonicName(c.tonicStep, raw.tradition ?? '');
  if (raw.tradition === 'arabic') return `Maqam ${raw.name} on ${tonic}`;
  if (raw.tradition === 'turkish') return `Makam ${raw.name} on ${tonic}`;
  return `${raw.thaat ? `${raw.thaat} thaat` : raw.name}, Sa = ${tonic}`;
}

function parentText(c: Tier3Candidate): string | null {
  const raw = RAW.get(c.scale)!;
  if (raw.tradition !== 'indian') return null;
  return raw.thaat ? `${raw.name}, the ${raw.ordinal} melakarta` : `the ${raw.ordinal} melakarta`;
}

function presentNotes(p: Float64Array, tonicStep: number, level = 0.2): number[] {
  const e = new Float64Array(12);
  for (let s = 0; s < 12; s++) {
    const centre = (tonicStep * BINS_PER_STEP + s * BINS_PER_SEMITONE) % HPCP_BINS;
    for (let d = -BINS_PER_SEMITONE / 2; d <= BINS_PER_SEMITONE / 2; d++) e[s] += p[pmod(centre + d, HPCP_BINS)];
  }
  const u = unitMax(e);
  return [...Array(12).keys()].filter((s) => u[s] >= level);
}

function ragaShortlist(p: Float64Array, best: Tier3Candidate, top = 3): string[] {
  const notes = new Set(presentNotes(p, best.tonicStep));
  const scored: [number, string][] = [];
  for (const r of RAGAS) {
    const rn = new Set(r.notes);
    const inter = [...notes].filter((x) => rn.has(x)).length;
    const union = new Set([...notes, ...rn]).size;
    const jac = inter / union;
    if (jac >= 0.7) scored.push([jac + (r.parent === best.scale ? 0.1 : 0), r.name]);
  }
  scored.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const names: string[] = [];
  for (const [, n] of scored) if (!names.includes(n)) names.push(n);
  return names.slice(0, top);
}

export function nearestKey(c: Tier3Candidate): { tonic: number; minor: boolean } {
  const cents = RAW.get(c.scale)!.cents;
  const pcs = new Set(cents.map((x) => pmod(Math.floor((tonicCents(c) + x) / 100 + 0.5), 12)));
  const tonic = pmod(Math.floor(tonicCents(c) / 100 + 0.5), 12);
  const thirdMinor = scale(c.scale).third === 'minor';
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const MINOR = [0, 2, 3, 5, 7, 8, 10];
  const before = (a: number[], b: number[]) => {
    const i = a.findIndex((v, k) => v !== b[k]);
    return i >= 0 && a[i] < b[i];
  };
  let best: { rank: number[]; tonic: number; minor: boolean } | null = null;
  for (let t = 0; t < 12; t++) {
    for (const minor of [false, true]) {
      const notes = new Set((minor ? MINOR : MAJOR).map((i) => (t + i) % 12));
      const diff = [...notes].filter((x) => !pcs.has(x)).length + [...pcs].filter((x) => !notes.has(x)).length;
      const triad = [t, t + (minor ? 3 : 4), t + 7].every((x) => pcs.has(x % 12)); // its chord is in the scale
      const rank = [diff, t === tonic && minor === thirdMinor ? 0 : 1, t === tonic ? 0 : 1, triad ? 0 : 1, minor === thirdMinor ? 0 : 1,
        t, minor ? 1 : 0];
      if (!best || before(rank, best.rank)) best = { rank, tonic: t, minor };
    }
  }
  return { tonic: best!.tonic, minor: best!.minor };
}

function ambiguityNote(cands: Tier3Candidate[]): Ambiguity | null {
  if (cands.length < 2) return null;
  const best = cands[0];
  const rb = RAW.get(best.scale)!;
  for (const c of cands.slice(1, 6)) {
    if (c.tonicStep !== best.tonicStep || c.prob < 0.5 * best.prob) continue;
    const rc = RAW.get(c.scale)!;
    const same = rc.cents.length === rb.cents.length && rc.cents.every((x, i) => x === rb.cents[i]) && rc.dominant === rb.dominant;
    const a = tier3Label(best);
    const b = tier3Label(c);
    const text = same ? `${a} or ${rc.name}: same notes and emphasis; only the melody tells them apart`
      : `${a} or ${b}: the two differ in notes that are hard to place here`;
    return { kind: same ? 'same_notes' : 'close', labels: [a, b], text };
  }
  return null;
}

export interface Tier3Result {
  key: { tonic: number; scale: string; third: string; tonic_cents: number };
  label: string;
  parent: string | null;
  tradition: string;
  confidence: number;
  key_confidence: number;
  ambiguity: Ambiguity | null;
  alternatives: { label: string; score: number }[];
  nearest_key: { tonic: number; minor: boolean };
  evidence: { deviation_cents: number; quarter_tones: number; drone: number };
  tuning_cents: number;
  duration: number;
  engine: 'tier3';
  segments: { start: number; end: number; label: string; key: Tier3Result['key']; confidence: number; key_confidence: number }[];
  ragas?: string[];
  western?: string; // the Western engine's answer, for comparison
}

export function tier3Result(f: Features, d: Decision, westernLabel?: string | null): Tier3Result {
  const best = d.cands[0];
  const s = scale(best.scale);
  const raw = RAW.get(best.scale)!;
  let sameTonic = 0;
  for (const c of d.cands) if (c.tonicStep === best.tonicStep) sameTonic += c.prob;
  const label = tier3Label(best);
  const key = { tonic: pmod(Math.floor(tonicCents(best) / 100 + 0.5), 12), scale: best.scale, third: s.third, tonic_cents: tonicCents(best) };
  const out: Tier3Result = {
    key,
    label,
    parent: parentText(best),
    tradition: raw.tradition!,
    confidence: roundTo(best.prob, 3),
    key_confidence: roundTo(sameTonic, 3),
    ambiguity: ambiguityNote(d.cands),
    alternatives: d.cands.slice(1, 4).map((c) => ({ label: tier3Label(c), score: roundTo(c.prob, 3) })),
    nearest_key: nearestKey(best),
    evidence: { deviation_cents: roundTo(d.evidence.deviation, 1), quarter_tones: roundTo(d.evidence.quarterTones, 3), drone: roundTo(d.evidence.drone, 3) },
    tuning_cents: roundTo(f.tuningCents, 1),
    duration: roundTo(f.duration, 2),
    engine: 'tier3',
    segments: [{ start: 0, end: roundTo(f.duration, 2), label, key: { ...key }, confidence: roundTo(best.prob, 3), key_confidence: roundTo(sameTonic, 3) }],
  };
  if (raw.tradition === 'indian') out.ragas = ragaShortlist(d.lead, best);
  if (westernLabel) out.western = westernLabel;
  return out;
}

/** For the parity tests: the intermediate values. */
export function tier3Debug(f: Features) {
  const fr = tunedFrames(f);
  const lead = leadProfile(fr);
  const dr = drone(fr);
  return { lead, ending: endingProfile(fr, f.hopSeconds), intonation: intonation(lead), drone: dr.drone, share: dr.share };
}
