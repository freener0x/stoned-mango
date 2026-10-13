// Analysis worker: decodes a file in chunks, extracts features, runs the engines and
// posts back the result. Nothing leaves the device; the file is only read here.

import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
import Essentia from 'essentia.js/dist/essentia.js-core.es.js';
import * as ort from 'onnxruntime-web/wasm';
import { analyseFeatures, type AnalysisOptions, type Engines, type Result } from './analysis.ts';
import { NeedsMainThreadDecode, openAudio } from './decode.ts';
import { envelope, type Envelope } from './envelope.ts';
import { FeatureExtractor } from './features.ts';
import { SHIPPED_FUSION } from './fusion.ts';

export type ToWorker =
  | { type: 'init'; modelUrl: string }
  | { type: 'analyse'; id: number; file: File; options?: AnalysisOptions }
  | { type: 'analysePcm'; id: number; samples: Float32Array; sampleRate: number; options?: AnalysisOptions }
  | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'ready'; ms: number }
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'result'; id: number; result: Result; ms: number; method: string; envelope: Envelope }
  | { type: 'needsMainDecode'; id: number }
  | { type: 'error'; id?: number; message: string; cancelled?: boolean };

let engines: Engines | null = null;
const cancelled = new Set<number>();
const post = (msg: FromWorker) => self.postMessage(msg);

class Cancelled extends Error {}

async function init(modelUrl: string) {
  const t0 = performance.now();
  if (!EssentiaWASM.EssentiaJS) await new Promise<void>((resolve) => (EssentiaWASM.onRuntimeInitialized = resolve));
  // One thread per worker: the pool provides the parallelism (threads would need COOP/COEP headers).
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  engines = { essentia: new Essentia(EssentiaWASM), ort, session, fusion: SHIPPED_FUSION };
  post({ type: 'ready', ms: performance.now() - t0 });
}

async function run(id: number, chunks: AsyncIterable<{ samples: Float32Array; progress: number }>, sampleRate: number, method: string,
  options: AnalysisOptions = {}) {
  const t0 = performance.now();
  const fx = new FeatureExtractor(engines!.essentia, sampleRate);
  let last = 0;
  for await (const { samples, progress } of chunks) {
    if (cancelled.has(id)) throw new Cancelled();
    fx.push(samples);
    if (progress - last >= 0.05 || progress === 1) {
      post({ type: 'progress', id, fraction: progress * 0.9 }); // the last 10%: CNN, fusion, timeline
      last = progress;
    }
  }
  const f = fx.finish();
  const result = await analyseFeatures(f, engines!, options);
  const env = envelope(f.rms, f.hopSeconds);
  self.postMessage({ type: 'result', id, result, ms: performance.now() - t0, method, envelope: env } satisfies FromWorker,
    { transfer: [env.values.buffer] });
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  const id = msg.type === 'init' ? undefined : msg.id;
  try {
    if (msg.type === 'init') await init(msg.modelUrl);
    else if (msg.type === 'analyse') {
      const audio = await openAudio(msg.file, msg.file.name);
      await run(msg.id, audio.chunks, audio.sampleRate, audio.method, msg.options);
    } else if (msg.type === 'analysePcm') {
      const one = (async function* () { yield { samples: msg.samples, progress: 1 }; })();
      await run(msg.id, one, msg.sampleRate, 'decodeAudioData', msg.options);
    }
  } catch (err) {
    if (err instanceof NeedsMainThreadDecode && id !== undefined) post({ type: 'needsMainDecode', id });
    else if (err instanceof Cancelled) post({ type: 'error', id, message: 'cancelled', cancelled: true });
    else post({ type: 'error', id, message: String((err as Error)?.message ?? err) });
  } finally {
    if (id !== undefined) cancelled.delete(id);
  }
};
