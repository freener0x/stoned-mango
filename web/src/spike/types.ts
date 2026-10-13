// Messages between the benchmark page and its analysis workers.

export interface AnalyseOptions {
  /** Essentia KeyExtractor profiles to run (each is a full pass over the audio). */
  profiles: string[];
  /** Run the per-frame loop: spectrum, peaks, 12- and 120-bin HPCP, tuning, CNN input. */
  frameLoop: boolean;
  /** Run the placeholder CNN on the frame loop's log-frequency spectrogram. */
  cnn: boolean;
}

export type ToWorker =
  | { type: 'init'; modelUrl: string }
  | { type: 'analyse'; id: number; name: string; pcm: Float32Array; sampleRate: number; opts: AnalyseOptions }
  | { type: 'golden'; inputUrl: string };

export interface KeyGuess {
  key: string;
  scale: string;
  strength: number;
}

export interface FileResult {
  id: number;
  name: string;
  durationS: number;
  decodeMs: number;
  keys: Record<string, KeyGuess>;
  keyExtractorMs: Record<string, number>;
  frameLoopMs: number;
  frames: number;
  hpcp12Mean: number[];
  tuningCents: number | null;
  cnnMs: number;
  cnnOutputShape: number[];
  totalWorkerMs: number;
  /** Size of the Essentia WASM heap after this file, in MB (grows, never shrinks). */
  essentiaHeapMB: number;
}

export type FromWorker =
  | { type: 'ready'; essentiaInitMs: number; ortInitMs: number; essentiaVersion: string }
  | { type: 'result'; result: Omit<FileResult, 'decodeMs'> }
  | { type: 'golden'; output: number[]; shape: number[]; ms: number }
  | { type: 'error'; id?: number; message: string };
