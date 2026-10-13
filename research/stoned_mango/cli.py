"""stoned-mango command line: find the key and mode of audio files or whole folders.

    stoned-mango song.mp3
    stoned-mango ~/Music/set --format csv > keys.csv
    stoned-mango a.wav b.mp3 --format json

Everything runs locally; nothing is uploaded. With the fusion engine (phase 3)
confidences are calibrated: 0.8 means right about 80% of the time. "Key" confidence
covers the home note and major/minor family ("D minor family" for D Dorian).
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections.abc import Iterator
from pathlib import Path

from .analysis import analyse
from .audio import AUDIO_EXTENSIONS


def find_audio(paths: list[Path]) -> Iterator[Path]:
    for p in paths:
        if p.is_dir():
            yield from sorted(f for f in p.rglob("*") if f.is_file() and f.suffix.lower() in AUDIO_EXTENSIONS)
        elif p.is_file():
            yield p
        else:
            print(f"stoned-mango: {p}: no such file or folder", file=sys.stderr)


def _clock(seconds: float) -> str:
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}"


def _row(path: Path, r: dict) -> dict:
    return {
        "file": str(path),
        "key": r["label"],
        "parent": r.get("parent") or "",
        "confidence": r["confidence"],
        "key_confidence": r.get("key_confidence", ""),
        "note": (r.get("ambiguity") or {}).get("text", ""),
        "timeline": "; ".join(f"{_clock(s['start'])} {s['label']}" for s in r.get("segments", [])) if len(r.get("segments", [])) > 1 else "",
        "alternatives": "; ".join(a["label"] for a in r["alternatives"]),
        "tuning_cents": r["tuning_cents"],
        "duration_s": r["duration"],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="stoned-mango", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", type=Path, help="audio files and/or folders (searched recursively)")
    ap.add_argument("--format", choices=["table", "csv", "json"], default="table")
    ap.add_argument("--max-tier", type=int, default=2, help="largest scale tier to consider (see shared/scales.json)")
    ap.add_argument("--no-timeline", action="store_true", help="skip the key-changes timeline (faster)")
    ap.add_argument("--traditions", default="western",
                    help="maqam/makam/raga scales: western (never, the default), auto (only when a song clearly shows them), all, "
                         "or any of arabic,turkish,indian (always)")
    ap.add_argument("--engine", choices=["auto", "fusion", "cnn", "template"], default="auto",
                    help="auto (default): fusion if fitted, else the key CNN, else the template engine")
    args = ap.parse_args(argv)

    files = list(find_audio(args.paths))
    if not files:
        print("stoned-mango: no audio files found", file=sys.stderr)
        return 1

    writer = None
    results = []
    failures = 0
    for path in files:
        try:
            r = analyse(path, max_tier=args.max_tier, engine=args.engine, timeline=not args.no_timeline,
                        traditions=args.traditions)
        except Exception as e:  # keep going through a batch
            failures += 1
            print(f"stoned-mango: {path}: {e}", file=sys.stderr)
            continue
        row = _row(path, r)
        if args.format == "json":
            results.append({"file": str(path), **r})
        elif args.format == "csv":
            if writer is None:
                writer = csv.DictWriter(sys.stdout, fieldnames=list(row))
                writer.writeheader()
            writer.writerow(row)
        else:
            parent = f"  ({row['parent']})" if row["parent"] else ""
            tuning = f"{int(round(row['tuning_cents'])):+d}¢" if row["tuning_cents"] is not None else "–"
            family = ""
            if r.get("tradition"):
                family = f" (home note {r['key_confidence']:.2f})"
            elif r.get("key") and r.get("key_confidence") is not None:
                family = f" ({r['label'].split()[0]} {r['key']['third']} family {r['key_confidence']:.2f})"
            print(f"{path.name}: {row['key']}{parent}  confidence {row['confidence']:.2f}{family}  tuning {tuning}")
            if r.get("ambiguity"):
                print(f"    note: {r['ambiguity']['text']}")
            if r.get("best_guess"):
                print(f"    best guess: {r['best_guess']}")
            if r.get("western"):
                print(f"    in Western terms: {r['western']}")
            if r.get("ragas"):
                print(f"    ragas with these notes: {', '.join(r['ragas'])}")
            if row["alternatives"]:
                print(f"    also possible: {row['alternatives']}")
            if row["timeline"]:
                print("    key changes: " + "  →  ".join(
                    f"{_clock(s['start'])}–{_clock(s['end'])} {s['label']}" for s in r["segments"]))
        sys.stdout.flush()
    if args.format == "json":
        json.dump(results, sys.stdout, indent=2)
        print()
    return 1 if failures == len(files) else 0


if __name__ == "__main__":
    sys.exit(main())
