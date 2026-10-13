// Streaming pitch features (PLAN.md stages [2] and [4]).
// Mirrors research/stoned_mango/features.py; the four spectral steps are Essentia's
// (same C++ core as the Python bindings), everything else is ported line for line.

import { Resampler } from './audio.ts';

export const FRAME_SIZE = 4096; // ~186 ms at 22.05 kHz
export const HOP_SIZE = 2048;
export const HPCP_BINS = 120; // 10 cents per bin
export const BINS_PER_SEMITONE = HPCP_BINS / 12;
export const SILENCE_RMS = 1e-3; // about -60 dBFS
export const LOGSPEC_BANDS = 105;
export const LOGSPEC_FMIN = 65.406; // C2
export const LOGSPEC_BANDS_PER_OCTAVE = 24;

/** An Essentia.js instance (essentia.js-core); the engine needs only a few of its algorithms. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Essentia = any;

/** [105 x (fftSize/2+1)] triangular filters centred 1/24 octave apart from C2, as rows of [start, weights]. */
export function logFilterbank(fftSize: number, sampleRate: number): { start: number; weights: Float64Array }[] {
  const nBins = fftSize / 2 + 1;
  const binHz = sampleRate / fftSize;
  const bands = [];
  for (let k = 0; k < LOGSPEC_BANDS; k++) {
    const [lo, mid, hi] = [-1, 0, 1].map((d) => (LOGSPEC_FMIN * 2 ** ((k + d) / LOGSPEC_BANDS_PER_OCTAVE)) / binHz);
    // A band narrower than one FFT bin still covers the nearest bin, so no band is empty.
    const start = Math.min(Math.floor(lo), Math.round(mid));
    const end = Math.max(Math.ceil(hi), Math.round(mid));
    const weights = new Float64Array(end - start + 1);
    for (let b = start; b <= end; b++) {
      const w = b <= mid ? (b - lo) / (mid - lo) : (hi - b) / (hi - mid);
      if (b >= 0 && b < nBins) weights[b - start] = Math.max(0, w);
    }
    if (weights.every((w) => w === 0)) weights[Math.round(mid) - start] = 1;
    bands.push({ start, weights });
  }
  return bands;
}

/** out[i] = v[i - shift] with linear interpolation, circularly. */
function circularShift(v: Float64Array, shift: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (((i - shift) % n) + n) % n;
    const lo = Math.floor(pos);
    const frac = pos - lo;
    out[i] = (1 - frac) * v[lo % n] + frac * v[(lo + 1) % n];
  }
  return out;
}

export class Features {
  readonly sampleRate: number;
  readonly hopSeconds: number;
  readonly duration: number;
  readonly hpcp: Float32Array; // [frames * 120], A-based, reference 440 Hz
  readonly bass: Float32Array; // [frames * 120]
  readonly rms: Float32Array; // [frames]
  readonly logspec: Float32Array; // [frames * 105]
  readonly tuningCents: number; // in (-50, 50]
  readonly tuningConfidence: number;

  constructor(sampleRate: number, hopSeconds: number, duration: number, hpcp: Float32Array, bass: Float32Array, rms: Float32Array, logspec: Float32Array, tuningCents: number, tuningConfidence: number) {
    this.sampleRate = sampleRate;
    this.hopSeconds = hopSeconds;
    this.duration = duration;
    this.hpcp = hpcp;
    this.bass = bass;
    this.rms = rms;
    this.logspec = logspec;
    this.tuningCents = tuningCents;
    this.tuningConfidence = tuningConfidence;
  }

  get frames(): number {
    return this.rms.length;
  }

  /** Indices of non-silent frames in [start, stop). */
  voiced(start = 0, stop?: number): number[] {
    const end = stop === undefined ? this.frames : Math.min(stop, this.frames);
    const out = [];
    for (let i = start; i < end; i++) if (this.rms[i] > SILENCE_RMS) out.push(i);
    return out;
  }

  /** Mean 120-bin profile over voiced frames, rotated so bin 0 is C at the recording's tuning. */
  profile120(bass = false, start = 0, stop?: number): Float64Array {
    const src = bass ? this.bass : this.hpcp;
    const idx = this.voiced(start, stop);
    const mean = new Float64Array(HPCP_BINS);
    if (idx.length === 0) return mean;
    // Sum in float32, like numpy's mean over a float32 array, then cast.
    const acc = new Float32Array(HPCP_BINS);
    for (const i of idx) for (let b = 0; b < HPCP_BINS; b++) acc[b] += src[i * HPCP_BINS + b];
    for (let b = 0; b < HPCP_BINS; b++) mean[b] = Math.fround(acc[b] / idx.length);
    const shifted = circularShift(mean, -this.tuningCents / 10);
    const out = new Float64Array(HPCP_BINS);
    const r = 3 * BINS_PER_SEMITONE; // move bin 0 from A to C
    for (let i = 0; i < HPCP_BINS; i++) out[i] = shifted[(i + r) % HPCP_BINS];
    return out;
  }

  /** 12-bin chroma, C first, tuned: each semitone gathers the bins within +/-50 cents. */
  chroma(bass = false, start = 0, stop?: number): Float64Array {
    const p = this.profile120(bass, start, stop);
    const out = new Float64Array(12);
    const half = BINS_PER_SEMITONE / 2;
    for (let s = 0; s < 12; s++) {
      let acc = 0;
      for (let d = -half; d <= half; d++) {
        const w = Math.abs(d) === half ? 0.5 : 1;
        acc += w * p[(((d + s * BINS_PER_SEMITONE) % HPCP_BINS) + HPCP_BINS) % HPCP_BINS];
      }
      out[s] = acc;
    }
    return out;
  }

  /** Rows [a, b) of the log-spectrogram. */
  logspecRows(a = 0, b = this.frames): Float32Array {
    return this.logspec.subarray(a * LOGSPEC_BANDS, b * LOGSPEC_BANDS);
  }
}

/** An append-only float32 buffer that doubles as it grows (4 bytes a value, not 8). */
class Grow {
  private data = new Float32Array(4096);
  length = 0;

  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }

  take(): Float32Array {
    return this.data.slice(0, this.length);
  }
}

/** Feed mono chunks at ``inputRate`` with push(); call finish() for the Features. */
export class FeatureExtractor {
  readonly sampleRate: number;
  private resampler: Resampler;
  private buf = new Float32Array(0);
  private framesEmitted = 0;
  private samplesIn = 0;
  private hpcp = new Grow();
  private bassHpcp = new Grow();
  private rms = new Grow();
  private logspec = new Grow();
  private filterbank: { start: number; weights: Float64Array }[];
  private tuningRe = 0;
  private tuningIm = 0;
  private tuningWeight = 0;

  private essentia: Essentia;

  constructor(essentia: Essentia, inputRate: number) {
    this.essentia = essentia;
    this.resampler = new Resampler(inputRate);
    this.sampleRate = this.resampler.outputRate;
    this.filterbank = logFilterbank(FRAME_SIZE, this.sampleRate).map(({ start, weights }) => ({
      start, weights: Float64Array.from(weights, Math.fround), // the Python filterbank is float32
    }));
  }

  push(chunk: Float32Array): void {
    const x = this.resampler.push(chunk);
    this.samplesIn += x.length;
    const merged = new Float32Array(this.buf.length + x.length);
    merged.set(this.buf);
    merged.set(x, this.buf.length);
    let off = 0;
    while (merged.length - off >= FRAME_SIZE) {
      this.frame(merged.subarray(off, off + FRAME_SIZE));
      off += HOP_SIZE;
    }
    this.buf = merged.slice(off);
  }

  finish(): Features {
    // One last zero-padded frame if the tail holds samples no frame has seen yet.
    const unseen = this.buf.length - (this.framesEmitted ? FRAME_SIZE - HOP_SIZE : 0);
    if (unseen > 0) {
      const last = new Float32Array(FRAME_SIZE);
      last.set(this.buf);
      this.frame(last);
    }
    this.buf = new Float32Array(0);
    let tuning = 0;
    let confidence = 0;
    if (this.tuningWeight > 0) {
      tuning = (Math.atan2(this.tuningIm, this.tuningRe) * 100) / (2 * Math.PI);
      confidence = Math.hypot(this.tuningRe, this.tuningIm) / this.tuningWeight;
    }
    return new Features(
      this.sampleRate,
      HOP_SIZE / this.sampleRate,
      this.samplesIn / this.sampleRate,
      this.hpcp.take(),
      this.bassHpcp.take(),
      this.rms.take(),
      this.logspec.take(),
      tuning > -50 ? tuning : tuning + 100,
      confidence,
    );
  }

  private frame(frame: Float32Array): void {
    const e = this.essentia;
    this.framesEmitted++;
    let sq = 0;
    for (let i = 0; i < frame.length; i++) sq += frame[i] * frame[i];
    this.rms.push(Math.sqrt(sq / frame.length));

    const vFrame = e.arrayToVector(frame);
    const windowed = e.Windowing(vFrame, true, FRAME_SIZE, 'blackmanharris62', 0, true).frame;
    const vSpectrum = e.Spectrum(windowed, FRAME_SIZE).spectrum;
    const spectrum: Float32Array = e.vectorToArray(vSpectrum);
    for (const { start, weights } of this.filterbank) {
      let acc = 0;
      for (let i = 0; i < weights.length; i++) acc += weights[i] * (spectrum[start + i] ?? 0);
      this.logspec.push(Math.log1p(Math.fround(acc)));
    }

    const peaks = e.SpectralPeaks(vSpectrum, 1e-5, 5000, 100, 30, 'magnitude', this.sampleRate);
    // vectorToArray throws on an empty vector (a silent frame has no peaks).
    const nPeaks: number = peaks.frequencies.size();
    const freqs: Float32Array = nPeaks ? e.vectorToArray(peaks.frequencies) : new Float32Array(0);
    const mags: Float32Array = nPeaks ? e.vectorToArray(peaks.magnitudes) : new Float32Array(0);
    const sr = this.sampleRate;
    // bandPreset, bandSplitFrequency, harmonics, maxFrequency, maxShifted, minFrequency, nonLinear,
    // normalized, referenceFrequency, sampleRate, size, weightType, windowSize
    // A silent frame has no peaks: Python's HPCP then returns zeros, Essentia.js throws instead.
    const full = freqs.length ? e.HPCP(peaks.frequencies, peaks.magnitudes, true, 500, 0, 5000, false, 40, false, 'unitMax',
      440, sr, HPCP_BINS, 'squaredCosine', 0.5).hpcp : null;
    if (full) for (const v of e.vectorToArray(full) as Float32Array) this.hpcp.push(v);
    else for (let b = 0; b < HPCP_BINS; b++) this.hpcp.push(0);

    const low: number[] = [];
    for (let i = 0; i < freqs.length; i++) if (freqs[i] <= 250) low.push(i);
    if (low.length) {
      const lf = e.arrayToVector(Float32Array.from(low, (i) => freqs[i]));
      const lm = e.arrayToVector(Float32Array.from(low, (i) => mags[i]));
      const bassV = e.HPCP(lf, lm, false, 500, 0, 250, false, 30, false, 'unitMax', 440, sr, HPCP_BINS,
        'squaredCosine', 0.5).hpcp;
      for (const v of e.vectorToArray(bassV) as Float32Array) this.bassHpcp.push(v);
      for (const v of [lf, lm, bassV]) v.delete();
    } else {
      for (let b = 0; b < HPCP_BINS; b++) this.bassHpcp.push(0);
    }

    // Tuning: each peak's offset from the nearest semitone as a point on a circle.
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] < 80 || freqs[i] > 2000) continue;
      const cents = Math.fround(1200 * Math.fround(Math.log2(Math.fround(freqs[i] / 440))));
      const angle = (2 * Math.PI * cents) / 100;
      this.tuningRe += mags[i] * Math.cos(angle);
      this.tuningIm += mags[i] * Math.sin(angle);
      this.tuningWeight += mags[i];
    }
    // Embind vectors live on the WASM heap and are not garbage-collected.
    for (const v of [vFrame, windowed, vSpectrum, peaks.frequencies, peaks.magnitudes, full]) v?.delete();
  }
}
