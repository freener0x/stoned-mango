# stoned-mango: Build Plan

A free, open-source web app that tells you the **key and mode** of your MP3 and WAV files. You can check one song or a whole folder.

**Your music never leaves your device.** All analysis runs inside your browser, and there is no server to upload to. We can't store what we never receive.

For each file it reports:

1. the **overall key and mode**, in standard notation: "A minor", "D Dorian", "E Phrygian dominant", "Maqam Bayati on D" and so on. It includes a confidence score and the most likely alternatives.
2. a **timeline of key and mode changes** across the track

## Decisions so far

| Decision | Choice |
|---|---|
| Platform | Web app, analysis runs **in the browser** (no upload, works offline) |
| Licence | **FOSS**: AGPL-3.0-or-later. Funded by donations (Cash App, PayPal, Apple Pay, and BTC/ETH/SOL/XMR) |
| Privacy | **Nothing about the user is stored or sent anywhere.** This is a main marketing point |
| Music | Any genre |
| Output | Standard notation, plus key and mode changes over time |
| Bulk | Yes. Drop many files or a whole folder, within limits the device can handle |
| Modes | **All of them**: Western modes and scales first, then maqam, makam and raga (microtonal) |
| Priority | Best accuracy, using a neural model plus classic methods, all fully FOSS |
| Key tagging | Optional (off by default): write the key into the files' tags for DJ software |
| Hosting | Cloudflare Pages (static files only) |
| Training hardware | Your PC's NVIDIA RTX 40-series GPU (phase 2), on Windows 11 via WSL/Ubuntu (Essentia has no Windows builds) |
| Phone testing | Through Cloudflare Pages preview links (no Node.js needed on your side) |
| Key display | **The name and the Camelot code** by default: "A minor · 8A". A mode shows the code of the key with the same notes: "D Dorian · 8B (C major)". Settings can switch to the name only, Open Key, or a code only |
| Look | A dark **studio (DAW-style)** skin by default; other skins can be chosen in Settings |
| Devices | Phones and computers equally |
| Key tags for modes | **The key with the same notes** (D Dorian is tagged `C` / 8B), the same code the app shows. "Same home note" (`Dm` / 7A) stays available in Settings |
| Your software | FL Studio and Traktor Pro. Traktor shows the tag in its Key Text column and has no Camelot in its Key column, so Open Key or standard tags suit it |
| Maqam, makam, raga (phase 8) | All three traditions together. **Automatic**: considered only when the audio has quarter-tones or comma steps, or a drone, so ordinary songs keep their Western answer; Settings can force them on or off. A result shows the nearest Western key's code with ≈ ("Maqam Bayati on D · ≈7A"). Real-music accuracy is measured on your PC. Built: a maqam or makam also needs the Western engine to be unsure of its key (detuned samples in electronic music can look like quarter tones). **Changed after your PC's runs:** the first Automatic named 8% of GiantSteps tracks; refitted, it names none of them (0 of 604), but catches only ~1 in 7 real makam recordings, so the default is **Western scales only** and "Always, <tradition>" is the choice for that music |

---

## 1. What "exact" can mean

No key detector is right 100% of the time.

- **Major/minor:** the best published systems score about **75–80%** (weighted MIREX score). Their mistakes are usually musically close: relative (C major ↔ A minor), a fifth (C ↔ G), or parallel (C major ↔ C minor).
- **Modes:** harder still. D Dorian and C major use *exactly the same seven notes*; only the home note (the tonic) differs. Songs also often leave out notes:
  - If a song in A minor never plays the 6th note (F or F♯), then A Aeolian and A Dorian both fit the audio equally well.
  - A detector can't honestly choose between them.
- **Some music has no key:** drum loops, noise, and atonal pieces.

So the program never shows only one answer. It returns:

- the **best key and mode**
- a **confidence** score from 0 to 1, calibrated so that 0.8 means right about 80% of the time
- the **next 2–3 alternatives**
- **honest ambiguity notes** when they apply, for example: "A minor: Aeolian or Dorian (the 6th note is never played)"
- the **parent key**, for example "D Dorian: same notes as C major", which helps musicians and DJs
- the **tuning offset**, for example "+14 cents" (slightly sharp of A = 440 Hz)
- **"No clear key"** when the confidence is below a calibrated threshold

Accuracy numbers for every category will be published on an **Accuracy** page on the site. They come from the evaluation in §7.

---

## 2. Privacy by design (the marketing point, and verifiable)

"We don't store your data" is a promise. "We *can't* receive your data" is something anyone can check. We build the second one.

| Measure | What it guarantees |
|---|---|
| **No backend.** The site is only static files (HTML, JS, WASM, the model) | There is no server that could receive audio, even by mistake |
| **Strict Content-Security-Policy** (`connect-src 'self'`, no third-party origins) | The browser itself blocks the page from sending data anywhere else. Anyone can confirm this in devtools |
| **Works offline** (a PWA with a service worker cache) | Load it once, turn off Wi-Fi, and it still works. That is easy proof for users and reviewers |
| **No analytics, no cookies, no third-party scripts, fonts or CDNs.** Everything is self-hosted | No tracking of any kind |
| **Results live only in the tab's memory.** Closing the tab clears them. Exports (CSV or JSON) are made locally | Nothing is saved, not even in browser storage (only UI preferences such as notation style) |
| **Open source (AGPL) and built from public source by GitHub Actions** | Anyone can audit it. The AGPL also requires anyone who hosts a modified copy to publish their source |
| **Automated privacy test in CI**: a Playwright test that analyses files and fails if *any* network request happens after the page loads | Protects the promise against future changes |

**Honest fine print for the privacy page:** like any website, the static host sees that *someone loaded the page*: an IP address in its access logs. It never sees any music, filenames or results. We will host on **Cloudflare Pages** (free, with minimal logging). Users can also self-host or run it fully offline.

---

## 3. How the analysis works

```
files dropped / folder picked ─► each File handed to a worker (nothing read yet)
   │
   ▼  ── everything below runs in Web Workers (WASM), one chunk at a time ──
[1] Stream-decode ─► mono, 22.05 kHz Float32 chunks (a few seconds each)
[2] Tuning estimation ─► reference pitch (e.g. A4 = 441.8 Hz / Sa = C♯ +18 cents)
   │
   ▼
[3] Harmonic/percussive separation (median-filter HPSS) ─► drop drums, keep pitched content
   │
   ▼
[4] Pitch profiles (Essentia HPCP)
      • 12-bin  (Western, per frame + per window)
      • 120-bin (10-cent resolution, for microtonal scales)
      • bass-register profile (for tonic detection)
   │
   ├───────────────────────┬────────────────────────┬──────────────────────────┐
   ▼                       ▼                        ▼                          ▼
[5a] Our CNN          [5b] Essentia            [5c] Scale-template       [5d] Tonic detector
   (ONNX Runtime Web)     KeyExtractor             engine                    bass notes, long notes,
   tonic head (12) +      (edma/bgate/             (all scales in            cadences/endings,
   scale-family head      temperley profiles,      scales.json, 12-          drone detection
                          major/minor only)        or 120-bin)               (tanpura/oud drones)
   │                       │                        │                          │
   └──────────────── scores over (tonic × scale) ───┴──────────────────────────┘
                                   │
                                   ▼
[6] Ensemble + calibration ─► best key/mode, alternatives, ambiguity notes
                                   │
                  ┌────────────────┴────────────────┐
                  ▼                                 ▼
[7a] Global result                        [7b] Timeline
                                              ~12 s windows, ~3 s hop → per-window scores
                                              → HMM/Viterbi over (tonic × scale) states
                                              → merge segments < ~10 s
```

### Stage details

**[1] Stream-decode, inside the worker.** Phase 0 showed that decoding a whole file at once costs over 1 GB of memory for a 20-minute track, and that decoding on the main thread holds up bulk batches. So the worker reads the file a chunk at a time:
- **WAV:** read directly in chunks with `File.slice`. No decoder is needed.
- **MP3:** WebCodecs `AudioDecoder` where the browser supports it (it is available inside workers), fed one MP3 frame at a time.
- **Fallback:** `decodeAudioData` handles other formats (FLAC, OGG, usually M4A/AAC) and browsers without WebCodecs. It needs the main thread and the whole file at once, so it gets a shorter length limit.
- Each chunk is downmixed to mono, resampled to 22.05 kHz, analysed, and thrown away. Memory per worker stays roughly constant whatever the song's length.

**[2] Tuning.** Essentia's `TuningFrequency`. For non-Western music the reference pitch can be any value, not just the nearest piano note, and it is measured to 10-cent precision.

**[3] HPSS** (harmonic/percussive source separation). A median-filter mask applied to the spectrogram, written in TypeScript and mirrored in Python. We keep it only if the evaluation shows it helps.

**[4] Pitch profiles.** Essentia's HPCP runs in two versions:
- **12 bins**, for Western scales
- **120 bins** (10 cents each), for maqam quarter-tones, Turkish makam intervals and raga intonation

A separate **bass-register profile** feeds tonic detection, because bass notes are strong evidence of the home note.

**[5a] Our own CNN.** We train our own model because the best off-the-shelf model (madmom's) uses a **non-commercial licence, which is not FOSS**. We use the same proven design (Korzeniowski & Widmer, 2018).
- It has two outputs (heads):
  - **tonic** (12 classes)
  - **scale family** (major, minor, and the other Western scales)
- It is exported to ONNX, quantized to int8 (target under 5 MB), and runs with ONNX Runtime Web (MIT) on its **WASM backend**.
  - WebGPU is not used: its runtime file (27 MB) exceeds Cloudflare Pages' 25 MiB per-file limit, and the model is too small to benefit.
  - The network is fully convolutional, so one pass over the song gives scores for every moment. The global key and the timeline windows both come from that single pass.

**[5b] Classic key profiles (Essentia's).** A strong classic method for major and minor, using several key profiles: `edma` and `bgate` suit electronic music, `temperley` and `krumhansl` suit classical and pop. The pitch profile from [4] is computed once, and all key profiles are scored against it in our own code. Calling Essentia's `KeyExtractor` once per profile would repeat the whole analysis each time (≈ 1.4 s wasted per 4-minute song in phase 0).

**[5c] Scale-template engine.** This is where "all modes" lives.
- Every scale is one entry in **`shared/scales.json`**: name, aliases, family, intervals in cents, and weights for its stable notes. Adding a scale means adding a line to that file.
- The pitch profile is compared against each scale at each possible tonic.
- A **missing-note check** flags scales that can't be told apart when some notes are never played.

**[5d] Tonic detection.** Decides which note is home. It combines:
- bass notes
- which notes are held longest
- the notes that sections and the song end on
- the CNN's tonic output
- **drone detection**: a constant tanpura or oud drone almost always marks Sa or the maqam's tonic

**[6] Ensemble.**
- For major and minor, all four signals vote.
- For finer mode and scale choices, [5c] and [5d] do most of the work.
- Weights and a temperature for calibration are fitted on held-out evaluation data.

**[7b] Timeline.**
- Each ~12-second window gets its own scores.
- An HMM smooths them into sections:
  - staying in the same key is cheap
  - moving to a closely related key or mode (a fifth away, relative, parallel, or a mode sharing the same notes) costs a moderate amount
  - moving to a distant key is expensive
- Segments shorter than about 10 seconds are merged into their neighbours, so passing chords don't appear as key changes.
- Maqam music often moves between related scale fragments (ajnas). It gets its own transition table.

---

## 4. Modes and scales: scope by tier

| Tier | Scales | Resolution | When |
|---|---|---|---|
| **1** | Major/minor, plus the 7 church modes: Ionian, Dorian, Phrygian, Lydian, Mixolydian, Aeolian, Locrian | 12-bin | v1 |
| **2** | Harmonic minor and its modes (Phrygian dominant, Lydian ♯2, …); melodic minor and its modes (Lydian dominant, altered, …); major/minor pentatonic; blues; whole-tone; diminished (both forms); double harmonic; Hungarian minor | 12-bin | v1 |
| **3a** | **Arabic maqam**: Rast, Bayati, Sikah, Hijaz, Saba, Nahawand, Kurd, Ajam, and more | 120-bin (quarter tones) | after v1 |
| **3b** | **Turkish makam** (the most common ones) | 120-bin | after v1 |
| **3c** | **Indian classical**: Hindustani *thaat* (10 parent scales) and Carnatic *melakarta* (72 parent scales), with Sa (the tonic) detected at any pitch | 120-bin | after v1 |
| **3d** | Common **named ragas** | 120-bin, plus melodic-movement features | research stretch |

Two limits the UI will state openly:

- **A raga is more than a scale.** Many ragas share the same notes and differ in their melodic movement (aroha/avaroha, pakad). From a note collection alone, the app can reliably find **Sa, the thaat or melakarta, and a shortlist of ragas**. Naming the exact raga needs melody analysis (tier 3d), which is still an open research problem.
- **Rare scales get lower confidence.** The app will say so rather than guess.

**Output examples:** "C major", "A minor", "D Dorian (same notes as C major)", "E Phrygian dominant (5th mode of A harmonic minor)", "Maqam Bayati on D", "Kalyan thaat, Sa ≈ C♯ +18¢ (possible ragas: Yaman, …)".

**Enharmonic spelling** follows key-signature convention (F♯ minor, G♭ major), with a setting to change it.

---

## 5. Bulk analysis ("reasonable for the program to handle")

Because the analysis runs on the user's own device, the app sizes its workload to that device:

| Setting | Default | Why |
|---|---|---|
| Files per batch | **up to 250** (user can raise it) | Keeps the results table responsive |
| Per-file length | **≤ 60 min** with streaming decode (MP3/WAV); **≤ 15 min** on the `decodeAudioData` fallback | Streaming keeps memory flat; the fallback holds the whole file in memory |
| Per-file size | **≤ 500 MB** streaming; **≤ 150 MB** fallback | Protects memory on the fallback path |
| Parallel workers | `clamp(floor(cores / 2), 1, 4)`, and **1–2 on phones or low-RAM devices** (`navigator.deviceMemory ≤ 4`) | Phase 0: past 2 workers on a 4-core machine, workers mostly competed for CPU (see the phase 0 report) |
| Decoding | Inside the workers, streamed in chunks | Decoding runs in parallel, and the page stays responsive |

**Batch UX**

- **Adding files:** drag and drop files *or a whole folder*. The folder is searched recursively, and non-audio files are ignored.
- **Results table:** rows fill in as files finish, with filename, key/mode, confidence, parent key and tuning. It can be sorted and filtered, and clicking a row opens that song's timeline.
- **Progress:** per-file and overall progress bars, an ETA, and Pause, Resume and Cancel buttons.
- **Export:** CSV or JSON, generated locally.
- **Phone warning:** batches of more than about 20 files on a phone show a warning first.

**Measured speed (phase 0, 4-core cloud machine):**
- A 4-minute song takes about 4–5 seconds.
- A 24-song batch (97 minutes of audio) took 80 seconds with 2 workers, so **100 songs ≈ 5–6 minutes**.
- Streaming decode and single-pass key scoring (§3) should make this faster still.
- Phone numbers are still to be measured on a real device.

### Optional: write the key into the files' tags

This is **off by default** because it changes the user's files. Users can switch it on in Settings.

- **What gets written (MP3):**
  - **ID3v2 `TKEY`** frame: the key DJ software reads (Rekordbox, Serato, Traktor, Engine DJ). The spec only allows major/minor names like `Am` or `F#`, so a mode is written as the major/minor key its code stands for (the same code the app shows): by default the key with the same notes (D Dorian → `C`, 8B); with the "same home note" setting, D Dorian → `Dm` (7A).
  - An extra **`TXXX:KEY_MODE`** frame: the full result, for example "D Dorian", for anyone who wants it.
  - A setting chooses the `TKEY` format: standard (`Am`), Camelot (`8A`) or Open Key (`1m`), since many DJs use Camelot in that field.
- **WAV:** keys go in an `id3 ` chunk. Support for this varies between DJ programs, and the Settings screen will say so.
- **Saving the changed files:**
  - In Chrome and Edge, the File System Access API can update the files in place, after the browser asks the user for permission.
  - Other browsers can't edit files on disk. There, the app offers **tagged copies** to download (a single file, or a .zip for a batch).
- **Library:** our own small ID3v2 editor (`web/src/ui/tagging`), because `browser-id3-writer` replaces the whole tag and would drop artwork and other frames. It keeps every other frame byte for byte, refuses tags it can't read safely, and is cross-checked against mutagen in CI. The audio data itself is never re-encoded.

---

## 6. Architecture and repository layout

The project has two parts:

- **Python** is the research workbench: training, evaluation and a command-line tool.
- **TypeScript/WASM** is what ships in the browser.

Both use the **same Essentia C++ core** (Python bindings on one side, Essentia.js on the other) and the **same `scales.json`**. Parity tests check that they give the same answers.

```
stoned-mango/
├── LICENSE                         # AGPL-3.0-or-later
├── docs/                           # phase reports (docs/phase0/REPORT.md, …)
├── shared/
│   ├── scales.json                 # every scale/mode/maqam/thaat — single source of truth
│   └── golden/                     # reference inputs + expected outputs for parity tests
├── research/                       # Python 3.11
│   ├── pyproject.toml
│   ├── stoned_mango/
│   │   ├── features.py             # tuning, HPSS, HPCP (12/120/bass)
│   │   ├── engines/                # cnn.py, essentia_key.py, templates.py
│   │   ├── tonic.py                # tonic + drone detection
│   │   ├── ensemble.py             # weighting + calibration
│   │   ├── timeline.py             # windows + HMM/Viterbi + merging
│   │   ├── notation.py             # names, enharmonics, parent keys
│   │   └── cli.py                  # `stoned-mango ./music/` for power users
│   ├── training/
│   │   ├── synth_data.py           # generates modal music (see §7)
│   │   ├── datasets.py
│   │   ├── train_cnn.py
│   │   └── export_onnx.py          # ONNX export + int8 quantisation
│   ├── eval/                       # mir_eval scoring, confusion matrices, calibration
│   └── tests/
├── web/                            # Vite + React + TypeScript, built as a static PWA
│   ├── public/models/key-cnn.onnx
│   ├── src/engine/                 # decode, features, templates, tonic, ensemble,
│   │                               # timeline, worker.ts, pool.ts (adaptive worker pool)
│   ├── src/ui/                     # Workspace (drop, batch table), SongView, Timeline (canvas),
│   │                               # Settings, About, tagging/, (Privacy, Accuracy, Donate: phase 7)
│   ├── src/pwa/sw.js               # service worker: the app's own files, for offline use
│   └── tests/                      # unit + Playwright (incl. zero-network privacy test)
└── .github/
    ├── workflows/ci.yml            # Python tests, TS tests, parity tests, privacy test
    ├── workflows/deploy.yml        # build → Cloudflare Pages
    └── FUNDING.yml                 # donation links shown on the GitHub repo
```

**Result format** (one per file, kept only in memory):

```json
{
  "file": "track01.mp3",
  "key": {
    "tonic": "D", "scale": "dorian", "family": "diatonic",
    "label": "D Dorian", "parent": "C major"
  },
  "confidence": 0.71,
  "ambiguity": null,
  "alternatives": [
    { "label": "D minor (Aeolian)", "score": 0.18 },
    { "label": "G Mixolydian",      "score": 0.06 }
  ],
  "tuning": { "reference_hz": 441.2, "cents": 4.7 },
  "segments": [
    { "start": 0.0,  "end": 96.3,  "label": "D Dorian", "confidence": 0.74 },
    { "start": 96.3, "end": 184.0, "label": "E Dorian", "confidence": 0.66 }
  ],
  "duration": 184.0
}
```

---

## 7. Training data, testing and evaluation

### Licence audit (phase 0)

Each dataset's terms are checked before use:

- If a dataset's terms allow it, it can be used for **training**.
- Datasets with non-commercial (NC) terms, or unclear terms, are used **for evaluation only**, so the model weights stay cleanly FOSS.
- **The model weights** are published under **CC BY-SA 4.0**, because the best FOSS training annotations are ShareAlike. CC BY-SA 4.0 is a free-culture licence and is one-way compatible with GPLv3.
- The phase 0 audit results are in `docs/phase0/REPORT.md` §6.

### Training data

- **Major/minor, real audio:**
  - GiantSteps Key and Beatport EDM Key (GiantSteps MTG Key), electronic dance music, CC BY-SA 4.0
  - GiantSteps+ EDM Key, CC BY-SA 4.0: 500 tracks with **modal and key-change annotations**, our only real modal labels
  - McGill Billboard, pop and rock, CC0 (tonic only, which suits the tonic head)
  - FSL10K loops, CC BY 4.0 annotations (only loops whose own licence is CC0 or CC BY)
  - The EDM audio is commercial preview clips. Training on it has unsettled legal status in some countries, so CC-licensed and synthetic audio come first (details in the phase 0 report).
- **Evaluation only:** Isophonics (licence unclear), FMA Keys (non-commercial research), Tonality ClassicalDB and the other CC BY-NC-SA sets.
- **Modes, synthetic audio:** there are few real recordings labelled by mode, so `synth_data.py` generates them:
  1. Write idiomatic chord progressions and melodies for each scale, e.g. Dorian's major IV chord or Mixolydian's ♭VII.
  2. Render them with FOSS soundfonts (FluidR3_GM, MIT) across many instruments and tempos.
  3. Add drums, reverb and slight detuning.
  4. Transpose to all 12 keys.
- **Modes, real audio:** a small, hand-labelled test set. Community contributions of labels are welcome later.
- **Non-Western:** CompMusic research corpora (Saraga for Carnatic and Hindustani; the Turkish makam and Arab-Andalusian datasets). Tier 3 relies mainly on templates and tonic detection, not training, so these corpora can be used for evaluation even if their terms are NC.

### Tests (run in CI on every PR)

- **Synthetic songs:** progressions in known keys and modes must be detected correctly.
- **Transposition:** shift a clip by *n* semitones and the detected tonic must shift by *n*. The mode must stay the same.
- **Ambiguity:** a clip that never plays the 6th degree must report "Aeolian or Dorian", not a confident guess.
- **Format consistency:** WAV and MP3 of the same audio must give the same result.
- **Edge cases:** silence, drums only and noise must return "No clear key". A 3-second clip, a mono file and a 96 kHz file must each work without crashing.
- **Timeline:** a synthetic track that modulates at 30 s must show a segment boundary within ±3 s.
- **Parity:** the browser engine and the Python engine must agree on all golden files, within tolerance.
- **Privacy:** Playwright analyses a batch and **fails on any network request** after the page loads.
- **Bulk:** 100 short files on a simulated low-memory device must finish without running out of memory.

### Accuracy benchmarks (published on the site)

- **Major/minor:** `mir_eval` weighted score. Target **≥ 0.72** on GiantSteps for v1, with 0.75 as a stretch goal.
- **Modes:** accuracy for the tonic and for the mode, each measured separately, plus how often the ambiguity note appears correctly.
- **Non-Western:** tonic (Sa) accuracy within ±20 cents, and thaat or maqam accuracy.
- **Calibration:** ECE < 0.05, so the confidence numbers mean what they say.

---

## 8. Donations (FOSS-friendly and privacy-safe)

- **Donate page:** a separate page with **plain outbound links and QR codes only**. No embedded payment widgets or scripts, so the analysis page stays tracker-free.
- **Supported methods:**
  - **Cash App:** `cash.app/$yourtag` link
  - **PayPal:** `paypal.me/yourname` link
  - **Apple Pay:** there is no Apple Pay link on its own. It works through a checkout that supports it: a **Stripe Payment Link** or **Ko-fi**. Both show Apple Pay automatically on Safari and iOS, and also accept cards.
  - **Crypto: BTC, ETH, SOL and XMR.** Wallet addresses shown as text with a copy button, plus QR codes generated at build time as static images. Never a third-party crypto widget.
    - **Monero (XMR)** suits the privacy message: donors stay private too.
    - **ETH:** the page will say which network the address is for (Ethereum mainnet, or which L2s) so donors don't send to the wrong chain.
  - **Optional, common for FOSS:** GitHub Sponsors, Liberapay, Open Collective
- **`.github/FUNDING.yml`:** adds a "Sponsor" button to the GitHub repo that links to the same places.
- **Tax note:** depending on where you live, donations may count as taxable income. Worth checking before launch.

---

## 9. Milestones

| Phase | Deliverable | Rough size |
|---|---|---|
| **0. Spike + audit** ✅ | <ul><li>Essentia.js and ONNX Runtime Web running in a Web Worker</li><li>Memory and speed measured (phone still to do on a real device)</li><li>Dataset licence audit</li></ul>See `docs/phase0/REPORT.md` | done |
| **1. Research core** ✅ | <ul><li>Streaming features, Essentia key, template engine, tier 1–2 `scales.json` (30 scales)</li><li>Evaluation harness</li><li>CLI</li></ul>See `docs/phase1/REPORT.md`. Real-music numbers come with phase 2's setup on your PC | done |
| **2. FOSS CNN** ✅ | <ul><li>Synthetic data generator, training, ONNX export</li><li>One-double-click setup and training on your PC's RTX 40-series GPU</li><li>**Beats the classic engines on real music:** GiantSteps weighted 0.701 vs 0.653; the model ships in `web/public/models/`</li></ul>See `docs/phase2/REPORT.md` | done |
| **3. Modes + tonic** ✅ | <ul><li>Tonic cues (bass, ending, drone), learned engine fusion, calibrated confidence</li><li>Ambiguity notes and "No clear key"</li><li>Fitted on your PC with real music: GiantSteps 0.703 (ties the CNN), held-out modes 69.7% vs 67.3%, "No clear key" on 2.2% of real tracks; ships as `shared/fusion.json`</li><li>Calibration: real-music ECE 0.099 (target &lt; 0.05 needs more varied real music)</li></ul>See `docs/phase3/REPORT.md` | done |
| **4. Timeline** ✅ | <ul><li>Windowing, HMM/Viterbi, segment merging, boundary refinement</li><li>Synthetic songs with key changes: 93% of changes found within 3 s, no single-key song split, right key 68% of the time (one answer per song: 38%)</li><li>Real-music false-change check on your PC (`timeline-windows.cmd`)</li></ul>See `docs/phase4/REPORT.md` | done |
| **5. Browser engine** ✅ | <ul><li>TypeScript/WASM port, streaming decode (WAV, WebCodecs MP3, fallback) and adaptive worker pool</li><li>Same answers as Python to ~1e-6 on the golden files (CI), and no network requests while analysing (CI, headless Chromium)</li><li>4-min song ≈ 5 s; 100 songs ≈ 6½ min; memory flat with song length</li></ul>See `docs/phase5/REPORT.md` | done |
| **6. UI** ✅ | <ul><li>Batch table and song view with the timeline and local playback, on phones and computers; name + Camelot code; three skins (Studio by default)</li><li>CSV/JSON export; optional key tagging (MP3 and WAV, in place or tagged copies), checked against mutagen</li><li>Works offline (service worker), tested with the network off; still no network requests while analysing</li></ul>See `docs/phase6/REPORT.md` | done |
| **Phone test** (any time) | <ul><li>You create a free Cloudflare account and connect the GitHub repo. It takes about 5 minutes and needs no coding tools</li><li>Every push then gets a preview link to open on your phone, which gives real phone speed and memory numbers</li></ul> | ~1 hour |
| **7. Launch** ✅ (ready; publishing needs your Cloudflare secrets) | <ul><li>Strict Content-Security-Policy, checked in the browser test (no violations; outside requests blocked)</li><li>Privacy, Accuracy and Donate pages (links and build-time QR codes, no widgets); `FUNDING.yml`</li><li>Deploy via GitHub Actions to Cloudflare Pages, with preview links per branch</li></ul>See `docs/phase7/REPORT.md` | done |
| **8. Non-Western (tiers 3a–3c)** ✅ | <ul><li>15 maqamat, 19 makams, 72 melakartas (10 thaats named), 47-raga shortlist; 120-bin templates, home note on a quarter-tone grid, bass, drone and ending cues</li><li>"Automatic" gate: non-piano intonation or a drone, a better fit than every Western scale, and for maqam/makam a Western engine that isn't sure. On your PC the first version named 8% of GiantSteps; refitted on the per-song measurements: 0 of 604 GiantSteps, but it catches only ~1 in 7 real makam recordings, so the default is Western scales only</li><li>Real Carnatic recordings (477): Sa 86%</li><li>Real Turkish makam recordings (OTMM, held-out half of 950): home note 84%, home and makam 49%. Synthetic held out: home note 99.4% and scale 82% when used</li><li>App: setting, ≈ codes, quarter-tone and cents notes, raga shortlist, Western name; `world-windows.cmd` for the real-music checks</li></ul>See `docs/phase8/REPORT.md` | done |
| **9. Raga naming (tier 3d)** | Melodic-movement features, raga shortlist → named raga | research, open-ended |

**Timeline (one developer):**

- **v1** (Western scales, bulk analysis, full privacy story): end of phase 7, about **12–14 weeks**.
- **Non-Western scales:** phase 8 follows as v1.1.

---

## 10. Risks

1. **Mode detection is harder than major/minor**, and few benchmarks exist for it.
   - Mitigations: ambiguity notes, calibrated confidence, and accuracy numbers published on the site. We don't over-promise.
2. **Training-data licences** could limit which datasets can be used for training.
   - Mitigations: the audit in phase 0, NC data used only for evaluation, and synthetic data filling the gaps.
3. **Essentia.js maintenance:** its last release (0.1.3) is old.
   - Phase 0: it works in module workers and matches current Python Essentia on every test. Its build also triggers some Vite warnings that don't affect it.
   - Fallbacks: compile Essentia to WASM ourselves with Emscripten, or reimplement HPCP in TypeScript. HPCP is small and well documented.
4. **Browser memory on phones** during bulk runs.
   - Phase 0: whole-file decoding needed +1.0–1.2 GB for a 20-minute track, and about +200 MB per extra worker. There were no leaks.
   - Mitigations: streaming decode in the workers (§3 [1]), adaptive worker count, and per-file limits. Still to be measured on real phones.
5. **Streaming MP3 decode isn't available everywhere.** WebCodecs `AudioDecoder` is missing from some browsers and versions.
   - Mitigation: the `decodeAudioData` fallback with lower limits. Phase 5 will test support across Chrome, Edge, Firefox and Safari, including iOS.
6. **Download size:** about 4.5 MB compressed on the first visit, most of it ONNX Runtime's WASM.
   - Mitigations: int8 quantisation (the model itself is about 0.1 MB), caching by the service worker, and later, a custom ORT build with only the operators we use (about 1–2 MB).
7. **Training on commercial preview audio** (the GiantSteps and Beatport EDM sets) has unsettled legal status in some countries.
   - Mitigations: CC-licensed and synthetic audio first, the Beatport-derived data measured separately, and the audio never redistributed.
8. **A raga is more than a scale**, so tier 3c promises a shortlist, not an exact raga name. Tier 3d is research.
