# Notes for Claude

## The author runs the PC scripts from a downloaded ZIP

The author doesn't use git. They download the project as a ZIP and double-click the `*-windows.cmd` scripts
(see `docs/phase2/TRAINING-ON-WINDOWS.md`). So whenever a reply, report or guide step asks them to run a script
after the scripts or code changed, **always include the download link and the re-download steps**, not just the
script name:

1. Download the ZIP (log in to GitHub first; the repository is private):
   https://github.com/freener0x/stoned-mango/archive/refs/heads/claude/audio-key-detection-khkh02.zip
   (If the work moves to another branch, use `https://github.com/freener0x/stoned-mango/archive/refs/heads/<branch>.zip`.)
2. Right-click the ZIP → Properties → tick Unblock (if it's there) → OK.
3. Right-click the ZIP → Extract All… → the same folder as before → Extract → "Replace the files in the destination".
   Earlier results (`results\`) and the datasets, model and caches (inside Ubuntu, `~/stoned-mango-data`) are kept.
4. Double-click the script; if Windows says "Windows protected your PC": More info → Run anyway.
5. Say exactly which files to upload or paste back, and which to keep private (anything listing song names).

The same steps live in `docs/phase2/TRAINING-ON-WINDOWS.md` under "Getting the latest version (whenever I change
the scripts)"; keep the two in sync.

## Privacy of the author's library

Results from the author's music library are reported as totals only. Never put song names, file names or
per-library statistics on public pages (the Accuracy page) or in commit messages.
