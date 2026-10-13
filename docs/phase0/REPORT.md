# Phase 0 report: spike + licence audit

**Status:** complete, except real-phone measurements (see §4.5).
**Verdict:** **go**. Running the whole analysis in the browser works, is fast enough, and gives the same answers as the Python reference. Two things must change before phones can handle long files and bulk batches: *stream* the audio, and decode it *in the workers*. Both are now in PLAN.md.

---

## 1. Summary

| Question | Answer |
|---|---|
| Do Essentia.js and ONNX Runtime Web run inside a Web Worker? | **Yes.** Both load and run in ES-module workers in Chromium 141 |
| Does the browser give the same answers as Python? | **Yes.** Essentia key labels matched on **80/80** checks (10 pieces × 4 profiles × WAV and MP3), and key strengths agreed to 3 decimal places. ONNX outputs match Python onnxruntime to within **6 × 10⁻⁶** |
| How fast is it? | A 4-minute song takes **~4 s of analysis per core**, about 45–60× faster than real time. A 24-song batch (97 min of audio) takes **80 s with 2 workers** |
| Does memory stay bounded? | **Not yet.** Per worker it's fine: no leaks, and the Essentia heap stays at 31 MB across 24 files. But decoding a whole file at once peaks at **+1.0–1.2 GB for a 20-minute track**. Fix: streaming (§5) |
| How much does a first visit download? | **~4.5 MB compressed** (ONNX Runtime 3.6 MB, Essentia 0.8 MB, model 0.1 MB). Cached for offline use after the first visit |
| Can we host it on Cloudflare Pages? | **Yes, WASM backend only.** ORT's WebGPU build is 27 MB, over Pages' 25 MiB per-file limit. Our model is small enough that WASM is plenty |
| Which training data keeps the model FOSS? | **GiantSteps Key, Beatport EDM Key and GiantSteps+** (CC BY-SA 4.0), **McGill Billboard** (CC0), **FSL10K loops** (CC BY 4.0), plus our own synthetic audio. Anything non-commercial (NC) or unclear is used for **evaluation only**. See §6 |
| Can classic methods detect modes? | **No, as expected.** The A minor piece came back as C major. Lydian and Locrian came back as their parent key, and the C→D modulation as G major. This confirms the plan's separate tonic detector [5d] and the timeline [7b] |

---

## 2. What was built

| Path | What it is |
|---|---|
| `research/pyproject.toml` | Python package `stoned-mango` (AGPL-3.0-or-later), pinned to `essentia==2.1b6.dev1389` |
| `research/stoned_mango/synth.py` | Synthetic music with a known key and mode: bass, chords, melody and drums, in all 7 church modes, plus a modulation, a +30¢ detuned piece, and 4/10/20-minute stereo files. It is the start of the phase 2 training-data generator |
| `research/stoned_mango/essentia_key.py` | Engine [5b] in Python: Essentia `KeyExtractor` (edma, bgate, temperley, krumhansl) plus tuning. This is the reference the browser is checked against |
| `research/spike/make_placeholder_cnn.py` | Builds a placeholder key CNN in ONNX (fp32 and int8), about 2–4× heavier than Korzeniowski & Widmer (2018), with **random weights**. It exists only to measure the runtime. It also writes golden input/output files for the parity test |
| `research/spike/compare_parity.py` | Compares browser results with Python results |
| `web/` | Vite + TypeScript spike: `src/spike/main.ts` (decoding and the worker pool), `src/spike/worker.ts` (Essentia.js + ORT Web), `src/spike/logfilter.ts` (CNN input features), and `index.html` (a manual benchmark form) |
| `web/bench/run-bench.mjs` | Playwright runner: drives headless Chromium and samples the whole browser's memory (PSS) |
| `LICENSE` | AGPL-3.0 text |

---

## 3. Test machine

- A 4-vCPU cloud container with 16 GB of RAM, running headless Chromium 141.
- Its per-core speed is roughly that of a mid-range laptop. It is **not** a phone.
- "Idle" memory means the whole headless browser with the page loaded: about 283 MB.
- Memory is measured as PSS summed over every Chromium process, which avoids counting shared libraries twice.

---

## 4. Results

### 4.1 Parity: browser vs Python

- **Essentia key labels:** 80/80 identical.
  - That's 10 synthetic pieces × 4 profiles, as WAV and as MP3.
  - Browser decoding (Web Audio) and Python decoding (Essentia's MonoLoader) differ slightly, but not enough to change any answer.
  - Largest strength difference: < 0.0005.
- **Tuning:** the +30¢ piece was measured at +30.0¢ in the browser and +29.0¢ in Python. All other pieces read +1.0¢ in both.
- **ONNX Runtime Web vs Python onnxruntime:** on the same input, the largest difference was 5.8 × 10⁻⁶ for fp32 and 2.4 × 10⁻⁶ for int8.
- **WAV vs MP3 (192 kbps):** 39/40 labels identical in each engine. The only difference was on the modulating piece (temperley profile), which is ambiguous anyway.

### 4.2 Speed of one 4-minute song (1 worker)

| Stage | Time | Notes |
|---|---|---|
| Decode MP3 → mono 22.05 kHz (main thread) | 0.85 s | `decodeAudioData` on an `OfflineAudioContext` |
| Essentia `KeyExtractor` × 4 profiles | 1.9 s (≈ 0.47 s each) | Each profile repeats the whole analysis. **Wasteful**: see §5 |
| Frame loop (2,599 frames) | 1.8 s (0.68 ms/frame) | Spectrum, peaks, 12- and 120-bin HPCP, tuning, CNN input features |
| Placeholder CNN, int8 | 0.28 s | fp32 took 0.27 s. int8 is **not faster** at this size, but the file is 3.4× smaller (92 KB vs 315 KB) |
| Worker start-up (once per worker) | 0.3–0.6 s | ORT session. Essentia starts in ~13 ms |
| **Total, wall clock** | **5.4 s** | 4.1 s with a single KeyExtractor profile |

Longer files scale linearly, at about **1.2 s of analysis per minute of audio**: a 10-minute file took 12.5 s, and a 20-minute file 24.8 s.

### 4.3 Memory

| Scenario | Peak browser PSS | Above idle | Essentia WASM heap |
|---|---|---|---|
| 4-min MP3 | 516 MB | +233 MB | 31 MB |
| 10-min MP3 | 842 MB | +558 MB | 68 MB |
| 20-min MP3 | 1,280 MB | +995 MB | 128 MB |
| 20-min WAV (212 MB file) | 1,515 MB | +1,232 MB | 128 MB |

- **No leaks.** Every embind vector is `delete()`d, and the Essentia heap stayed at exactly 31 MB across 24 files in one worker.
- **Memory still grows with song length**, because at several points the whole song is held in memory at once:
  - the raw file bytes
  - the decoded stereo buffer
  - the mono copy
  - a second copy inside the WASM heap
- Chromium also appears to decode at the file's own sample rate before resampling.
- A 20-minute file therefore needs over 1 GB, which would crash many phones. **Fix in §5.**

### 4.4 Bulk: 24 × 4-min MP3 (96.6 min of audio)

| Workers | Wall time | Speed | Peak PSS |
|---|---|---|---|
| 1 | 105 s | 55× realtime | 751 MB |
| **2** | **80 s** | **72×** | 955 MB |
| 3 | 75 s | 77× | 1,180 MB |
| 4 | 74 s | 79× | 1,313 MB |

- **Beyond 2 workers, gains were small on this machine.** Each file's analysis time rose from 3.5 s to 10.1 s as workers competed for the 4 vCPUs.
- **Decoding blocks progress.** It runs on the main thread, one file at a time. Moving it into the workers (§5) lets it run in parallel too.
- Each extra worker adds about 200 MB at peak. That also goes away with streaming.
- The results table stayed responsive and there were no errors.

### 4.5 Phones: not measured yet

- **Chrome's CPU throttling is not a phone proxy.** At 4× and 6× throttling, only main-thread decoding slowed (0.85 s → 1.5–2.0 s). The workers ran at full speed.
- Real numbers need a real phone opening the benchmark page. Two ways to get them:
  - once the Cloudflare Pages site exists, open it on a phone; or
  - run `npm run build && npx vite preview --host` on a computer and open it from a phone on the same Wi-Fi.
- The page has a manual form for this: pick files, tap Run, and copy the JSON result.

### 4.6 Download size (first visit, compressed)

| Piece | Raw | gzip |
|---|---|---|
| ONNX Runtime Web (WASM, SIMD) | 13.6 MB | 3.6 MB |
| Essentia.js (ES build with the WASM inlined as base64) | 2.6 MB | 0.76 MB |
| Placeholder model (int8) | 0.09 MB | about 0.09 MB |
| **Total** | | **≈ 4.5 MB** |

- The service worker caches everything, so this is downloaded once.
- Two later optimisations:
  - Essentia's separate `.wasm` build (0.5 MB gzip) compiles as it downloads.
  - A custom ORT build containing only our operators could cut ORT to about 1–2 MB.

---

## 5. Changes to the plan (now applied in PLAN.md)

1. **Stream the audio instead of decoding whole files.**
   - WAV files are read in chunks directly with `File.slice`, so no decoder is needed.
   - MP3s go through the WebCodecs `AudioDecoder` where the browser supports it; it is also available inside workers. `decodeAudioData` stays as a fallback for other formats and older browsers, with a shorter length limit.
   - Features are accumulated chunk by chunk; key detection only needs running totals and per-window summaries.
   - **Expected result:** memory per worker stays about the same whatever the song's length (tens of MB instead of ~1 GB).
2. **Decode inside the workers**, not on the main thread. This removes the bulk bottleneck in §4.4 and keeps the UI smooth.
3. **Compute pitch profiles once, then score all key profiles in TypeScript.** Essentia's key profiles are just tables of numbers. This saves about 1.4 s per 4-minute song compared with calling `KeyExtractor` four times.
4. **Default worker count:** `clamp(floor(cores / 2), 1, 4)`, where `cores` is the logical core count. The earlier formula was `cores − 1`, but logical cores overstate real capacity. To be re-checked on real laptops and phones.
5. **ONNX Runtime: WASM backend only**, no WebGPU. The WebGPU build breaks Cloudflare Pages' 25 MiB per-file limit, and the model is too small to benefit from a GPU.
6. **Model weights will be published under CC BY-SA 4.0**, not the code licence.
   - The best FOSS training annotations are CC BY-SA 4.0 (ShareAlike), so the weights should carry the same licence.
   - CC BY-SA 4.0 is a free-culture licence and is one-way compatible with GPLv3.
7. **Training-data list revised** following the audit in §6.
8. **Training environment:** this sandbox's network policy blocks `download.pytorch.org`. Phase 2 needs a machine (or network rule) where PyTorch can be installed. The ONNX side of training was checked here, using `onnx` directly.

---

## 6. Licence audit

### 6.1 Datasets

**Sources:**
- Licence strings come from each dataset's loader in [mirdata](https://github.com/mir-dataset-loaders/mirdata) (checked in the repository), from the datasets' own READMEs, and from search results for sites this sandbox could not reach.
- Zenodo, isophonics.net and ddmal.ca are blocked by this environment's network policy. Rows marked † should be re-checked at the source before training.

| Dataset | Content | Licence | Use |
|---|---|---|---|
| **GiantSteps Key** | 604 two-minute EDM previews (Beatport), key | CC BY-SA 4.0 (per mirdata; the repo README states none) | **Training + eval** |
| **Beatport EDM Key** (GiantSteps MTG Key) | 1,486 EDM previews, key + confidence | CC BY-SA 4.0 | **Training + eval** |
| **GiantSteps+ EDM Key** † | 500 of the above, with **pitch-class sets, key changes and modal changes** | CC BY-SA 4.0 (Zenodo record, via search) | **Training + eval, and our only real modal labels** |
| **McGill Billboard** | 742 pop songs from 1958–91; tonic only, no mode | CC0 | **Training (tonic head) + eval** |
| **FSL10K** (Freesound Loop Dataset) † | 9,455 loops with key annotations | Annotations CC BY 4.0. Each loop has its own Freesound licence | **Training, using only CC0/CC BY loops** |
| FMA Keys | 5,489 songs with key + mode | The loader says "non-commercial research" (its licence field says CC BY 4.0, which is contradictory) | **Eval only** |
| Isophonics (Beatles, Queen, …) † | Key and key-change annotations | Unclear (mirdata couldn't find one) | **Eval only** |
| Tonality ClassicalDB | Classical key labels | CC BY-NC-SA 4.0 | Eval only |
| Haydn Op. 20 | Classical, harmonic analysis | CC BY-NC-SA 4.0 | Eval only |
| Saraga (Carnatic, Hindustani) | Raga, tonic | CC BY-NC-SA 4.0 | Eval only (tier 3c) |
| CompMusic Indian tonic | Tonic (Sa) | CC BY-NC-SA 4.0 | Eval only (tier 3c) |
| CompMusic Raga | 780 recordings, 70 ragas, tonic | Annotations CC BY 4.0 (audio access restricted) | Eval; training possible for the annotations |
| CompMusic OTMM Makam | Turkish makam | CC BY-NC-SA 4.0 | Eval only (tier 3b) |
| madmom key model | Pre-trained CNN | **CC BY-NC-SA 4.0** (confirmed in the madmom README) | **Not used.** We train our own |

**Audio copyright caveat:**
- The GiantSteps and Beatport audio is commercial preview clips. The annotations are CC BY-SA, but the audio isn't ours.
- Whether training on copyrighted audio is allowed depends on the country (the EU has a text-and-data-mining exception; in the US it's unsettled). We never redistribute the audio, and the weights don't contain it.
- To keep the risk low, phase 2 will lean on CC-licensed audio (FSL10K) and our synthetic audio first, and report how much the Beatport-derived data adds.
- This is not legal advice.

### 6.2 Software and assets

| Dependency | Licence | Where it's used | OK for AGPL FOSS? |
|---|---|---|---|
| Essentia (Python) / Essentia.js | AGPL-3.0 (source headers: "or later"; PyPI metadata: "only") | Shipped (web), research | ✅ It's the reason the project is AGPL |
| ONNX Runtime Web / onnxruntime | MIT | Shipped / research | ✅ |
| onnx | Apache-2.0 | Research | ✅ |
| Vite, TypeScript, Playwright | MIT, Apache-2.0, Apache-2.0 | Build/test only | ✅ |
| React (planned) | MIT | Shipped | ✅ |
| wavesurfer.js (planned) | BSD-3-Clause | Shipped | ✅ |
| browser-id3-writer (planned) | MIT | Shipped (optional tagging) | ✅ |
| JSZip (planned, batch downloads) | MIT or GPL-3.0 | Shipped | ✅ |
| qrcode (planned, donate page, build time only) | MIT | Build | ✅ |
| NumPy, SciPy, soundfile | BSD-style | Research | ✅ |
| lameenc | LGPL-3.0 | Research only (writes MP3 test files) | ✅ Not shipped |
| FluidR3_GM soundfont | MIT | Research (synthetic training audio) | ✅ |

### 6.3 Hosting

- **Cloudflare Pages:** 25 MiB maximum per file (per Cloudflare's limits page, via search).
- Our largest file is ORT's 13.6 MB WASM, so we're within the limit. The WebGPU build (27 MB) would not be; see §5.5.

---

## 7. Environment notes

- `essentia==2.1b6.dev1110` (the newest build for Python 3.11 before 2025) **crashes on import under NumPy 2**. `2.1b6.dev1389` works and is pinned.
- Playwright 1.63 expects a newer Chromium than the one installed here. The runner uses a pre-installed Chromium (`CHROMIUM_PATH`, or `/opt/pw-browsers/chromium`) when one is available.
- `download.pytorch.org` is blocked here (see §5.8).

---

## 8. How to reproduce

```bash
# Python side
cd research
python3 -m venv .venv && .venv/bin/pip install -e ".[spike]"
.venv/bin/python -m stoned_mango.synth /tmp/fx --mp3 --stereo --long 4 10 20
.venv/bin/python -m stoned_mango.essentia_key /tmp/fx && .venv/bin/python -m stoned_mango.essentia_key /tmp/fx --ext mp3
.venv/bin/python spike/make_placeholder_cnn.py          # writes web/public/spike/

# Browser side
cd ../web
npm install && npm run build
node bench/run-bench.mjs --fixtures /tmp/fx --out /tmp/bench.json
../research/.venv/bin/python ../research/spike/compare_parity.py /tmp/fx /tmp/bench.json

# Manual / phone: npm run build && npx vite preview --host, then open the page
```

---

## 9. Next: phase 1 (research core)

- Streaming feature extraction in Python, mirrored in the browser engine: chunked HPCP at 12 and 120 bins, plus tuning.
- Scoring of key profiles in our own code, replacing the four `KeyExtractor` calls.
- Tier 1–2 `shared/scales.json` and the scale-template engine [5c].
- Evaluation harness with `mir_eval`, run on GiantSteps / Beatport EDM Key and on the synthetic modal set.
- A command-line tool that analyses a whole folder.
