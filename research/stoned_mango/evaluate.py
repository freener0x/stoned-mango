"""Evaluation harness: run every engine over a dataset and score it.

    python -m stoned_mango.evaluate synthetic DIR       # manifest.json from `synth --eval-set`
    python -m stoned_mango.evaluate giantsteps DIR      # GiantSteps Key: annotations/key/*.key + audio/*.mp3
    python -m stoned_mango.evaluate beatport DIR        # Beatport EDM Key (GiantSteps MTG Key), same layout
    python -m stoned_mango.evaluate songs DIR           # WAV + JSON pairs from `songgen` (without --features)

Options: --limit N, --out results.json, --bass-weights 0 0.3 ..., --no-keyextractor,
--cnn MODEL.onnx (adds the CNN and CNN x template engines),
--fusion WEIGHTS.json ... (adds the phase 3 fusion engine: "fusion" for one file, "fusion_<file stem>"
for several; needs --cnn or the bundled model).

Metrics (each is the mean over items):
    weighted   mir_eval.key.weighted_score on the major/minor projection
               (1 exact, 0.5 fifth, 0.3 relative, 0.2 parallel)
    mm_exact   major/minor projection exactly right
    tonic      tonic pitch class right
    mode       tonic and scale both right (synthetic set only)
    notes      right set of notes, whatever the tonic (synthetic set only)

Engines with a probability (cnn, fusion) also report
    conf       the answer's probability: of the exact scale (synthetic) or of the home note
               and major/minor family (real music); ``ece`` compares it with ``mode`` or
               ``mm_exact``: 0 = perfectly calibrated
    flagged    an ambiguity note was shown ("A minor or A Dorian ...")
    in_note    the answer or the note's alternative was right (mode / mm_exact)
    split      with --timeline: the item was split into several key sections (its label has one key)
    no_key     "No clear key" (fusion only: key confidence under its no_key_below);
               ``no_key_right`` is how often those withheld answers would have been right
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import mir_eval
import numpy as np

from .ambiguity import ambiguity
from .analysis import DEFAULT_BASS_WEIGHT
from .engines import Candidate, combine, essentia_keys, score_scales
from .features import NOTE_NAMES, extract
from .scales import library


@dataclass
class Item:
    name: str
    audio: Path
    tonic: int
    scale: str | None  # scale id when the dataset has modes (synthetic), else None
    third: str  # "major" / "minor"
    family: str | None = None
    confidence: int | None = None  # Beatport EDM Key: annotator confidence 0-2


_PC = {n: i for i, n in enumerate(NOTE_NAMES)} | {"C#": 1, "Db": 1, "D#": 3, "Gb": 6, "F#": 6, "G#": 8, "A#": 10}


def _parse_key(text: str) -> tuple[int, str] | None:
    """'A minor', 'd minor\t2' -> (9, 'minor'). None for no key ('-') or two keys ('F minor / G# major')."""
    if "/" in text:
        return None
    m = re.match(r"\s*([A-Ga-g])([#b]?)\s*(major|minor|maj|min)\b", text, re.I)
    if not m:
        return None
    name = m.group(1).upper() + m.group(2)
    return _PC[name], "major" if m.group(3).lower().startswith("maj") else "minor"


def load_synthetic(root: Path) -> list[Item]:
    items = []
    lib = library()
    for it in json.loads((root / "manifest.json").read_text()):
        e = it["expected"]
        wav = next(f for f in it["files"] if f.endswith(".wav"))
        items.append(Item(it["name"], root / wav, e["tonic_pc"], e["mode"], lib[e["mode"]].third, lib[e["mode"]].family))
    return items


def load_songs(root: Path) -> list[Item]:
    items = []
    for js in sorted(root.glob("*.json")):
        lab = json.loads(js.read_text())
        if "scale" not in lab or not js.with_suffix(".wav").exists():
            continue
        items.append(Item(lab["name"], js.with_suffix(".wav"), lab["tonic"], lab["scale"], lab["third"], lab["family"]))
    return items


def load_giantsteps_style(root: Path) -> list[Item]:
    """GiantSteps Key and Beatport EDM Key share a layout: annotations/key/<id>.key, audio/<id>.mp3."""
    items = []
    for ann in sorted((root / "annotations" / "key").glob("*.key")):
        text = ann.read_text()
        parsed = _parse_key(text)
        audio = root / "audio" / (ann.stem + ".mp3")
        if parsed is None or not audio.exists():
            continue
        fields = text.split("\t")
        conf = int(fields[1]) if len(fields) > 1 and fields[1].strip().isdigit() else None
        items.append(Item(ann.stem, audio, parsed[0], None, parsed[1], confidence=conf))
    return items


LOADERS = {"synthetic": load_synthetic, "songs": load_songs, "giantsteps": load_giantsteps_style,
           "beatport": load_giantsteps_style}


def _mm(tonic: int, third: str) -> str:
    return f"{NOTE_NAMES[tonic % 12]} {third}"


def _probabilistic(cands: list[Candidate], chroma: np.ndarray, no_key_below: float | None = None) -> dict:
    note = ambiguity(cands, chroma)
    alt = next((c for c in cands if note and c.label == note["labels"][1]), None)
    from .fusion import key_confidence

    key_conf = key_confidence(cands)
    info = {"conf": cands[0].prob, "conf_key": key_conf, "alt": (alt.tonic, alt.scale) if alt else None}
    if no_key_below is not None:
        info["no_key"] = key_conf < no_key_below
    return info


def predictions(item: Item, bass_weights: list[float], keyextractor: bool, cnn=None,
                fusions: dict | None = None, timeline: bool = False) -> tuple[dict[str, tuple[int, str]], dict[str, dict]]:
    """Engine name -> (tonic, scale id) for one item, plus confidence and ambiguity
    info for the probabilistic engines. Features are computed once."""
    f = extract(item.audio)
    chroma, bass = f.chroma(), f.chroma(bass=True)
    out, info = {}, {}
    for bw in bass_weights:
        best = score_scales(chroma, bass, bass_weight=bw)[0]
        out[f"template_bass{bw:g}"] = (best.tonic, best.scale)
    if cnn is not None:
        net = cnn.candidates(f.logspec)
        out["cnn"] = (net[0].tonic, net[0].scale)
        info["cnn"] = _probabilistic(net, chroma)
        both = combine(net, score_scales(chroma, bass, bass_weight=DEFAULT_BASS_WEIGHT))[0]
        out["cnn_x_template"] = (both.tonic, both.scale)
    if fusions:
        from .fusion import song_features

        feats = song_features(f.logspec, chroma, bass, cnn)
        for name, fusion in fusions.items():
            fc = fusion.candidates(feats)
            out[name] = (fc[0].tonic, fc[0].scale)
            info[name] = _probabilistic(fc, chroma, fusion.no_key_below)
            if timeline:
                from .timeline import timeline as key_changes

                info[name]["sections"] = len(key_changes(f, fusion, cnn))
    for profile, r in essentia_keys(chroma).items():
        out[f"essentia_{profile}"] = (r["tonic"], r["scale"])
    if keyextractor:
        import essentia.standard as es

        audio = es.MonoLoader(filename=str(item.audio), sampleRate=22050)()
        for profile in ("edma", "temperley"):
            key, scale, _ = es.KeyExtractor(profileType=profile, sampleRate=22050, frameSize=4096, hopSize=2048)(audio)
            out[f"keyextractor_{profile}"] = (_PC[key], "ionian" if scale == "major" else "aeolian")
    return out, info


def score(item: Item, pred: tuple[int, str], info: dict | None = None) -> dict[str, float]:
    lib = library()
    tonic, sid = pred
    third = lib[sid].third
    m = {
        "weighted": float(mir_eval.key.weighted_score(_mm(item.tonic, item.third), _mm(tonic, third))),
        "mm_exact": float(tonic == item.tonic and third == item.third),
        "tonic": float(tonic == item.tonic),
    }
    if item.scale is not None:
        m["mode"] = float(tonic == item.tonic and sid == item.scale)
        want = {(item.tonic + p) % 12 for p in lib[item.scale].semitones}
        got = {(tonic + p) % 12 for p in lib[sid].semitones}
        m["notes"] = float(want == got)
    if info is not None:
        right = "mode" if item.scale is not None else "mm_exact"
        m["conf"] = float(info["conf"] if item.scale is not None else info["conf_key"])
        m["flagged"] = float(info["alt"] is not None)
        m["in_note"] = max(m[right], score(item, info["alt"])[right] if info["alt"] else 0.0)
        if "sections" in info:  # the song's single labelled key, so more than one section is a false change
            m["split"] = float(info["sections"] > 1)
        if "no_key" in info:
            m["no_key"] = float(info["no_key"])
    return m


def summarise(rows: list[dict], by: str | None = None) -> dict:
    groups = defaultdict(list)
    for r in rows:
        groups[r[by] if by else "all"].append(r)
    out = {}
    for g, rs in groups.items():
        per_engine = defaultdict(lambda: defaultdict(list))
        for r in rs:
            for eng, m in r["metrics"].items():
                for k, v in m.items():
                    per_engine[eng][k].append(v)
        out[g] = {}
        for eng, ms in per_engine.items():
            out[g][eng] = {k: round(float(np.mean(v)), 3) for k, v in ms.items()}
            if "conf" in ms:
                from .fusion import expected_calibration_error

                right = ms["mode"] if "mode" in ms else ms["mm_exact"]
                out[g][eng]["ece"] = round(expected_calibration_error(ms["conf"], right), 3)
            if any(ms.get("no_key", [])):
                withheld = np.array(ms["no_key"], bool)
                right = np.array(ms["mode"] if "mode" in ms else ms["mm_exact"])
                out[g][eng]["no_key_right"] = round(float(right[withheld].mean()), 3)
            out[g][eng]["n"] = len(rs)
    return out


def print_table(engines: dict, title: str) -> None:
    print(f"\n{title}")
    metrics = list(dict.fromkeys(k for m in engines.values() for k in m if k != "n"))
    print(f"  {'engine':24s} " + " ".join(f"{m:>9s}" for m in metrics))
    for eng, m in sorted(engines.items(), key=lambda kv: -kv[1].get("mode", kv[1]["weighted"])):
        print(f"  {eng:24s} " + " ".join(f"{m[k]:9.3f}" if k in m else f"{'':9s}" for k in metrics))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", choices=sorted(LOADERS))
    ap.add_argument("root", type=Path)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--bass-weights", type=float, nargs="+", default=[0.0, DEFAULT_BASS_WEIGHT])
    ap.add_argument("--no-keyextractor", action="store_true", help="skip the original Essentia KeyExtractor baseline")
    ap.add_argument("--cnn", type=Path, help="an exported key CNN (.onnx with its .json model card)")
    ap.add_argument("--fusion", type=Path, nargs="+", default=[], help="fusion weights (shared/fusion.json) to evaluate")
    ap.add_argument("--timeline", action="store_true",
                    help="also run the timeline with each fusion; 'split' = share of (single-key) items split into sections")
    args = ap.parse_args()
    cnn, fusions = None, {}
    if args.cnn:
        from .cnn.engine import CnnEngine

        cnn = CnnEngine(args.cnn)
    if args.fusion:
        from .analysis import default_cnn
        from .fusion import Fusion

        fusions = {"fusion" if len(args.fusion) == 1 else f"fusion_{p.stem}": Fusion.load(p) for p in args.fusion}
        cnn = cnn or default_cnn()
        if cnn is None:
            sys.exit("--fusion needs the key CNN (--cnn MODEL.onnx, or the bundled model and onnxruntime)")

    items = LOADERS[args.dataset](args.root)[: args.limit]
    if not items:
        sys.exit(f"no items found under {args.root}")
    rows = []
    t0 = time.time()
    for i, item in enumerate(items, 1):
        preds, info = predictions(item, args.bass_weights, not args.no_keyextractor, cnn, fusions, args.timeline)
        rows.append({
            "name": item.name, "family": item.family or "-", "scale": item.scale or item.third,
            "expected": [item.tonic, item.scale or item.third],
            "predicted": {k: [v[0], v[1]] for k, v in preds.items()},
            "metrics": {k: score(item, v, info.get(k)) for k, v in preds.items()},
        })
        if i % 20 == 0 or i == len(items):
            print(f"  {i}/{len(items)} items, {time.time() - t0:.0f}s", file=sys.stderr)

    overall = summarise(rows)
    print_table(overall["all"], f"{args.dataset}: {len(items)} items")
    result = {"dataset": args.dataset, "n": len(items), "overall": overall["all"]}
    if args.dataset in ("synthetic", "songs"):
        best = max(overall["all"], key=lambda e: overall["all"][e].get("mode", 0))
        fam = summarise(rows, "family")
        scl = summarise(rows, "scale")
        print(f"\nBy family ({best}): mode / tonic / notes")
        for f, engines in sorted(fam.items()):
            m = engines[best]
            print(f"  {f:18s} n={m['n']:3d}  mode={m['mode']:.2f} tonic={m['tonic']:.2f} notes={m['notes']:.2f}")
        result["by_family"] = fam
        result["by_scale"] = {s: e[best] for s, e in scl.items()}
        result["best_engine"] = best
    result["rows"] = rows
    if args.out:
        args.out.write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
