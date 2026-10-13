"""Human-readable summary of a calibration run (what calibrate.sh writes to SUMMARY.md).

    python -m stoned_mango.fusion_summary RUN_DIR
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

NAMES = {"cnn": "CNN alone", "template_bass0.3": "Template + bass (phase 1)",
         "keyextractor_edma": "Essentia KeyExtractor (edma)"}
COLUMNS = ["weighted", "mm_exact", "tonic", "mode", "notes", "conf", "ece", "flagged", "in_note", "no_key",
           "no_key_right", "split"]


def _name(engine: str) -> str:
    if engine.startswith("fusion"):
        return "Fusion" + (f" ({engine[len('fusion_'):]})" if engine != "fusion" else "")
    return NAMES.get(engine, engine)


def _table(result: dict) -> list[str]:
    engines = {e: m for e, m in result["overall"].items() if e.startswith("fusion") or e in NAMES}
    cols = [c for c in COLUMNS if any(c in m for m in engines.values())]
    lines = ["| Engine | " + " | ".join(cols) + " |", "|---" * (len(cols) + 1) + "|"]
    for eng, m in sorted(engines.items(), key=lambda kv: -kv[1]["weighted"]):
        lines.append(f"| {_name(eng)} | " + " | ".join(f"{m[c]:.3f}" if c in m else "" for c in cols) + " |")
    return lines


def summary(run: Path) -> str:
    out = [f"# Results {run.name}", ""]
    for path in sorted(run.glob("fusion*.json")):
        d = json.loads(path.read_text())
        meta = d.get("meta", {})
        out += [f"- `{path.name}`: weights " + ", ".join(f"{k} {v:.3f}" for k, v in d["weights"].items())
                + f"; no clear key below {d['no_key_below']:.3f} (keyless clips up to {meta.get('keyless_max', 0):.3f}"
                + "".join(f", {k} withheld {v:.1%}" for k, v in meta.get("withheld", {}).items()) + ")"
                + f"; fitted on {meta.get('fitted_on')}: accuracy {meta.get('fit_accuracy')}, ECE {meta.get('fit_ece')}"
                + (f"; real-music temperature {meta['real_temperature']:.3f}, ECE by source {meta.get('fit_ece_by_source')}"
                   if "real_temperature" in meta else "")]
    for name, title in [("eval-giantsteps.json", "GiantSteps Key (real EDM tracks, never trained on)"),
                        ("eval-heldout-songs.json", "Held-out synthetic songs (30 scales)")]:
        path = run / name
        if path.exists():
            r = json.loads(path.read_text())
            out += ["", f"## {title}: {r['n']} items", ""] + _table(r)
    out += ["", "Columns: weighted = MIREX score; mm_exact = major/minor right; mode = exact scale right;",
            "conf = mean confidence; ece = calibration error (0 is perfect); flagged = ambiguity note shown;",
            "in_note = answer or the note's alternative right; no_key = answered \"No clear key\";",
            "no_key_right = how often those withheld answers would have been right;",
            "split = the timeline wrongly split a single-key track into several keys."]
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    print(summary(Path(sys.argv[1])))
