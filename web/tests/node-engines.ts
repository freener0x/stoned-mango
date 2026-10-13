// Loads the engine's two WASM libraries in Node for tests (the browser uses the ES builds instead).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as ort from 'onnxruntime-web/wasm';
import type { Engines } from '../src/engine/analysis.ts';
import { SHIPPED_FUSION } from '../src/engine/fusion.ts';

const require = createRequire(import.meta.url);
const MODEL = new URL('../public/models/key-cnn.fp32.onnx', import.meta.url);

let cached: Promise<Engines> | null = null;

export function nodeEngines(): Promise<Engines> {
  cached ??= (async () => {
    const wasm = require('essentia.js/dist/essentia-wasm.umd.js');
    const Essentia = require('essentia.js/dist/essentia.js-core.umd.js');
    const m = wasm.EssentiaWASM ?? wasm;
    if (!m.EssentiaJS) await new Promise<void>((resolve) => (m.onRuntimeInitialized = resolve));
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(readFileSync(MODEL));
    return { essentia: new Essentia(m), ort, session, fusion: SHIPPED_FUSION };
  })();
  return cached;
}
