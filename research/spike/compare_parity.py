"""Phase 0: compare Essentia.js (browser) key results with Essentia (Python).

    python spike/compare_parity.py FIXTURE_DIR BENCH_RESULTS_JSON

FIXTURE_DIR must contain essentia_python_{wav,mp3}.json from
`python -m stoned_mango.essentia_key FIXTURE_DIR [--ext mp3]`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    fixtures, bench = Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text())
    for ext in ("wav", "mp3"):
        py = {r["name"]: r for r in json.loads((fixtures / f"essentia_python_{ext}.json").read_text())}
        js = {Path(f["name"]).stem: f for f in bench[f"parity_{ext}"]["summary"]["files"]}
        same = total = 0
        max_strength_diff = 0.0
        print(f"\n{ext.upper()}: piece, expected, then per profile Python -> browser")
        for name, p in py.items():
            j = js[name]
            cells = []
            for profile, pk in p["keys"].items():
                jk = j["keys"][profile]
                a, b = f"{pk['key']} {pk['scale']}", f"{jk['key']} {jk['scale']}"
                total += 1
                same += a == b
                max_strength_diff = max(max_strength_diff, abs(pk["strength"] - jk["strength"]))
                cells.append(f"{profile}: {a}" + ("" if a == b else f" -> {b} (!)"))
            print(f"  {name:26s} {p['expected']:9s} | " + "; ".join(cells))
            print(f"  {'':26s} tuning: Python {p['tuning_cents']:+.1f}c, browser {j['tuningCents']:+.1f}c")
        print(f"  agreement {same}/{total} labels, max strength difference {max_strength_diff:.3f}")


if __name__ == "__main__":
    main()
