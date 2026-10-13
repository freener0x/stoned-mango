// Parity: the browser engine (TypeScript + Essentia.js + ONNX Runtime Web) must reproduce the
// Python engine's results on the golden files (shared/golden, written by `python -m stoned_mango.golden`).
// Measured differences are float rounding (~1e-6), so the tolerances are tight.
//
//   node --test tests/        (from web/)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyseFeatures } from '../src/engine/analysis.ts';
import { CnnLogits } from '../src/engine/cnn.ts';
import { FeatureExtractor, LOGSPEC_BANDS, HPCP_BINS } from '../src/engine/features.ts';
import { candidateFeatures, fusionLogProbs } from '../src/engine/fusion.ts';
import { tonicCues } from '../src/engine/tonic.ts';
import { decide, tier3Debug } from '../src/engine/world.ts';
import { readWavHeader, wavChunks } from '../src/engine/wav.ts';
import { nodeEngines } from './node-engines.ts';

const GOLDEN = new URL('../../shared/golden/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', GOLDEN), 'utf8'));

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  assert.equal(a.length, b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

async function features(name: string) {
  const { essentia } = await nodeEngines();
  const blob = new Blob([readFileSync(new URL(manifest.clips[name].wav, GOLDEN))]);
  const info = await readWavHeader(blob);
  if (!info) throw new Error('WAV header');
  const fx = new FeatureExtractor(essentia, info.sampleRate);
  for await (const chunk of wavChunks(blob, info, 2.5)) fx.push(chunk); // small chunks: streaming must not matter
  return fx.finish();
}

for (const name of Object.keys(manifest.clips)) {
  const exp = JSON.parse(readFileSync(new URL(manifest.clips[name].expected, GOLDEN), 'utf8'));

  test(`${name}: features match Python`, async () => {
    const f = await features(name);
    const e = exp.features;
    assert.equal(f.sampleRate, e.sample_rate);
    assert.equal(f.frames, e.frames);
    assert.ok(Math.abs(f.duration - e.duration) < 1e-9);
    assert.equal(f.voiced().length, e.voiced);
    assert.ok(Math.abs(f.tuningCents - e.tuning_cents) < 1e-3, `tuning ${f.tuningCents} vs ${e.tuning_cents}`);
    const mid = Math.floor(f.frames / 2);
    assert.ok(maxDiff(f.hpcp.subarray(mid * HPCP_BINS, (mid + 1) * HPCP_BINS), e.hpcp_mid_frame) < 1e-4, 'HPCP frame');
    assert.ok(maxDiff(f.chroma(), e.chroma) < 1e-4, 'chroma');
    assert.ok(maxDiff(f.chroma(true), e.bass_chroma) < 1e-4, 'bass chroma');
    const mean = new Float64Array(LOGSPEC_BANDS);
    for (let i = 0; i < f.logspec.length; i++) mean[i % LOGSPEC_BANDS] += f.logspec[i] / f.frames;
    assert.ok(maxDiff(mean, e.logspec_mean) < 1e-5, 'log-spectrogram');
  });

  test(`${name}: CNN and fusion scores match Python`, async () => {
    const eng = await nodeEngines();
    const f = await features(name);
    const logits = await CnnLogits.compute(eng.ort!, eng.session!, f.logspec);
    const lp = logits.logProbs();
    assert.ok(maxDiff(lp, exp.cnn_log_probs) < 1e-4, `CNN ${maxDiff(lp, exp.cnn_log_probs)}`);
    if (exp.fusion_log_probs) {
      const flp = fusionLogProbs(eng.fusion!, candidateFeatures(lp, f.chroma(), tonicCues(f.logspec, f.chroma(true))));
      assert.ok(maxDiff(flp, exp.fusion_log_probs) < 1e-4, `fusion ${maxDiff(flp, exp.fusion_log_probs)}`);
    }
  });

  test(`${name}: the CNN run in pieces equals one whole pass`, async () => {
    const eng = await nodeEngines();
    const f = await features(name);
    const whole = await CnnLogits.compute(eng.ort!, eng.session!, f.logspec, 1 << 30);
    const pieces = await CnnLogits.compute(eng.ort!, eng.session!, f.logspec, 64);
    assert.equal(pieces.frames, whole.frames);
    assert.ok(maxDiff(pieces.data, whole.data) < 1e-4, `pieces vs whole ${maxDiff(pieces.data, whole.data)}`);
  });

  test(`${name}: tier 3 (maqam, makam, raga) values match Python`, async () => {
    const f = await features(name);
    const d = decide(f);
    const e = exp.world;
    assert.equal(d === null, e === null);
    if (!d) return;
    const dbg = tier3Debug(f);
    const scale = Math.max(...e.lead, 1e-9);
    assert.ok(maxDiff(dbg.lead, e.lead) / scale < 1e-4, `lead profile ${maxDiff(dbg.lead, e.lead) / scale}`);
    const endScale = Math.max(...e.ending, 1e-9);
    assert.ok(maxDiff(dbg.ending, e.ending) / endScale < 1e-4, `ending profile ${maxDiff(dbg.ending, e.ending) / endScale}`);
    assert.ok(Math.abs(d.evidence.deviation - e.deviation) < 0.01, `deviation ${d.evidence.deviation} vs ${e.deviation}`);
    assert.ok(Math.abs(d.evidence.quarterTones - e.quarter_tones) < 1e-3, 'quarter tones');
    assert.ok(Math.abs(d.evidence.drone - e.drone) < 1e-9, `drone ${d.evidence.drone} vs ${e.drone}`);
    assert.ok(Math.abs(d.western - e.western) < 1e-4, `western ${d.western} vs ${e.western}`);
    assert.equal(d.use, e.use);
    // same candidates in the same order, except that exact ties (scales whose extra notes fall
    // where the profile is empty) may come either way
    type Top = { tonic_step: number; scale: string; score: number; prob: number };
    const last: Top = e.top[e.top.length - 1];
    d.cands.slice(0, e.top.length).forEach((c, i) => {
      assert.ok(Math.abs(c.score - e.top[i].score) < 1e-4, `score ${i}: ${c.score} vs ${e.top[i].score}`);
      assert.ok(Math.abs(c.fit! - e.top[i].fit) < 1e-4, `fit ${i}`);
      assert.ok(Math.abs(c.prob - e.top[i].prob) < 1e-3, `prob ${i}`);
      const twin = (e.top as Top[]).find((t) => t.tonic_step === c.tonicStep && t.scale === c.scale);
      assert.ok(twin ? Math.abs(twin.score - c.score) < 1e-6 : Math.abs(c.score - last.score) < 1e-6,
        `candidate ${i}: ${c.scale} at step ${c.tonicStep}`);
    });
  });

  test(`${name}: the result and timeline match Python`, async () => {
    const r = await analyseFeatures(await features(name), await nodeEngines(), { traditions: 'auto' }); // as golden.py
    const e = exp.result;
    assert.equal(r.label, e.label);
    assert.deepEqual(r.key, e.key);
    assert.equal(r.engine, e.engine);
    assert.equal(r.parent ?? null, e.parent ?? null);
    assert.equal(r.best_guess ?? null, e.best_guess ?? null);
    assert.equal(r.ambiguity?.text ?? null, e.ambiguity?.text ?? null);
    assert.ok(Math.abs(r.confidence - e.confidence) <= 0.001, `confidence ${r.confidence} vs ${e.confidence}`);
    assert.deepEqual(r.alternatives.map((a) => a.label), e.alternatives.map((a: { label: string }) => a.label));
    if (e.engines) assert.deepEqual(r.engines?.essentia, e.engines.essentia);
    assert.equal(r.tradition ?? null, e.tradition ?? null);
    assert.deepEqual(r.nearest_key ?? null, e.nearest_key ?? null);
    assert.deepEqual(r.ragas ?? null, e.ragas ?? null);
    assert.equal(r.western ?? null, e.western ?? null);
    if (e.evidence) {
      assert.ok(Math.abs(r.evidence!.deviation_cents - e.evidence.deviation_cents) <= 0.1, 'evidence: deviation');
      assert.ok(Math.abs(r.evidence!.drone - e.evidence.drone) <= 0.001, 'evidence: drone');
    }
    assert.deepEqual(r.segments.map((s) => s.label), e.segments.map((s: { label: string }) => s.label));
    r.segments.forEach((s, i) => {
      assert.ok(Math.abs(s.start - e.segments[i].start) <= 0.01 && Math.abs(s.end - e.segments[i].end) <= 0.01,
        `section ${i}: ${s.start}-${s.end} vs ${e.segments[i].start}-${e.segments[i].end}`);
    });
  });
}
