"""Human-readable summary of a training run (what train.sh writes to SUMMARY.md).

    python -m stoned_mango.cnn.summary RUN_DIR
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ENGINES = ["cnn_x_template", "cnn", "template_bass0.3", "keyextractor_edma"]
NAMES = {"cnn_x_template": "CNN x template", "cnn": "CNN alone", "template_bass0.3": "Template + bass (phase 1)",
         "keyextractor_edma": "Essentia KeyExtractor (edma)"}


def _table(result: dict, metrics: list[str]) -> list[str]:
    lines = ["| Engine | " + " | ".join(metrics) + " |", "|---" * (len(metrics) + 1) + "|"]
    for eng in ENGINES:
        m = result["overall"].get(eng)
        if m:
            lines.append(f"| {NAMES[eng]} | " + " | ".join(f"{m[k]:.3f}" for k in metrics) + " |")
    return lines


def summary(run: Path) -> str:
    out = [f"# Training run {run.name}", ""]
    log = [json.loads(line) for line in (run / "log.jsonl").read_text().splitlines() if line.strip()]
    if log:
        best = max(log, key=lambda e: e["score"])
        out += [f"- Epochs run: {len(log)}; best epoch {best['epoch']} (score {best['score']:.3f}), "
                f"{sum(e['seconds'] for e in log) / 60:.0f} min of training", "- Validation at the best epoch:"]
        out += [f"  - {name}: " + ", ".join(f"{k} {v:.3f}" for k, v in m.items() if k != "n" and v is not None)
                + f" (n={m['n']})" for name, m in best["val"].items()]
    card = run / "model" / "key-cnn.fp32.json"
    if card.exists():
        c = json.loads(card.read_text())
        int8 = run / "model" / "key-cnn.int8.onnx"
        out += [f"- Model: {c['bytes'] / 1024:.0f} KiB fp32"
                + (f", {int8.stat().st_size / 1024:.0f} KiB int8" if int8.exists() else "")
                + f"; int8 agrees with fp32 on {c.get('int8_top1_agreement_with_fp32', 0):.1%} of songs; "
                f"ONNX vs PyTorch max difference {c['onnx_vs_torch_max_abs_diff']:.1e}"]
    for name, title, metrics in [
        ("eval-giantsteps.json", "GiantSteps Key (real EDM tracks, never trained on)", ["weighted", "mm_exact", "tonic"]),
        ("eval-heldout-songs.json", "Held-out synthetic songs (30 scales)", ["weighted", "tonic", "mode", "notes"]),
    ]:
        path = run / name
        if path.exists():
            r = json.loads(path.read_text())
            out += ["", f"## {title}: {r['n']} items", ""] + _table(r, metrics)
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    print(summary(Path(sys.argv[1])))
