// Interface preferences: the only thing the app ever stores (PLAN.md section 2).
// They stay in this browser's localStorage; results, file names and audio are never saved.

import type { CodeRule, Notation, Spelling } from './notation.ts';

export type Skin = 'studio' | 'mango' | 'minimal';
export type TagFormat = 'standard' | 'camelot' | 'openkey';
/** When maqam, makam and raga-family scales are considered (engine/world.ts). */
export type Traditions = 'auto' | 'western' | 'all' | 'arabic' | 'turkish' | 'indian';

export interface Settings {
  skin: Skin;
  notation: Notation;
  codeRule: CodeRule;
  spelling: Spelling;
  /** 0 = automatic (sized to this device). */
  workers: number;
  batchLimit: number;
  traditions: Traditions;
  tagging: boolean;
  tagFormat: TagFormat;
  /** Also write the full result ("D Dorian") into a TXXX:KEY_MODE frame. */
  tagModeFrame: boolean;
}

export const DEFAULTS: Readonly<Settings> = Object.freeze({
  skin: 'studio',
  notation: 'name+camelot',
  codeRule: 'notes',
  spelling: 'key',
  workers: 0,
  batchLimit: 250,
  traditions: 'western', // 'auto' is safe but misses most real maqam/raga music (docs/phase8/REPORT.md §8)
  tagging: false,
  tagFormat: 'standard',
  tagModeFrame: true,
});

export const BATCH_LIMIT_MAX = 5000;
export const STORAGE_KEY = 'stoned-mango.settings';

const CHOICES: { [K in keyof Settings]?: readonly Settings[K][] } = {
  skin: ['studio', 'mango', 'minimal'],
  notation: ['name+camelot', 'name+openkey', 'name', 'camelot', 'openkey'],
  codeRule: ['notes', 'home'],
  spelling: ['key', 'sharps', 'flats'],
  tagFormat: ['standard', 'camelot', 'openkey'],
  traditions: ['auto', 'western', 'all', 'arabic', 'turkish', 'indian'],
};

/** Settings from stored JSON: unknown or invalid values fall back to the defaults. */
export function parseSettings(json: string | null): Settings {
  const out: Settings = { ...DEFAULTS };
  if (!json) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(CHOICES) as (keyof typeof CHOICES)[]) {
    if ((CHOICES[key] as readonly unknown[]).includes(r[key])) (out as unknown as Record<string, unknown>)[key] = r[key];
  }
  if (Number.isInteger(r.workers) && (r.workers as number) >= 0 && (r.workers as number) <= 8) out.workers = r.workers as number;
  if (Number.isInteger(r.batchLimit) && (r.batchLimit as number) >= 1) out.batchLimit = Math.min(BATCH_LIMIT_MAX, r.batchLimit as number);
  for (const key of ['tagging', 'tagModeFrame'] as const) if (typeof r[key] === 'boolean') out[key] = r[key];
  return out;
}

/** Only the values that differ from the defaults are stored. */
export function serialiseSettings(s: Settings): string {
  const diff: Partial<Record<keyof Settings, unknown>> = {};
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) if (s[key] !== DEFAULTS[key]) diff[key] = s[key];
  return JSON.stringify(diff);
}

// Storage can be missing or blocked (private windows, strict privacy settings): the app
// then simply forgets preferences when the tab closes.
export function loadSettings(): Settings {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    const text = serialiseSettings(s);
    if (text === '{}') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // not stored: fine
  }
}
