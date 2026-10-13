"""Key/mode engines that work on pitch profiles (PLAN.md stages [5b] and [5c]).

Both take the profile computed once by ``features`` and score candidates
from it, so adding profiles or scales costs almost nothing.
"""

from __future__ import annotations

from dataclasses import dataclass

import essentia.standard as es
import numpy as np

from .scales import Scale, label, library

# Template weights by the role a pitch class plays in the scale. Shaped like the
# Krumhansl-Kessler major profile (tonic > fifth > third > other scale notes >
# non-scale notes); this is the part that tells D Dorian from C major, whose
# note sets are identical.
ROLE_WEIGHTS = {"tonic": 1.0, "fifth": 0.8, "third": 0.72, "scale": 0.55, "outside": 0.15}
ESSENTIA_PROFILES = ("edma", "bgate", "temperley", "krumhansl")


@dataclass
class Candidate:
    tonic: int  # pitch class, 0 = C
    scale: str  # id in shared/scales.json
    score: float
    prob: float = 0.0

    @property
    def label(self) -> str:
        return label(self.tonic, self.scale)


def template(scale: Scale) -> np.ndarray:
    pcs = set(scale.semitones)
    t = np.full(12, ROLE_WEIGHTS["outside"])
    for pc in pcs:
        t[pc] = ROLE_WEIGHTS["scale"]
    for pc in (3, 4):
        if pc in pcs:
            t[pc] = ROLE_WEIGHTS["third"]
    fifth = 7 if 7 in pcs else (6 if 6 in pcs else (8 if 8 in pcs else None))
    if fifth is not None:
        t[fifth] = ROLE_WEIGHTS["fifth"]
    t[0] = ROLE_WEIGHTS["tonic"]
    return t


def _zscore(v: np.ndarray) -> np.ndarray:
    sd = v.std()
    return (v - v.mean()) / sd if sd > 1e-12 else np.zeros_like(v)


def score_scales(
    chroma: np.ndarray,
    bass: np.ndarray | None = None,
    bass_weight: float = 0.0,
    scales: list[str] | None = None,
    max_tier: int = 2,
    temperature: float = 0.03,
) -> list[Candidate]:
    """[5c] Correlate a C-first 12-bin chroma with every (tonic, scale) template.

    ``bass_weight`` adds a simple tonic cue: the bass profile's strength at the
    candidate tonic (0..1). Phase 3 replaces this with the full tonic detector.
    Probabilities are a softmax over scores and are NOT calibrated yet.
    """
    lib = library()
    ids = scales or [s.id for s in lib.values() if s.tier <= max_tier]
    z = _zscore(np.asarray(chroma, np.float64))
    b = None
    if bass is not None and bass_weight:
        b = np.asarray(bass, np.float64)
        b = b / b.max() if b.max() > 0 else b
    out = []
    for sid in ids:
        zt = _zscore(template(lib[sid]))
        for tonic in range(12):
            score = float(np.dot(z, np.roll(zt, tonic)) / 12)
            if b is not None:
                score += bass_weight * float(b[tonic])
            out.append(Candidate(tonic, sid, score))
    out.sort(key=lambda c: -c.score)
    scores = np.array([c.score for c in out])
    p = np.exp((scores - scores[0]) / temperature)
    p /= p.sum()
    for c, pi in zip(out, p):
        c.prob = float(pi)
    return out


_KEY_NAMES_A = ["A", "Bb", "B", "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab"]
_PC = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7,
       "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}


def essentia_keys(chroma: np.ndarray, profiles=ESSENTIA_PROFILES) -> dict[str, dict]:
    """[5b] Essentia's Key algorithm (major/minor only) on the same C-first chroma."""
    pcp = np.roll(np.asarray(chroma, np.float32), -9)  # Essentia's PCP starts at A
    pcp = pcp / pcp.max() if pcp.max() > 0 else pcp
    out = {}
    for profile in profiles:
        key, scale, strength, _ = es.Key(profileType=profile, pcpSize=12)(pcp.astype(np.float32))
        out[profile] = {"tonic": _PC[key], "scale": "ionian" if scale == "major" else "aeolian",
                        "label": f"{key} {scale}", "strength": float(strength)}
    return out


def combine(*ranked: list[Candidate], weights: list[float] | None = None) -> list[Candidate]:
    """Merge engines by adding their log-probabilities for each (tonic, scale).

    A simple product-of-experts; phase 3 replaces the fixed weights with calibrated ones.
    """
    weights = weights or [1.0] * len(ranked)
    table: dict[tuple[int, str], float] = {}
    for cands, w in zip(ranked, weights):
        for c in cands:
            table[(c.tonic, c.scale)] = table.get((c.tonic, c.scale), 0.0) + w * float(np.log(max(c.prob, 1e-12)))
    # Only candidates every engine scored can be compared fairly.
    common = set.intersection(*({(c.tonic, c.scale) for c in r} for r in ranked))
    out = [Candidate(t, s, table[(t, s)]) for t, s in common]
    out.sort(key=lambda c: -c.score)
    scores = np.array([c.score for c in out])
    p = np.exp(scores - scores[0])
    p /= p.sum()
    for c, pi in zip(out, p):
        c.prob = float(pi)
    return out

