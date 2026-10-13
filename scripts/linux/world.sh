#!/usr/bin/env bash
# Phase 8: the maqam, makam and raga scales (tier 3) on real recordings, and how often they wrongly
# take over ordinary music. Usage: world.sh [PROJECT_DIR] [MUSIC_DIR]
# Nothing is uploaded: SUMMARY.md has totals and the .json files one line of measurements per song, with no
# names; your-music-tier3.csv (file names) stays on this PC. Features are cached in $DATA/cache (never next to
# your music), so a re-run is much quicker.
source "$(dirname "$0")/common.sh" "$@"
cd "$REPO/research"
source .venv/bin/activate
pip install -q "mirdata==1.0.0"

MUSIC="${2:-}"
RUN="$DATA/world/$(date +%Y%m%d-%H%M)"
mkdir -p "$RUN"

step "1/4 Turkish makam: the OTMM dataset (1000 recordings as pitch tracks, about 0.5 GB, CC BY-NC-SA)"
OTMM="$DATA/otmm_makam_recognition_dataset"
[ -f "$OTMM/annotations.json" ] || git clone --depth 1 https://github.com/MTG/otmm_makam_recognition_dataset "$OTMM"
python -m stoned_mango.world_real makam "$OTMM" --out "$RUN/makam.json"

step "2/4 Indian raga: the CompMusic raga dataset's pitch tracks (780 recordings, from Zenodo)"
if python -c "import mirdata; mirdata.initialize('compmusic_raga', data_home='$DATA/compmusic_raga').download(partial_download=['features'])"; then
  python -m stoned_mango.world_real raga "$DATA/compmusic_raga" --out "$RUN/raga.json" \
    || echo "The raga check failed (details above); the other checks carry on."
else
  echo "Could not download the raga dataset (details above); skipping it."
fi

step "3/4 GiantSteps (604 electronic tracks): does tier 3 leave them alone?"
if [ -d "$DATA/giantsteps-key-dataset" ]; then
  python -m stoned_mango.world_real western "$DATA/giantsteps-key-dataset" --out "$RUN/western-giantsteps.json" \
    --cache "$DATA/cache/world-features"
else
  echo "Missing GiantSteps: run setup-windows.cmd first. Skipping."
fi

if [ -n "$MUSIC" ]; then
  step "4/4 Your music folder: up to 1000 files (nothing is uploaded or changed)"
  [ -d "$MUSIC" ] || { echo "Music folder not found: '$MUSIC'"; exit 1; }
  python -m stoned_mango.world_real western "$MUSIC" --limit 1000 --out "$RUN/western-your-music.json" \
    --files "$RUN/your-music-tier3.csv" --cache "$DATA/cache/world-features"
else
  step "4/4 Skipped: no music folder given"
fi

python -m stoned_mango.world_real summary "$RUN" > "$RUN/SUMMARY.md"
cat "$RUN/SUMMARY.md"
cp "$LOG" "$RUN/"
copy_back "$RUN"
step "Done. Upload SUMMARY.md and the four .json files from results/$(basename "$RUN") to the chat (no song names in any of them). Keep your-music-tier3.csv to yourself."
