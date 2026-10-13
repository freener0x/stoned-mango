#!/usr/bin/env bash
# One-time setup: Python environment with CUDA PyTorch, tests, datasets, and a first real-music evaluation.
source "$(dirname "$0")/common.sh" "$@"
cd "$REPO/research"

step "Python environment ($(python3 --version))"
[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
pip install -q --upgrade pip

step "PyTorch with CUDA (about 3 GB the first time)"
if ! python -c "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then
  for cuda in cu130 cu128 cu126; do
    if pip install -q torch --index-url "https://download.pytorch.org/whl/$cuda"; then break; fi
  done
fi
pip install -q -e ".[dev,train]"
python - <<'PY'
import sys, torch
if not torch.cuda.is_available():
    sys.exit("PyTorch cannot see the GPU. Update the NVIDIA driver on Windows (https://www.nvidia.com/Download/index.aspx), "
             "restart, and run setup again.")
print(f"GPU: {torch.cuda.get_device_name(0)}, PyTorch {torch.__version__}, CUDA {torch.version.cuda}")
PY

step "Tests"
pytest -q

step "Datasets: GiantSteps Key (604 tracks) and Beatport EDM Key (1,486 tracks), about 2.5 GB"
python -m stoned_mango.datasets giantsteps "$DATA"
python -m stoned_mango.datasets beatport "$DATA"

step "First real-music results: the current engines on GiantSteps Key (a few minutes)"
python -m stoned_mango.evaluate giantsteps "$DATA/giantsteps-key-dataset" --out "$DATA/results/baseline-giantsteps.json" \
  | tee "$DATA/results/baseline-giantsteps.txt"
copy_back "$DATA/results/baseline-giantsteps.txt" "$DATA/results/baseline-giantsteps.json" "$LOG"

step "Setup finished. Next: double-click train-windows.cmd"
