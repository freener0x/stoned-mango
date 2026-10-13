// Streaming resampling: halve the rate until it is at most 32 kHz.
// Mirrors research/stoned_mango/audio.py (Decimator, Resampler), sample for sample.

export const MAX_ANALYSIS_RATE = 32000;

/** Hamming-windowed sinc low-pass at 0.45x the output Nyquist, for decimation by 2. */
export function halfbandTaps(nTaps = 63): Float64Array {
  const m = (nTaps - 1) / 2;
  const fc = 0.225; // cycles per input sample; output Nyquist is 0.25
  const h = new Float64Array(nTaps);
  let sum = 0;
  for (let i = 0; i < nTaps; i++) {
    const k = i - m;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * 2 * fc * k) / (Math.PI * 2 * fc * k);
    h[i] = 2 * fc * sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (nTaps - 1)));
    sum += h[i];
  }
  for (let i = 0; i < nTaps; i++) h[i] /= sum;
  return h;
}

/** Low-pass and keep every other sample, across chunk boundaries. */
export class Decimator {
  private taps: Float64Array;
  private history: Float64Array;
  private position = 0; // absolute index of the next input sample

  constructor(nTaps = 63) {
    this.taps = halfbandTaps(nTaps);
    this.history = new Float64Array(nTaps - 1);
  }

  push(x: Float32Array): Float32Array {
    if (x.length === 0) return new Float32Array(0);
    const n = this.taps.length;
    const ext = new Float64Array(this.history.length + x.length);
    ext.set(this.history);
    ext.set(x, this.history.length);
    // One filtered value per input sample; keep those at even absolute indices.
    const firstEven = this.position % 2;
    const count = Math.max(0, Math.ceil((x.length - firstEven) / 2));
    const out = new Float32Array(count);
    for (let j = 0, i = firstEven; i < x.length; i += 2, j++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += ext[i + k] * this.taps[n - 1 - k];
      out[j] = acc;
    }
    this.history = ext.slice(ext.length - (n - 1));
    this.position += x.length;
    return out;
  }
}

/** Chains decimators until the rate is at most MAX_ANALYSIS_RATE (44.1k -> 22.05k, 96k -> 24k). */
export class Resampler {
  readonly outputRate: number;
  private stages: Decimator[] = [];

  constructor(inputRate: number) {
    let rate = inputRate;
    while (rate > MAX_ANALYSIS_RATE) {
      this.stages.push(new Decimator());
      rate = Math.floor(rate / 2);
    }
    this.outputRate = rate;
  }

  push(x: Float32Array): Float32Array {
    for (const s of this.stages) x = s.push(x);
    return x;
  }
}
