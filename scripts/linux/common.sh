# Shared by setup.sh and train.sh. Usage: source common.sh [WINDOWS_PROJECT_DIR_AS_WSL_PATH]
set -euo pipefail
SOURCE_REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REPO="$HOME/stoned-mango"          # working copy on the Linux disk (much faster than /mnt/c)
DATA="$HOME/stoned-mango-data"     # datasets, caches and training runs; survives re-syncs
mkdir -p "$DATA/results"

# Everything printed from here on also goes to a log file, and (when started from Windows)
# to a second copy in the Windows project's results folder, so a failed run leaves a trace there.
LOG="$DATA/results/$(basename "$0" .sh)-$(date +%Y%m%d-%H%M%S).log"
if [ "$SOURCE_REPO" != "$REPO" ] && mkdir -p "$SOURCE_REPO/results" 2>/dev/null; then
  exec > >(tee -a "$LOG" "$SOURCE_REPO/results/$(basename "$LOG")") 2>&1
else
  exec > >(tee -a "$LOG") 2>&1
fi

echo "stoned-mango $(basename "$0") on $(. /etc/os-release && echo "$PRETTY_NAME"), $(python3 --version 2>&1)"
if [ "$SOURCE_REPO" != "$REPO" ]; then
  rsync -a --delete --exclude .venv --exclude node_modules --exclude results --exclude '*.egg-info' \
    "$SOURCE_REPO/" "$REPO/"
fi

copy_back() {  # copy a results path back to the Windows project folder, when run from Windows
  if [ "$SOURCE_REPO" != "$REPO" ] && [ -d "$SOURCE_REPO" ]; then
    mkdir -p "$SOURCE_REPO/results"
    cp -r "$@" "$SOURCE_REPO/results/"
  fi
}

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
