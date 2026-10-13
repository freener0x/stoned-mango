# Phase 5 report: the analysis runs in the browser

**Status:** done. The whole analysis now runs inside the web page, in background workers, and gives the same answers as the Python engine to about six decimal places. Files are read on the device; nothing is uploaded, and an automated test checks that no network request happens while files are analysed.

Try it: `cd web && npm run build && npm run preview`, then open the page and drop in some songs. The page is a plain engine preview; the real interface is phase 6.

## 1. What was built

| Piece | File (`web/src/engine/`) | What it does |
|---|---|---|
| Scales and names | `scales.ts` | Reads `shared/scales.json`. The same labels as Python: "D Dorian", "same notes as C major", flat or sharp spelling. |
| Resampler | `audio.ts` | The same half-band filter as Python, sample for sample. |
| Features | `features.ts` | Windowing, spectrum, spectral peaks and pitch profiles (HPCP) through **Essentia.js**: the same C++ core and settings as the Python side. Log-spectrogram, loudness, tuning and chroma folding are ported line by line. Stored as float32 in growing buffers, about 18 MB for a 20-minute song. |
| Engines | `engines.ts`, `cnn.ts`, `tonic.ts`, `fusion.ts`, `ambiguity.ts` | Template engine and Essentia key profiles. The key CNN on **ONNX Runtime Web** (WASM). Home-note cues, the fitted fusion from `shared/fusion.json`, and the ambiguity notes. |
| Timeline | `timeline.ts` | Windows, HMM/Viterbi, merging, boundary refinement and per-section labels, exactly as in phase 4. |
| Result | `analysis.ts` | The same JSON shape as Python's `analyse_features`, so results can be compared field by field. |
| Decoding | `wav.ts`, `decode.ts` | **WAV** is read directly a few seconds at a time. **MP3** is split into frames here and decoded by the browser's WebCodecs `AudioDecoder` inside the worker, 2 MB at a time. **Anything else** (FLAC, M4A, OGG…) goes through the browser's `decodeAudioData` on the main thread, whole file at once, so it has tighter limits. Limits from PLAN.md §5: 60 min / 500 MB streamed; 15 min / 150 MB for the fallback. |
| Worker | `worker.ts` | Loads Essentia.js and the model once, then decodes, extracts, analyses and reports progress per file. Supports cancel. |
| Worker pool | `pool.ts` | `clamp(floor(cores / 2), 1, 4)` workers, at most 2 with ≤ 4 GB of memory and 1 with ≤ 2 GB. A queue, pause/resume/cancel, and the main-thread fallback. |
| Preview page | `index.html`, `src/app/main.ts` | Drop files or a whole folder (searched recursively). Rows fill in as files finish, with key, parent key, confidence, ambiguity note, key changes and tuning. CSV and JSON export are generated on the device. The phase 0 benchmark page moved to `spike.html`. |

## 2. Parity with Python

- `python -m stoned_mango.golden` writes `shared/golden/`: short clips plus the Python engine's exact outputs on them.
  - `modulating-22k.wav`: C major, then G major at 18 s.
  - `dorian-44k-stereo.wav`: 44.1 kHz stereo with silent start and end. This exercises the resampler, the downmix and frames with no sound at all.
  - `noise-22k.wav`: pink noise.
  - An MP3 and a FLAC copy, for the browser's decoders.
- **`web/tests/parity.test.ts`** runs the TypeScript engine on those WAVs in Node (Essentia.js and ONNX Runtime Web both run there) and compares:

| Compared | Largest difference measured | Test tolerance |
|---|---|---|
| Tuning | 0.00002 cents | 0.001 cents |
| Chroma / bass chroma / one HPCP frame | 0.000001 | 0.0001 |
| Log-spectrogram (mean per band) | 0.00000003 | 0.00001 |
| CNN log-probabilities (360) | 0.000003 | 0.0001 |
| Fusion log-probabilities (360) | 0.000004 | 0.0001 |
| Label, key, parent, ambiguity note, alternatives, Essentia keys, section labels | identical | must be identical |
| Confidence / section boundaries | identical | 0.001 / 0.01 s |

- The rest is float32 rounding: the two engines are the same computation.
- **`research/tests/test_golden.py`** fails if the golden files go stale. A new model or new fusion weights means regenerating them, which then re-checks the browser.
- **The silent-frame bug.** Silent frames were the one real difference found, and only in a real-length song: Python's HPCP returns zeros when a frame has no spectral peaks, but Essentia.js throws. The browser engine now returns zeros too, and the golden Dorian clip has digital silence so the parity test covers it.
- **The CNN runs in pieces.** In one pass, its activations grow with song length: about +300 MB for a 20-minute song. It now runs on ~95 s pieces with 32-frame margins. The network only reaches about ±12 frames in time, so every output is exactly what a whole pass gives; a test checks this on every golden clip.

## 3. In a real browser (headless Chromium, 4-core machine)

**`web/tests/browser.mjs`** (in CI) loads the built page and analyses all the golden files through the worker pool:

| File | Decoded by | Result | Matches Python |
|---|---|---|---|
| modulating-22k.wav | WAV, in the worker | C major → G major | yes |
| dorian-44k-stereo.wav | WAV, in the worker | D Dorian | yes |
| noise-22k.wav | WAV, in the worker | No clear key | yes |
| modulating-22k.mp3 | WebCodecs MP3, in the worker | C major → G major | yes |
| dorian-22k.flac | decodeAudioData fallback | D Dorian | yes |

- **Privacy:** after the engine has loaded, the test records every request the page makes while it analyses the files. The list must be empty, and it is. (The page also carries an empty inline icon, so the browser doesn't even ask for `/favicon.ico`.)

Speed and memory, with 2 workers:

| Input | Time | Extra browser memory |
|---|---|---|
| 4-minute song, WAV (44.1 kHz stereo) | 5.1 s | +63 MB |
| 4-minute song, MP3 (192 kbps) | 5.9 s | +80 MB |
| 20-minute song, WAV (212 MB file) | 22.3 s | +66 MB |
| 20-minute song, MP3 | 27.5 s | +109 MB |
| 8 × 4-minute MP3 (32 minutes of audio) | 31.7 s | +225 MB |

- **Memory stays flat with length:** a 20-minute WAV costs the same as a 4-minute one, because of the streamed decoding and the chunked CNN.
- **Speed:** about 60× real time in bulk, so **100 songs take about 6½ minutes** on this machine. That's in line with phase 0's estimate, now with the full engine (fusion, timeline) instead of the spike.
- The key change in the long test songs was placed at 113 s and 563 s; the true changes were at 113.5 s and 562.9 s.

## 4. Limits and next steps

- **MP3 gapless trimming:** encoder delay and padding are not trimmed, unlike libsndfile/mpg123 in Python. That shifts the audio by a few milliseconds; the labels are unaffected (tested).
- **Fallback formats** (FLAC, M4A, OGG) are decoded by the browser at 44.1 kHz and on the main thread, so they are slower to start and limited to 15 minutes. Streaming FLAC in the worker is possible later if it matters.
- **Browsers:** WebCodecs MP3 works in Chromium. Browsers without it use the fallback automatically. Safari and Firefox still need checking on real devices, along with phones (the Cloudflare preview links make that easy).
- **Phase 6 (UI)** builds the real interface on `AnalysisPool`: the batch table, the timeline view, settings, the PWA and optional key tagging.
