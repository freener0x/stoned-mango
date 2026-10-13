"""Synthetic test songs for tier 3: maqam, makam and raga-family scales, with their own
intonation (quarter tones, commas, just intonation) and textures.

    python -m stoned_mango.worldgen OUT_DIR [--per-scale 2] [--seconds 30] [--seed 0]

Each song has a known scale and home note (in cents, so a quarter-tone home note such as
E half-flat is exact) and is rendered from simple synthetic instruments:

* Indian: a tanpura-like drone (Sa, Pa, high Sa, cycling plucks), a sung or bowed melody
  with slides and vibrato, and a tabla-like drum tuned to Sa.
* Arabic and Turkish: a plucked (oud-like) and a breathy (ney-like) line in heterophony,
  an occasional low tonic, sometimes a held drone (ison), and a frame drum.

The melody walks the scale in phrases that lean on the home note and the dominant and end
home, as these traditions do. This is not real music; it checks that the engine can hear
the scales, and the real recordings are measured separately on the author's PC.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from .scales import library

SR = 22050


@dataclass
class WorldPiece:
    name: str
    scale: str
    tonic_cents: float  # home note, cents above C4 (0..1200)
    tuning_cents: float  # whole recording offset from A=440
    seconds: float
    drone: bool
    seed: int

    @property
    def tradition(self) -> str:
        return library()[self.scale].tradition or ""

    def expected(self) -> dict:
        return {"scale": self.scale, "tradition": self.tradition, "tonic_cents": self.tonic_cents,
                "tuning_cents": self.tuning_cents, "drone": self.drone}


def _hz(cents_above_c4: float, tuning: float) -> float:
    return 261.6256 * 2 ** ((cents_above_c4 + tuning) / 1200)


def _partials(f0: np.ndarray, t: np.ndarray, amps: list[float], inharm: float = 0.0) -> np.ndarray:
    """Sum of harmonics following a (possibly gliding) f0 curve."""
    phase = 2 * np.pi * np.cumsum(f0) / SR
    out = np.zeros_like(t)
    for h, a in enumerate(amps, start=1):
        if f0.max() * h > SR / 2 - 500:
            break
        out += a * np.sin(phase * h * (1 + inharm * h * h))
    return out


def _env(n: int, attack: float, decay: float) -> np.ndarray:
    t = np.arange(n) / SR
    e = np.minimum(1.0, t / max(attack, 1e-3)) * np.exp(-t / max(decay, 1e-3))
    tail = min(n, int(0.03 * SR))
    if tail:
        e[-tail:] *= np.linspace(1, 0, tail)
    return e


def _add(buf: np.ndarray, sig: np.ndarray, start: float) -> None:
    i = int(start * SR)
    j = min(len(buf), i + len(sig))
    if 0 <= i < j:
        buf[i:j] += sig[: j - i]


def _note(cents: float, dur: float, tuning: float, rng, kind: str, prev: float | None = None) -> np.ndarray:
    n = max(1, int(dur * SR))
    t = np.arange(n) / SR
    target = _hz(cents, tuning)
    f0 = np.full(n, target)
    if prev is not None and kind in ("voice", "ney", "bowed") and rng.random() < 0.5:
        # a slide (meend, glissando) from the previous note over the first 15%
        k = max(1, int(0.15 * n))
        f0[:k] = np.geomspace(_hz(prev, tuning), target, k)
    if kind in ("voice", "ney", "bowed"):
        vib = rng.uniform(4.5, 6.5)
        depth = rng.uniform(5, 15)  # cents
        f0 *= 2 ** (depth * np.sin(2 * np.pi * vib * t) * np.minimum(1, t / 0.3) / 1200)
    if kind == "pluck":
        sig = _partials(f0, t, [1, 0.6, 0.45, 0.3, 0.2, 0.12, 0.08], inharm=0.0003) * _env(n, 0.004, 0.45 * dur + 0.15)
    elif kind == "ney":
        sig = _partials(f0, t, [1, 0.25, 0.12, 0.05]) * _env(n, 0.08, 4 * dur)
        sig += 0.02 * rng.standard_normal(n) * _env(n, 0.05, dur)
    else:  # voice, bowed
        sig = _partials(f0, t, [1, 0.7, 0.5, 0.35, 0.2, 0.1]) * _env(n, 0.05, 6 * dur)
    return sig.astype(np.float64)


def _tanpura(buf: np.ndarray, sa: float, tuning: float, fifth: float) -> None:
    cycle = 2.4
    pattern = [fifth - 1200, 0, 0, -1200]  # Pa (low), Sa, Sa, low Sa
    t = 0.0
    while t < len(buf) / SR:
        for k, c in enumerate(pattern):
            dur = 3.0
            n = int(dur * SR)
            tt = np.arange(n) / SR
            f0 = np.full(n, _hz(sa + c, tuning))
            sig = _partials(f0, tt, [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2]) * _env(n, 0.01, 2.2)
            _add(buf, 0.10 * sig, t + k * cycle / 4)
        t += cycle


def _drum(buf: np.ndarray, start: float, rng, pitch_hz: float | None) -> None:
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    if pitch_hz:  # tabla-like dayan: a ringing pitched stroke
        sig = np.sin(2 * np.pi * pitch_hz * t) * np.exp(-t * 14) + 0.3 * np.sin(2 * np.pi * 2 * pitch_hz * t) * np.exp(-t * 20)
    else:  # frame drum: a thud and a slap
        sig = np.sin(2 * np.pi * (70 + 40 * np.exp(-t * 40)) * t) * np.exp(-t * 18)
        sig += 0.3 * rng.standard_normal(n) * np.exp(-t * 60)
    _add(buf, 0.18 * sig, start)


def _phrase(rng, n_degrees: int, dominant: int, length: int) -> list[int]:
    """Scale degree indices (may go an octave up/down: index +/- n): starts near home or the
    dominant, wanders by small steps, ends home."""
    pos = rng.choice([0, dominant, n_degrees])
    out = [pos]
    for _ in range(length - 2):
        step = rng.choice([-2, -1, -1, 1, 1, 2, 0])
        pos = int(np.clip(pos + step, -2, n_degrees + 3))
        out.append(pos)
    out.append(rng.choice([0, 0, n_degrees]))
    return out


def render(p: WorldPiece) -> np.ndarray:
    rng = np.random.default_rng(p.seed)
    s = library()[p.scale]
    cents = list(s.cents)
    n = len(cents)
    dominant = (s.dominant or 5) - 1
    buf = np.zeros(int(p.seconds * SR) + SR)
    sa = p.tonic_cents if p.tonic_cents < 700 else p.tonic_cents - 1200  # keep the melody in a comfortable range
    deg = lambda i: sa + cents[i % n] + 1200 * (i // n)  # noqa: E731
    indian = p.tradition == "indian"
    if p.drone:
        if indian:
            _tanpura(buf, sa - 1200, p.tuning_cents, 702.0)
        else:  # a held ison on the home note
            m = len(buf)
            tt = np.arange(m) / SR
            sig = _partials(np.full(m, _hz(sa - 1200, p.tuning_cents)), tt, [1, 0.5, 0.3, 0.2])
            buf += 0.05 * sig
    lead = rng.choice(["voice", "bowed"]) if indian else rng.choice(["pluck", "ney"])
    beat = 60 / rng.uniform(70, 130)
    t = rng.uniform(0.2, 1.0)
    prev = None
    while t < p.seconds - 1.0:
        for i in _phrase(rng, n, dominant, int(rng.integers(5, 10))):
            dur = beat * rng.choice([0.5, 1, 1, 1.5, 2])
            c = deg(i)
            _add(buf, 0.22 * _note(c, dur * 1.05, p.tuning_cents, rng, lead, prev), t)
            if not indian and rng.random() < 0.6:  # heterophony: a second instrument an octave down
                other = "ney" if lead == "pluck" else "pluck"
                _add(buf, 0.12 * _note(c - 1200, dur, p.tuning_cents, rng, other), t + rng.uniform(0, 0.03))
            prev = c
            t += dur
            if t >= p.seconds - 1.0:
                break
        if not indian and rng.random() < 0.5:
            _add(buf, 0.15 * _note(sa - 1200, 2 * beat, p.tuning_cents, rng, "pluck"), t)
        t += beat * rng.choice([0.5, 1, 2])
    pitch = _hz(sa, p.tuning_cents) if indian else None
    for k in range(int(p.seconds / beat)):
        if rng.random() < 0.8:
            _drum(buf, k * beat, rng, pitch if (pitch and k % 2 == 0) else None)
    buf = buf[: int(p.seconds * SR)]
    return (0.8 * buf / max(1e-9, np.abs(buf).max())).astype(np.float32)


def pieces(per_scale: int, seconds: float, seed: int = 0) -> list[WorldPiece]:
    rng = np.random.default_rng(seed)
    out = []
    for s in library().values():
        if s.tier != 3:
            continue
        for k in range(per_scale):
            if s.tradition == "indian":
                tonic = float(rng.integers(0, 12)) * 100  # Sa anywhere; the tuning adds the rest
                tuning = float(rng.uniform(-45, 45))
                drone = True
            else:
                hint = _hint_cents(s)
                tonic = (hint + 100 * int(rng.integers(-3, 4))) % 1200  # transposed (ahenk)
                tuning = float(rng.uniform(-20, 20))
                drone = bool(rng.random() < 0.3)
            out.append(WorldPiece(f"{s.id}_{k}", s.id, round(tonic, 1), round(tuning, 1), seconds, drone,
                                  int(rng.integers(0, 2**31))))
    return out


_NOTE = {"C": 0, "D": 200, "E": 400, "F": 500, "G": 700, "A": 900, "B": 1100}


def _hint_cents(s) -> float:
    from .world import scale_info

    hint = scale_info(s.id).get("tonic_hint", "C")
    base = _NOTE[hint[0]]
    if "half-flat" in hint:
        base -= 50
    elif "koma-flat" in hint:
        base -= 1200 / 53 * 0.7  # Segah: about 15 cents below B (Rast + 17 commas)
    elif "flat" in hint:
        base -= 100
    return base % 1200


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", type=Path)
    ap.add_argument("--per-scale", type=int, default=2)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for p in pieces(args.per_scale, args.seconds, args.seed):
        sf.write(args.out / f"{p.name}.wav", render(p), SR, subtype="PCM_16")
        manifest.append({"file": f"{p.name}.wav", "expected": p.expected()})
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"{len(manifest)} songs in {args.out}")


if __name__ == "__main__":
    main()
