"""Classic key estimation with Essentia's KeyExtractor (major/minor only).

This is engine [5b] in PLAN.md and the Python reference the browser build
(Essentia.js) is checked against.

    python -m stoned_mango.essentia_key FIXTURE_DIR   # runs over manifest.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import essentia
import essentia.standard as es
import numpy as np

essentia.log.infoActive = False

SAMPLE_RATE = 22050
PROFILES = ("edma", "bgate", "temperley", "krumhansl")
# Frame settings shared with web/src/spike/worker.ts; keep them in sync.
FRAME_SIZE = 4096
HOP_SIZE = 2048


def load(path: Path, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Decode, downmix to mono and resample, as the browser does."""
    return es.MonoLoader(filename=str(path), sampleRate=sample_rate)()


def keys(audio: np.ndarray, sample_rate: int = SAMPLE_RATE, profiles=PROFILES) -> dict:
    out = {}
    for profile in profiles:
        key, scale, strength = es.KeyExtractor(
            profileType=profile, sampleRate=sample_rate, frameSize=FRAME_SIZE, hopSize=HOP_SIZE
        )(audio)
        out[profile] = {"key": key, "scale": scale, "strength": round(float(strength), 4)}
    return out


def tuning_cents(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> float:
    freq = es.TuningFrequencyExtractor(frameSize=FRAME_SIZE, hopSize=HOP_SIZE)(
        audio if sample_rate == 44100 else es.Resample(inputSampleRate=sample_rate, outputSampleRate=44100)(audio)
    )
    return float(1200 * np.log2(np.median(freq) / 440.0))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("fixtures", type=Path)
    ap.add_argument("--ext", default="wav", choices=["wav", "mp3"])
    args = ap.parse_args()

    manifest = json.loads((args.fixtures / "manifest.json").read_text())
    results = []
    for item in manifest:
        if item["name"].startswith("long_"):
            continue
        audio = load(args.fixtures / f"{item['name']}.{args.ext}")
        res = {"name": item["name"], "expected": item["expected"]["major_minor"],
               "keys": keys(audio), "tuning_cents": round(tuning_cents(audio), 1)}
        results.append(res)
        got = {p: f"{v['key']} {v['scale']}" for p, v in res["keys"].items()}
        print(f"{item['name']:28s} expected {res['expected']:10s} got {got}  tuning {res['tuning_cents']:+.1f}c")
    (args.fixtures / f"essentia_python_{args.ext}.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
