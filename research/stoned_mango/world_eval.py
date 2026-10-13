"""Measure tier 3 (maqam, makam, raga families) on synthetic songs, and check that ordinary
Western songs and keyless clips are left alone.

    python -m stoned_mango.world_eval WORLD_DIR [--western DIR ...] [--keyless] [--out results.json]

WORLD_DIR is made by ``python -m stoned_mango.worldgen``; a --western directory by
``python -m stoned_mango.synth DIR --eval-set N`` (any folder with a manifest.json works:
only whether tier 3 wrongly takes over is counted there).

Reports, per tradition: how often tier 3 is chosen ("auto" mode), the home note within
20 cents (the plan's measure for Sa), the exact scale, and the scale counting scales with
identical notes and emphasis as right; and for Western songs and keyless clips, how often
tier 3 wrongly takes over.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

from . import world
from .analysis import western_confidence
from .features import Features, extract, extract_array
from .scales import library

TONIC_TOLERANCE = 20.0


def cached_features(path: Path, cache: Path | None = None) -> Features:
    """Features of an audio file, saved next to it (or at ``cache``) after the first time."""
    cache = cache or path.with_suffix(".features.npz")
    if cache.exists():
        z = np.load(cache)
        return Features(int(z["sample_rate"]), float(z["hop_seconds"]), float(z["duration"]), z["hpcp"], z["bass"],
                        z["rms"], z["logspec"], float(z["tuning_cents"]), float(z["tuning_confidence"]))
    f = extract(path)
    np.savez_compressed(cache, sample_rate=f.sample_rate, hop_seconds=f.hop_seconds, duration=f.duration, hpcp=f.hpcp,
                        bass=f.bass, rms=f.rms, logspec=f.logspec, tuning_cents=f.tuning_cents,
                        tuning_confidence=f.tuning_confidence)
    return f


def circ(a: float, b: float, period: float = 1200.0) -> float:
    d = (a - b) % period
    return min(d, period - d)


def _same_template(a: str, b: str) -> bool:
    lib = library()
    return lib[a].cents == lib[b].cents and lib[a].dominant == lib[b].dominant


def score_world(f: Features, exp: dict, mode: str = "auto") -> dict:
    d = world.decide(f, mode, western_confidence(f))
    out = {"tradition": exp["tradition"], "scale": exp["scale"]}
    if d is None:
        return out | {"used": False}
    out |= {"used": bool(d.use), "deviation": d.evidence.deviation, "drone": d.evidence.drone, "fires": d.evidence.fires()}
    cands = d.cands
    if not cands:
        return out
    best = cands[0]
    err = circ(best.tonic_cents + f.tuning_cents, exp["tonic_cents"] + exp["tuning_cents"])
    out |= {"pred": best.scale, "tonic_err": err, "tonic_ok": err <= TONIC_TOLERANCE,
            "scale_ok": best.scale == exp["scale"], "scale_ok_same": _same_template(best.scale, exp["scale"]),
            "tradition_ok": library()[best.scale].tradition == exp["tradition"], "prob": best.prob,
            "fit": best.score, "western_fit": d.western}
    return out


def score_other(f: Features, mode: str = "auto") -> dict:
    d = world.decide(f, mode, western_confidence(f))
    if d is None:
        return {"used": False}
    return {"used": bool(d.use), "deviation": d.evidence.deviation, "drone": d.evidence.drone, "fires": d.evidence.fires(),
            "fit": d.cands[0].score if d.cands else None, "western_fit": d.western}


def summarise(rows: list[dict]) -> dict:
    out = {"n": len(rows)}
    for k in ("used", "fires", "tonic_ok", "scale_ok", "scale_ok_same", "tradition_ok"):
        vals = [r[k] for r in rows if k in r]
        if vals:
            out[k] = round(float(np.mean(vals)), 3)
    used = [r for r in rows if r.get("used") and "scale_ok" in r]
    if used:
        out["when_used"] = {k: round(float(np.mean([r[k] for r in used])), 3) for k in ("tonic_ok", "scale_ok", "scale_ok_same")}
        conf = np.array([r["prob"] for r in used])
        hit = np.array([r["scale_ok_same"] and r["tonic_ok"] for r in used], float)
        bins = np.minimum((conf * 10).astype(int), 9)
        out["when_used"]["mean_confidence"] = round(float(conf.mean()), 3)
        out["when_used"]["ece"] = round(float(sum(abs(conf[bins == b].mean() - hit[bins == b].mean()) * (bins == b).mean()
                                                  for b in range(10) if (bins == b).any())), 3)
    if any("tonic_err" in r for r in rows):
        out["tonic_err_median"] = round(float(np.median([r["tonic_err"] for r in rows if "tonic_err" in r])), 1)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("world", type=Path)
    ap.add_argument("--western", type=Path, nargs="*", default=[])
    ap.add_argument("--keyless", action="store_true", help="also check the noise and drum clips (keyless.py)")
    ap.add_argument("--mode", default="auto")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    rows = []
    for it in json.loads((args.world / "manifest.json").read_text()):
        rows.append(score_world(cached_features(args.world / it["file"]), it["expected"], args.mode))
    report = {"mode": args.mode, "world": summarise(rows), "by_tradition": {}}
    by = defaultdict(list)
    for r in rows:
        by[r["tradition"]].append(r)
    report["by_tradition"] = {t: summarise(v) for t, v in sorted(by.items())}
    for d in args.western:
        wrows = []
        for it in json.loads((d / "manifest.json").read_text()):
            name = it.get("file") or it["files"][0]
            wrows.append(score_other(cached_features(d / name), args.mode))
        report[f"western:{d.name}"] = summarise(wrows)
    if args.keyless:
        from .keyless import clips
        from .synth import SR as KEYLESS_SR

        krows = [score_other(extract_array(audio, KEYLESS_SR), args.mode) for _, audio in clips()]
        report["keyless"] = summarise(krows)
    print(json.dumps(report, indent=1))
    if args.out:
        args.out.write_text(json.dumps({"report": report, "rows": rows}, indent=1) + "\n")


if __name__ == "__main__":
    main()


def fit_temperature(world_dir: Path, grid=None) -> tuple[float, dict]:
    """The softmax temperature that makes tier 3 confidences honest on songs where it is used:
    minimises the negative log-likelihood of the right answer (home note within a quarter
    tone, same notes and emphasis). Returns (temperature, {temperature: (nll, ece)})."""
    grid = grid or [0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.04, 0.06, 0.08, 0.12]
    data = []
    for it in json.loads((world_dir / "manifest.json").read_text()):
        f = cached_features(world_dir / it["file"])
        d = world.decide(f, "auto", western_confidence(f))
        if d is None or not d.use:
            continue
        exp = it["expected"]
        scores = np.array([c.score for c in d.cands])
        right = np.array([circ(c.tonic_cents + f.tuning_cents, exp["tonic_cents"] + exp["tuning_cents"]) <= 25
                          and _same_template(c.scale, exp["scale"]) for c in d.cands])
        data.append((scores, right))
    table = {}
    for t in grid:
        nll, conf, hit = 0.0, [], []
        for scores, right in data:
            w = np.exp((scores - scores.max()) / t)
            w /= w.sum()
            nll -= np.log(max(float(w[right].sum()), 1e-12))
            conf.append(float(w[0]))
            hit.append(bool(right[0]))
        conf, hit = np.array(conf), np.array(hit)
        bins = np.minimum((conf * 10).astype(int), 9)
        ece = sum(abs(conf[bins == b].mean() - hit[bins == b].mean()) * (bins == b).mean() for b in range(10) if (bins == b).any())
        table[t] = (round(nll / max(1, len(data)), 3), round(float(ece), 3))
    best = min(table, key=lambda t: table[t][0])
    return best, table
