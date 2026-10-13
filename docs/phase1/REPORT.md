# Phase 1 report: research core

**Status:** complete. Real-music accuracy (GiantSteps, Beatport EDM Key) still has to be run on your PC, because this sandbox can't download the dataset audio (§5).

**In one line:**
- The analysis now runs as a stream, so memory doesn't depend on song length.
- It scores **30 scales** from a shared library.
- On a held-out synthetic set it names the **exact key and mode 53%** of the time and the **home note 77%** of the time. Essentia's classic method gets 5% and 67%, because it only knows major and minor.
- Most remaining errors are near-misses that phase 3 targets directly.

---

## 1. What was built

| Path | What it is |
|---|---|
| `shared/scales.json` | The scale library: **30 tier 1–2 scales**, in cents so microtonal scales fit later. Each entry has its family, aliases and "mode of" link (e.g. Phrygian dominant = 5th mode of harmonic minor). A test checks every link is a true rotation. Python reads it now; the browser will read the same file |
| `research/stoned_mango/audio.py` | Streaming input: reads WAV/MP3/FLAC/OGG in 10 s blocks (libsndfile) and mixes them to mono. A stateful low-pass filter halves the sample rate (44.1 → 22.05 kHz, 48/96 → 24 kHz). The filter coefficients are written out so the browser can use identical ones |
| `research/stoned_mango/features.py` | Streaming features, one frame at a time:<ul><li>120-bin pitch profile (10 cents per bin)</li><li>bass-only profile (30–250 Hz)</li><li>loudness</li><li>a running tuning estimate that needs no second pass</li></ul>Profiles are folded to tuned 12-note chroma whenever needed. **Feeding the same file in different chunk sizes gives bit-identical results** |
| `research/stoned_mango/engines.py` | [5c] **Scale-template engine**: correlates the chroma with every (home note × scale) template. Templates weight home note > fifth > third > other scale notes > outside notes, which is what separates D Dorian from C major. A simple bass cue for the home note is added (weight 0.3). [5b] Essentia's `Key` profiles, scored on the *same* chroma: computed once, no repeated passes |
| `research/stoned_mango/scales.py` | Names and spelling: "C major", "A minor", "D Dorian (same notes as C major)", "E Phrygian dominant (5th mode of A harmonic minor)". Uses key-signature spelling (F♯ minor, G♭ major) |
| `research/stoned_mango/analysis.py` | Features → engines → result (key, parent, confidence, alternatives, tuning) |
| `research/stoned_mango/cli.py` | **`stoned-mango`** command: files or whole folders (recursive), output as a table, CSV or JSON |
| `research/stoned_mango/synth.py` | Now renders **any library scale**, with random home note, tempo (80–150 BPM), instrument brightness, drums (70% of pieces) and detuning (±40¢ on 20%). `--eval-set N` writes N pieces per scale. Two progression styles:<ul><li>"vamp": the home chord every other bar</li><li>"moving": four different chords</li></ul> |
| `research/stoned_mango/evaluate.py` | Evaluation harness for the synthetic set, **GiantSteps Key** and **Beatport EDM Key**. Reports the `mir_eval` weighted score, major/minor accuracy, home-note accuracy, exact-mode accuracy and right-notes accuracy, by engine and by scale family |
| `research/tests/` | **61 tests**: filter accuracy and chunk invariance, tuning (−35…+45¢), silence, scale-library consistency, spelling, transposition invariance, ideal-profile recovery for every asymmetric scale, end-to-end pieces, and the CLI on a folder |
| `.github/workflows/ci.yml` | CI: Python lint + tests, web typecheck + build |

---

## 2. Accuracy on synthetic music

**The data:**
- Two independent sets: 6 random pieces for each of the 30 scales, 30 s each, so **180 pieces per set**.
- The bass weight was chosen on the *tuning* set (seed 1). The *held-out* set (seed 2) gives the honest numbers.

**Held-out set (180 pieces):**

| Engine | Weighted¹ | Major/minor exact | Home note | **Exact mode** | Right notes² |
|---|---|---|---|---|---|
| **Template + bass (ours)** | **0.765** | **0.728** | **0.767** | **0.528** | **0.689** |
| Template, no bass | 0.669 | 0.622 | 0.650 | 0.439 | 0.672 |
| Essentia `KeyExtractor` (edma), original pipeline | 0.652 | 0.617 | 0.667 | 0.050 | 0.078 |
| Essentia `Key` profiles on our chroma (best: krumhansl) | 0.513 | 0.450 | 0.506 | 0.050 | 0.117 |

¹ `mir_eval` weighted key score on the major/minor projection (a mode counts as major or minor by its third).
² The right set of notes, whatever the home note.

- **Chance level:** random guessing across 30 scales × 12 home notes would get 0.3% exact.
- **Essentia can't do modes:** it only knows major and minor, so its exact-mode score is capped at the 2 of 30 scales it can express.

**By scale family (held-out set, template + bass):**

| Family | n | Exact mode | Home note | Right notes |
|---|---|---|---|---|
| Double harmonic / Hungarian minor | 12 | 1.00 | 1.00 | 1.00 |
| Pentatonic | 12 | 0.92 | 0.92 | 1.00 |
| Diatonic (church modes) | 42 | 0.55 | 0.67 | 0.76 |
| Harmonic-minor modes | 42 | 0.50 | 0.71 | 0.71 |
| Melodic-minor modes | 42 | 0.48 | 0.71 | 0.69 |
| Symmetric (whole-tone, diminished) | 18 | 0.33 | 0.83 | 0.39 |
| Blues | 12 | 0.17 | 1.00 | 0.17 |

Per-scale results are in `docs/phase1/synthetic-heldout-set.json`; the tuning-set run is in `synthetic-tuning-set.json`.

### Where it goes wrong

Most errors fall into two groups, both targeted by phase 3:

1. **Right home note, a neighbouring scale that differs by one rarely played note.** These are the most common errors:
   - blues → minor pentatonic (5 of 6); the "blue note" ♭5 is brief
   - major blues → major pentatonic (5 of 6)
   - Lydian ♯2 → Lydian, and Locrian ♮2 → Locrian (3 each)
   - harmonic minor → natural minor, and melodic minor → Dorian (2 each)

   These are the cases where the answer should be **"A minor pentatonic or A blues (the ♭5 is barely used)"**, not a confident guess. Phase 3 adds that ambiguity check.
2. **Right notes, wrong home note.** The engine names the relative or another mode of the same note set, e.g. Mixolydian heard as Dorian, or A minor heard as C major. The bass cue helps a lot here (exact mode 0.44 → 0.53), but it's crude. Example: a long C major loop of C–G–Am–F comes out as **G Mixolydian**, with C major second. Phase 3's proper home-note detector (long notes, phrase endings, cadences, drones) is aimed at this.

Symmetric scales are inherently ambiguous: every note of a whole-tone scale could be the home note. The app will say so rather than guess.

### Caveat

This synthetic music is simple and very regular, and it plays scale notes more evenly than real music does.
- These numbers show that **the pipeline works and how the engines compare**.
- They don't say how accurate it is on real recordings. §5 covers that.

---

## 3. Speed (Python reference, one core)

- **Command-line tool, 4-minute stereo MP3:** 1.8 s end to end, including start-up.
- **Feature extraction:** about 1.2 s of that.
- **Scoring all 360 candidates:** a few milliseconds.

The browser port (phase 5) does the same work per frame as the phase 0 spike, which ran at about 0.7 ms per frame.

---

## 4. Decisions made

- **Analysis rate:** decimate by 2 until ≤ 32 kHz, with no general resampler. That's one small filter to port and test, and it avoids a resampling library in the browser.
- **Pitch features:** a 120-bin profile computed once per frame, then folded to 12 notes using the tuning estimate. This replaces separate 12- and 120-bin passes and the "estimate tuning first, then analyse" second pass.
- **Essentia's `Key` on our chroma scores worse than Essentia's own `KeyExtractor`** (0.51 vs 0.65 weighted). Its profiles are tuned to its own profile settings.
  - Essentia engine [5b] stays as an ensemble input.
  - The template engine is the primary engine from now on.
- **Default bass weight: 0.3.** It's the best on the tuning set, and 0.2–0.4 all score within 0.02 of each other. Phase 3 replaces it.
- **Confidence numbers are not calibrated yet.** The CLI says so, and phase 3 calibrates them.

---

## 5. Real-music evaluation: needs your PC

- The harness already reads **GiantSteps Key** (604 tracks) and **Beatport EDM Key** (1,486 tracks). Their annotations are on GitHub, and their `audio_dl.sh` scripts were updated in 2025.
- This sandbox's network policy blocks the audio host (Beatport's preview server), so I couldn't run them here.
- **The plan:** the phase 2 setup script for your RTX 40-series PC will also download these two datasets and run:

  ```bash
  python -m stoned_mango.evaluate giantsteps path/to/giantsteps-key-dataset
  python -m stoned_mango.evaluate beatport path/to/giantsteps-mtg-key-dataset
  ```

  That gives the first real-music numbers, and the baseline the CNN must beat.

---

## 6. How to reproduce

```bash
cd research
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
.venv/bin/python -m stoned_mango.synth /tmp/tune --eval-set 6 --seconds 30 --seed 1
.venv/bin/python -m stoned_mango.synth /tmp/heldout --eval-set 6 --seconds 30 --seed 2
.venv/bin/python -m stoned_mango.evaluate synthetic /tmp/tune --bass-weights 0 0.1 0.2 0.3 0.4 0.6
.venv/bin/python -m stoned_mango.evaluate synthetic /tmp/heldout --bass-weights 0 0.3
.venv/bin/stoned-mango /path/to/music --format csv
```

---

## 7. Next

- **Phase 2 (FOSS CNN), on your PC:**
  - a setup script (Python, CUDA PyTorch, datasets)
  - a synthetic training-data generator built from `synth.py`
  - training and ONNX export
  - first real-music numbers
- **Phase 3 (modes + home note):**
  - the proper home-note detector
  - "Aeolian or Dorian"-style ambiguity notes
  - calibrated confidence
  - a real-music modal test set (GiantSteps+)
