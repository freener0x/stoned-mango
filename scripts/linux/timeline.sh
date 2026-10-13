#!/usr/bin/env bash
# Phase 4: how often the timeline invents key changes in real music. GiantSteps tracks are labelled
# with one key each, so a split is a false change. Optionally also runs the library check on a music
# folder (which now reports songs split into several keys). Usage: timeline.sh [PROJECT_DIR] [MUSIC_DIR]
source "$(dirname "$0")/common.sh" "$@"
cd "$REPO/research"
source .venv/bin/activate
pip install -q "mutagen>=1.47"

MUSIC="${2:-}"
RUN="$DATA/timeline/$(date +%Y%m%d-%H%M)"
mkdir -p "$RUN"
[ -d "$DATA/giantsteps-key-dataset" ] || { echo "Missing GiantSteps: run setup-windows.cmd first."; exit 1; }

step "1/2 GiantSteps Key with the timeline (604 real tracks, one key each)"
python -m stoned_mango.evaluate giantsteps "$DATA/giantsteps-key-dataset" --no-keyextractor --bass-weights 0.3 \
  --fusion "$REPO/shared/fusion.json" --timeline --out "$RUN/eval-giantsteps.json"
python -m stoned_mango.fusion_summary "$RUN" > "$RUN/SUMMARY.md"

if [ -n "$MUSIC" ]; then
  step "2/2 Your music folder (nothing is uploaded or changed)"
  [ -d "$MUSIC" ] || { echo "Music folder not found: '$MUSIC'"; exit 1; }
  python -m stoned_mango.library "$MUSIC" --out "$RUN/library" --fusion "$REPO/shared/fusion.json"
  { echo; echo "---"; echo; cat "$RUN/library/SUMMARY.md"; } >> "$RUN/SUMMARY.md"
else
  step "2/2 Skipped: no music folder given"
fi
cat "$RUN/SUMMARY.md"
cp "$LOG" "$RUN/"
copy_back "$RUN"
step "Done. Paste results/$(basename "$RUN")/SUMMARY.md into the chat (it has no song names)."
