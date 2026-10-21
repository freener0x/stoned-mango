// The worker pool (src/engine/pool.ts) with a stand-in worker: Cancel stops a worker that
// never answers (one stuck in a computation can't read the cancel message).

import assert from 'node:assert/strict';
import { test } from 'node:test';

class StuckWorker {
  static made: StuckWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  constructor() {
    StuckWorker.made.push(this);
  }
  postMessage(msg: { type: string }) {
    if (msg.type === 'init') setTimeout(() => this.onmessage?.({ data: { type: 'ready' } }));
    // 'analyse' and 'cancel' are never answered: the worker is stuck
  }
  terminate() {
    this.terminated = true;
  }
}

test('Cancel replaces a worker that does not stop', async () => {
  (globalThis as unknown as { Worker: unknown }).Worker = StuckWorker;
  const { AnalysisPool, CANCEL_GRACE_MS } = await import('../src/engine/pool.ts');
  const pool = new AnalysisPool({ workers: 1, modelUrl: 'model.onnx' });
  await pool.ready();
  const [job] = pool.add([new File([new Uint8Array(44)], 'stuck.wav')]);
  assert.equal(job.status, 'running');
  pool.cancel();
  await new Promise((r) => setTimeout(r, CANCEL_GRACE_MS + 200));
  assert.equal(job.status, 'cancelled');
  assert.equal(StuckWorker.made[0].terminated, true, 'the stuck worker was stopped');
  assert.equal(StuckWorker.made.length, 2, 'and a fresh one started');
  assert.equal(pool.size, 1);
  pool.terminate();
});
