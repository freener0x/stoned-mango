// Phase 0 benchmark page: decode on the main thread, analyse in a worker pool.
// Exposes window.stonedMangoBench for the Playwright runner (bench/run-bench.mjs)
// and a small form for running it by hand, e.g. on a phone.

import type { AnalyseOptions, FileResult, FromWorker, ToWorker } from './types';

const SAMPLE_RATE = 22050;
const BASE = import.meta.env.BASE_URL;

export interface RunOptions extends AnalyseOptions {
  workers: number;
  model: 'int8' | 'fp32';
}

export interface RunSummary {
  userAgent: string;
  hardwareConcurrency: number;
  deviceMemoryGB: number | null;
  workers: number;
  model: string;
  init: { essentiaInitMs: number; ortInitMs: number; essentiaVersion: string }[];
  totalMs: number;
  audioSeconds: number;
  realtimeFactor: number;
  mainHeapMB: number | null;
  files: FileResult[];
  errors: string[];
}

interface PoolWorker {
  worker: Worker;
  pending?: (msg: FromWorker) => void;
}

function spawn(model: RunOptions['model']): Promise<{ pw: PoolWorker; ready: Extract<FromWorker, { type: 'ready' }> }> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const pw: PoolWorker = { worker };
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.type === 'ready') resolve({ pw, ready: msg });
      else if (msg.type === 'error' && msg.id === undefined && !pw.pending) reject(new Error(msg.message));
      else pw.pending?.(msg);
    };
    worker.onerror = (e) => reject(new Error(e.message));
    const init: ToWorker = { type: 'init', modelUrl: `${BASE}spike/key-cnn-placeholder.${model}.onnx` };
    worker.postMessage(init);
  });
}

function request(pw: PoolWorker, msg: ToWorker, transfer: Transferable[] = []): Promise<FromWorker> {
  return new Promise((resolve) => {
    pw.pending = (reply) => {
      pw.pending = undefined;
      resolve(reply);
    };
    pw.worker.postMessage(msg, transfer);
  });
}

/** Decode any format the browser supports to mono PCM at SAMPLE_RATE. */
async function decode(file: File): Promise<{ pcm: Float32Array; ms: number }> {
  const t = performance.now();
  const bytes = await file.arrayBuffer();
  // decodeAudioData on an OfflineAudioContext resamples to the context's rate.
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buf = await ctx.decodeAudioData(bytes);
  const pcm = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) pcm[i] += ch[i] / buf.numberOfChannels;
  }
  return { pcm, ms: performance.now() - t };
}

export async function run(files: File[], opts: RunOptions, onProgress?: (r: FileResult) => void): Promise<RunSummary> {
  const t0 = performance.now();
  const spawned = await Promise.all(Array.from({ length: opts.workers }, () => spawn(opts.model)));
  const free = spawned.map((s) => s.pw);
  const waiting: ((pw: PoolWorker) => void)[] = [];
  const acquire = () => new Promise<PoolWorker>((res) => (free.length ? res(free.pop()!) : waiting.push(res)));
  const release = (pw: PoolWorker) => (waiting.length ? waiting.shift()!(pw) : free.push(pw));

  const results: FileResult[] = [];
  const errors: string[] = [];
  const inflight: Promise<void>[] = [];
  const analyseOpts: AnalyseOptions = { profiles: opts.profiles, frameLoop: opts.frameLoop, cnn: opts.cnn };

  // Decode only when a worker is free, so at most `workers` decoded files exist at once.
  for (const [id, file] of files.entries()) {
    const pw = await acquire();
    let decoded;
    try {
      decoded = await decode(file);
    } catch (err) {
      errors.push(`${file.name}: decode failed: ${err}`);
      release(pw);
      continue;
    }
    const msg: ToWorker = { type: 'analyse', id, name: file.name, pcm: decoded.pcm, sampleRate: SAMPLE_RATE, opts: analyseOpts };
    inflight.push(
      request(pw, msg, [decoded.pcm.buffer]).then((reply) => {
        if (reply.type === 'result') {
          const r = { ...reply.result, decodeMs: decoded.ms };
          results.push(r);
          onProgress?.(r);
        } else if (reply.type === 'error') {
          errors.push(`${file.name}: ${reply.message}`);
        }
        release(pw);
      }),
    );
  }
  await Promise.all(inflight);
  spawned.forEach((s) => s.pw.worker.terminate());

  const totalMs = performance.now() - t0;
  const audioSeconds = results.reduce((s, r) => s + r.durationS, 0);
  const mem = (performance as any).memory;
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: (navigator as any).deviceMemory ?? null,
    workers: opts.workers,
    model: opts.model,
    init: spawned.map((s) => ({
      essentiaInitMs: s.ready.essentiaInitMs,
      ortInitMs: s.ready.ortInitMs,
      essentiaVersion: s.ready.essentiaVersion,
    })),
    totalMs,
    audioSeconds,
    realtimeFactor: audioSeconds / (totalMs / 1000),
    mainHeapMB: mem ? mem.usedJSHeapSize / 2 ** 20 : null,
    files: results.sort((a, b) => a.id - b.id),
    errors,
  };
}

/** Runs the golden input through a worker and compares with Python onnxruntime's output. */
export async function golden(model: RunOptions['model']) {
  const { pw } = await spawn(model);
  const reply = await request(pw, { type: 'golden', inputUrl: `${BASE}spike/golden-input.f32` });
  pw.worker.terminate();
  if (reply.type !== 'golden') throw new Error(reply.type === 'error' ? reply.message : 'unexpected reply');
  const expected = (await (await fetch(`${BASE}spike/golden.json`)).json()).models[`key-cnn-placeholder.${model}.onnx`];
  let maxAbsDiff = 0;
  reply.output.forEach((v, i) => (maxAbsDiff = Math.max(maxAbsDiff, Math.abs(v - expected.output[i]))));
  return { model, shape: reply.shape, expectedShape: expected.output_shape, maxAbsDiff, ms: reply.ms };
}

export function defaultWorkers(): number {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = (navigator as any).deviceMemory as number | undefined;
  const n = Math.min(Math.max(cores - 1, 1), 4);
  return mem !== undefined && mem <= 4 ? Math.min(n, 2) : n;
}

(window as any).stonedMangoBench = { run, golden, defaultWorkers };

// Manual form.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const out = $<HTMLPreElement>('out');
$<HTMLInputElement>('workers').value = String(defaultWorkers());
$<HTMLButtonElement>('run').onclick = async () => {
  const files = [...($<HTMLInputElement>('files').files ?? [])];
  if (!files.length) {
    out.textContent = 'Pick one or more audio files first.';
    return;
  }
  out.textContent = `Analysing ${files.length} file(s)…\n`;
  const opts: RunOptions = {
    workers: Number($<HTMLInputElement>('workers').value),
    model: $<HTMLSelectElement>('model').value as RunOptions['model'],
    profiles: $<HTMLInputElement>('profiles').value.split(',').map((s) => s.trim()).filter(Boolean),
    frameLoop: $<HTMLInputElement>('frameLoop').checked,
    cnn: $<HTMLInputElement>('cnn').checked,
  };
  try {
    const summary = await run(files, opts, (r) => {
      const key = Object.entries(r.keys).map(([p, k]) => `${p}: ${k.key} ${k.scale}`).join(', ');
      out.textContent += `✓ ${r.name} (${r.durationS.toFixed(0)} s audio) in ${((r.decodeMs + r.totalWorkerMs) / 1000).toFixed(1)} s — ${key}\n`;
    });
    out.textContent += `\n${JSON.stringify(summary, null, 2)}`;
  } catch (err) {
    out.textContent += `\nFailed: ${err}`;
  }
};
$<HTMLButtonElement>('golden').onclick = async () => {
  out.textContent = 'Running golden check…';
  try {
    out.textContent = JSON.stringify(await Promise.all([golden('fp32'), golden('int8')]), null, 2);
  } catch (err) {
    out.textContent = `Failed: ${err}`;
  }
};
