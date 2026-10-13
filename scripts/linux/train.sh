#!/usr/bin/env bash
# Train the key CNN: training data -> training -> ONNX export -> evaluation -> results summary.
# Safe to re-run: finished data steps are skipped. Tunables: PER_SCALE (default 300), EPOCHS (default 60).
source "$(dirname "$0")/common.sh" "$@"
cd "$REPO/research"
source .venv/bin/activate

PER_SCALE="${PER_SCALE:-300}"
EPOCHS="${EPOCHS:-60}"
RUN="$DATA/runs/$(date +%Y%m%d-%H%M)"

step "1/6 Synthetic training songs: $PER_SCALE per scale x 30 scales (features only, no audio kept)"
python -m stoned_mango.songgen "$DATA/cache/synthetic" --per-scale "$PER_SCALE" --seconds 30 --features --seed 1

step "2/6 Real-music training features: Beatport EDM Key"
python -m stoned_mango.cnn.data beatport "$DATA/giantsteps-mtg-key-dataset" "$DATA/cache/beatport"

step "3/6 Held-out test songs (10 per scale, never used for training)"
python -m stoned_mango.songgen "$DATA/heldout-songs" --per-scale 10 --seconds 30 --seed 999

step "4/6 Training on the GPU (up to $EPOCHS epochs; stops early when it stops improving)"
python -m stoned_mango.cnn.train --synthetic "$DATA/cache/synthetic" --real "$DATA/cache/beatport" \
  --out "$RUN" --epochs "$EPOCHS"

step "5/6 Export to ONNX (fp32 + int8)"
python -m stoned_mango.cnn.export "$RUN/best.pt" --calibration "$DATA/cache/beatport" "$DATA/cache/synthetic" \
  --out "$RUN/model"

step "6/6 Evaluation: GiantSteps Key (real music, never trained on) and the held-out songs"
python -m stoned_mango.evaluate giantsteps "$DATA/giantsteps-key-dataset" --cnn "$RUN/model/key-cnn.fp32.onnx" \
  --out "$RUN/eval-giantsteps.json"
python -m stoned_mango.evaluate songs "$DATA/heldout-songs" --cnn "$RUN/model/key-cnn.fp32.onnx" --no-keyextractor \
  --out "$RUN/eval-heldout-songs.json"
python -m stoned_mango.cnn.summary "$RUN" | tee "$RUN/SUMMARY.md"

cp "$LOG" "$RUN/"
copy_back "$RUN"
step "Training finished. Send back results/$(basename "$RUN")/SUMMARY.md and the files in results/$(basename "$RUN")/model/"
