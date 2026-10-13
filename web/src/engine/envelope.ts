// A song's loudness over time, for drawing the timeline (the UI's waveform stand-in).
// Made in the worker from the features' per-frame RMS, so the main thread never needs
// the audio itself.

export interface Envelope {
  /** Seconds per value. */
  step: number;
  /** Peak RMS per step (linear, 0..1). */
  values: Float32Array;
}

/** At most ``points`` values: the loudest frame of each group of frames. */
export function envelope(rms: ArrayLike<number>, hopSeconds: number, points = 1500): Envelope {
  const per = Math.max(1, Math.ceil(rms.length / points));
  const values = new Float32Array(Math.ceil(rms.length / per));
  for (let i = 0; i < values.length; i++) {
    let peak = 0;
    for (let j = i * per; j < Math.min(rms.length, (i + 1) * per); j++) peak = Math.max(peak, rms[j]);
    values[i] = peak;
  }
  return { step: per * hopSeconds, values };
}

/** RMS -> 0..1 on a decibel scale (0 at ``floorDb``, 1 at full scale). */
export function loudness(rms: number, floorDb = -60): number {
  const db = 20 * Math.log10(Math.max(rms, 1e-9));
  return Math.min(1, Math.max(0, (db - floorDb) / -floorDb));
}
