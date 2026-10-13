# Phase 2 report: the FOSS key CNN

**Status: done.** The first real training run on your RTX 4060 Laptop (30 Sep 2026) produced a model that **beats every earlier engine on real music it never saw**:

- **GiantSteps Key: 0.701 weighted, 65.1% exact.** Essentia's EDM-tuned KeyExtractor scores 0.653 and 57.6%.
- **Held-out synthetic songs across 30 scales: 67.3% exact mode.** The phase 1 template engine scores 43.3%.

The model ships at `web/public/models/key-cnn.fp32.onnx` and is now the `stoned-mango` CLI's default engine. The full run summary is in [training-run-20260930-0139.md](training-run-20260930-0139.md).

---

## 1. What was built

| Path | What it is |
|---|---|
| `research/stoned_mango/songgen.py` | Training-song generator. Each song arranges:<ul><li>**bass**: roots, eighths, syncopated or walking</li><li>**chords**: whole notes, quarters, off-beat stabs or arpeggiated, with random inversions and sevenths</li><li>an optional **arpeggio** line</li><li>a **melody**: a smooth random walk that leans on chord tones and ends phrases on the home note 60% of the time</li><li>**drums**: four-on-the-floor, backbeat or half-time, in 70% of songs</li></ul>Instruments are random General MIDI programs, tempo 70–160 BPM, and 25% of songs are detuned up to ±45¢. Three progression styles: vamp, moving, drone. Songs are rendered by **FluidSynth + FluidR3_GM (MIT)**, or by the built-in synth when FluidSynth is missing. A test checks that **every note of every generated song is in its scale, for all 30 scales**. Speed: 720 songs in about 2 minutes on 4 cores |
| `research/stoned_mango/features.py` | Adds the **105-band log-frequency spectrogram** (24 bands per octave from C2) to the streaming features. Its filter bank matches the browser's (`web/src/spike/logfilter.ts`), including JavaScript's rounding |
| `research/stoned_mango/cnn/model.py` | **KeyNet**, 75k parameters (§2) |
| `research/stoned_mango/cnn/train.py` | Training with transposition augmentation (±6 semitones) and mixed precision on CUDA. Keeps the best checkpoint, stops early when validation stops improving, and logs every epoch |
| `research/stoned_mango/cnn/export.py` | ONNX fp32 and int8 export with a **model card** (feature settings, output layout, licence **CC BY-SA 4.0**, training summary). Refuses to write a model whose ONNX output differs from PyTorch by more than 1e-3. Reports how often int8 agrees with fp32 |
| `research/stoned_mango/cnn/engine.py` | Runs an exported model with onnxruntime (no PyTorch needed). Supports frame windows for the phase 4 timeline |
| `research/stoned_mango/cnn/data.py` | Feature caches for real music. Skips Beatport tracks marked uncertain (confidence 0), unlabelled ("-") or with two keys ("F minor / G# major") |
| `research/stoned_mango/datasets.py` | Resumable, parallel, checksum-verified download of GiantSteps Key and Beatport EDM Key, with each dataset's backup mirror as fallback |
| `research/stoned_mango/evaluate.py` | Adds `--cnn MODEL.onnx`: the engines "CNN" and "CNN × template" (log-probabilities added). Also evaluates `songgen` song folders |
| `research/stoned_mango/cnn/summary.py` | Writes the run's `SUMMARY.md` |
| `setup-windows.cmd`, `train-windows.cmd`, `scripts/windows/run-in-wsl.ps1`, `scripts/linux/*.sh` | The Windows workflow (§3) |
| `research/tests/` | **104 tests** now. The PyTorch and ONNX ones skip automatically where torch isn't installed (CI) |

## 2. Model design

**The first design didn't work.** It used separate outputs for "home note + major/minor" and "which scale". After 6 CPU epochs on a small set:
- key accuracy was 60%
- **exact-mode accuracy was 3–4%, no better than chance**

The scale output had to find the home note on its own, and nothing linked the two outputs.

**The current design (KeyNet):**
1. 7 small 3×3 convolutions over the spectrogram learn local patterns: notes, harmonics, chords.
2. The frequency axis is **folded into one octave**, a 24-bin circle where bin 2t is pitch class t.
3. A **circular convolution** scores each scale at each of the 12 rotations **with the same weights**. It works as a learned version of the phase 1 template engine.
4. The output is one score per (scale, home note), 30 × 12 = 360 in all, per frame.
5. The home note reads bins 2t−1…2t+1, so detuning of up to a quarter tone still lands on the right note.

**Why it's better:**
- **Transposing the input shifts the output by the same amount:** measured error 0.006 (test threshold 0.05). The only residue comes from the bottom edge of the spectrogram.
- **Home note and scale are chosen together**, so there are no inconsistent pairs.
- **Major/minor-only data** (Beatport) trains the same output through a marginal: the probability summed over all scales with that third, at the labelled home note.
- **It's small:** 75k parameters, 299 KiB as fp32 ONNX.

**Same smoke test, after the redesign:**

| | Key (home note + major/minor) | Exact mode |
|---|---|---|
| First design | 60% | 3% |
| **KeyNet** | 61% | **36%**, and still rising when stopped |

The smoke test was 6 CPU epochs on 648 songs, validated on 72 held-out songs.

**Combined with the template engine (90 held-out songs, 30 scales, same smoke model):**

| Engine | Exact mode | Home note | Weighted |
|---|---|---|---|
| **CNN × template** | **0.467** | **0.667** | **0.678** |
| Template + bass (phase 1) | 0.389 | 0.622 | 0.648 |
| CNN alone | 0.322 | 0.644 | 0.643 |
| Essentia `Key` (best profile) | 0.056 | 0.433 | 0.470 |

The smoke test is 3 CPU minutes on about 7% of the planned training data, with no real music. Its only purpose is to show that the pipeline works and that combining the engines helps. The GPU run on your PC is the real result.

**fp32 vs int8:** on the smoke model, int8 agreed with fp32 on only 95% of songs, which is too lossy.
- **The app ships fp32 unless int8 agrees on at least 99%.**
- At 299 KiB, fp32 is already small next to ONNX Runtime's 3.6 MB.

## 3. Training on Windows via WSL

- **Essentia has no Windows builds**, only Linux and macOS (checked on PyPI).
- So training runs in **WSL (Ubuntu 24.04)**. That's the same Linux as CI and this sandbox, and NVIDIA supports CUDA inside WSL through the normal Windows driver.

**The workflow:**
1. **`setup-windows.cmd`**
   - Checks the NVIDIA driver.
   - Installs WSL/Ubuntu if missing, asking for administrator permission and possibly one restart.
   - Installs system packages as root, so there is no password prompt.
   - Copies the project to the Linux disk, because working from `/mnt/c` is much slower.
   - Installs **CUDA PyTorch** (tries cu130, then cu128, then cu126) and checks the GPU is visible.
   - Runs the tests, downloads both datasets, and **runs the first real-music evaluation** (current engines on GiantSteps Key).
2. **`train-windows.cmd`**
   - 9,000 synthetic songs (300 × 30 scales, features only).
   - Beatport features.
   - 300 held-out test songs.
   - GPU training (up to 60 epochs, early stopping).
   - ONNX export.
   - Evaluation on GiantSteps Key and the held-out songs.
   - `SUMMARY.md`, with the results copied back into the Windows folder.

Every step logs to a file and can be re-run safely.

**Tested here** (CPU only, since this sandbox has no GPU and can't reach the dataset audio host):
- `train.sh` ran **end to end** (exit code 0, 155 s).
- It used small settings (3 songs per scale, 2 epochs) and **stand-in datasets** with the same layout as GiantSteps and Beatport, including an ambiguous label and a keyless one, which were correctly skipped.
- The dataset downloader is tested against a local web server: backup mirror, skipping verified files, and failures.

**Not testable here:**
- the PowerShell/WSL installation itself
- the CUDA PyTorch install
- the real downloads

If any of those fails on your PC, the scripts save a log in `results\`, and I'll fix it from that log.

## 4. Decisions

- **Training on Windows goes through WSL**, because Essentia has no Windows builds. It uses the same environment as CI, so one code path.
- **Output layout:** one joint (scale, home note) output. Major/minor-only data trains through the marginal.
- **Default training set:**
  - 300 synthetic songs per scale, plus Beatport EDM Key (repeated 3× per epoch)
  - GiantSteps Key is **test only**, never trained on (the standard protocol)
  - 10% of each source is held back for validation
- **fp32 ships by default;** int8 only if it agrees on ≥ 99% of songs.
- **Model licence:** CC BY-SA 4.0, stated in every model card.

## 5. First real-music results: GiantSteps Key baseline

These came from your PC (setup step, 30 Sep 2026, all **604** tracks downloaded). They show the engines that existed *before* the CNN, on real electronic dance music they were never tuned on. The label set is 85% minor (511 minor, 93 major).

| Engine | Weighted | Major/minor exact | Home note |
|---|---|---|---|
| **Essentia KeyExtractor (edma)** | **0.653** | **0.576** | **0.692** |
| Template + bass (phase 1) | 0.559 | 0.464 | 0.599 |
| Template, no bass | 0.537 | 0.424 | 0.553 |
| Essentia `Key` profiles on our chroma (best: temperley) | 0.484 | 0.409 | 0.460 |

Error types (604 tracks):

| Engine | Exact | Fifth | Relative | Parallel | Other |
|---|---|---|---|---|---|
| KeyExtractor (edma) | 348 | 52 | 39 | 70 | 95 |
| Template + bass | 280 | 77 | 34 | 82 | 131 |

**What this says:**
- **On real EDM, the phase 1 template engine is behind Essentia's EDM-tuned profile**, the reverse of the synthetic results. Its weights were set by hand and tuned on simple synthetic music.
- Its main extra mistakes are **major-sounding answers for minor tracks**. It picked a major-third scale (Mixolydian, Ionian, major pentatonic, Lydian…) for about 140 tracks when only 93 are labelled major. It also made **more fifth errors**.
- **This is exactly what the CNN is for:** it learns from 1,300+ real Beatport EDM tracks plus the synthetic songs. The CNN (and CNN × template) must beat **0.653 weighted** here to be worth shipping.
- Phase 3 will also re-tune the template weights on real music (Beatport, never GiantSteps).

Summary numbers: `docs/phase2/baseline-giantsteps.json`.

## 6. Training run results (30 Sep 2026, RTX 4060 Laptop)

**The run:**
- 9,000 synthetic songs plus Beatport EDM Key.
- 22 epochs, stopped early; the best was epoch 14.
- **10 minutes of GPU time.**

**Model checks:**
- ONNX matches PyTorch to within 2.1e-5.
- int8 agrees with fp32 on **100%** of calibration songs, so int8 now passes the ≥ 99% rule. fp32 still ships for now: the 200 KB saving is small, and switching is a one-line change later.

**Validation at the best epoch:**
- Synthetic (900 songs): key 72.9%, home note 74.8%, **exact mode 63.8%**.
- Beatport (133 real tracks): key 69.9%, home note 78.2%.

**GiantSteps Key (604 real EDM tracks, never trained on):**

| Engine | Weighted | Major/minor exact | Home note |
|---|---|---|---|
| **CNN** | **0.701** | **0.651** | **0.710** |
| Essentia KeyExtractor (edma) | 0.653 | 0.576 | 0.692 |
| CNN × template | 0.631 | 0.551 | 0.664 |
| Template + bass (phase 1) | 0.559 | 0.464 | 0.599 |

**Held-out synthetic songs (300, 30 scales):**

| Engine | Weighted | Home note | Exact mode | Right notes |
|---|---|---|---|---|
| **CNN** | **0.777** | **0.777** | **0.673** | **0.867** |
| CNN × template | 0.738 | 0.740 | 0.593 | 0.817 |
| Template + bass (phase 1) | 0.681 | 0.683 | 0.433 | 0.643 |

**What this means:**
- **The CNN clears the bar set in §5:** 0.701 against 0.653 on GiantSteps, and +7.5 points of exact major/minor accuracy.
- **Combining it with the template engine now *hurts*.** The template engine is the weaker of the two, and adding their log-probabilities with equal weight lets its errors through. **The app and CLI use the CNN alone** until phase 3 learns proper engine weights, or drops the template engine where it doesn't help.
- **Checks in this repository:**
  - The six church modes are recognised correctly, including when transposed.
  - Locally the model gets 8 of 10 phase 0 fixtures. Its two misses are relative-key confusions (A minor heard as F Lydian, i.e. the C major note set; a C major loop heard as A minor), which is what phase 3's home-note work targets.
  - `research/tests/test_trained_model.py` guards these, and any retrained model has to pass it before it ships.
- **Headroom:** training stopped after 10 minutes. A bigger run (`PER_SCALE=500 EPOCHS=80`) or a wider network is cheap to try on your GPU.

## 7. Next

1. **Done:** setup, the baseline, the training run, and the model committed to `web/public/models/` with its licence note.
2. **Optional, cheap:** a bigger training run on your GPU (`PER_SCALE=500 EPOCHS=80`) to see how much headroom there is.
3. **Phase 3:**
   - Learned engine weighting, so combining engines helps instead of hurting.
   - The home-note detector, aimed at the relative-key confusions.
   - "Aeolian or Dorian"-style ambiguity notes.
   - Calibrated confidence.
   - The GiantSteps+ real-music modal test set.
