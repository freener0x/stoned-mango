"""Feature caches for training: one ``.npz`` per song.

Synthetic caches come from ``python -m stoned_mango.songgen DIR --features``.
Real-music caches come from this module:

    python -m stoned_mango.cnn.data beatport path/to/giantsteps-mtg-key-dataset OUT_DIR
    python -m stoned_mango.cnn.data giantsteps path/to/giantsteps-key-dataset OUT_DIR

Each npz holds ``logspec`` ([frames, 105] float16), ``chroma`` and ``bass``
(12-bin, for the template engine) and ``labels`` (JSON: tonic, third and,
when known, scale).
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from multiprocessing import Pool
from pathlib import Path

import numpy as np

from ..features import LOGSPEC_BANDS_PER_OCTAVE, extract
from .labels import THIRDS, joint_index, scale_ids

BINS_PER_SEMITONE = LOGSPEC_BANDS_PER_OCTAVE // 12


@dataclass
class Example:
    name: str
    logspec: np.ndarray  # [frames, 105] float16
    tonic: int  # -1 if unknown
    third: str | None
    scale: int  # index into scale_ids(), -1 if unknown
    source: str


def load_cache(root: Path, source: str | None = None) -> list[Example]:
    ids = scale_ids()
    out = []
    for p in sorted(Path(root).glob("*.npz")):
        with np.load(p) as z:
            lab = json.loads(str(z["labels"]))
            out.append(Example(
                name=p.stem, logspec=z["logspec"], tonic=int(lab.get("tonic", -1)), third=lab.get("third"),
                scale=ids.index(lab["scale"]) if lab.get("scale") in ids else -1, source=source or Path(root).name,
            ))
    return out


def split(examples: list[Example], val_fraction: float, seed: int) -> tuple[list[Example], list[Example]]:
    """(train, validation). Deterministic, so later steps can recover exactly what training never saw."""
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(examples))
    n_val = max(1, int(round(len(examples) * val_fraction))) if len(examples) > 1 else 0
    return [examples[i] for i in idx[n_val:]], [examples[i] for i in idx[:n_val]]


def transpose(logspec: np.ndarray, semitones: int) -> np.ndarray:
    """Shift a log-frequency spectrogram up by whole semitones (zero-filled at the edge).

    Band k is centred at C2 * 2^(k/24), so a shift of 2 bands is exactly one semitone.
    """
    s = semitones * BINS_PER_SEMITONE
    out = np.zeros_like(logspec)
    if s > 0:
        out[:, s:] = logspec[:, :-s]
    elif s < 0:
        out[:, :s] = logspec[:, -s:]
    else:
        out[:] = logspec
    return out


def targets(ex: Example, shift: int = 0) -> tuple[int, int, int]:
    """(joint scale*12+tonic index or -1, tonic or -1, third 0/1 or -1) after transposing by ``shift``.

    Songs with a known scale train the joint output directly; songs with only a
    major/minor label train the sum over scales with that third.
    """
    tonic = (ex.tonic + shift) % 12 if ex.tonic >= 0 else -1
    joint = joint_index(ex.scale, tonic) if ex.scale >= 0 and tonic >= 0 else -1
    third = THIRDS.index(ex.third) if ex.third in THIRDS and tonic >= 0 else -1
    return joint, tonic, third


def crop(logspec: np.ndarray, length: int, rng: np.random.Generator) -> np.ndarray:
    if len(logspec) >= length:
        start = int(rng.integers(0, len(logspec) - length + 1))
        return logspec[start:start + length]
    reps = int(np.ceil(length / max(1, len(logspec))))
    return np.tile(logspec, (reps, 1))[:length]


# ---- real-music caches -------------------------------------------------------


def _cache_job(args):
    audio, out, labels = args
    target = out / f"{labels['name']}.npz"
    if target.exists():
        return labels["name"], None
    try:
        f = extract(audio)
    except Exception as e:  # a broken download shouldn't stop the batch
        return labels["name"], str(e)
    np.savez_compressed(target, logspec=f.logspec.astype(np.float16), chroma=f.chroma().astype(np.float32),
                        bass=f.chroma(bass=True).astype(np.float32), labels=json.dumps(labels))
    return labels["name"], None


def build_real(dataset: str, root: Path, out: Path, workers: int) -> None:
    from ..evaluate import LOADERS

    out.mkdir(parents=True, exist_ok=True)
    # Beatport EDM Key: skip tracks the annotator marked as uncertain (confidence 0).
    items = [it for it in LOADERS[dataset](root) if it.confidence != 0]
    jobs = [(it.audio, out, {"name": it.name, "tonic": it.tonic, "third": it.third, "dataset": dataset,
                             "confidence": it.confidence}) for it in items]
    print(f"{len(jobs)} {dataset} tracks -> {out}")
    failed = 0
    with Pool(workers) as pool:
        for i, (name, err) in enumerate(pool.imap_unordered(_cache_job, jobs, chunksize=4), 1):
            if err:
                failed += 1
                print(f"  {name}: {err}")
            if i % 100 == 0 or i == len(jobs):
                print(f"  {i}/{len(jobs)}", flush=True)
    print(f"done, {failed} failed")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", choices=["giantsteps", "beatport"])
    ap.add_argument("root", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()
    build_real(args.dataset, args.root, args.out, args.workers)


if __name__ == "__main__":
    main()
