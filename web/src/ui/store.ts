// The batch: the files the user added, their analysis state and results, kept only in
// this tab's memory. Wraps the worker pool and gives React immutable snapshots, at most
// one every 50 ms however many progress messages the workers send.

import type { Result } from '../engine/analysis.ts';
import type { Envelope } from '../engine/envelope.ts';
import { AnalysisPool, type Job, type JobStatus } from '../engine/pool.ts';
import type { Picked } from './files.ts';

export interface TagState {
  state: 'writing' | 'done' | 'skipped' | 'error';
  message: string;
}

export interface Row {
  id: number;
  path: string;
  name: string;
  folder: string;
  size: number;
  status: JobStatus;
  progress: number;
  result?: Result;
  envelope?: Envelope;
  error?: string;
  method?: string;
  ms?: number;
  tag?: TagState;
}

export interface BatchInfo {
  total: number;
  finished: number;
  failed: number;
  running: number;
  progress: number;
  etaSeconds: number | null;
  paused: boolean;
  busy: boolean;
}

export interface StoreState {
  rows: Row[];
  batch: BatchInfo;
  engine: 'loading' | 'ready' | 'failed';
  engineError?: string;
  workers: number;
}

const FINISHED: JobStatus[] = ['done', 'error', 'cancelled'];

export class Store {
  readonly pool: AnalysisPool;
  private sources = new Map<number, Picked>();
  private rowCache = new Map<number, Row>();
  private tags = new Map<number, TagState>();
  private listeners = new Set<() => void>();
  private dirty = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private engine: StoreState['engine'] = 'loading';
  private engineError?: string;
  private state: StoreState;
  // the current batch: everything added since the pool was last idle
  private batchFirstId = 1;
  private activeMs = 0;
  private activeSince: number | null = null;

  constructor(pool: AnalysisPool) {
    this.pool = pool;
    this.state = this.build([]);
    pool.addEventListener('update', (e) => this.touch((e as CustomEvent<Job>).detail.id));
    pool.addEventListener('state', () => this.touch());
    pool.addEventListener('idle', () => {
      this.stopClock();
      this.touch();
    });
    pool.ready().then(() => {
      this.engine = 'ready';
      this.touch();
    }, (err: Error) => {
      this.engine = 'failed';
      this.engineError = err.message;
      this.touch();
    });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): StoreState => this.state;

  source(id: number): Picked | undefined {
    return this.sources.get(id);
  }

  job(id: number): Job | undefined {
    return this.pool.jobs.find((j) => j.id === id);
  }

  add(picked: Picked[]): Job[] {
    const startsBatch = this.pool.idle;
    const byFile = new Map(picked.map((p) => [p.file, p]));
    const jobs = this.pool.add(picked.map((p) => p.file));
    if (!jobs.length) return jobs;
    if (startsBatch) {
      this.batchFirstId = jobs[0].id;
      this.activeMs = 0;
      this.activeSince = null;
    }
    for (const j of jobs) this.sources.set(j.id, byFile.get(j.file)!);
    this.startClock();
    this.touch();
    return jobs;
  }

  /** For tests and scripts (window.stonedMango): analyse plain files and wait for all of them. */
  analyse(files: File[]): Promise<Job[]> {
    const jobs = this.add(files.map((file) => ({ file, path: file.webkitRelativePath || file.name })));
    return new Promise((resolve) => {
      const check = () => {
        if (jobs.every((j) => FINISHED.includes(j.status))) {
          this.pool.removeEventListener('update', check);
          resolve(jobs);
        }
      };
      this.pool.addEventListener('update', check);
      check();
    });
  }

  pause(): void {
    this.pool.pause();
    this.stopClock();
  }

  resume(): void {
    this.pool.resume();
    if (!this.pool.idle) this.startClock();
  }

  cancel(id?: number): void {
    this.pool.cancel(id);
  }

  /** Forget finished files and their results. */
  clear(): void {
    for (const j of this.pool.clear()) {
      this.sources.delete(j.id);
      this.rowCache.delete(j.id);
      this.tags.delete(j.id);
    }
    this.touch();
  }

  setTag(id: number, tag: TagState | undefined): void {
    if (tag) this.tags.set(id, tag);
    else this.tags.delete(id);
    this.touch(id);
  }

  /** After a file was rewritten in place, its old File object can't be read any more. */
  replaceFile(id: number, file: File): void {
    const job = this.job(id);
    const src = this.sources.get(id);
    if (job) job.file = file;
    if (src) src.file = file;
    this.touch(id);
  }

  private startClock(): void {
    if (this.activeSince === null && !this.pool.isPaused) this.activeSince = performance.now();
  }

  private stopClock(): void {
    if (this.activeSince !== null) {
      this.activeMs += performance.now() - this.activeSince;
      this.activeSince = null;
    }
  }

  private touch(id?: number): void {
    if (id !== undefined) this.dirty.add(id);
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), 50);
  }

  private flush(): void {
    this.timer = null;
    const changed = this.dirty.size > 0 || this.state.rows.length !== this.pool.jobs.length;
    for (const id of this.dirty) {
      const job = this.job(id);
      if (job) this.row(job);
    }
    this.dirty.clear();
    // The rows array is only replaced when a row changed, so the table doesn't re-render for batch-only updates.
    this.state = this.build(changed ? this.pool.jobs.map((j) => this.rowCache.get(j.id) ?? this.row(j)) : this.state.rows);
    for (const fn of this.listeners) fn();
  }

  private row(job: Job): Row {
    const path = this.sources.get(job.id)?.path ?? job.file.name;
    const cut = path.lastIndexOf('/');
    const row: Row = {
      id: job.id, path, name: path.slice(cut + 1), folder: cut > 0 ? path.slice(0, cut) : '', size: job.file.size,
      status: job.status, progress: job.progress, result: job.result, envelope: job.envelope, error: job.error,
      method: job.method, ms: job.ms, tag: this.tags.get(job.id),
    };
    this.rowCache.set(job.id, row);
    return row;
  }

  private build(rows: Row[]): StoreState {
    const batch = this.pool.jobs.filter((j) => j.id >= this.batchFirstId);
    let finished = 0, failed = 0, running = 0, units = 0;
    for (const j of batch) {
      if (FINISHED.includes(j.status)) {
        finished++;
        units++;
        if (j.status === 'error') failed++;
      } else if (j.status === 'running') {
        running++;
        units += j.progress;
      }
    }
    const busy = !this.pool.idle;
    const elapsed = this.activeMs + (this.activeSince !== null ? performance.now() - this.activeSince : 0);
    const remaining = batch.length - units;
    const etaSeconds = busy && units >= 0.3 && elapsed > 1500 ? (elapsed / units) * remaining / 1000 : null;
    return {
      rows,
      batch: { total: batch.length, finished, failed, running, progress: batch.length ? units / batch.length : 0, etaSeconds,
        paused: this.pool.isPaused, busy },
      engine: this.engine,
      engineError: this.engineError,
      workers: this.pool.size,
    };
  }
}
