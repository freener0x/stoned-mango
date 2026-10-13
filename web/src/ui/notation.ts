// Key names and DJ codes for the interface, the exports and the tags.
//
// Every result maps to one major or minor "mixing key", which gives its Camelot and
// Open Key codes. With the default rule ("same notes"), a mode gets the code of the
// major/minor key with the same notes, the one harmonic mixing needs:
//   A minor -> A minor 8A;  D Dorian -> C major 8B;  E Phrygian dominant -> A minor 8A
// With the "home note" rule, it gets the key with the same home note and third instead:
//   D Dorian -> D minor 7A
// Maqam, makam and raga-family scales (tier 3) have notes between the piano's keys, so they
// get the code of the nearest major/minor key, shown with "≈" (Maqam Bayati on D ≈ 7A, D minor).
// The tag written into files (TKEY) is always this same mixing key, so the code shown
// on screen is the code DJ software will show.

import { library, noteName, parentKey, scale } from '../engine/scales.ts';
import { nearestKey, tonicName, traditionOf } from '../engine/world.ts';

export type CodeRule = 'notes' | 'home';
export type Spelling = 'key' | 'sharps' | 'flats';

export interface MixKey {
  tonic: number;
  minor: boolean;
}

export interface KeyRef {
  tonic: number;
  scale: string;
  /** Tier 3: the home note in cents above C (it can sit on a quarter tone). */
  tonic_cents?: number;
}

/** A maqam, makam or raga-family scale: its code is only the nearest key's (≈). */
export const isApprox = (k: KeyRef) => scale(k.scale).tier === 3;
const tonicStep = (k: KeyRef) => (k.tonic_cents !== undefined ? Math.round(k.tonic_cents / 50) : 2 * mod12(k.tonic));

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PITCH: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

const mod12 = (x: number) => ((x % 12) + 12) % 12;
const pcs = (tonic: number, steps: number[]) => new Set(steps.map((p) => mod12(tonic + p)));
const differ = (a: Set<number>, b: Set<number>) => [...a].filter((x) => !b.has(x)).length + [...b].filter((x) => !a.has(x)).length;
const same = (a: MixKey, b: MixKey) => a.tonic === b.tonic && a.minor === b.minor;

/** The major or minor key with the same home note and third (D Dorian -> D minor). */
export function homeKey(k: KeyRef): MixKey {
  return { tonic: mod12(k.tonic), minor: scale(k.scale).third === 'minor' };
}

const CACHE = new Map<string, MixKey>();

/**
 * The major/minor key a result mixes as.
 * 'notes': among the 24 keys, those whose notes differ least from the scale's; of these,
 *   the home-note key if it is one, else the key of the scale this is a mode of (D Dorian ->
 *   C major, E Phrygian dominant -> A harmonic minor -> A minor), else the home-note key.
 * 'home': always the home-note key.
 */
export function mixKey(k: KeyRef, rule: CodeRule = 'notes'): MixKey {
  const id = `${mod12(k.tonic)}/${k.tonic_cents ?? ''}/${k.scale}/${rule}`;
  const hit = CACHE.get(id);
  if (hit) return hit;
  const home = homeKey(k);
  let out = home;
  if (rule === 'notes' && isApprox(k)) {
    out = nearestKey({ tonicStep: tonicStep(k), scale: k.scale, score: 0, prob: 0 });
  } else if (rule === 'notes') {
    const s = scale(k.scale);
    const notes = pcs(k.tonic, s.semitones);
    let best: MixKey[] = [];
    let fewest = Infinity;
    for (let t = 0; t < 12; t++) {
      for (const minor of [false, true]) {
        const d = differ(notes, pcs(t, minor ? MINOR : MAJOR));
        if (d < fewest) [fewest, best] = [d, []];
        if (d === fewest) best.push({ tonic: t, minor });
      }
    }
    const parent = parentKey(mod12(k.tonic), s);
    const viaParent = parent ? mixKey({ tonic: parent[0], scale: parent[1] }, rule) : null;
    out = best.find((m) => same(m, home)) ?? (viaParent && best.find((m) => same(m, viaParent))) ?? home;
  }
  CACHE.set(id, out);
  return out;
}

/** Camelot: C major 8B, A minor 8A. */
export function camelot(m: MixKey): string {
  const major = m.minor ? mod12(m.tonic + 3) : m.tonic;
  return `${mod12(7 * major + 7) + 1}${m.minor ? 'A' : 'B'}`;
}

/** Open Key: C major 1d, A minor 1m. */
export function openKey(m: MixKey): string {
  const major = m.minor ? mod12(m.tonic + 3) : m.tonic;
  return `${mod12(7 * major) + 1}${m.minor ? 'm' : 'd'}`;
}

/** Camelot order for sorting: 1A, 1B, 2A, ... 12B -> 0..23. */
export function camelotOrder(m: MixKey): number {
  const code = camelot(m);
  return (parseInt(code, 10) - 1) * 2 + (m.minor ? 0 : 1);
}

/** Keys that mix well in the Camelot sense: same code, one step around the wheel, or the relative key. */
export function compatible(a: MixKey, b: MixKey): boolean {
  const [na, nb] = [parseInt(camelot(a), 10), parseInt(camelot(b), 10)];
  if (a.minor === b.minor) return na === nb || mod12(na - nb) === 1 || mod12(nb - na) === 1;
  return na === nb;
}

export function spellNote(pc: number, spelling: Spelling, minor = false): string {
  pc = mod12(pc);
  if (spelling === 'sharps') return SHARPS[pc];
  if (spelling === 'flats') return FLATS[pc];
  return noteName(pc, scale(minor ? 'aeolian' : 'ionian'));
}

/** 'C major', 'F# minor' (ASCII sharps and flats). */
export function mixKeyName(m: MixKey, spelling: Spelling = 'key'): string {
  return `${spellNote(m.tonic, spelling, m.minor)} ${m.minor ? 'minor' : 'major'}`;
}

/** The ID3 TKEY form: 'C', 'F#m', 'Bbm'. */
export function standardKey(m: MixKey, spelling: Spelling = 'key'): string {
  return `${spellNote(m.tonic, spelling, m.minor)}${m.minor ? 'm' : ''}`;
}

/** Re-spell the note names in an engine label ("Gb major" -> "F# major" with sharps). */
export function respell(text: string, spelling: Spelling): string {
  if (spelling === 'key') return text;
  // ("B half-flat" keeps its letter: a quarter tone is named from the note above it)
  return text.replace(/(^|[\s(])([A-G](?:#|b)?)(?=[\s):,]|$)(?! half-flat)/g, (_, pre: string, note: string) =>
    `${pre}${spelling === 'sharps' ? SHARPS[PITCH[note]] : FLATS[PITCH[note]]}`);
}

/** Typographic sharps and flats for display: "F# minor" -> "F♯ minor". */
export function pretty(text: string): string {
  return text.replace(/(^|[\s(])([A-G])(#|b)(?=[\s):,]|$)/g, (_, pre: string, letter: string, acc: string) =>
    `${pre}${letter}${acc === '#' ? '♯' : '♭'}`);
}

export type Notation = 'name+camelot' | 'name+openkey' | 'name' | 'camelot' | 'openkey';

/** The code to show next to a key name for a notation setting (null for 'name'). */
export function codeFor(m: MixKey, notation: Notation): string | null {
  if (notation === 'name+camelot' || notation === 'camelot') return camelot(m);
  if (notation === 'name+openkey' || notation === 'openkey') return openKey(m);
  return null;
}

/** True when the mixing key isn't simply the label's own key (modes and other scales). */
export function showsMixKey(k: KeyRef, m: MixKey): boolean {
  if (isApprox(k)) return true;
  return !((k.scale === 'ionian' && !m.minor) || (k.scale === 'aeolian' && m.minor)) || m.tonic !== mod12(k.tonic);
}

let NAMES: Map<string, string> | null = null;

/** The key behind an engine label ("F# Dorian" -> F#, dorian), for labels that come without one (alternatives). */
export function parseLabel(text: string): KeyRef | null {
  if (!NAMES) NAMES = new Map([...library().values()].map((s) => [s.label ?? s.name, s.id]));
  const m = /^([A-G](?:#|b)?) (.+)$/.exec(text);
  const id = m && NAMES.get(m[2]);
  return m && id ? { tonic: PITCH[m[1]], scale: id } : null;
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL = [0, 2, 4, 5, 7, 9, 11];

/**
 * The notes of a scale, from its home note: "D Dorian" -> D E F G A B C. Seven-note scales use
 * each letter once (D harmonic minor -> D E F G A Bb C#), as on a score; other scales, or any
 * that would need a double sharp or flat, follow the key signature. With the "always sharps"
 * or "always flats" setting, every note is spelled that way.
 */
export function scaleNotes(k: KeyRef, spelling: Spelling = 'key'): string[] {
  if (isApprox(k)) return tier3Notes(k);
  const s = scale(k.scale);
  const tonic = mod12(k.tonic);
  const pcs = s.semitones.map((p) => mod12(tonic + p));
  if (spelling !== 'key') return pcs.map((pc) => (spelling === 'sharps' ? SHARPS : FLATS)[pc]);
  const home = noteName(tonic, s);
  if (pcs.length === 7) {
    const first = LETTERS.indexOf(home[0]);
    const lettered = pcs.map((pc, i) => {
      const letter = (first + i) % 7;
      const shift = ((pc - NATURAL[letter] + 18) % 12) - 6; // -6..5
      return Math.abs(shift) > 1 ? null : `${LETTERS[letter]}${shift === 1 ? '#' : shift === -1 ? 'b' : ''}`;
    });
    if (lettered.every((n) => n !== null)) return lettered as string[];
  }
  const acc = home.slice(1);
  const names = acc === 'b' ? FLATS : acc === '#' ? SHARPS : keySignatureNames(tonic, s.third === 'minor');
  return pcs.map((pc, i) => (i === 0 ? home : names[pc]));
}

function keySignatureNames(tonic: number, minor: boolean): string[] {
  const major = minor ? mod12(tonic + 3) : tonic;
  return [1, 3, 5, 6, 8, 10].includes(major) ? FLATS : SHARPS;
}

const NATURAL_CENTS = NATURAL.map((p) => p * 100);
// Accidentals, the plain ones first (they win ties): ½♭ is a quarter tone flat.
const ACCIDENTALS: [number, string][] = [[0, ''], [-100, '♭'], [100, '♯'], [-50, '½♭'], [50, '½♯']];

/**
 * A maqam, makam or raga-family scale's notes, ready to display: one letter per degree, with
 * quarter-tone accidentals and the cents left over when a note sits 5+ cents off them
 * ("E½♭", "F♯−14¢" for a just-intonation third). Spelled from the home note's letter when that
 * works, else from the letter needing the fewest accidentals; the spelling setting doesn't apply.
 */
export function tier3Notes(k: KeyRef): string[] {
  const s = scale(k.scale);
  const home = (k.tonic_cents ?? 100 * mod12(k.tonic)) % 1200;
  const spell = (first: number) => {
    let cost = 0;
    const out: string[] = [];
    for (const [i, c] of s.cents.entries()) {
      const letter = (first + i) % 7; // all tier 3 scales have seven notes
      const diff = (((home + c - NATURAL_CENTS[letter]) % 1200) + 1800) % 1200 - 600;
      let [acc, sym] = ACCIDENTALS[0];
      for (const [a, y] of ACCIDENTALS) if (Math.abs(diff - a) < Math.abs(diff - acc)) [acc, sym] = [a, y];
      const rest = Math.round(diff - acc);
      if (Math.abs(rest) > 25) return null;
      cost += Math.abs(acc);
      out.push(`${LETTERS[letter]}${sym}${Math.abs(rest) >= 5 ? `${rest > 0 ? '+' : '−'}${Math.abs(rest)}¢` : ''}`);
    }
    return { out, cost };
  };
  const named = LETTERS.indexOf(tonicName(Math.round(home / 50), traditionOf(k.scale) ?? '')[0]);
  let best = spell(named);
  for (let l = 0; l < 7 && !best; l++) {
    const t = spell(l);
    // the letter needing the fewest accidentals (C# Kalyan would need F double-sharp: Db instead)
    for (let m = l + 1; t && m < 7; m++) {
      const u = spell(m);
      if (u && u.cost < t.cost) Object.assign(t, u);
    }
    best = t;
  }
  return best?.out ?? [];
}
