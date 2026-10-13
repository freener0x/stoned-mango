# Phase 3 report: home note, engine fusion, calibrated confidence

**Status:** done.

- The real-music fit ran on the author's PC (§3). It ties the CNN on real major/minor music, is better on modes and calibration, and now ships as the default (`shared/fusion.json`).
- One rerun of `calibrate-windows.cmd` ([guide step 6](../phase2/TRAINING-ON-WINDOWS.md#step-6-calibrate-phase-3-after-training)) is still needed. It confirms the corrected "No clear key" floor on real music.

## 1. What was built

| Piece | File | What it does |
|---|---|---|
| Home-note (tonic) cues | `research/stoned_mango/tonic.py` | Three 12-note clues for which note is "home": the **bass** profile, the **ending** (notes of the last 15% of the track) and the **drone** (how often each note is among the two loudest). All come from the features already cached for training, so no audio has to be re-read. |
| Engine fusion | `research/stoned_mango/fusion.py` | Scores all 360 answers (12 home notes × 30 scales) with a weighted sum of the CNN, the phase 1 template engine and the three cues, then turns the scores into probabilities. The weights are fitted by maximum likelihood, which also **calibrates** the confidence. Songs labelled only "major"/"minor" count as right for every scale with that third. |
| "No clear key" | `research/stoned_mango/keyless.py`, `fusion.py` | The fit also scores 40 clips with no key (white, pink and brown noise, and drum loops with pitched kicks). It sets the floor 50% above the most confident of them, capped so that at most 2% of each source's songs lose their answer. The floor applies to the key confidence (home note + major/minor family; see §3). Below it the app says **"No clear key"** and still shows the best guess. |
| Ambiguity notes | `research/stoned_mango/ambiguity.py` | Two honest notes, shown when a close runner-up can't be ruled out: **"A minor or A Dorian: the 6th note is barely played"** (the two scales differ only in notes the song hardly uses) and **"Home note unclear: C major or A minor (same notes)"**. |
| Analysis and command line | `analysis.py`, `cli.py` | `--engine auto` uses the fusion when `shared/fusion.json` exists, else the CNN. Every answer carries its ambiguity note; the table and CSV output print it. |
| Evaluation | `evaluate.py`, `fusion_summary.py` | New `--fusion` engine(s) and new metrics: `conf`, `ece` (calibration error), `flagged` (note shown), `in_note` (the answer or the note's alternative is right) and `no_key`. |
| Your PC | `calibrate-windows.cmd`, `scripts/linux/calibrate.sh` | Makes 1,200 new synthetic songs (seed 21, never used for training). Fits two fusions: synthetic only, and synthetic plus the 10% of Beatport tracks the CNN held out. Tests both against the CNN on GiantSteps and the held-out songs, and writes `SUMMARY.md`. |

Tests: `research/tests/test_fusion.py` (22 tests). They cover the cues, the feature layout, a finite-difference check of the likelihood gradient, recovery of an informative cue, save and load, ECE, both ambiguity notes, the fusion engine end to end, noise and drums giving "No clear key", and the CLI note output. **134 tests pass** in total.

## 2. Results here (synthetic music only)

### Which clues help (5-fold cross-validation on the 1,200 fitting songs)

| Features | Exact scale | Home note | ECE |
|---|---|---|---|
| CNN alone, raw | 0.660 | 0.743 | 0.100 |
| CNN alone, fitted temperature | 0.660 | 0.743 | 0.022 |
| CNN + template | 0.692 | 0.767 | 0.024 |
| CNN + template + bass | 0.693 | 0.768 | 0.018 |
| CNN + template + drone | 0.692 | 0.768 | 0.020 |
| CNN + template + ending | 0.698 | 0.773 | 0.013 |
| All five | 0.698 | 0.774 | 0.021 |
| Template + cues, no CNN | 0.439 | 0.673 | 0.132 |

- Most of the gain comes from putting the **template engine** back next to the CNN, once the combination is learned rather than a plain product. Phase 2's plain product *lost* accuracy.
- Calibration alone fixes most of the CNN's confidence problem: ECE falls from 0.100 to 0.022 with the same answers.

### Held-out songs (300 new songs, 10 per scale, never fitted on)

Shipped rule: all weights ≥ 0 (see §4). Fitted weights: CNN 1.28, template 2.78, bass 0.10, ending 0, drone 0.94. No clear key below 0.248.

| Engine | Weighted | Home note | Exact scale | Right notes | Mean confidence | ECE | Note shown | Answer or note right |
|---|---|---|---|---|---|---|---|---|
| **Fusion** | **0.801** | **0.800** | **0.693** | **0.890** | 0.715 | **0.066** | 21% | 0.797 |
| CNN alone | 0.777 | 0.777 | 0.673 | 0.867 | 0.580 | 0.097 | 31% | 0.787 |
| CNN × template (phase 2) | 0.738 | 0.740 | 0.593 | 0.817 | | | | |
| Template + bass (phase 1) | 0.681 | 0.683 | 0.433 | 0.643 | | | | |

By family, the fusion is equal or better everywhere. Exact-scale accuracy:

| Family | CNN | Fusion |
|---|---|---|
| Diatonic | 0.63 | 0.66 |
| Harmonic minor | 0.66 | 0.69 |
| Melodic minor | 0.64 | 0.67 |
| Symmetric | 0.73 | 0.73 |
| Blues | 0.60 | 0.60 |
| Pentatonic | 0.85 | 0.85 |
| Double harmonic | 0.80 | 0.80 |

**Confidence means more now.** The table shows how often each engine was right when it said a given confidence:

| Said | CNN: songs / right | Fusion: songs / right |
|---|---|---|
| under 0.4 | 80 / 40% | 33 / 30% |
| 0.4–0.6 | 79 / 49% | 71 / 49% |
| 0.6–0.8 | 69 / **88%** | 64 / 61% |
| 0.8–0.95 | 56 / 96% | 79 / 90% |
| 0.95 and up | 16 / 100% | 53 / 100% |

- The CNN is *under*-confident: at "0.7" it is right 88% of the time.
- The fusion is honest at both ends, and it is sure (≥ 0.8) about 44% of songs instead of 24%.
- It is still a little over-confident in the 0.6–0.8 band. Held-out ECE is 0.066, short of the plan's 0.05 target.

**Ambiguity notes.** The note appears on 42% of the fusion's wrong answers but only 12% of its right ones. A third of the wrong answers (34%) are rescued by the note, meaning the alternative it names was right.

**No clear key** (first version, applied to the exact answer; §3 moves it to the key confidence). The fitting keyless clips reached at most 0.166 and the floor was 0.248. One held-out song (0.3%) fell below it, and its answer was wrong anyway. A fresh set of noise and drum clips (a different seed) all read "No clear key" (tested).

## 3. Real music: the calibration run on the author's PC

Run `20260930-2046` ([full summary](calibration-run-20260930-2046.md)). The synthetic-only fit on the PC came out with exactly the same weights as the fit here, so the pipeline is reproducible across machines.

**GiantSteps Key (604 real EDM tracks, never fitted on):**

| Engine | Weighted | Major/minor exact | Home note |
|---|---|---|---|
| **Fusion (synthetic + Beatport)** | **0.703** | 0.649 | **0.714** |
| CNN alone | 0.701 | 0.651 | 0.710 |
| Fusion (synthetic only) | 0.695 | 0.637 | 0.702 |
| Template + bass (phase 1) | 0.559 | 0.464 | 0.599 |

- **Real music: a tie.** Fitting on the Beatport tracks the CNN held out is what keeps the template engine from hurting on EDM: weights CNN 1.12, template 2.12, bass 0.50, drone 0.42. The synthetic-only fit loses 0.006.
- **Modes and calibration: better.** On the held-out songs this fit scores 69.7% exact mode against the CNN's 67.3%, with ECE 0.057 against 0.097.
- **Decision:** this fit ships as `shared/fusion.json`, so `--engine auto` now uses the fusion. It doesn't cost anything on major/minor music and is better at modes, ambiguity notes and calibrated confidence.

**Bug found by the run: the confidence used for "No clear key".**

- The first floor was applied to the probability of the *exact* answer (e.g. "D Dorian"). On real music that probability is spread over close modes of one clear key ("D Dorian 0.35, D minor 0.30, D Phrygian 0.10"). So 7.6% of GiantSteps tracks fell below the floor, and the real-music ECE (0.20) compared the wrong event against the major/minor labels.
- **Fix:** the floor now applies to the **key confidence**: the answer's home note plus its major/minor family (`fusion.key_confidence`).
  - The floor is re-chosen on that: 1.5 × the most confident keyless clip, capped at 2% withheld for **each** source of songs separately, so real music gets its own cap.
  - Real-music evaluation now compares the key confidence with the major/minor labels.
  - `evaluate` also reports `no_key_right`: how often the withheld answers would have been right.
- **The shipped file:** its floor (0.327) was re-chosen here (`python -m stoned_mango.fusion floor`) from the keyless clips and the synthetic fitting songs. On the held-out songs it withholds 2.0% of answers, and only 33% of those would have been right (70% overall). So it withholds the right ones.
- **Still to confirm on real music:** the GiantSteps "No clear key" rate under the new floor needs one more `calibrate-windows.cmd` run. It re-uses everything already made, so only the fit and the tests run again.
- The CLI shows both numbers, e.g. `D Dorian  confidence 0.45 (D minor family 0.82)`.

### Second PC run: the corrected floor on real music

Run `20260930-2246` ([summary](calibration-run-20260930-2246.md)).

- **The floor works on real music.**
  - It was chosen with the per-source cap on the PC's Beatport tracks (0.196).
  - GiantSteps "No clear key" fell from 7.6% to **2.2%**, and only 23% of those withheld answers would have been right (65% overall).
  - The synthetic-only fit, with no real songs to protect, withheld 7.5%. That shows why the per-source cap matters.
- **Real-music calibration, measured correctly now, needs work.**
  - With key confidence against the major/minor labels, the fusion is over-confident on GiantSteps: it says 0.74 on average and is right 65% of the time (ECE 0.115).
  - The CNN alone happens to be close (0.66 said, 65% right; ECE 0.091).
  - The fusion's sharper weights help the exact mode on synthetic songs but overstate certainty on EDM.
- **Fix (in this commit):** after fitting the weights, `fusion fit` scales them all by one **real-music temperature**.
  - The temperature is fitted on the held-out Beatport tracks alone.
  - Scaling changes no answer, only how sure it sounds. Real music is what people upload, so its calibration takes priority.
  - Per-source ECE is recorded in the file's `meta`.
  - Needs one more `calibrate-windows.cmd` run.
- **Noise and drums:** the real-music floor (0.196) sits below the most confident keyless clip (0.219), so some noise and drum clips get an answer. The temperature changes both sides of that comparison; the next run will show where they land.

### Third PC run: the real-music temperature (shipped)

Run `20260930-2345` ([summary](calibration-run-20260930-2345.md)).

- **The temperature came out at 0.880**: the fusion's weights are flattened by 12% so its confidence matches the real Beatport tracks.

| GiantSteps (604 tracks) | Weighted | Says (mean) | Right (major/minor) | ECE | "No clear key" | Withheld that were right |
|---|---|---|---|---|---|---|
| **Fusion, run 3 (shipped)** | **0.703** | 0.705 | 0.649 | 0.099 | 2.2% | 23% |
| Fusion, run 2 (no temperature) | 0.703 | 0.741 | 0.649 | 0.115 | 2.2% | 23% |
| CNN alone | 0.701 | 0.659 | 0.651 | 0.091 | – | – |

- **Shipped:** `shared/fusion.json` is now this run's fit. It holds run 1's weights × 0.880 and the floor of 0.168 chosen on the PC with the per-source cap, rebuilt from the summary.
- **Calibration is better on real music, not yet good.**
  - ECE fell from 0.115 to 0.099, about level with the CNN alone; the plan's target is < 0.05.
  - On the held-out synthetic songs it rose from 0.057 to 0.080, the expected cost of putting real music first.
  - One factor fitted on 133 EDM previews can't do more. The next real step is more varied real music with trusted keys, beyond EDM. That needs data, not code, and is noted for the accuracy page (phase 7).
- **Noise and drums:**
  - The real-music floor (0.168) sits a little below the most confident keyless clip (0.188). Fresh noise and drum sets are caught 85–92% of the time.
  - The rest get an answer whose key confidence is at most 0.21, which the app shows.
  - This is the intended trade-off: real songs are protected first (2% cap per source).

### Your own library: the library check

On the author's music, almost no files had a key tag: the keys are written by hand in the file names. So the check reads them there first (`key_from_name`).

- Accepted: a whole bracketed group (`(Am)`, `[8A]`), a whole ` - `-separated part (`01 - F#m - Title`), "in G minor" / "in B flat major", a Camelot code anywhere, lowercase keys as words (`artist g#min title`, `fmin`), keys among other words (`Title C#m 128`, `Artist D#min Title`), and `C# Minor` with a capital M.
- Never read as keys: words inside a title ("Here I Am", "A Minor Incident") or a one-letter artist name.
- When names can't be read, the summary shows their layout with every word replaced by `w`, so the parser can be extended without seeing any titles.

- `library-windows.cmd` (`scripts/linux/library.sh`, `stoned_mango/library.py`) analyses up to 1,000 full-length tracks from a music folder and compares the answers with their key tags.
  - It reads ID3 `TKEY`, MP4 `initialkey`, and Vorbis/FLAC `INITIALKEY`/`KEY`.
  - It understands standard, Camelot and Open Key notation.
  - Short files (likely loops and samples, which producers usually name with their true key) are reported as their own group.
- **Tags are often wrong**, so the summary reports *agreement*, not accuracy. It also breaks disagreements down into a fifth above, a fifth below, relative, parallel and other, and splits agreement by whether the app was sure.
- **The ending clue:** it also compares the fusion with the "ending" cue switched on at weights 0.5, 1 and 2. This is the first test on full-length songs, and it decides whether the ending cue can be switched on.
- **Privacy:** `SUMMARY.md` holds totals only; `tracks.csv` and `to-check.csv` (file names) stay on the PC. The author's results stay private too: this report gives only what they taught.
- Tag reading uses `mutagen` (GPL-2.0-or-later, compatible with AGPL-3.0). It is research-side only and never shipped to the browser.

### What the library checks taught

The author ran the check three times, the last on the whole library (mostly hip-hop and EDM).

- **The ending cue stays off, now with evidence.** On real full-length songs, every amount of it lowered agreement, in every run. The weight fitted on cut clips was 0, and full songs agree.
- **The fusion matches or slightly beats the CNN alone**, as on GiantSteps.
- **The fifths.** Many disagreements are a home note a fifth apart, with no overall direction (as many above as below), so there is no systematic dominant-for-tonic mistake to correct.
  - The check lists the 12 most confident disagreements in `to-check.csv` for a listen.
  - The author listened to them and found the app's answers "seem to be correct", though not certainly.
  - In loop-based hip-hop and EDM, two chords a fifth apart can each sound like home, so these stay listed as ambiguous rather than counted as errors.
- **"Agrees when sure" is barely above "unsure".** With hand-written keys this is the expected sign of label noise, not proof of poor calibration (GiantSteps, with checked labels, measures calibration directly).

## 4. Decisions and limitations

- **No negative weights.**
  - Training clips are cut mid-song: Beatport previews, and synthetic songs cut at 30 s. On these the "ending" cue came out *negative* (−0.95), because the last seconds of a cut clip are an arbitrary chord.
  - On a full song that really ends at home, that weight would count against the right answer. All weights are now bounded at ≥ 0, which costs 0.012 on the fitting songs.
  - The ending cue is therefore unused (weight 0) until there is training material with real endings: full-length songs, or songgen songs that finish with a cadence.
- **The Beatport validation split** that the fusion may use was also used for early stopping in phase 2. That is a mild optimistic bias; GiantSteps stays fully untouched.
- **ECE target not met yet** (0.066 against < 0.05). If the real-music fit doesn't reach it, the next step is a per-song temperature that depends on track length and loudness, not just on the scores.
- **Home-note confusions are the remaining error.** The right notes are found 89% of the time, but the home note only 80%. The cues help a little on synthetic songs. Real music, with genuine endings and bass lines, is where they should matter more; phase 4's timeline will also give the ending cue proper phrase ends.

## 5. Reproduce

```bash
cd research
python -m stoned_mango.songgen CACHE/fusion-synthetic --per-scale 40 --seconds 30 --features --seed 21
python -m stoned_mango.songgen HELDOUT --per-scale 10 --seconds 30 --seed 999
python -m stoned_mango.fusion fit --synthetic CACHE/fusion-synthetic --out ../docs/phase3/fusion-synthetic.json
python -m stoned_mango.evaluate songs HELDOUT --no-keyextractor --fusion ../docs/phase3/fusion-synthetic.json
```

The held-out results are in `docs/phase3/heldout-songs.json`.
