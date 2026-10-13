"""Score the timeline on songs with known key changes (``songgen --modulating``).

    python -m stoned_mango.timeline_eval DIR [--grid] [--change 6 --per-note 1] [--out results.json]

Metrics (means over songs):
    boundary_f   change points found within +/-3 s (F-measure; 1 when neither side has any)
    key_time     share of the song's time labelled with exactly the right key (home note + scale)
    mm_time      share labelled with the right home note and major/minor family
    notes_time   share labelled with the right notes, whatever the home note
    split_rate   single-key songs only: how often they were wrongly split into sections
    within_3s    songs with changes: share of true changes that have a found change within 3 s

``global`` is the baseline without a timeline: the whole-song answer for the whole song.
``--grid`` tries a range of HMM costs and prints each, to choose ``CHANGE_COST``/``PER_NOTE_COST``.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from multiprocessing import Pool
from pathlib import Path

import numpy as np

from .scales import library

TOLERANCE = 3.0
GRID_CHANGE = (2.0, 4.0, 6.0, 9.0, 13.0)
GRID_PER_NOTE = (0.0, 0.5, 1.0, 2.0)


def _key_at(sections: list[dict], t: float):
    for s in sections:
        if s["start"] <= t < s["end"]:
            return s
    return sections[-1]


def score_song(ref: list[dict], est: list[dict], tol: float = TOLERANCE) -> dict:
    """Compare estimated sections (``timeline`` output) with the true ones."""
    lib = library()
    ref_b = [s["start"] for s in ref[1:]]
    est_b = [s["start"] for s in est[1:]]
    used, found = set(), []
    for r in ref_b:  # greedy one-to-one matching, nearest first
        cands = sorted((abs(e - r), j) for j, e in enumerate(est_b) if j not in used and abs(e - r) <= tol)
        if cands:
            used.add(cands[0][1])
        found.append(bool(cands))
    hits = sum(found)
    p = hits / len(est_b) if est_b else 1.0
    r = hits / len(ref_b) if ref_b else 1.0
    f = 2 * p * r / (p + r) if p + r > 0 else 0.0
    end = ref[-1]["end"]
    times = np.arange(0.05, end, 0.1)
    key = mm = notes = 0
    for t in times:
        a, b = _key_at(ref, t), _key_at(est, t)
        if b.get("key") is None:
            continue
        bt, bs = b["key"]["tonic"], b["key"]["scale"]
        key += (bt == a["tonic"] and bs == a["scale"])
        mm += (bt == a["tonic"] and lib[bs].third == lib[a["scale"]].third)
        notes += ({(bt + x) % 12 for x in lib[bs].semitones} == {(a["tonic"] + x) % 12 for x in lib[a["scale"]].semitones})
    n = max(1, len(times))
    return {"boundary_f": f, "key_time": key / n, "mm_time": mm / n, "notes_time": notes / n,
            "n_ref": len(ref), "n_est": len(est), "hits": hits, "n_ref_changes": len(ref_b), "found": found}


def global_sections(f, fusion, cnn) -> list[dict]:
    from .timeline import RangeScorer, candidates_from

    lp = RangeScorer(f, fusion, cnn).log_probs(0, f.frames)
    if lp is None:
        return [{"start": 0.0, "end": f.duration, "key": None}]
    best = candidates_from(lp)[0]
    return [{"start": 0.0, "end": f.duration, "key": {"tonic": best.tonic, "scale": best.scale}}]


def _song(job: tuple) -> dict:
    """All metrics for one song: the global baseline and every (change, per_note) pair."""
    from .analysis import default_cnn, default_fusion
    from .features import extract
    from .timeline import decode, prepare

    wav, settings, engine = job
    labels = json.loads(Path(wav).with_suffix(".json").read_text())
    ref = labels["sections"]
    f = extract(wav)
    cnn = default_cnn() if engine in ("fusion", "cnn") else None
    fusion = default_fusion() if engine == "fusion" else None
    prep = prepare(f, fusion, cnn)
    out = {"name": labels["name"], "changes": [s["change"] for s in ref[1:]],
           "global": score_song(ref, global_sections(f, fusion, cnn))}
    for change, per_note in settings:
        out[f"{change:g}/{per_note:g}"] = score_song(ref, decode(prep, change, per_note))
    return out


def summarise(rows: list[dict]) -> dict:
    keys = [k for k in rows[0] if k not in ("name", "changes")]
    out = {}
    for k in keys:
        ms = [r[k] for r in rows]
        single = [m for m in ms if m["n_ref"] == 1]
        multi = [m for m in ms if m["n_ref"] > 1]
        out[k] = {m: round(float(np.mean([x[m] for x in ms])), 3) for m in ("boundary_f", "key_time", "mm_time", "notes_time")}
        out[k]["split_rate"] = round(float(np.mean([m["n_est"] > 1 for m in single])), 3) if single else None
        out[k]["within_3s"] = (round(sum(m["hits"] for m in multi) / max(1, sum(m["n_ref_changes"] for m in multi)), 3)
                               if multi else None)
    by_kind = defaultdict(lambda: defaultdict(list))  # change kind -> setting -> found within 3 s?
    for r in rows:
        for k in keys:
            for kind, hit in zip(r["changes"], r[k]["found"]):
                by_kind[kind][k].append(hit)
    out["_by_change"] = {kind: {k: round(float(np.mean(v)), 3) for k, v in d.items()} for kind, d in by_kind.items()}
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", type=Path)
    ap.add_argument("--grid", action="store_true", help="try a range of HMM costs")
    ap.add_argument("--grid-change", type=float, nargs="+", default=list(GRID_CHANGE))
    ap.add_argument("--grid-per-note", type=float, nargs="+", default=list(GRID_PER_NOTE))
    ap.add_argument("--change", type=float)
    ap.add_argument("--per-note", type=float)
    ap.add_argument("--engine", choices=["fusion", "cnn", "template"], default="fusion")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)

    from .timeline import CHANGE_COST, PER_NOTE_COST

    wavs = [w for w in sorted(args.root.glob("*.wav")) if w.with_suffix(".json").exists()][: args.limit]
    if not wavs:
        sys.exit(f"no songs under {args.root}")
    if args.grid:
        settings = [(c, p) for c in args.grid_change for p in args.grid_per_note]
    else:
        settings = [(args.change if args.change is not None else CHANGE_COST,
                     args.per_note if args.per_note is not None else PER_NOTE_COST)]
    t0, rows = time.time(), []
    with Pool(args.workers) as pool:
        for i, r in enumerate(pool.imap_unordered(_song, [(str(w), settings, args.engine) for w in wavs]), 1):
            rows.append(r)
            if i % 20 == 0 or i == len(wavs):
                print(f"  {i}/{len(wavs)} songs, {time.time() - t0:.0f}s", file=sys.stderr, flush=True)
    summary = summarise(rows)
    n_single = sum(r["global"]["n_ref"] == 1 for r in rows)
    print(f"\n{args.root.name}: {len(rows)} songs ({n_single} without a key change), engine {args.engine}")
    print(f"  {'setting':10s} {'boundary_f':>10s} {'within_3s':>9s} {'split_rate':>10s} {'key_time':>8s} {'mm_time':>7s} {'notes_time':>10s}")
    for k, m in summary.items():
        if k.startswith("_"):
            continue
        fmt = lambda v: f"{v:.3f}" if v is not None else "  -  "  # noqa: E731
        print(f"  {k:10s} {m['boundary_f']:10.3f} {fmt(m['within_3s']):>9s} {fmt(m['split_rate']):>10s} "
              f"{m['key_time']:8.3f} {m['mm_time']:7.3f} {m['notes_time']:10.3f}")
    print("\nChanges found within 3 s, by kind of change:")
    for kind, d in sorted(summary["_by_change"].items()):
        print(f"  {kind:15s} n={len([r for r in rows if kind in r['changes']]):3d}  "
              + "  ".join(f"{k}={v:.2f}" for k, v in d.items() if k != "global"))
    if args.out:
        args.out.write_text(json.dumps({"engine": args.engine, "n": len(rows), "summary": summary, "rows": rows}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
