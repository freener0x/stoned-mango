"""Synthetic songs for training the key CNN (phase 2).

Richer than synth.py (which makes the fixed test fixtures): each song is an
arrangement of bass, chords, an optional arpeggio, melody and drums, with
random General MIDI instruments, grooves, voicings and tempo, in any scale
from shared/scales.json. Songs are rendered with FluidSynth and the FluidR3
GM soundfont (MIT) when available, otherwise with the built-in additive synth.

    python -m stoned_mango.songgen OUT_DIR --per-scale 4 --seconds 30            # WAV + labels, to listen to
    python -m stoned_mango.songgen OUT_DIR --per-scale 300 --features --workers 8   # training cache (no audio kept)
    python -m stoned_mango.songgen OUT_DIR --modulating 120 --seconds 90           # key changes, for the timeline (phase 4)

With --features, each song is analysed straight away and only its features
are kept (``<name>.npz``: log-spectrogram, chroma, bass chroma, labels).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import soundfile as sf

from .scales import library
from .synth import _midi_to_hz, chord, scale_pcs

RENDER_SR = 22050  # analysis rate, so no decimation is needed
SOUNDFONTS = ("/usr/share/sounds/sf2/FluidR3_GM.sf2", "/usr/share/soundfonts/FluidR3_GM.sf2")

# General MIDI program pools.
BASS = [32, 33, 34, 35, 36, 37, 38, 39]
CHORDS = [0, 1, 2, 4, 5, 6, 16, 17, 18, 19, 24, 25, 26, 27, 46, 48, 49, 50, 51, 52, 88, 89, 90, 91, 92, 94, 95]
LEAD = [0, 4, 8, 11, 13, 22, 24, 25, 40, 41, 42, 56, 57, 60, 64, 65, 66, 68, 71, 73, 74, 79, 80, 81, 82, 85, 104, 105]
ARP = [4, 8, 10, 11, 12, 13, 24, 46, 80, 81, 98, 99]
DRUM_CHANNEL = 9
KICK, SNARE, CLOSED_HAT, OPEN_HAT, CLAP = 36, 38, 42, 46, 39


@dataclass
class Note:
    start: float  # seconds
    dur: float
    pitch: int  # MIDI note
    vel: int
    channel: int


@dataclass
class Song:
    name: str
    tonic: int
    scale: str
    bpm: float
    seconds: float
    tuning_cents: float
    programs: dict[int, int]  # channel -> GM program
    style: dict
    notes: list[Note] = field(default_factory=list)

    def labels(self) -> dict:
        s = library()[self.scale]
        return {"name": self.name, "tonic": self.tonic, "scale": self.scale, "third": s.third, "family": s.family,
                "bpm": self.bpm, "seconds": self.seconds, "tuning_cents": self.tuning_cents,
                "programs": self.programs, "style": self.style}


def _progression(rng: np.random.Generator, n_degrees: int) -> tuple[list[int], str]:
    others = list(range(2, n_degrees + 1))
    r = rng.random()
    if r < 0.45:
        a, b, c = (int(x) for x in rng.choice(others, 3))
        return [1, a, 1, b, 1, a, c, 1], "vamp"
    if r < 0.8:
        return [1] + [int(x) for x in rng.choice(others, 3, replace=False)], "moving"
    return [1, 1, int(rng.choice(others)), 1], "drone"


def arrange(name: str, tonic: int, scale_id: str, seconds: float, rng: np.random.Generator) -> Song:
    pcs = scale_pcs(scale_id)
    bpm = float(rng.integers(70, 161))
    beat = 60.0 / bpm
    bar = 4 * beat
    prog, prog_style = _progression(rng, len(pcs))
    style = {
        "progression": prog_style,
        "bass": str(rng.choice(["roots", "eighths", "syncopated", "walking"])),
        "comp": str(rng.choice(["whole", "quarters", "stabs", "arp"])),
        "arpeggio": bool(rng.random() < 0.3),
        "drums": str(rng.choice(["four", "backbeat", "halftime"])) if rng.random() < 0.7 else "none",
        "cadence": bool(rng.random() < 0.6),
    }
    tuning = float(round(rng.uniform(-45, 45), 1)) if rng.random() < 0.25 else 0.0
    programs = {0: int(rng.choice(BASS)), 1: int(rng.choice(CHORDS)), 2: int(rng.choice(LEAD)), 3: int(rng.choice(ARP))}
    song = Song(name, tonic, scale_id, bpm, seconds, tuning, programs, style)
    add = song.notes.append
    n_bars = max(1, int(np.ceil(seconds / bar)))
    scale_notes = [tonic + p for p in pcs]
    melody_pitch = 72 + tonic

    for b in range(n_bars):
        t0 = b * bar
        deg = prog[b % len(prog)] - 1
        tones = chord(tonic, pcs, deg)
        root = tones[0] % 12
        # Bass (channel 0), around MIDI 36-47.
        bass_root = 36 + root
        if style["bass"] == "roots":
            hits = [(0, 2, bass_root), (2, 2, bass_root)]
        elif style["bass"] == "eighths":
            hits = [(i / 2, 0.45, bass_root + (12 if i % 4 == 3 and rng.random() < 0.5 else 0)) for i in range(8)]
        elif style["bass"] == "syncopated":
            hits = [(0, 1.4, bass_root), (1.5, 0.9, bass_root), (2.5, 0.9, 36 + tones[-1] % 12), (3.5, 0.45, bass_root)]
        else:  # walking: root, then up and back down the scale
            idx = pcs.index((root - tonic) % 12)
            steps = [36 + scale_notes[(idx + i) % len(pcs)] % 12 for i in (0, 1, 2, 1)]
            hits = [(i, 0.95, p) for i, p in enumerate(steps)]
        for off, dur, p in hits:
            add(Note(t0 + off * beat, dur * beat, int(p), int(rng.integers(80, 110)), 0))

        # Chords (channel 1): random inversion, sometimes a seventh.
        voicing = sorted(48 + (t % 12) for t in tones)
        if len(pcs) == 7 and rng.random() < 0.3:
            voicing.append(48 + (tonic + pcs[(deg + 6) % 7]) % 12 + 12)
        for _ in range(int(rng.integers(0, len(voicing)))):
            voicing = voicing[1:] + [voicing[0] + 12]
        if style["comp"] == "whole":
            for p in voicing:
                add(Note(t0, bar * 0.98, p, int(rng.integers(55, 80)), 1))
        elif style["comp"] == "quarters":
            for q in range(4):
                for p in voicing:
                    add(Note(t0 + q * beat, beat * 0.9, p, int(rng.integers(55, 85)), 1))
        elif style["comp"] == "stabs":
            for q in (0.5, 1.5, 2.5, 3.5):
                for p in voicing:
                    add(Note(t0 + q * beat, beat * 0.4, p, int(rng.integers(60, 90)), 1))
        else:
            for i in range(8):
                add(Note(t0 + i * beat / 2, beat * 0.5, voicing[i % len(voicing)], int(rng.integers(55, 85)), 1))
        # Arpeggio (channel 3), sixteenths across two octaves.
        if style["arpeggio"]:
            arp = voicing + [p + 12 for p in voicing]
            for i in range(16):
                add(Note(t0 + i * beat / 4, beat / 4 * 0.9, arp[i % len(arp)] + 12, int(rng.integers(40, 70)), 3))

        # Melody (channel 2): a random walk over the scale, leaning on chord tones, in 2-bar phrases.
        t = 0.0
        while t < 4 - 1e-6:
            dur = float(rng.choice([0.5, 0.5, 1.0, 1.0, 1.5, 2.0]))
            dur = min(dur, 4 - t)
            last_of_phrase = b % 2 == 1 and t + dur >= 4 - 1e-6
            if rng.random() < 0.22 and not last_of_phrase:
                t += dur
                continue
            if last_of_phrase and style["cadence"] and b % len(prog) == len(prog) - 1:
                target_pc = tonic % 12  # phrase ends on the tonic
            elif rng.random() < 0.6:
                target_pc = tones[int(rng.integers(len(tones)))] % 12
            else:
                target_pc = scale_notes[int(rng.integers(len(scale_notes)))] % 12
            # Nearest octave of the target to the previous note keeps the line smooth.
            cands = [target_pc + 12 * o for o in range(5, 8)]
            melody_pitch = min(cands, key=lambda c: abs(c - melody_pitch))
            add(Note(t0 + t * beat, dur * beat * 0.95, int(melody_pitch), int(rng.integers(70, 105)), 2))
            t += dur

        # Drums (channel 9).
        if style["drums"] != "none":
            for i in range(8):
                pos = t0 + i * beat / 2
                if style["drums"] == "four" and i % 2 == 0:
                    add(Note(pos, 0.1, KICK, 110, DRUM_CHANNEL))
                if style["drums"] == "backbeat" and i in (0, 5):
                    add(Note(pos, 0.1, KICK, 110, DRUM_CHANNEL))
                if style["drums"] == "halftime" and i == 0:
                    add(Note(pos, 0.1, KICK, 110, DRUM_CHANNEL))
                if (style["drums"] != "halftime" and i in (2, 6)) or (style["drums"] == "halftime" and i == 4):
                    add(Note(pos, 0.1, SNARE if rng.random() < 0.8 else CLAP, 100, DRUM_CHANNEL))
                add(Note(pos, 0.05, OPEN_HAT if i == 7 and rng.random() < 0.3 else CLOSED_HAT, int(rng.integers(50, 80)),
                         DRUM_CHANNEL))
    song.notes = [n for n in song.notes if n.start < seconds]
    return song


def find_soundfont() -> str | None:
    env = os.environ.get("STONED_MANGO_SOUNDFONT")
    for p in ([env] if env else []) + list(SOUNDFONTS):
        if p and Path(p).exists():
            return p
    return None


def render_soundfont(song: Song, soundfont: str) -> np.ndarray:
    import mido

    ticks_per_second = 960  # 480 ticks per beat at the MIDI default of 120 BPM
    mid = mido.MidiFile(ticks_per_beat=480)
    events = []
    for ch, prog in song.programs.items():
        events.append((0, 0, mido.Message("program_change", channel=ch, program=prog)))
    for n in song.notes:
        on = int(round(n.start * ticks_per_second))
        off = int(round((n.start + n.dur) * ticks_per_second))
        events.append((on, 1, mido.Message("note_on", channel=n.channel, note=n.pitch, velocity=n.vel)))
        events.append((max(off, on + 1), 0, mido.Message("note_off", channel=n.channel, note=n.pitch, velocity=0)))
    events.sort(key=lambda e: (e[0], e[1]))
    track = mido.MidiTrack()
    now = 0
    for tick, _, msg in events:
        track.append(msg.copy(time=tick - now))
        now = tick
    mid.tracks.append(track)
    with tempfile.TemporaryDirectory() as tmp:
        midi_path, wav_path = Path(tmp) / "song.mid", Path(tmp) / "song.wav"
        mid.save(midi_path)
        subprocess.run(["fluidsynth", "-ni", "-q", "-g", "0.5", "-r", str(RENDER_SR), "-T", "wav",
                        "-F", str(wav_path), soundfont, str(midi_path)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        audio, _ = sf.read(wav_path, dtype="float32", always_2d=True)
    return audio.mean(axis=1)


def _tone(freq: float, dur: float, amp: float, n_harm: int, sr: int = RENDER_SR) -> np.ndarray:
    t = np.arange(max(1, int(dur * sr))) / sr
    env = np.exp(-3.0 * t / max(dur, 1e-3)) * np.minimum(1.0, t / 0.01)
    out = np.zeros_like(t)
    for h in range(1, n_harm + 1):
        if freq * h < sr / 2 - 500:
            out += np.sin(2 * np.pi * freq * h * t) / h
    return amp * env * out


def render_additive(song: Song, seed: int = 0) -> np.ndarray:
    global_sr = RENDER_SR
    rng = np.random.default_rng(seed)
    buf = np.zeros(int((song.seconds + 2) * global_sr))
    brightness = {0: 4, 1: 5, 2: 6, 3: 5}
    level = {0: 0.35, 1: 0.1, 2: 0.14, 3: 0.06}
    for n in song.notes:
        i = int(n.start * global_sr)
        if n.channel == DRUM_CHANNEL:
            length = int(0.12 * global_sr)
            env = np.exp(-np.arange(length) / global_sr * (15 if n.pitch == KICK else 40))
            if n.pitch == KICK:
                t = np.arange(length) / global_sr
                sig = 0.5 * np.sin(2 * np.pi * (50 + 60 * np.exp(-t * 30)) * t) * env
            else:
                sig = 0.08 * rng.standard_normal(length) * env
        else:
            sig = _tone(_midi_to_hz(n.pitch, 0.0), n.dur, level[n.channel] * n.vel / 100, brightness[n.channel])
        j = min(len(buf), i + len(sig))
        buf[i:j] += sig[: j - i]
    return buf.astype(np.float32)


def apply_tuning(audio: np.ndarray, cents: float) -> np.ndarray:
    """Detune by resampling (pitch and tempo move together, like a sped-up record)."""
    if not cents:
        return audio
    factor = 2 ** (cents / 1200)
    src = np.arange(0, len(audio) - 1, factor)
    return np.interp(src, np.arange(len(audio)), audio).astype(np.float32)


def make(name: str, tonic: int, scale_id: str, seconds: float, seed: int, backend: str) -> tuple[Song, np.ndarray]:
    rng = np.random.default_rng(seed)
    song = arrange(name, tonic, scale_id, seconds, rng)
    sfont = find_soundfont() if backend == "soundfont" else None
    if backend == "soundfont" and (sfont is None or shutil.which("fluidsynth") is None):
        raise RuntimeError("soundfont backend needs `fluidsynth` and FluidR3_GM.sf2 (apt install fluidsynth fluid-soundfont-gm)")
    audio = render_soundfont(song, sfont) if sfont else render_additive(song, seed)
    audio = apply_tuning(audio, song.tuning_cents)
    peak = np.abs(audio).max()
    return song, (0.9 * audio / peak if peak > 0 else audio).astype(np.float32)


# Key changes for the timeline test set: (name, semitones up, new scale or None to keep it).
MODULATIONS = [("fifth up", 7, None), ("fifth down", 5, None), ("step up", 2, None), ("semitone up", 1, None),
               ("minor third up", 3, None), ("tritone", 6, None), ("relative", None, None), ("parallel", 0, None),
               ("mode change", 0, "mode")]
COMMON_SCALES = ["ionian", "aeolian", "dorian", "mixolydian"]
MIN_SECTION_SECONDS = 20.0


def next_key(rng: np.random.Generator, tonic: int, scale_id: str) -> tuple[int, str, str]:
    """A key change from (tonic, scale): returns (new tonic, new scale, kind of change).

    A change that keeps the same notes *and* moves to a note the scale treats the same
    way (a minor third in a diminished scale, a step in whole-tone) can't be heard, so
    those fall back to a fifth up.
    """
    t, sid, kind = _next_key(rng, tonic, scale_id)
    same_notes = {(t + p) % 12 for p in scale_pcs(sid)} == {(tonic + p) % 12 for p in scale_pcs(scale_id)}
    if same_notes and sid == scale_id:
        return (tonic + 7) % 12, scale_id, "fifth up"
    return t, sid, kind


def _next_key(rng: np.random.Generator, tonic: int, scale_id: str) -> tuple[int, str, str]:
    name, shift, new = MODULATIONS[int(rng.integers(len(MODULATIONS)))]
    if name in ("relative", "parallel") and scale_id not in ("ionian", "aeolian"):
        name, shift, new = MODULATIONS[0]
    if name == "relative":
        return ((tonic + 9) % 12, "aeolian", name) if scale_id == "ionian" else ((tonic + 3) % 12, "ionian", name)
    if name == "parallel":
        return tonic, "aeolian" if scale_id == "ionian" else "ionian", name
    if new == "mode":
        others = [x for x in COMMON_SCALES if x != scale_id]
        return tonic, str(rng.choice(others)), name
    return (tonic + shift) % 12, scale_id, name


def make_modulating(name: str, seconds: float, seed: int, backend: str,
                    n_changes: int | None = None) -> tuple[dict, np.ndarray]:
    """A song whose key changes 0-2 times on bar lines, played by the same band throughout.

    Every section is arranged from the same random seed, so tempo, instruments and
    groove stay the same and only the key moves. Returns (labels with "sections", audio).
    """
    rng = np.random.default_rng(seed)
    lib = library()
    tiers = [sid for sid, sc in lib.items() if sc.tier <= 2]
    scale_id = str(rng.choice(COMMON_SCALES)) if rng.random() < 0.6 else str(rng.choice(tiers))
    tonic = int(rng.integers(12))
    if n_changes is None:
        n_changes = int(rng.choice([0, 1, 2], p=[0.25, 0.5, 0.25]))
    probe = arrange(name, tonic, scale_id, 4.0, np.random.default_rng(seed + 1))
    bar = 4 * 60.0 / probe.bpm
    n_bars = max(1, int(round(seconds / bar)))
    min_bars = int(np.ceil(MIN_SECTION_SECONDS / bar))
    n_changes = min(n_changes, max(0, n_bars // min_bars - 1))
    cuts = []
    while len(cuts) < n_changes:  # bar lines at least MIN_SECTION_SECONDS apart and from either end
        c = sorted(set(int(x) for x in rng.integers(min_bars, n_bars - min_bars + 1, n_changes)))
        if len(c) == n_changes and all(b - a >= min_bars for a, b in zip([0] + c, c + [n_bars])):
            cuts = c
    edges = [0] + cuts + [n_bars]
    keys = [(tonic, scale_id, "start")]
    for _ in cuts:
        keys.append(next_key(rng, keys[-1][0], keys[-1][1]))
    song, sections = None, []
    for (t, sid, kind), (b0, b1) in zip(keys, zip(edges[:-1], edges[1:])):
        part = arrange(name, t, sid, (b1 - b0) * bar, np.random.default_rng(seed + 1))  # same band and groove
        offset = b0 * bar
        for n in part.notes:
            n.start += offset
        if song is None:
            song = part
        else:
            song.notes += part.notes
        sections.append({"start": round(offset, 3), "end": round(b1 * bar, 3), "tonic": t, "scale": sid,
                         "third": lib[sid].third, "change": kind})
    song.seconds = n_bars * bar
    sfont = find_soundfont() if backend == "soundfont" else None
    audio = render_soundfont(song, sfont) if sfont else render_additive(song, seed)
    audio = apply_tuning(audio, song.tuning_cents)
    peak = np.abs(audio).max()
    labels = {"name": name, "sections": sections, "bpm": song.bpm, "seconds": song.seconds,
              "tuning_cents": song.tuning_cents, "programs": song.programs, "style": song.style}
    return labels, (0.9 * audio / peak if peak > 0 else audio).astype(np.float32)


def _modulating_job(args: tuple) -> str:
    out, name, seconds, seed, backend = args
    labels, audio = make_modulating(name, seconds, seed, backend)
    sf.write(out / f"{name}.wav", audio, RENDER_SR, subtype="PCM_16")
    (out / f"{name}.json").write_text(json.dumps(labels))
    return name


def _job(args: tuple) -> str:
    out, name, tonic, scale_id, seconds, seed, backend, features = args
    song, audio = make(name, tonic, scale_id, seconds, seed, backend)
    labels = song.labels()
    if features:
        from .features import extract_array

        f = extract_array(audio, RENDER_SR)
        np.savez_compressed(out / f"{name}.npz", logspec=f.logspec.astype(np.float16), chroma=f.chroma().astype(np.float32),
                            bass=f.chroma(bass=True).astype(np.float32), labels=json.dumps(labels))
    else:
        sf.write(out / f"{name}.wav", audio, RENDER_SR, subtype="PCM_16")
        (out / f"{name}.json").write_text(json.dumps(labels | {"notes": len(song.notes)}))
    return name


def jobs(out: Path, per_scale: int, seconds: float, seed: int, backend: str, features: bool, max_tier: int = 2):
    rng = np.random.default_rng(seed)
    for sid, scale in library().items():
        if scale.tier > max_tier:
            continue
        for i in range(per_scale):
            yield (out, f"{sid}_{seed}_{i:04d}", int(rng.integers(12)), sid, seconds,
                   int(rng.integers(2**31)), backend, features)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", type=Path)
    ap.add_argument("--per-scale", type=int, default=4)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--backend", choices=["soundfont", "additive"], default="soundfont" if find_soundfont() else "additive")
    ap.add_argument("--features", action="store_true", help="keep features (.npz) instead of audio")
    ap.add_argument("--modulating", type=int, metavar="N",
                    help="instead: N songs with 0-2 key changes (WAV + JSON with sections), for the timeline")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.modulating:
        rng = np.random.default_rng(args.seed)
        todo = [(args.out, f"mod_{args.seed}_{i:04d}", args.seconds, int(rng.integers(2**31)), args.backend)
                for i in range(args.modulating)]
        todo = [j for j in todo if not (args.out / f"{j[1]}.wav").exists()]
        print(f"{len(todo)} modulating songs to make with the {args.backend} backend -> {args.out}")
        with Pool(args.workers) as pool:
            for i, _ in enumerate(pool.imap_unordered(_modulating_job, todo, chunksize=2), 1):
                if i % 20 == 0 or i == len(todo):
                    print(f"  {i}/{len(todo)}", flush=True)
        return
    todo = [j for j in jobs(args.out, args.per_scale, args.seconds, args.seed, args.backend, args.features)
            if not (args.out / f"{j[1]}.{'npz' if args.features else 'wav'}").exists()]
    print(f"{len(todo)} songs to make with the {args.backend} backend, {args.workers} workers -> {args.out}")
    with Pool(args.workers) as pool:
        for i, _ in enumerate(pool.imap_unordered(_job, todo, chunksize=4), 1):
            if i % 100 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)}", flush=True)
    (args.out / "songgen.json").write_text(json.dumps(vars(args) | {"out": str(args.out)}, indent=1))


if __name__ == "__main__":
    main()
