// Adaptive worker pool (PLAN.md section 5): as many analysis workers as the device
// can usefully run, a queue of files, pause/resume/cancel, and the main-thread
// decode fallback for formats the workers can't stream.

import { decodeWhole } from './decode.ts';
import type { AnalysisOptions, Result } from './analysis.ts';
import type { Envelope } from './envelope.ts';
import type { FromWorker, ToWorker } from './worker.ts';

export const AUDIO_EXTENSIONS = ['.wav', '.wave', '.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.aif', '.aiff', '.webm'];
export const MAX_WORKERS = 8;
/** How long a worker gets to stop after Cancel before it's replaced (one stuck in a computation never reads the message). */
export const CANCEL_GRACE_MS = 3000;

/** clamp(floor(cores / 2), 1, 4); at most 2 with <= 4 GB of memory, 1 with <= 2 GB (phase 0 measurements). */
export function defaultWorkerCount(nav: { hardwareConcurrency?: number; deviceMemory?: number } = navigator): number {
  let n = Math.min(4, Math.max(1, Math.floor((nav.hardwareConcurrency ?? 2) / 2)));
  const mem = nav.deviceMemory;
  if (mem !== undefined && mem <= 4) n = Math.min(n, 2);
  if (mem !== undefined && mem <= 2) n = 1;
  return n;
}

export const isAudioFile = (name: string) => AUDIO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface Job {
  id: number;
  file: File;
  status: JobStatus;
  progress: number; // 0..1
  result?: Result;
  envelope?: Envelope; // loudness over time, for the timeline view
  error?: string;
  method?: string; // how it was decoded
  ms?: number;
  options?: AnalysisOptions; // as the analysis started
}

interface Slot {
  worker: Worker;
  job: Job | null;
  ready: boolean;
  retiring: boolean; // leaves the pool once its current job is done
}

export class AnalysisPool extends EventTarget {
  readonly jobs: Job[] = [];
  private slots: Slot[] = [];
  private nextId = 1;
  private paused = false;
  private readonly modelUrl: string;
  private readyPromise: Promise<void>;
  /** Analysis options for files started from now on (the traditions setting). */
  options: AnalysisOptions = {};
  /** Main-thread decodes run one at a time: each holds a whole decoded file in memory. */
  private decoding: Promise<unknown> = Promise.resolve();

  constructor(opts: { workers?: number; modelUrl?: string } = {}) {
    super();
    this.modelUrl = opts.modelUrl ?? new URL(`${import.meta.env.BASE_URL}models/key-cnn.fp32.onnx`, location.href).href;
    this.readyPromise = this.grow(opts.workers ?? defaultWorkerCount()).then(() => this.pump());
  }

  /** Resolves once the first workers have loaded Essentia and the model (after that, nothing is fetched). */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** The number of workers (not counting ones about to leave after a resize). */
  get size(): number {
    return this.slots.filter((s) => !s.retiring).length;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  add(files: File[]): Job[] {
    const added = files.filter((f) => isAudioFile(f.name)).map((file): Job => ({ id: this.nextId++, file, status: 'queued', progress: 0 }));
    this.jobs.push(...added);
    for (const j of added) this.emit(j);
    this.pump();
    return added;
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event('state'));
  }

  resume(): void {
    this.paused = false;
    this.dispatchEvent(new Event('state'));
    this.pump();
  }

  /** Cancel one job, or everything not yet finished. */
  cancel(id?: number): void {
    for (const job of this.jobs) {
      if (id !== undefined && job.id !== id) continue;
      if (job.status === 'queued') this.finish(job, { status: 'cancelled' });
      else if (job.status === 'running') {
        const slot = this.slots.find((s) => s.job === job);
        if (!slot) continue;
        slot.worker.postMessage({ type: 'cancel', id: job.id } satisfies ToWorker);
        setTimeout(() => {
          if (slot.job === job && this.slots.includes(slot)) this.replace(slot, { status: 'cancelled' });
        }, CANCEL_GRACE_MS);
      }
    }
  }

  /** Forget finished jobs (their results and files); returns them. */
  clear(): Job[] {
    const removed = this.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
    const keep = this.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    this.jobs.splice(0, this.jobs.length, ...keep);
    return removed;
  }

  /** Change the number of workers. Busy workers finish their current file before they leave. */
  resize(n: number): void {
    n = Math.max(1, Math.min(MAX_WORKERS, Math.round(n)));
    const active = this.slots.filter((s) => !s.retiring);
    if (n > active.length) {
      this.grow(n - active.length).catch((err) => this.dispatchEvent(new CustomEvent('error', { detail: err })));
    } else if (n < active.length) {
      const leaving = [...active.filter((s) => !s.job), ...active.filter((s) => s.job)].slice(0, active.length - n);
      for (const s of leaving) {
        s.retiring = true;
        if (!s.job) this.remove(s);
      }
    }
    this.dispatchEvent(new Event('state'));
  }

  terminate(): void {
    for (const s of this.slots) s.worker.terminate();
    this.slots = [];
  }

  get idle(): boolean {
    return this.jobs.every((j) => j.status !== 'queued' && j.status !== 'running');
  }

  private grow(n: number): Promise<void> {
    return Promise.all(Array.from({ length: n }, () => this.start())).then(() => undefined);
  }

  private start(): Promise<void> {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = { worker, job: null, ready: false, retiring: false };
    this.slots.push(slot);
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        if (e.data.type === 'ready') {
          slot.ready = true;
          worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(slot, ev.data);
          worker.onerror = (ev) => this.onCrash(slot, ev.message);
          resolve();
          this.dispatchEvent(new Event('state'));
          this.pump();
        } else if (e.data.type === 'error') {
          this.remove(slot);
          reject(new Error(e.data.message));
        }
      };
      worker.onerror = (e) => {
        this.remove(slot);
        reject(new Error(e.message || 'the analysis engine failed to start'));
      };
      worker.postMessage({ type: 'init', modelUrl: this.modelUrl } satisfies ToWorker);
    });
  }

  private pump(): void {
    if (this.paused) return;
    for (const slot of this.slots) {
      if (slot.job || !slot.ready || slot.retiring) continue;
      const job = this.jobs.find((j) => j.status === 'queued');
      if (!job) break;
      slot.job = job;
      job.status = 'running';
      job.options = { ...this.options };
      this.emit(job);
      slot.worker.postMessage({ type: 'analyse', id: job.id, file: job.file, options: job.options } satisfies ToWorker);
    }
  }

  private async onMessage(slot: Slot, msg: FromWorker): Promise<void> {
    const job = slot.job;
    if (!job || !('id' in msg) || msg.id !== job.id) return;
    if (msg.type === 'progress') {
      job.progress = msg.fraction;
      this.emit(job);
    } else if (msg.type === 'result') {
      this.release(slot, job, { status: 'done', progress: 1, result: msg.result, envelope: msg.envelope, ms: msg.ms, method: msg.method });
    } else if (msg.type === 'error') {
      this.release(slot, job, msg.cancelled ? { status: 'cancelled' } : { status: 'error', error: msg.message });
    } else if (msg.type === 'needsMainDecode') {
      const current = () => job.status === 'running' && slot.job === job && this.slots.includes(slot);
      try {
        const decoded = this.decoding.then(() => (current() ? decodeWhole(job.file) : null));
        this.decoding = decoded.catch(() => undefined);
        const pcm = await decoded;
        if (!pcm || !current()) return; // cancelled meanwhile
        const { samples, sampleRate } = pcm;
        slot.worker.postMessage({ type: 'analysePcm', id: job.id, samples, sampleRate, options: job.options } satisfies ToWorker, [samples.buffer]);
      } catch (err) {
        if (current()) this.release(slot, job, { status: 'error', error: `can't decode this file: ${(err as Error).message ?? err}` });
      }
    }
  }

  /** A worker died (for example out of memory): fail its file and start a fresh worker. */
  private onCrash(slot: Slot, message: string): void {
    this.replace(slot, { status: 'error', error: `the analysis stopped unexpectedly${message ? ` (${message})` : ''}` });
  }

  /** Stops a worker, finishes its file with ``patch`` and starts a fresh worker in its place. */
  private replace(slot: Slot, patch: Partial<Job>): void {
    const job = slot.job;
    const fresh = !slot.retiring;
    this.remove(slot);
    if (job) this.finish(job, patch);
    if (fresh) this.grow(1).catch((err) => this.dispatchEvent(new CustomEvent('error', { detail: err })));
  }

  private remove(slot: Slot): void {
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
    this.dispatchEvent(new Event('state'));
  }

  private release(slot: Slot, job: Job, patch: Partial<Job>): void {
    slot.job = null;
    if (slot.retiring) this.remove(slot);
    this.finish(job, patch);
    this.pump();
  }

  private finish(job: Job, patch: Partial<Job>): void {
    Object.assign(job, patch);
    this.emit(job);
    if (this.idle) this.dispatchEvent(new Event('idle'));
  }

  private emit(job: Job): void {
    this.dispatchEvent(new CustomEvent<Job>('update', { detail: job }));
  }
}
