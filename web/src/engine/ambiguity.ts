// Honest ambiguity notes: say when the audio can't decide. Mirrors research/stoned_mango/ambiguity.py.

import { candidateLabel, type Candidate } from './engines.ts';
import { scale } from './scales.ts';

const QUIET = 0.15; // a note at < 15% of the loudest note's level counts as "barely played"
const RUNNER_UP = 0.25; // runners-up within this ratio of the best probability are considered (missing note)
const HOME_RUNNER_UP = 0.5; // stricter for home-note notes: same notes, different tonic
const ORDINAL: Record<number, string> = { 1: '2nd', 2: '2nd', 3: '3rd', 4: '3rd', 5: '4th', 6: '5th', 7: '5th', 8: '6th',
  9: '6th', 10: '7th', 11: '7th' };

export interface Ambiguity {
  kind: 'missing_note' | 'home_note' | 'same_notes' | 'close'; // the last two from tier 3 (world.ts)
  labels: [string, string];
  text: string;
}

const notes = (c: Candidate) => new Set(scale(c.scale).semitones.map((p) => (c.tonic + p) % 12));
const symDiff = (a: Set<number>, b: Set<number>) => [...a, ...b].filter((x) => !(a.has(x) && b.has(x)));
const sameSet = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));

function degreeWords(tonic: number, pcs: number[]): string {
  const words = [...new Set(pcs.map((p) => ORDINAL[(((p - tonic) % 12) + 12) % 12]))]
    .sort((a, b) => parseInt(a) - parseInt(b));
  if (words.length === 1) return `the ${words[0]} note is`;
  return `the ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]} notes are`;
}

/** An ambiguity note for the best candidate, or null when the answer is clear. */
export function ambiguity(cands: Candidate[], chroma: ArrayLike<number>, top = 12): Ambiguity | null {
  if (!cands.length) return null;
  const best = cands[0];
  const max = Math.max(...Array.from(chroma));
  const level = Array.from(chroma, (v) => (max > 0 ? v / max : v));
  const bestNotes = notes(best);
  const rest = cands.slice(1, top);

  const missing = rest.filter((c) => c.tonic === best.tonic && c.prob >= RUNNER_UP * best.prob
    && symDiff(bestNotes, notes(c)).every((p) => level[p] < QUIET));
  if (missing.length) {
    const alt = missing[0];
    const quiet = symDiff(bestNotes, notes(alt));
    return { kind: 'missing_note', labels: [candidateLabel(best), candidateLabel(alt)],
      text: `${candidateLabel(best)} or ${candidateLabel(alt)}: ${degreeWords(best.tonic, quiet)} barely played` };
  }
  const home = rest.filter((c) => c.tonic !== best.tonic && sameSet(notes(c), bestNotes) && c.prob >= HOME_RUNNER_UP * best.prob);
  if (home.length) {
    return { kind: 'home_note', labels: [candidateLabel(best), candidateLabel(home[0])],
      text: `Home note unclear: ${candidateLabel(best)} or ${candidateLabel(home[0])} (same notes)` };
  }
  return null;
}
