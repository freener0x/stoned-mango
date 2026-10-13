# Phase 4 report: key changes over time

**Status:** done and tested on synthetic songs. A real-music check (how often the timeline invents a key change) runs on your PC with `timeline-windows.cmd` ([guide step 8](../phase2/TRAINING-ON-WINDOWS.md#step-8-check-the-key-changes-timeline-phase-4)).

## 1. What was built

| Piece | File | What it does |
|---|---|---|
| Timeline engine | `research/stoned_mango/timeline.py` | Four steps, below. |
| Songs with key changes | `songgen.py --modulating N` | 90 s SoundFont songs with 0–2 key changes on bar lines, played by the same band at the same tempo throughout, so only the key moves. Nine kinds of change: fifth up or down, step up, semitone up, minor third up, tritone, relative, parallel, and a change of mode on the same home note. Changes that can't be heard (a minor third in a diminished scale) are left out. |
| Evaluation | `research/stoned_mango/timeline_eval.py` | Change points found within ±3 s (F-measure), share of the song in the right key, share of single-key songs wrongly split, and results by kind of change. `--grid` searches the HMM costs. |
| Output | `analysis.py`, `cli.py` | Every result has `segments` (start, end, label, key, parent, confidence, key confidence, ambiguity note), as specified in PLAN.md §6. The command line prints `key changes: 0:00–2:15 Bb Altered → 2:15–4:03 F Altered` and adds a `timeline` column to the CSV; `--no-timeline` skips it. |
| Real-music checks | `evaluate --timeline`, library check, `timeline.sh` / `timeline-windows.cmd` | GiantSteps tracks carry one key each, so any split is a false change. The library check also reports the share of your songs split into several keys. |

How the engine works:

1. **Windows.** Windows of about 12 s, every 3 s, each get scores for all 360 answers (12 home notes × 30 scales), from the same fusion as the whole-song answer. The CNN runs once over the whole song (it is fully convolutional), and each window averages its output.
2. **HMM.** A Viterbi path picks one answer per window. Staying put is free. A change costs `CHANGE_COST` plus `PER_NOTE_COST` for each note the two scales don't share, so a relative key costs less than a fifth away, which costs less than a distant key.
3. **Merging and refinement.**
   - Sections shorter than 10 s are folded into the neighbour with the closer key.
   - Each change point is then moved to where the two keys involved explain 1.5 s blocks best.
   - Long windows alone placed changes 2–3 s early; refinement brings them to within about 1 s.
4. **Labels.** Each section is scored again over all of its audio, which gives its label, confidence, ambiguity note, and "No clear key" if needed (a drum intro, say). Neighbours that come out the same join up. A song without changes gets exactly the whole-song answer.

The timeline adds about 0.5 s to a 4-minute song: features take 0.7 s, the key 0.8 s, and key plus timeline 1.3 s.

## 2. Tuning (120 songs, seed 41)

The change cost was searched from 2 to 50, with a per-note cost from 0 to 3 ([tuning-grid.json](tuning-grid.json)):

- A **low change cost** splits single-key songs: at 2, 57% of them were split.
- A **high change cost** misses real changes: at 50, only 83% were found.
- **Change cost 18, per-note cost 1** is the best balance: no single-key song split, 92% of changes found within 3 s, boundary F 0.958.
- The per-note cost hardly matters. Synthetic songs jump to distant keys as often as near ones, so it is kept small (1). It still makes near keys a little cheaper, as PLAN.md describes.
- The windows overlap by 75%, so each moment is counted about four times. That is why the tuned costs look large next to single log-probabilities.

## 3. Results on 120 different songs (seed 43; 32 of them with no key change)

| | Boundary F | Changes found within 3 s | Single-key songs split | Time in the right key | Right family | Right notes |
|---|---|---|---|---|---|---|
| **Timeline (cost 18 / 1)** | **0.961** | **93.4%** | **0 of 32** | **67.9%** | **76.7%** | **89.5%** |
| Cost 6 / 1 | 0.904 | 95.0% | 4 of 32 | 65.7% | 74.5% | 89.8% |
| One answer for the whole song | 0.267 | 0% | 0 | 38.4% | 52.9% | 57.5% |

By kind of change (found within 3 s):

| Change | Songs | Found |
|---|---|---|
| Fifth up | 31 | 97% |
| Fifth down | 11 | 91% |
| Step up | 9 | 100% |
| Semitone up | 10 | 91% |
| Minor third up | 16 | 100% |
| Tritone | 11 | 91% |
| Parallel (C major → C minor) | 9 | 100% |
| Mode change (D Dorian → D Mixolydian) | 15 | 93% |
| **Relative (C major → A minor)** | 4 | **25%** |

- **The plan's test passes:** a synthetic track that modulates at 30 s shows a boundary within ±3 s (`tests/test_timeline.py`).
- **Relative changes are the weak spot.** The notes stay the same; only the home note moves. This is the same home-note problem as in phase 3, and the 10 s merging plus the change cost make it harder still. A song that moves between relative keys usually reads as one key, and its ambiguity note says "Home note unclear: C major or A minor".
- **"Time in the right key" (68%)** sits close to the exact-mode accuracy of the whole-song answer (phase 3: 69.7%). The timeline finds *where* keys change about as well as the engine knows *which* key a stretch is in.

## 4. Real music

Real music has no timeline labels here, so the risk to measure is false changes:

- **GiantSteps Key:** 604 two-minute EDM previews, each labelled with one key. The `split` column counts tracks the timeline splits.
- **Your library:** the share of songs split into several keys. Hip-hop and EDM rarely change key, so this should be low.

Both run with `timeline-windows.cmd`. If false changes turn out common on real music, the change cost goes up; the synthetic results above show there is room (cost 25 still finds 92% of changes).

## 5. Reproduce

```bash
cd research
python -m stoned_mango.songgen TUNE --modulating 120 --seconds 90 --seed 41
python -m stoned_mango.songgen TEST --modulating 120 --seconds 90 --seed 43
python -m stoned_mango.timeline_eval TUNE --grid --grid-change 2 4 6 9 13 18 25 35 50 --grid-per-note 0 1 3
python -m stoned_mango.timeline_eval TEST                       # the shipped costs
stoned-mango song.mp3                                           # prints "key changes: …" when there are any
```
