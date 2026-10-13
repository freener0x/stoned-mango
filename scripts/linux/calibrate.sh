#!/usr/bin/env bash
# Phase 3: fit the engine fusion (calibrated confidence, "No clear key") on this PC's data, then compare
# it with the CNN alone on GiantSteps Key and the held-out songs. Needs setup.sh and train.sh to have run.
# No GPU needed. Safe to re-run: finished data steps are skipped.
source "$(dirname "$0")/common.sh" "$@"
cd "$REPO/research"
source .venv/bin/activate

RUN="$DATA/calibration/$(date +%Y%m%d-%H%M)"
mkdir -p "$RUN"
for need in "$DATA/cache/beatport" "$DATA/giantsteps-key-dataset"; do
  [ -d "$need" ] || { echo "Missing $need: run setup-windows.cmd and train-windows.cmd first."; exit 1; }
done

step "1/5 Synthetic fusion songs: 40 per scale x 30 scales (features only; different songs from training)"
python -m stoned_mango.songgen "$DATA/cache/fusion-synthetic" --per-scale 40 --seconds 30 --features --seed 21

step "2/5 Held-out test songs (only made if train.sh has not made them already)"
python -m stoned_mango.songgen "$DATA/heldout-songs" --per-scale 10 --seconds 30 --seed 999

step "3/5 Fitting the fusion: synthetic only, and synthetic + the Beatport tracks the CNN never trained on"
python -m stoned_mango.fusion fit --synthetic "$DATA/cache/fusion-synthetic" --out "$RUN/fusion-synthetic.json"
python -m stoned_mango.fusion fit --synthetic "$DATA/cache/fusion-synthetic" --real "$DATA/cache/beatport" \
  --out "$RUN/fusion-with-real.json"

step "4/5 Evaluation: GiantSteps Key (real music, never fitted on) and the held-out songs"
python -m stoned_mango.evaluate giantsteps "$DATA/giantsteps-key-dataset" --no-keyextractor \
  --fusion "$RUN/fusion-synthetic.json" "$RUN/fusion-with-real.json" --out "$RUN/eval-giantsteps.json"
python -m stoned_mango.evaluate songs "$DATA/heldout-songs" --no-keyextractor \
  --fusion "$RUN/fusion-synthetic.json" "$RUN/fusion-with-real.json" --out "$RUN/eval-heldout-songs.json"

step "5/5 Summary"
python -m stoned_mango.fusion_summary "$RUN" | tee "$RUN/SUMMARY.md"

cp "$LOG" "$RUN/"
copy_back "$RUN"
step "Calibration finished. Send back results/$(basename "$RUN")/SUMMARY.md and the two fusion-*.json files next to it"
