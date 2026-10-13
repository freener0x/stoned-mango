"""Download the real-music key datasets (annotations from GitHub, audio previews).

    python -m stoned_mango.datasets giantsteps DATA_DIR     # GiantSteps Key: 604 tracks, test set
    python -m stoned_mango.datasets beatport DATA_DIR       # Beatport EDM Key: 1,486 tracks, training set

Resumable: files already present with the right checksum are skipped. Each
file is tried at its main address and then at the dataset's backup mirror,
as the datasets' own audio_dl.sh scripts do. The audio is Beatport's
two-minute preview clips; it's used locally for research and never
redistributed (see docs/phase0/REPORT.md section 6).
"""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DATASETS = {
    "giantsteps": {
        "repo": "https://github.com/GiantSteps/giantsteps-key-dataset.git",
        "dir": "giantsteps-key-dataset",
        "urls": ["https://www.cp.jku.at/datasets/giantsteps/backup/", "https://geo-samples.beatport.com/lofi/"],
    },
    "beatport": {
        "repo": "https://github.com/GiantSteps/giantsteps-mtg-key-dataset.git",
        "dir": "giantsteps-mtg-key-dataset",
        "urls": ["https://geo-samples.beatport.com/lofi/", "https://www.cp.jku.at/datasets/giantsteps/mtg_key_backup/"],
    },
}


def _md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def _fetch(url: str, dest: Path, tries: int = 3) -> bool:
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "stoned-mango-research"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if len(data) < 10_000:  # an error page, not an MP3
                return False
            tmp = dest.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return True
        except urllib.error.HTTPError as e:
            if e.code < 500:  # 403/404 won't change on a retry
                return False
            time.sleep(2 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(2 * (attempt + 1))
    return False


def download(name: str, data_dir: Path, workers: int = 8) -> Path:
    spec = DATASETS[name]
    root = data_dir / spec["dir"]
    if not (root / "annotations").exists():
        data_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--depth", "1", spec["repo"], str(root)], check=True)
    audio = root / "audio"
    audio.mkdir(exist_ok=True)
    md5s = {p.stem: p.read_text().strip() for p in (root / "md5").glob("*.md5")}

    def job(stem: str) -> str:
        dest = audio / f"{stem}.mp3"
        want = md5s[stem]
        if dest.exists() and _md5(dest) == want:
            return "skipped"
        for base in spec["urls"]:
            if _fetch(base + dest.name, dest) and _md5(dest) == want:
                return "ok"
        dest.unlink(missing_ok=True)
        return "failed"

    counts = {"ok": 0, "skipped": 0, "failed": 0}
    with ThreadPoolExecutor(workers) as pool:
        for i, result in enumerate(pool.map(job, sorted(md5s)), 1):
            counts[result] += 1
            if i % 100 == 0 or i == len(md5s):
                print(f"  {name}: {i}/{len(md5s)} {counts}", flush=True)
    if counts["failed"]:
        print(f"  {counts['failed']} files could not be downloaded; they are left out of training and evaluation.")
    return root


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", choices=sorted(DATASETS))
    ap.add_argument("data_dir", type=Path)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    root = download(args.dataset, args.data_dir, args.workers)
    print(root)
    sys.exit(0)


if __name__ == "__main__":
    main()
