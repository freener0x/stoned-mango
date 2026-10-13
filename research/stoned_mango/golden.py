"""Golden files for the browser engine's parity tests (PLAN.md section 7).

    python -m stoned_mango.golden [--out ../shared/golden]

Writes a few short reference clips (16-bit WAV) and, for each, what this Python
engine computes from that very file: pitch features, the CNN's and the fusion's
log-probabilities, and the full result with its timeline. web/tests/parity.test.ts
runs the TypeScript engine on the same WAVs and must agree within tolerance.

The clips are small on purpose (about 3 MB in all):
  modulating-22k.wav   C major for 18 s, then G major: the timeline must find the change
  dorian-44k-stereo.wav  D Dorian, 44.1 kHz stereo, silent start and end: resampler, downmix, empty frames
  noise-22k.wav        pink noise: little or no key
  sikah-22k.wav        Maqam Sikah on E half-flat (tier 3): quarter tones and a quarter-tone home note
  kalyan-22k.wav       Kalyan thaat, Sa = D, with a tanpura drone (tier 3): the drone cue and the raga shortlist

Every clip also records the tier 3 intermediate values (world.py), so Western clips check
that tier 3 stays out in the browser too.

and two compressed copies for the browser's decoders (web/tests/browser.mjs checks the
label and sections only, since lossy decoders differ slightly):
  modulating-22k.mp3   WebCodecs MP3 decoding, streamed frame by frame
  dorian-22k.flac      the main-thread decodeAudioData fallback
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import soundfile as sf

from .analysis import analyse_features, default_cnn, default_fusion
from .audio import Resampler
from .features import extract
from .fusion import song_features
from .synth import SR, Piece, Section, render
from .worldgen import SR as WORLD_SR, WorldPiece, render as render_world

GOLDEN = Path(__file__).resolve().parents[2] / "shared" / "golden"


def _to_22k(x: np.ndarray) -> np.ndarray:
    return Resampler(SR).push(x.astype(np.float32))


def clips() -> dict[str, tuple[np.ndarray, int]]:
    """name -> (audio [samples] or [samples, channels], sample rate)."""
    mod = render(Piece("mod", [Section(0, "ionian", [1, 4, 5, 1], 12), Section(7, "ionian", [1, 4, 5, 1], 12)],
                       bpm=160.0), seed=11)
    dorian = render(Piece("dor", [Section(2, "dorian", [1, 4, 1, 7], 4)], bpm=160.0), seed=12)[: 6 * SR]
    silence = np.zeros(int(0.75 * SR), np.float32)  # digital silence: frames with no spectral peaks at all
    dorian = np.concatenate([silence, dorian, silence])
    stereo = np.stack([dorian, 0.6 * dorian], axis=1)
    rng = np.random.default_rng(13)
    spec = np.fft.rfft(rng.normal(size=4 * 22050))
    f = np.arange(len(spec), dtype=float)
    f[0] = 1.0
    noise = np.fft.irfft(spec / np.sqrt(f), 4 * 22050)
    sikah = render_world(WorldPiece("sikah", "maqam_sikah", 350.0, 0.0, 20.0, False, 12))
    kalyan = render_world(WorldPiece("kalyan", "mela_65", 200.0, 0.0, 20.0, True, 12))
    return {"modulating-22k": (_to_22k(mod), 22050), "dorian-44k-stereo": (stereo, SR),
            "noise-22k": (0.5 * noise / np.abs(noise).max(), 22050),
            "sikah-22k": (sikah, WORLD_SR), "kalyan-22k": (kalyan, WORLD_SR)}


def _world(f) -> dict | None:
    """Tier 3's intermediate values: the lead-line profile, intonation, drone, the top candidates."""
    from . import world

    d = world.decide(f)
    if d is None:
        return None
    frames = world._tuned_frames(f)
    return {"lead": world.lead_profile(frames).tolist(), "ending": world.ending_profile(frames, f.hop_seconds).tolist(),
            "deviation": d.evidence.deviation,
            "quarter_tones": d.evidence.quarter_tones, "drone": d.evidence.drone, "western": d.western,
            "use": d.use, "top": [{"tonic_step": c.tonic_step, "scale": c.scale, "score": c.score, "fit": c.fit, "prob": c.prob}
                                  for c in d.cands[:5]]}


def _compressed(out: Path) -> dict[str, str]:
    """Writes the MP3 and FLAC copies; returns file -> the WAV it was made from."""
    import lameenc  # spike extra; the files are committed, so only needed to remake them

    mod, rate = sf.read(out / "modulating-22k.wav", dtype="int16")
    enc = lameenc.Encoder()
    enc.set_bit_rate(96)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    (out / "modulating-22k.mp3").write_bytes(enc.encode(mod.tobytes()) + enc.flush())
    dorian, rate = sf.read(out / "dorian-44k-stereo.wav", dtype="float32")
    sf.write(out / "dorian-22k.flac", Resampler(rate).push(dorian.mean(axis=1)), 22050, subtype="PCM_16")
    return {"modulating-22k.mp3": "modulating-22k.wav", "dorian-22k.flac": "dorian-44k-stereo.wav"}


def expected(path: Path) -> dict:
    f = extract(path)
    cnn, fusion = default_cnn(), default_fusion()
    chroma, bass = f.chroma(), f.chroma(bass=True)
    out = {
        "features": {
            "sample_rate": f.sample_rate, "frames": f.frames, "duration": f.duration,
            "tuning_cents": f.tuning_cents, "voiced": int(f.voiced().size),
            "chroma": chroma.tolist(), "bass_chroma": bass.tolist(),
            "logspec_mean": f.logspec.mean(axis=0).tolist(), "rms_mean": float(f.rms.mean()),
            "hpcp_mid_frame": f.hpcp[f.frames // 2].tolist(),
        },
    }
    if cnn is not None:
        out["cnn_log_probs"] = cnn.log_probs(f.logspec).tolist()
        if fusion is not None and f.voiced().size:
            out["fusion_log_probs"] = fusion.log_probs(song_features(f.logspec, chroma, bass, cnn)).tolist()
    out["world"] = _world(f)
    out["result"] = analyse_features(f, traditions="auto")  # tier 3 too (the clips include maqam and thaat songs)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=GOLDEN)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    cnn, fusion = default_cnn(), default_fusion()
    manifest = {"$comment": "Written by `python -m stoned_mango.golden`; checked by web/tests/parity.test.ts.",
                "model": f"{cnn.path.name} sha256:{hashlib.sha256(cnn.path.read_bytes()).hexdigest()[:16]}" if cnn else None,
                "fusion": fusion.weights if fusion else None, "clips": {}}
    for name, (audio, rate) in clips().items():
        wav = args.out / f"{name}.wav"
        sf.write(wav, audio, rate, subtype="PCM_16")
        exp = expected(wav)
        (args.out / f"{name}.json").write_text(json.dumps(exp, indent=1) + "\n")
        manifest["clips"][name] = {"wav": wav.name, "expected": f"{name}.json", "label": exp["result"]["label"],
                                   "segments": [s["label"] for s in exp["result"]["segments"]]}
        print(f"{name}: {exp['result']['label']}, segments {manifest['clips'][name]['segments']}")
    manifest["compressed"] = {}
    for name, write in _compressed(args.out).items():
        r = analyse_features(extract(args.out / name), traditions="auto")
        manifest["compressed"][name] = {"source": write, "label": r["label"], "segments": [s["label"] for s in r["segments"]]}
        print(f"{name}: {r['label']}, segments {manifest['compressed'][name]['segments']}")
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")


if __name__ == "__main__":
    main()
