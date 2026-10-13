// Analysis worker for the phase 0 spike: Essentia.js (WASM) + ONNX Runtime Web.
// Everything here runs off the main thread; audio arrives as transferred PCM.

import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
import Essentia from 'essentia.js/dist/essentia.js-core.es.js';
import * as ort from 'onnxruntime-web/wasm';
import { applyFilterbank, makeFilterbank, N_BINS, type Filterbank } from './logfilter';
import type { FromWorker, KeyGuess, ToWorker } from './types';

// Keep in sync with research/stoned_mango/essentia_key.py.
const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;

let essentia: any;
let session: ort.InferenceSession;
let filterbank: Filterbank | null = null;

const post = (msg: FromWorker, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

async function init(modelUrl: string) {
  const t0 = performance.now();
  if (!EssentiaWASM.EssentiaJS) {
    await new Promise<void>((resolve) => (EssentiaWASM.onRuntimeInitialized = resolve));
  }
  essentia = new Essentia(EssentiaWASM);
  const essentiaInitMs = performance.now() - t0;

  // One thread per worker: the pool provides the parallelism, and threads would
  // need cross-origin isolation (COOP/COEP headers).
  // Vite bundles ORT's .wasm as a hashed asset, so no wasmPaths is needed.
  ort.env.wasm.numThreads = 1;
  const t1 = performance.now();
  session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  post({ type: 'ready', essentiaInitMs, ortInitMs: performance.now() - t1, essentiaVersion: essentia.version });
}

function heapMB(): number {
  return EssentiaWASM.HEAPU8.byteLength / 2 ** 20;
}

async function analyse(msg: Extract<ToWorker, { type: 'analyse' }>) {
  const { id, name, pcm, sampleRate, opts } = msg;
  const tStart = performance.now();

  // [5b] KeyExtractor: one full pass per profile.
  const keys: Record<string, KeyGuess> = {};
  const keyExtractorMs: Record<string, number> = {};
  if (opts.profiles.length) {
    const signal = essentia.arrayToVector(pcm);
    for (const profile of opts.profiles) {
      const t = performance.now();
      const r = essentia.KeyExtractor(signal, true, FRAME_SIZE, HOP_SIZE, 12, 3500, 60, 25, 0.2, profile, sampleRate);
      keys[profile] = { key: r.key, scale: r.scale, strength: r.strength };
      keyExtractorMs[profile] = performance.now() - t;
    }
    signal.delete();
  }

  // [4] Per-frame features: 12/120-bin HPCP, tuning, and the CNN's log-frequency input.
  const nFrames = pcm.length >= FRAME_SIZE ? Math.floor((pcm.length - FRAME_SIZE) / HOP_SIZE) + 1 : 0;
  const cnnFrames = Math.ceil(nFrames / 2); // every other frame: ~5.4 frames/s at 22.05 kHz
  const spec = new Float32Array(cnnFrames * N_BINS);
  const hpcp12 = new Float64Array(12);
  const hpcp120 = new Float64Array(120);
  const tunings: number[] = [];
  let frameLoopMs = 0;
  if (opts.frameLoop) {
    filterbank ??= makeFilterbank(FRAME_SIZE, sampleRate);
    const t = performance.now();
    for (let i = 0; i < nFrames; i++) {
      const frame = essentia.arrayToVector(pcm.subarray(i * HOP_SIZE, i * HOP_SIZE + FRAME_SIZE));
      const windowed = essentia.Windowing(frame, true, FRAME_SIZE, 'blackmanharris62').frame;
      const spectrum = essentia.Spectrum(windowed, FRAME_SIZE).spectrum;
      const peaks = essentia.SpectralPeaks(spectrum, 0.00001, 5000, 100, 40, 'magnitude', sampleRate);
      const h12 = essentia.HPCP(peaks.frequencies, peaks.magnitudes, true, 500, 0, 5000, false, 40, false,
        'unitMax', 440, sampleRate, 12).hpcp;
      const h120 = essentia.HPCP(peaks.frequencies, peaks.magnitudes, true, 500, 0, 5000, false, 40, false,
        'unitMax', 440, sampleRate, 120).hpcp;
      const a12 = essentia.vectorToArray(h12);
      const a120 = essentia.vectorToArray(h120);
      for (let k = 0; k < 12; k++) hpcp12[k] += a12[k];
      for (let k = 0; k < 120; k++) hpcp120[k] += a120[k];
      if (peaks.frequencies.size() > 0) {
        tunings.push(essentia.TuningFrequency(peaks.frequencies, peaks.magnitudes, 1).tuningCents);
      }
      if (i % 2 === 0) {
        applyFilterbank(filterbank, essentia.vectorToArray(spectrum), spec, (i / 2) * N_BINS);
      }
      // Embind vectors live on the WASM heap and are not garbage-collected.
      for (const v of [frame, windowed, spectrum, peaks.frequencies, peaks.magnitudes, h12, h120]) v.delete();
    }
    frameLoopMs = performance.now() - t;
  }

  // [5a] CNN: one pass over the whole track gives frame-level scores.
  let cnnMs = 0;
  let cnnOutputShape: number[] = [];
  if (opts.cnn && opts.frameLoop && cnnFrames >= 8) {
    const t = performance.now();
    const input = new ort.Tensor('float32', spec, [1, 1, cnnFrames, N_BINS]);
    const out = await session.run({ spec: input });
    cnnOutputShape = [...out.logits.dims];
    out.logits.dispose();
    cnnMs = performance.now() - t;
  }

  tunings.sort((a, b) => a - b);
  const max12 = Math.max(...hpcp12) || 1;
  post({
    type: 'result',
    result: {
      id,
      name,
      durationS: pcm.length / sampleRate,
      keys,
      keyExtractorMs,
      frameLoopMs,
      frames: nFrames,
      hpcp12Mean: Array.from(hpcp12, (v) => Math.round((v / max12) * 1000) / 1000),
      tuningCents: tunings.length ? tunings[Math.floor(tunings.length / 2)] : null,
      cnnMs,
      cnnOutputShape,
      totalWorkerMs: performance.now() - tStart,
      essentiaHeapMB: heapMB(),
    },
  });
}

async function golden(inputUrl: string) {
  const buf = await (await fetch(inputUrl)).arrayBuffer();
  const data = new Float32Array(buf);
  const frames = data.length / N_BINS;
  const t = performance.now();
  const out = await session.run({ spec: new ort.Tensor('float32', data, [1, 1, frames, N_BINS]) });
  const ms = performance.now() - t;
  post({ type: 'golden', output: Array.from(out.logits.data as Float32Array), shape: [...out.logits.dims], ms });
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') await init(msg.modelUrl);
    else if (msg.type === 'analyse') await analyse(msg);
    else if (msg.type === 'golden') await golden(msg.inputUrl);
  } catch (err) {
    post({ type: 'error', id: msg.type === 'analyse' ? msg.id : undefined, message: String((err as Error)?.stack ?? err) });
  }
};
