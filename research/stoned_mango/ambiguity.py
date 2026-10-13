"""Honest ambiguity notes (PLAN.md section 1): say when the audio can't decide.

Two cases, checked against the best answer's close runners-up:

* **Missing note**: same tonic, a scale that differs only in notes the song barely
  plays. "A minor or A Dorian: the 6th note is barely played."
* **Home note**: the same notes with a different tonic, nearly as likely.
  "Home note unclear: C major or A minor (same notes)."
"""

from __future__ import annotations

import numpy as np

from .engines import Candidate
from .scales import library

QUIET = 0.15  # a note at < 15% of the loudest note's level counts as "barely played"
RUNNER_UP = 0.25  # runners-up within this ratio of the best probability are considered (missing note)
HOME_RUNNER_UP = 0.5  # stricter for home-note notes: same notes, different tonic
_ORDINAL = {1: "2nd", 2: "2nd", 3: "3rd", 4: "3rd", 5: "4th", 6: "5th", 7: "5th", 8: "6th", 9: "6th", 10: "7th", 11: "7th"}


def _notes(c: Candidate) -> frozenset[int]:
    return frozenset((c.tonic + p) % 12 for p in library()[c.scale].semitones)


def _degree_words(tonic: int, pcs: set[int]) -> str:
    words = sorted({_ORDINAL[(p - tonic) % 12] for p in pcs}, key=lambda w: int(w[:-2]))
    if len(words) == 1:
        return f"the {words[0]} note is"
    return "the " + ", ".join(words[:-1]) + f" and {words[-1]} notes are"


def ambiguity(cands: list[Candidate], chroma: np.ndarray, top: int = 12) -> dict | None:
    """An ambiguity note for the best candidate, or None when the answer is clear."""
    if not cands:
        return None
    best = cands[0]
    level = np.asarray(chroma, float)
    level = level / level.max() if level.max() > 0 else level
    best_notes = _notes(best)

    missing = [c for c in cands[1:top]
               if c.tonic == best.tonic and c.prob >= RUNNER_UP * best.prob
               and all(level[p] < QUIET for p in best_notes ^ _notes(c))]
    if missing:
        alt = missing[0]
        quiet = set(best_notes ^ _notes(alt))
        return {"kind": "missing_note", "labels": [best.label, alt.label],
                "text": f"{best.label} or {alt.label}: {_degree_words(best.tonic, quiet)} barely played"}

    home = [c for c in cands[1:top] if c.tonic != best.tonic and _notes(c) == best_notes
            and c.prob >= HOME_RUNNER_UP * best.prob]
    if home:
        return {"kind": "home_note", "labels": [best.label, home[0].label],
                "text": f"Home note unclear: {best.label} or {home[0].label} (same notes)"}
    return None
