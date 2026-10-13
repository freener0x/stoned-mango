"""Tonic cues (PLAN.md stage [5d]): evidence for which note is "home".

Scales that share their notes (C major, A minor, D Dorian …) differ only in
their tonic, so the tonic needs evidence beyond "which notes are played".
Each cue is a 12-vector (C first, 0..1) scored at a candidate tonic:

* ``bass``: the bass-register profile (30-250 Hz); songs sit on the tonic in the bass.
* ``ending``: the notes of the last part of the track; phrases and songs end home.
* ``drone``: how constantly each note is among the loudest two (pedal notes, drones).

All cues come from the log-frequency spectrogram plus the bass profile, both of
which are stored in the training caches, so they can be computed for any
dataset without the audio.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .features import LOGSPEC_BANDS, LOGSPEC_BANDS_PER_OCTAVE

CUES = ("bass", "ending", "drone")
ENDING_FRACTION = 0.15  # the last 15% of the voiced frames
_BANDS_PER_SEMITONE = LOGSPEC_BANDS_PER_OCTAVE // 12


def _fold_matrix() -> np.ndarray:
    """[105, 12]: band k is k/2 semitones above C2; quarter-tone bands split between neighbours."""
    m = np.zeros((LOGSPEC_BANDS, 12))
    for k in range(LOGSPEC_BANDS):
        lo, frac = divmod(k, _BANDS_PER_SEMITONE)
        if frac == 0:
            m[k, lo % 12] = 1.0
        else:
            m[k, lo % 12] += 0.5
            m[k, (lo + 1) % 12] += 0.5
    return m


_FOLD = _fold_matrix()


def frame_chroma(logspec: np.ndarray) -> np.ndarray:
    """[frames, 12] chroma per frame (C first) from a [frames, 105] log-spectrogram."""
    return np.asarray(logspec, np.float64) @ _FOLD


def _unit_max(v: np.ndarray) -> np.ndarray:
    m = float(np.max(v)) if v.size else 0.0
    return v / m if m > 0 else np.zeros_like(v)


@dataclass
class TonicCues:
    bass: np.ndarray
    ending: np.ndarray
    drone: np.ndarray

    def at(self, tonic: int) -> np.ndarray:
        return np.array([getattr(self, c)[tonic % 12] for c in CUES])


def tonic_cues(logspec: np.ndarray, bass_chroma: np.ndarray) -> TonicCues:
    chroma = frame_chroma(logspec)
    if len(chroma) == 0:
        z = np.zeros(12)
        return TonicCues(z, z, z)
    energy = chroma.sum(axis=1)
    voiced = np.flatnonzero(energy > 0.05 * max(float(energy.max()), 1e-9))
    if voiced.size == 0:
        voiced = np.arange(len(chroma))
    tail = voiced[-max(1, int(len(voiced) * ENDING_FRACTION)):]
    ending = _unit_max(chroma[tail].mean(axis=0))
    top2 = np.argsort(-chroma[voiced], axis=1)[:, :2]
    drone = np.bincount(top2.ravel(), minlength=12) / len(voiced)
    return TonicCues(bass=_unit_max(np.asarray(bass_chroma, np.float64)), ending=ending, drone=drone)
