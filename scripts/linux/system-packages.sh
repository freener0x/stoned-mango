#!/usr/bin/env bash
# System packages for stoned-mango research on Ubuntu 24.04 (native or WSL). Run as root.
# Optional argument: the project folder, to also write a log into its results/ folder.
set -euo pipefail
if [ -n "${1:-}" ] && mkdir -p "$1/results" 2>/dev/null; then
  exec > >(tee -a "$1/results/system-packages-$(date +%Y%m%d-%H%M%S).log") 2>&1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
  python3 python3-venv python3-dev python3-pip build-essential \
  git rsync curl ca-certificates \
  fluidsynth fluid-soundfont-gm
