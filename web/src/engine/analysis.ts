// One-call analysis of a file's features -> a result object, the same shape as
// research/stoned_mango/analysis.py returns (so the golden files compare directly).

import { ambiguity, type Ambiguity } from './ambiguity.ts';
import { CnnLogits, type OrtLike, type SessionLike } from './cnn.ts';
import { candidateLabel, essentiaKeys, scoreScales, type Candidate } from './engines.ts';
import type { Essentia, Features } from './features.ts';
import { candidateFeatures, candidatesFrom, fusionLogProbs, keyConfidence, type Fusion } from './fusion.ts';
import { parentLabel, scale } from './scales.ts';
import { timeline as keyChanges, roundTo, type Section } from './timeline.ts';
import { tonicCues } from './tonic.ts';
import { decide, tier3Result, type TraditionsSetting } from './world.ts';

export const DEFAULT_BASS_WEIGHT = 0.3;

export interface Engines {
  essentia: Essentia;
  ort?: OrtLike;
  session?: SessionLike; // the key CNN; without it the template engine answers
  fusion?: Fusion | null; // fusion weights; without them the CNN answers alone
}

export interface AnalysisOptions {
  engine?: 'auto' | 'fusion' | 'cnn' | 'template';
  timeline?: boolean;
  maxTier?: number;
  /** Maqam, makam and raga families (world.ts): 'western' (default), 'auto' (only when a song clearly shows them), 'all', or 'arabic,indian'... */
  traditions?: TraditionsSetting;
}

export interface Result {
  key: { tonic: number; scale: string; third: string; tonic_cents?: number } | null;
  label: string;
  parent?: string | null;
  confidence: number;
  key_confidence?: number;
  best_guess?: string;
  ambiguity?: Ambiguity | null;
  alternatives: { label: string; score: number }[];
  tuning_cents: number | null;
  duration: number;
  engine: string | null;
  engines?: { essentia: Record<string, string> };
  segments: Section[];
  // tier 3 answers only (engine "tier3")
  tradition?: string;
  nearest_key?: { tonic: number; minor: boolean };
  evidence?: { deviation_cents: number; quarter_tones: number; drone: number };
  ragas?: string[];
  western?: string; // the Western engine's answer, for comparison
}

export async function analyseFeatures(f: Features, eng: Engines, opts: AnalysisOptions = {}): Promise<Result> {
  const { engine = 'auto', timeline = true, maxTier = 2, traditions = 'western' } = opts;
  const chroma = f.chroma();
  const bass = f.chroma(true);
  if (f.voiced().length === 0 || Math.max(...chroma) <= 0) {
    return { key: null, label: 'No clear key', confidence: 0, alternatives: [], tuning_cents: null,
      duration: roundTo(f.duration, 2), engine: null, segments: [] };
  }
  const western = await analyseWestern(f, eng, chroma, bass, engine, timeline, maxTier);
  if (traditions !== 'western') {
    // the Western answer first: in "auto" mode a maqam or makam doesn't replace a key it is sure of
    const d = decide(f, traditions, western.key_confidence);
    if (d?.use) return tier3Result(f, d, western.key ? western.label : null);
  }
  return western;
}

/** The answer from the Western scales (tiers 1-2): fusion, CNN or templates. */
async function analyseWestern(f: Features, eng: Engines, chroma: Float64Array, bass: Float64Array,
  engine: NonNullable<AnalysisOptions['engine']>, timeline: boolean, maxTier: number): Promise<Result> {
  const useCnn = ['auto', 'cnn', 'fusion'].includes(engine) && eng.session && eng.ort;
  if ((engine === 'cnn' || engine === 'fusion') && !useCnn) throw new Error('the key CNN is not available');
  const logits = useCnn ? await CnnLogits.compute(eng.ort!, eng.session!, f.logspec) : null;
  const fusion = (engine === 'auto' || engine === 'fusion') && logits ? eng.fusion ?? null : null;
  if (engine === 'fusion' && !fusion) throw new Error('no fusion weights');

  let cands: Candidate[];
  let used: string;
  if (fusion && logits) {
    const feats = candidateFeatures(logits.logProbs(), chroma, tonicCues(f.logspec, bass));
    cands = candidatesFrom(fusionLogProbs(fusion, feats));
    used = 'fusion';
  } else if (logits) {
    cands = candidatesFrom(logits.logProbs());
    used = 'cnn';
  } else {
    cands = scoreScales(chroma, bass, DEFAULT_BASS_WEIGHT, maxTier);
    used = 'template';
  }
  cands = cands.filter((c) => scale(c.scale).tier <= maxTier);
  const best = cands[0];
  const kc = keyConfidence(cands);
  const segments = timeline ? keyChanges(f, fusion, logits, { maxTier }) : [];
  for (const s of segments) if (s.key) s.parent = parentLabel(s.key.tonic, s.key.scale);
  const alternatives = cands.slice(1, 4).map((c) => ({ label: candidateLabel(c), score: roundTo(c.prob, 3) }));
  const common = { tuning_cents: roundTo(f.tuningCents, 1), duration: roundTo(f.duration, 2), engine: used, segments };
  if (fusion && kc < fusion.noKeyBelow) {
    return { key: null, label: 'No clear key', confidence: roundTo(best.prob, 3), key_confidence: roundTo(kc, 3),
      best_guess: candidateLabel(best), alternatives, ...common };
  }
  return {
    key: { tonic: best.tonic, scale: best.scale, third: scale(best.scale).third },
    label: candidateLabel(best),
    parent: parentLabel(best.tonic, best.scale),
    confidence: roundTo(best.prob, 3),
    key_confidence: roundTo(kc, 3),
    ambiguity: ambiguity(cands, chroma),
    alternatives,
    ...common,
    engines: { essentia: essentiaKeys(eng.essentia, chroma) },
  };
}
