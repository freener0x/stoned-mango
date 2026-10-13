// The scale library (shared/scales.json) and human-readable names.
// Mirrors research/stoned_mango/scales.py.

import doc from '../../../shared/scales.json' with { type: 'json' };

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// Flat-side tonics are spelled with flats, the rest with sharps (F# minor, but Gb major).
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_MAJOR_TONICS = new Set([1, 3, 5, 6, 8, 10]);

export interface Scale {
  id: string;
  name: string;
  family: string;
  tier: number;
  cents: number[];
  label: string | null;
  modeOf: [string, number] | null;
  aliases: string[];
  /** Pitch classes relative to the tonic (tiers 1-2 are all on the 12-tone grid). */
  semitones: number[];
  /** 'major' or 'minor', for scoring against major/minor-only datasets. */
  third: 'major' | 'minor';
}

interface RawScale {
  id: string;
  name: string;
  family: string;
  tier: number;
  cents: number[];
  label?: string;
  mode_of?: { scale: string; degree: number };
  aliases?: string[];
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Python's round(): halves to the even neighbour (tier 3 cents such as 450 must round like the research code). */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}

function build(s: RawScale): Scale {
  const semitones = [...new Set(s.cents.map((c) => mod(roundHalfEven(c / 100), 12)))].sort((a, b) => a - b);
  const has = (pc: number) => semitones.includes(pc);
  const third = has(4) && !has(3) ? 'major' : has(3) && !has(4) ? 'minor' : s.id === 'major_blues' ? 'major' : 'minor';
  return {
    id: s.id, name: s.name, family: s.family, tier: s.tier, cents: s.cents, label: s.label ?? null,
    modeOf: s.mode_of ? [s.mode_of.scale, s.mode_of.degree] : null, aliases: s.aliases ?? [], semitones, third,
  };
}

const LIBRARY: Map<string, Scale> = new Map((doc.scales as RawScale[]).map((s) => [s.id, build(s)]));

export function library(): Map<string, Scale> {
  return LIBRARY;
}

export function scale(id: string): Scale {
  const s = LIBRARY.get(id);
  if (!s) throw new Error(`unknown scale ${id}`);
  return s;
}

/** Tier 1-2 scale ids in library order: the CNN's and the fusion's output layout (index scale * 12 + tonic). */
export function scaleIds(maxTier = 2): string[] {
  return [...LIBRARY.values()].filter((s) => s.tier <= maxTier).map((s) => s.id);
}

/** For a mode, the tonic and id of the scale it is a rotation of (D Dorian -> C Ionian). */
export function parentKey(tonic: number, s: Scale): [number, string] | null {
  if (!s.modeOf) return null;
  const parent = scale(s.modeOf[0]);
  const offset = Math.round(parent.cents[s.modeOf[1] - 1] / 100);
  return [mod(tonic - offset, 12), parent.id];
}

/** Spell a tonic by key-signature convention for the scale's parent major key. */
export function noteName(pc: number, s?: Scale): string {
  pc = mod(pc, 12);
  if (!s) return NOTE_NAMES[pc];
  const parent = parentKey(pc, s);
  const refMajor = parent && scale(parent[1]).id === 'ionian' ? parent[0] : s.third === 'major' ? pc : mod(pc + 3, 12);
  return (FLAT_MAJOR_TONICS.has(refMajor) ? FLAT : SHARP)[pc];
}

/** 'C major', 'A minor', 'D Dorian', 'E Phrygian dominant'. */
export function label(tonic: number, scaleId: string): string {
  const s = scale(scaleId);
  return `${noteName(tonic, s)} ${s.label ?? s.name}`;
}

/** 'same notes as C major' / '5th mode of A harmonic minor', or null for parent scales. */
export function parentLabel(tonic: number, scaleId: string): string | null {
  const s = scale(scaleId);
  const parent = parentKey(tonic, s);
  if (!parent) return null;
  const [ptonic, pid] = parent;
  const degree = s.modeOf![1];
  if (pid === 'ionian') return `same notes as ${label(ptonic, pid)}`;
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[degree] ?? 'th';
  return `${degree}${suffix} mode of ${label(ptonic, pid)}`;
}
