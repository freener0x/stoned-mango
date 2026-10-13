// The key CNN with ONNX Runtime Web. Mirrors research/stoned_mango/cnn/engine.py.
// The network is fully convolutional: one pass over the song gives logits for every
// moment, which the whole-song answer and the timeline windows both average.

import { LOGSPEC_BANDS } from './features.ts';

export const TIME_DOWNSAMPLE = 4;
const MIN_FRAMES = 8;
export const CHUNK_FRAMES = 1024; // ~95 s per network run (a multiple of 4)
const MARGIN_FRAMES = 32; // > the network's reach in time (~12 frames); a multiple of 4

/** The parts of onnxruntime-web the engine uses (so tests can pass the Node build). */
export interface OrtLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => any;
}
export interface SessionLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(feeds: Record<string, any>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
}

export function logSoftmax(x: ArrayLike<number>): Float64Array {
  let max = -Infinity;
  for (let i = 0; i < x.length; i++) max = Math.max(max, x[i]);
  let z = 0;
  for (let i = 0; i < x.length; i++) z += Math.exp(x[i] - max);
  const lz = Math.log(z);
  return Float64Array.from(x, (v) => v - max - lz);
}

/** Per-frame logits for a whole song: [outputs][frames / 4], computed once. */
export class CnnLogits {
  readonly data: Float32Array;
  readonly outputs: number;
  readonly frames: number;

  constructor(data: Float32Array, outputs: number, frames: number) {
    this.data = data;
    this.outputs = outputs;
    this.frames = frames;
  }

  /**
   * Runs the network over ~95 s pieces with a margin on each side, not the whole song at once:
   * its activations grow with the input's length (~300 MB for 20 minutes in one pass), while
   * its reach in time is only about +/-12 input frames. With 32-frame margins, every output
   * frame is exactly what one pass over the whole song gives (tests/parity.test.ts checks this).
   */
  static async compute(ort: OrtLike, session: SessionLike, logspec: Float32Array, chunkFrames = CHUNK_FRAMES): Promise<CnnLogits> {
    let x = logspec;
    if (x.length / LOGSPEC_BANDS < MIN_FRAMES) {
      x = new Float32Array(MIN_FRAMES * LOGSPEC_BANDS);
      x.set(logspec);
    }
    const frames = x.length / LOGSPEC_BANDS;
    const run = async (a: number, b: number) => {
      const out = await session.run({ spec: new ort.Tensor('float32', x.subarray(a * LOGSPEC_BANDS, b * LOGSPEC_BANDS), [1, 1, b - a, LOGSPEC_BANDS]) });
      return { data: out.logits.data as Float32Array, outputs: out.logits.dims[1], frames: out.logits.dims[2] };
    };
    if (frames <= chunkFrames + 2 * MARGIN_FRAMES) {
      const one = await run(0, frames);
      return new CnnLogits(one.data, one.outputs, one.frames);
    }
    const totalOut = Math.floor(frames / TIME_DOWNSAMPLE);
    let data: Float32Array | null = null;
    let outputs = 0;
    for (let s = 0; s < frames; s += chunkFrames) {
      const a = Math.max(0, s - MARGIN_FRAMES);
      const b = Math.min(frames, s + chunkFrames + MARGIN_FRAMES);
      const part = await run(a, b);
      if (!data) {
        outputs = part.outputs;
        data = new Float32Array(outputs * totalOut);
      }
      const g0 = s / TIME_DOWNSAMPLE;
      const g1 = Math.min(totalOut, (s + chunkFrames) / TIME_DOWNSAMPLE);
      const off = a / TIME_DOWNSAMPLE; // a and s are multiples of 4, so outputs line up with one whole pass
      for (let o = 0; o < outputs; o++) {
        data.set(part.data.subarray(o * part.frames + (g0 - off), o * part.frames + (g1 - off)), o * totalOut + g0);
      }
    }
    return new CnnLogits(data!, outputs, totalOut);
  }

  /** Log-probabilities over all (scale, tonic) pairs for input frames [start, stop). */
  logProbs(start = 0, stop?: number): Float64Array {
    const a = Math.floor(start / TIME_DOWNSAMPLE);
    const b = stop === undefined ? this.frames : Math.max(a + 1, Math.ceil(stop / TIME_DOWNSAMPLE));
    const hi = Math.min(b, this.frames);
    const mean = new Float64Array(this.outputs);
    for (let o = 0; o < this.outputs; o++) {
      // numpy's mean of a float32 slice: float32 sum (pairwise; plain sum is within ~1e-7 here)
      let acc = 0;
      for (let t = a; t < hi; t++) acc += this.data[o * this.frames + t];
      mean[o] = Math.fround(acc / Math.max(1, hi - a));
    }
    return logSoftmax(mean);
  }
}
