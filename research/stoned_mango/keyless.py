"""Audio with no key (noise, drum loops) for choosing the "No clear key" floor.

``fusion fit`` scores these clips and sets ``no_key_below`` just above the most
confident answer any of them gets, so noise and drums read "No clear key"
while real songs keep their answer (fusion.py, docs/phase3/REPORT.md).
"""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np

from .synth import SR


def _colored(rng: np.random.Generator, beta: float, n: int) -> np.ndarray:
    """Noise with a 1/f^beta power spectrum: 0 white, 1 pink, 2 brown."""
    spec = np.fft.rfft(rng.normal(size=n))
    f = np.arange(len(spec), dtype=float)
    f[0] = 1.0
    x = np.fft.irfft(spec / f ** (beta / 2), n)
    return 0.5 * x / np.abs(x).max()


def _drums(rng: np.random.Generator, seconds: float, bpm: float, kick_hz: float) -> np.ndarray:
    """Kick (a pitched sine sweep, as in real kicks), snare and hi-hat on a straight beat."""
    n = int(seconds * SR)
    x = np.zeros(n)
    t = np.arange(int(0.3 * SR)) / SR
    kick = np.sin(2 * np.pi * (kick_hz * t + 80 * (1 - np.exp(-t * 30)) / 30)) * np.exp(-t * 12)
    snare = 0.6 * rng.normal(size=len(t)) * np.exp(-t * 25)
    hat = 0.3 * np.diff(rng.normal(size=len(t) + 1)) * np.exp(-t * 80)
    half_beat = int(30 / bpm * SR)
    for i, s in enumerate(range(0, n - len(t), half_beat)):
        x[s:s + len(t)] += hat
        if i % 2 == 0:
            x[s:s + len(t)] += kick if (i // 2) % 2 == 0 else snare
    return 0.8 * x / np.abs(x).max()


def clips(seconds: float = 20.0, seed: int = 5, noise: int = 8, drums: int = 16) -> Iterator[tuple[str, np.ndarray]]:
    """(name, mono float32 audio at synth.SR): ``noise`` clips each of white, pink and
    brown noise, then ``drums`` loops at random tempos (80-180 BPM) and kick pitches (40-70 Hz)."""
    rng = np.random.default_rng(seed)
    for name, beta in (("white", 0), ("pink", 1), ("brown", 2)):
        for i in range(noise):
            yield f"{name}-noise-{i}", _colored(rng, beta, int(seconds * SR)).astype(np.float32)
    for i in range(drums):
        bpm, hz = rng.uniform(80, 180), rng.uniform(40, 70)
        yield f"drums-{i}-{bpm:.0f}bpm", _drums(rng, seconds, bpm, hz).astype(np.float32)
