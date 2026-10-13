// Triangular log-frequency filterbank: FFT magnitudes -> 105 bins at 24 bins
// per octave from C2 (~65 Hz), the input the key CNN expects.

export const N_BINS = 105;
const F_MIN = 65.406; // C2
const BINS_PER_OCTAVE = 24;

export interface Filterbank {
  /** For each output band: [firstFftBin, weights...] */
  bands: { start: number; weights: Float32Array }[];
}

export function makeFilterbank(fftSize: number, sampleRate: number): Filterbank {
  const hz = (k: number) => F_MIN * 2 ** (k / BINS_PER_OCTAVE);
  const binHz = sampleRate / fftSize;
  const bands = [];
  for (let k = 0; k < N_BINS; k++) {
    const lo = hz(k - 1) / binHz;
    const mid = hz(k) / binHz;
    const hi = hz(k + 1) / binHz;
    // At low frequencies a band is narrower than one FFT bin; always cover at least the nearest bin.
    const start = Math.min(Math.floor(lo), Math.round(mid));
    const end = Math.max(Math.ceil(hi), Math.round(mid));
    const weights = new Float32Array(end - start + 1);
    for (let b = start; b <= end; b++) {
      const w = b <= mid ? (b - lo) / (mid - lo) : (hi - b) / (hi - mid);
      weights[b - start] = Math.max(0, w);
    }
    if (weights.every((w) => w === 0)) weights[Math.round(mid) - start] = 1;
    bands.push({ start, weights });
  }
  return { bands };
}

/** Writes log(1 + filtered magnitude) for one frame into `out` at `offset`. */
export function applyFilterbank(fb: Filterbank, mags: ArrayLike<number>, out: Float32Array, offset: number): void {
  for (let k = 0; k < N_BINS; k++) {
    const { start, weights } = fb.bands[k];
    let acc = 0;
    for (let i = 0; i < weights.length; i++) acc += weights[i] * (mags[start + i] ?? 0);
    out[offset + k] = Math.log1p(acc);
  }
}
