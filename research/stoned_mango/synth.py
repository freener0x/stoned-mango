"""Synthetic music with a known key and mode.

Renders simple but musically idiomatic pieces (bass, chords, melody, drums)
so tests and benchmarks have audio whose correct answer is known. Any
scale in shared/scales.json can be rendered. Phase 2 grows this into the
training-data generator.

    python -m stoned_mango.synth OUT_DIR [--seconds 60] [--mp3]          # phase 0 fixture suite
    python -m stoned_mango.synth OUT_DIR --eval-set 6 --seconds 30       # random pieces for every scale
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

from .scales import library

SR = 44100

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def scale_pcs(scale_id: str) -> list[int]:
    return list(library()[scale_id].semitones)


def chord(tonic: int, pcs: list[int], degree: int) -> list[int]:
    """Root, third and fifth built on a scale degree (0-based), using only scale notes.

    For heptatonic scales this is the usual stacked-thirds triad; for other scales
    it picks whichever third and fifth the scale has, so every chord stays in scale.
    """
    root = pcs[degree % len(pcs)]
    rel = {(p - root) % 12 for p in pcs}
    notes = [root]
    third = next((i for i in (4, 3) if i in rel), None)
    fifth = next((i for i in (7, 6, 8) if i in rel), None)
    notes += [root + i for i in (third, fifth) if i is not None]
    return [tonic + n + (12 if degree >= len(pcs) else 0) for n in notes]


@dataclass
class Section:
    tonic: int  # pitch class, 0 = C
    mode: str  # scale id in shared/scales.json
    progression: list[int]  # 1-based scale degrees, one chord per bar
    bars: int

    @property
    def label(self) -> str:
        return f"{NOTE_NAMES[self.tonic]} {self.mode}"


@dataclass
class Piece:
    name: str
    sections: list[Section]
    tuning_cents: float = 0.0
    drums: bool = True
    bpm: float = 120.0
    harmonics: int = 6  # timbre brightness of chords and melody
    notes: str = ""
    expected: dict = field(default_factory=dict)


def _tone(freq: float, dur: float, amp: float, n_harm: int = 6, decay: float = 3.0) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    env = np.exp(-decay * t / max(dur, 1e-3)) * np.minimum(1.0, t / 0.01)
    rel = int(0.02 * SR)
    if len(env) > rel:
        env[-rel:] *= np.linspace(1.0, 0.0, rel)
    out = np.zeros_like(t)
    for h in range(1, n_harm + 1):
        if freq * h < SR / 2 - 1000:
            out += np.sin(2 * np.pi * freq * h * t) / h
    return amp * env * out


def _midi_to_hz(m: float, cents: float) -> float:
    return 440.0 * 2 ** ((m - 69 + cents / 100.0) / 12)


def _add(buf: np.ndarray, sig: np.ndarray, start: float) -> None:
    i = int(start * SR)
    j = min(len(buf), i + len(sig))
    if i < j:
        buf[i:j] += sig[: j - i]


def _drums(buf: np.ndarray, start: float, rng: np.random.Generator, beat_s: float) -> None:
    kick_t = np.arange(int(0.25 * SR)) / SR
    kick = np.sin(2 * np.pi * (50 + 60 * np.exp(-kick_t * 30)) * kick_t) * np.exp(-kick_t * 12)
    for beat in range(4):
        t0 = start + beat * beat_s
        if beat in (0, 2):
            _add(buf, 0.5 * kick, t0)
        else:
            snare = rng.standard_normal(int(0.15 * SR)) * np.exp(-np.arange(int(0.15 * SR)) / SR * 25)
            _add(buf, 0.15 * snare, t0)
        for half in (0, 0.5):
            hat = rng.standard_normal(int(0.04 * SR))
            hat = np.diff(hat, prepend=0.0) * np.exp(-np.arange(len(hat)) / SR * 90)
            _add(buf, 0.05 * hat, t0 + half * beat_s)


def render(piece: Piece, seconds: float | None = None, seed: int = 0) -> np.ndarray:
    """Render ``piece``. With ``seconds``, the section list is looped/trimmed to that length."""
    rng = np.random.default_rng(seed)
    BEAT = 60.0 / piece.bpm
    BAR = 4 * BEAT
    sections = piece.sections
    total_bars = sum(s.bars for s in sections)
    if seconds is not None:
        n_bars = max(1, int(round(seconds / BAR)))
        reps = int(np.ceil(n_bars / total_bars))
        # Stretch each section proportionally so modulations keep their relative place.
        sections = [Section(s.tonic, s.mode, s.progression, s.bars * reps) for s in sections]
        total_bars = n_bars
    buf = np.zeros(int(total_bars * BAR * SR) + SR)
    cents = piece.tuning_cents

    bar = 0
    for sec in sections:
        scale = scale_pcs(sec.mode)
        for k in range(sec.bars):
            if bar >= total_bars:
                break
            t0 = bar * BAR
            deg = sec.progression[k % len(sec.progression)] - 1
            notes = chord(sec.tonic, scale, deg)
            root = notes[0] % 12
            # Bass: root on beats 1 and 3, fifth on the "and" of 4.
            _add(buf, _tone(_midi_to_hz(36 + root, cents), 2 * BEAT, 0.35, 4), t0)
            _add(buf, _tone(_midi_to_hz(36 + root, cents), 1.5 * BEAT, 0.3, 4), t0 + 2 * BEAT)
            _add(buf, _tone(_midi_to_hz(36 + (notes[-1] % 12), cents), 0.5 * BEAT, 0.2, 4), t0 + 3.5 * BEAT)
            # Pad chord, voiced around middle C.
            for m in notes:
                _add(buf, _tone(_midi_to_hz(60 + (m % 12) - (12 if m % 12 > 7 else 0), cents), BAR, 0.12,
                                max(2, piece.harmonics - 1), 1.5), t0)
            # Melody: eighth notes, mostly chord tones, sometimes other scale notes.
            for e in range(8):
                if rng.random() < 0.2:
                    continue
                if rng.random() < 0.65:
                    pc = notes[rng.integers(len(notes))] % 12
                else:
                    pc = (sec.tonic + scale[rng.integers(len(scale))]) % 12
                _add(buf, _tone(_midi_to_hz(72 + pc, cents), 0.9 * BEAT / 2, 0.1, piece.harmonics, 4.0), t0 + e * BEAT / 2)
            if piece.drums:
                _drums(buf, t0, rng, BEAT)
            bar += 1
    # Final tonic chord so the piece resolves home.
    last = sections[-1]
    t_end = total_bars * BAR
    buf = np.concatenate([buf[: int(t_end * SR)], np.zeros(int(1.5 * SR))])
    for m in chord(last.tonic, scale_pcs(last.mode), 0):
        _add(buf, _tone(_midi_to_hz(48 + m, cents), 1.5, 0.15, 5, 2.0), t_end)
    return (0.9 * buf / (np.max(np.abs(buf)) + 1e-9)).astype(np.float32)


def suite() -> list[Piece]:
    """The phase 0 fixture set: every church mode, a modulation, and a detuned piece."""
    pieces = [
        Piece("c_ionian", [Section(0, "ionian", [1, 5, 6, 4], 16)]),
        Piece("a_aeolian", [Section(9, "aeolian", [1, 6, 3, 7], 16)]),
        Piece("d_dorian", [Section(2, "dorian", [1, 4, 1, 7], 16)]),
        Piece("e_phrygian", [Section(4, "phrygian", [1, 2, 1, 7], 16)]),
        Piece("f_lydian", [Section(5, "lydian", [1, 2, 1, 5], 16)]),
        Piece("g_mixolydian", [Section(7, "mixolydian", [1, 7, 4, 1], 16)]),
        Piece("b_locrian", [Section(11, "locrian", [1, 2, 1, 7], 16)]),
        Piece("fs_ionian_no_drums", [Section(6, "ionian", [1, 4, 5, 1], 16)], drums=False),
        Piece(
            "c_to_d_ionian_modulation",
            [Section(0, "ionian", [1, 4, 5, 1], 8), Section(2, "ionian", [1, 4, 5, 1], 8)],
            notes="Modulates from C major to D major halfway through.",
        ),
        Piece("a_aeolian_plus30c", [Section(9, "aeolian", [1, 4, 5, 1], 16)], tuning_cents=30.0,
              notes="Tuned 30 cents sharp of A=440."),
    ]
    for p in pieces:
        p.expected = expected(p)
    return pieces


def expected(p: Piece) -> dict:
    s = p.sections[0]
    third = library()[s.mode].third
    return {
        "tonic": NOTE_NAMES[s.tonic],
        "tonic_pc": s.tonic,
        "mode": s.mode,
        "major_minor": f"{NOTE_NAMES[s.tonic]} {third}",
        "sections": [sec.label for sec in p.sections],
        "tuning_cents": p.tuning_cents,
    }


def eval_set(per_scale: int, seed: int = 0, max_tier: int = 2) -> list[Piece]:
    """Random pieces for every scale up to ``max_tier``: random tonic, tempo, timbre,
    drums and tuning, and one of two progression styles:

    * vamp: the tonic chord on every other bar ([1, a, 1, b, ...]), common in modal music
    * moving: four different chords starting on the tonic, so the tonic is less obvious
    """
    rng = np.random.default_rng(seed)
    pieces = []
    for sid, scale in library().items():
        if scale.tier > max_tier:
            continue
        n = len(scale.semitones)
        for i in range(per_scale):
            others = list(range(2, n + 1))
            if rng.random() < 0.6:
                a, b, c = rng.choice(others, 3)
                prog, style = [1, int(a), 1, int(b), 1, int(a), int(c), 1], "vamp"
            else:
                prog, style = [1] + [int(x) for x in rng.choice(others, 3, replace=False)], "moving"
            tuning = float(rng.uniform(-40, 40)) if rng.random() < 0.2 else 0.0
            piece = Piece(
                f"{sid}_{i:02d}",
                [Section(int(rng.integers(12)), sid, prog, 8)],
                tuning_cents=round(tuning, 1),
                drums=bool(rng.random() < 0.7),
                bpm=float(rng.integers(80, 151)),
                harmonics=int(rng.integers(3, 9)),
                notes=style,
            )
            piece.expected = expected(piece)
            pieces.append(piece)
    return pieces


def write(audio: np.ndarray, path: Path, mp3: bool, stereo: bool = False) -> list[str]:
    if stereo:
        # A slightly delayed, quieter right channel: enough to make decoders do real stereo work.
        right = np.concatenate([np.zeros(441, np.float32), audio[:-441]]) * 0.9
        audio = np.stack([audio, right], axis=1)
    sf.write(path.with_suffix(".wav"), audio, SR, subtype="PCM_16")
    out = [path.with_suffix(".wav").name]
    if mp3:
        import lameenc

        enc = lameenc.Encoder()
        enc.set_bit_rate(192)
        enc.set_in_sample_rate(SR)
        enc.set_channels(2 if stereo else 1)
        enc.set_quality(2)
        pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes()
        path.with_suffix(".mp3").write_bytes(enc.encode(pcm) + enc.flush())
        out.append(path.with_suffix(".mp3").name)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", type=Path)
    ap.add_argument("--seconds", type=float, default=60.0, help="length of each suite piece")
    ap.add_argument("--mp3", action="store_true", help="also write 192 kbps MP3 copies")
    ap.add_argument("--stereo", action="store_true", help="write the long pieces as stereo, like real releases")
    ap.add_argument("--eval-set", type=int, metavar="N",
                    help="instead of the fixture suite, render N random pieces per tier 1-2 scale")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--long", type=float, nargs="*", default=[],
                    help="also render C major pieces of these lengths in minutes, for speed/memory tests")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    manifest = []
    pieces = eval_set(args.eval_set, args.seed) if args.eval_set else suite()
    for i, piece in enumerate(pieces):
        files = write(render(piece, args.seconds, seed=i), args.out / piece.name, args.mp3)
        manifest.append({"name": piece.name, "files": files, "expected": piece.expected, "notes": piece.notes})
        print(f"wrote {piece.name}")
    for minutes in args.long:
        piece = Piece(f"long_{minutes:g}min_c_ionian", [Section(0, "ionian", [1, 5, 6, 4], 16)])
        files = write(render(piece, minutes * 60, seed=99), args.out / piece.name, args.mp3, args.stereo)
        manifest.append({"name": piece.name, "files": files, "expected": expected(piece)})
        print(f"wrote {piece.name}")
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
