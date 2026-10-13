# stoned-mango research workbench

Python side of stoned-mango: the reference implementation of the analysis,
the evaluation harness, and a command-line tool. Install it from a checkout
of the whole repository (it reads `../shared/scales.json`):

```bash
cd research
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## Command line

```bash
.venv/bin/stoned-mango song.mp3
.venv/bin/stoned-mango ~/Music --format csv > keys.csv
.venv/bin/stoned-mango song.wav --engine template   # engines: auto (default), fusion, cnn, template
```

## Evaluation

```bash
.venv/bin/python -m stoned_mango.synth /tmp/evalset --eval-set 6 --seconds 30   # 180 pieces, 30 scales
.venv/bin/python -m stoned_mango.evaluate synthetic /tmp/evalset
.venv/bin/python -m stoned_mango.evaluate giantsteps path/to/giantsteps-key-dataset   # after ./audio_dl.sh
```

## Training the key CNN

On Windows, follow [docs/phase2/TRAINING-ON-WINDOWS.md](../docs/phase2/TRAINING-ON-WINDOWS.md). On Linux with an
NVIDIA GPU, run `bash scripts/linux/setup.sh` once, then `bash scripts/linux/train.sh` (both from the repository root;
`sudo bash scripts/linux/system-packages.sh` first on a fresh Ubuntu). The steps it runs:

```bash
python -m stoned_mango.songgen CACHE/synthetic --per-scale 300 --features          # training songs (features only)
python -m stoned_mango.datasets beatport DATA                                       # Beatport EDM Key audio
python -m stoned_mango.cnn.data beatport DATA/giantsteps-mtg-key-dataset CACHE/beatport
python -m stoned_mango.cnn.train --synthetic CACHE/synthetic --real CACHE/beatport --out runs/NAME
python -m stoned_mango.cnn.export runs/NAME/best.pt --calibration CACHE/beatport --out runs/NAME/model
python -m stoned_mango.evaluate giantsteps DATA/giantsteps-key-dataset --cnn runs/NAME/model/key-cnn.fp32.onnx
```

## Engine fusion and calibration (phase 3)

`bash scripts/linux/calibrate.sh` (or `calibrate-windows.cmd`) runs these after training:

```bash
python -m stoned_mango.songgen CACHE/fusion-synthetic --per-scale 40 --features --seed 21   # songs the CNN never saw
python -m stoned_mango.fusion fit --synthetic CACHE/fusion-synthetic --real CACHE/beatport --out ../shared/fusion.json
python -m stoned_mango.evaluate giantsteps DATA/giantsteps-key-dataset --fusion ../shared/fusion.json --no-keyextractor
```

`--real` uses only the Beatport tracks that CNN training held out. `python -m stoned_mango.fusion floor FILE --synthetic ... --real ...`
re-chooses only the "No clear key" floor of a fitted file. When `shared/fusion.json` exists, the command
line uses it (`--engine auto`): calibrated confidence, ambiguity notes and "No clear key".

## Key changes over time (phase 4)

```bash
python -m stoned_mango.songgen TEST --modulating 120 --seconds 90 --seed 43   # songs with key changes
python -m stoned_mango.timeline_eval TEST                                     # boundaries, split rate, key over time
python -m stoned_mango.evaluate giantsteps DATA/giantsteps-key-dataset --fusion ../shared/fusion.json --timeline
```

## Checking against a music library's key tags

```bash
python -m stoned_mango.library ~/Music --out runs/library   # SUMMARY.md (totals only) + tracks.csv
```

On Windows: `library-windows.cmd` (see the training guide, step 7).

## Golden files for the browser engine

```bash
python -m stoned_mango.golden    # rewrites shared/golden; web/tests/parity.test.ts checks the browser engine against it
```

Regenerate after any change that alters results (model, fusion weights, features); `tests/test_golden.py` fails until you do.

## Tests

```bash
.venv/bin/pytest
```
