#!/usr/bin/env bash
# Compare stoned-mango with the key tags in a music folder. Usage: library.sh [PROJECT_DIR] MUSIC_DIR
# Nothing is uploaded: SUMMARY.md has totals only; tracks.csv (file names) stays on this PC.
source "$(dirname "$0")/common.sh" "$@"
cd "$REPO/research"
source .venv/bin/activate

MUSIC="${2:-}"
[ -n "$MUSIC" ] && [ -d "$MUSIC" ] || { echo "Music folder not found: '$MUSIC'"; exit 1; }
pip install -q "mutagen>=1.47"

# Use the newest fusion fitted on this PC (calibrate.sh), else the one that ships with the project.
FUSION="$(ls -t "$DATA"/calibration/*/fusion-with-real.json 2>/dev/null | head -1 || true)"
FUSION="${FUSION:-$REPO/shared/fusion.json}"
RUN="$DATA/library/$(date +%Y%m%d-%H%M)"
LIMIT="${LIMIT:-1000}"

step "Checking up to $LIMIT tagged tracks from your music folder against their key tags (fusion: $FUSION)"
python -m stoned_mango.library "$MUSIC" --out "$RUN" --fusion "$FUSION" --limit "$LIMIT"

cp "$LOG" "$RUN/"
copy_back "$RUN"
step "Done. Paste results/$(basename "$RUN")/SUMMARY.md into the chat. Keep tracks.csv to yourself: it lists your files."
