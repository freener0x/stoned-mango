# stoned-mango

A free, open-source musical key and mode reader that runs entirely in your
browser. Your music never leaves your device.

- **Plan:** [PLAN.md](PLAN.md)
- **Phase 0 (spike + licence audit):** [docs/phase0/REPORT.md](docs/phase0/REPORT.md)
- **Phase 1 (research core):** [docs/phase1/REPORT.md](docs/phase1/REPORT.md)
- **Phase 2 (key CNN):** [docs/phase2/REPORT.md](docs/phase2/REPORT.md) · **[Train it on your Windows PC](docs/phase2/TRAINING-ON-WINDOWS.md)**
- **Download the latest version (ZIP):** https://github.com/freener0x/stoned-mango/archive/refs/heads/claude/audio-key-detection-khkh02.zip (log in to GitHub first). To update an earlier download, see [Getting the latest version](docs/phase2/TRAINING-ON-WINDOWS.md#getting-the-latest-version-whenever-i-change-the-scripts)
- **Phase 3 (tonic, fusion, calibration):** [docs/phase3/REPORT.md](docs/phase3/REPORT.md)
- **Phase 4 (key changes over time):** [docs/phase4/REPORT.md](docs/phase4/REPORT.md)
- **Phase 5 (the analysis in the browser):** [docs/phase5/REPORT.md](docs/phase5/REPORT.md)
- **Phase 6 (the app):** [docs/phase6/REPORT.md](docs/phase6/REPORT.md)
- **Phase 7 (ready to launch: security policy, Privacy/Accuracy/Donate pages, publishing):** [docs/phase7/REPORT.md](docs/phase7/REPORT.md)
- **Phase 8 (maqam, makam and raga-family scales):** [docs/phase8/REPORT.md](docs/phase8/REPORT.md)
- **Going live, step by step (Cloudflare, donations, publishing):** [docs/LAUNCH.md](docs/LAUNCH.md)
- `research/`: Python workbench for training, evaluation and the `stoned-mango` command-line tool ([how to use](research/README.md))
- `shared/scales.json`: the scale library, shared by the Python and browser code
- `web/`: the browser app: the analysis engine (`web/src/engine`) and the interface (`web/src/ui`); `npm run build && npm run preview` to try it

Licensed under the [GNU AGPL v3.0 or later](LICENSE).
