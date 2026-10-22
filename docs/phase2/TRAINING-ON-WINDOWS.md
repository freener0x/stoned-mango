# Training the key model on your Windows PC

This guide trains stoned-mango's key-detection model on your **NVIDIA RTX 40-series** graphics card. You only double-click a few files. Everything else is automatic.

**What you need**

- Windows 11 (Pro is fine) and an NVIDIA RTX 40-series card
- About **15 GB** of free disk space
- An internet connection. About 6 GB is downloaded the first time.
- About **1–3 hours**, mostly unattended

**Why it runs in "WSL"**

- The audio library the project uses (Essentia) has no Windows version.
- So the scripts run the project inside **WSL**, the Linux system built into Windows 11.
- NVIDIA supports GPU training inside WSL, so your graphics card is used at full speed.
- You don't need to know anything about Linux.
- Your normal Windows Python isn't used or changed.

---

## Step 1: Update your NVIDIA driver (recommended)

Open the **NVIDIA app** (or GeForce Experience) and install any driver update. If you have neither, get the latest driver from [nvidia.com/Download](https://www.nvidia.com/Download/index.aspx).

## Step 2: Download the project

1. Download this ZIP:
   **https://github.com/freener0x/stoned-mango/archive/refs/heads/claude/audio-key-detection-khkh02.zip**
2. Before extracting, right-click the ZIP → **Properties** → tick **Unblock** (if it's there) → **OK**. This stops Windows from blocking the scripts inside.
3. Right-click the ZIP → **Extract All…** and extract it into your own Documents folder, for example `C:\Users\<you>\Documents\stoned-mango`.
   (A folder straight under `C:\`, such as `C:\stoned-mango`, can be changed by every account on the PC. That's fine if you're the only one who uses it; otherwise move it into Documents.)

## Getting the latest version (whenever I change the scripts)

When I've changed something you need to run, download the project again. Your datasets, the trained model and earlier results are kept, so there's no need to run the setup again.

1. **Download the ZIP again**:
   **https://github.com/freener0x/stoned-mango/archive/refs/heads/claude/audio-key-detection-khkh02.zip**
2. Right-click the new ZIP → **Properties** → tick **Unblock** (if it's there) → **OK**.
3. Right-click the ZIP → **Extract All…** → choose **the same folder as before** (for example `C:\Users\<you>\Documents\stoned-mango`) → **Extract**.
4. When Windows asks, choose **Replace the files in the destination**.
5. Double-click the script I asked for. If Windows says "Windows protected your PC", click **More info** → **Run anyway**.

Why this is safe:
- The `results` folder isn't in the ZIP, so your earlier results stay.
- The datasets, the model and the caches live inside Ubuntu (`stoned-mango-data`), not in this folder.

## Step 3: Run the setup (once)

In the extracted folder, **double-click `setup-windows.cmd`**.

- **If Windows says "Windows protected your PC":** click **More info** → **Run anyway**. This appears because the script was downloaded from the internet.
- **The first time, WSL isn't installed yet:**
  1. Windows asks for administrator permission. Click **Yes**.
  2. It installs Ubuntu, about 500 MB.
  3. An Ubuntu window asks you to **choose a username and password**. Pick anything and write them down.
  4. If Windows asks you to **restart**, restart.
  5. Then **double-click `setup-windows.cmd` again**.
- **The setup then does the rest by itself**, in about 20–40 minutes depending on your internet speed:
  1. Linux packages
  2. PyTorch for your GPU (about 3 GB)
  3. The project's tests
  4. The two music test sets (about 2.5 GB)
  5. A first accuracy test on real music

  When it finishes, it says **Done**.

**Please send me** the file `results\baseline-giantsteps.txt` (open it in Notepad and paste its contents into our chat). These are the project's first accuracy numbers on real music.

## Step 4: Train

**Double-click `train-windows.cmd`.**

- It takes about 1–2 hours. The window shows progress through 6 steps:
  1. Make about 9,000 synthetic practice songs across all 30 scales
  2. Prepare the Beatport music
  3. Make test songs
  4. **Train on your GPU**
  5. Export the model
  6. Test it on music it has never seen
- **Keep the PC awake while it trains:** Settings → System → Power → set *Sleep* to **Never** for now.
- **On a laptop, keep the charger plugged in.** On battery, Windows slows the graphics card down a lot.
- **If it's interrupted,** just double-click it again. Finished steps are skipped.

## Step 5: Send the results back

At the end, a new folder appears in `results\` named with the date and time, for example `results\20261001-2130\`.

1. **Paste the contents of `SUMMARY.md`** from that folder into our chat. You can open it in Notepad.
2. **Upload the model** so the app can use it:
   1. Open **https://github.com/freener0x/stoned-mango/tree/claude/audio-key-detection-khkh02/web/public**
   2. Click **Add file → Upload files**.
   3. Drag the whole **`model`** folder from your results folder onto the page.
   4. At the bottom, keep "Commit directly to the `claude/audio-key-detection-khkh02` branch" selected and click **Commit changes**.

That's it. I'll take it from there.

## Step 6: Calibrate (phase 3, after training)

**Double-click `calibrate-windows.cmd`.** No GPU is needed for this one. The first run takes about 30–60 minutes; later runs re-use what it made and are quicker.

- It fits the part that combines the model with the other clues (bass, the notes played most often), sets how sure the app says it is, and picks the point below which it answers "No clear key".
- Then it tests the result on the GiantSteps songs, which it never learned from.

At the end, a new folder appears in `results\`, for example `results\20261002-1900\`. Paste these three files from it into our chat (open each in Notepad):

1. `SUMMARY.md`
2. `fusion-with-real.json`
3. `fusion-synthetic.json`

## Step 7: Check against your own music library (optional)

**Double-click `library-windows.cmd`**, drag your music folder onto the window, and press Enter.

- It reads the key you wrote in each file name, such as `Artist - Title (Am)`, `8A - Title` or `01 - F#m - Title`, or else the key tag from music software. It checks up to 1,000 songs, works out each key itself and compares the two. Short files such as loops and samples are compared separately.
- If it finds no key in many of your file names, its `SUMMARY.md` shows how a few of the names are laid out, with every word replaced by `w` and only the keys kept. That shows me how to read them without showing your song titles.
- Keys written by hand can be wrong, and that's fine. Everything is compared against the *same* tags, and full-length songs are what's needed to test the "ending" clue.
- **Nothing is uploaded or changed.** Your files are only read.
- It takes about 15–45 minutes, depending on the size of the library.

At the end, paste `SUMMARY.md` from the new `results\` folder into our chat. It contains only totals, no song names. The folder also holds `tracks.csv`: one line per song with its tag and the app's answer. It's yours to look through; there's no need to send it.

## Step 8: Check the key-changes timeline (phase 4)

**Double-click `timeline-windows.cmd`.** To include your own music, drag the music folder onto the window; otherwise just press Enter.

- It runs the timeline on the 604 GiantSteps tracks. Each has one key, so any key change the timeline shows there is a mistake.
- With your folder, it also runs the library check, which now reports how many of your songs it splits into several keys.
- It takes about 15–45 minutes. Nothing is uploaded or changed.

At the end, paste `SUMMARY.md` from the new `results\` folder into our chat. It has no song names.

## Step 9: Check the maqam, makam and raga scales (phase 8)

**First get the latest version** (see [Getting the latest version](#getting-the-latest-version-whenever-i-change-the-scripts)): download **https://github.com/freener0x/stoned-mango/archive/refs/heads/claude/audio-key-detection-khkh02.zip**, unblock it, extract it over your old folder and choose **Replace the files in the destination**.

Then **double-click `world-windows.cmd`.** To include your own music, drag the music folder onto the window; otherwise just press Enter.

- It downloads two research datasets of real recordings, as melody pitch tracks (no audio): Turkish makam music (1,000 recordings, about 0.5 GB) and Indian raga music (780 recordings). It checks how often the app finds the home note and the scale.
- It runs the 604 GiantSteps tracks, and up to 1,000 of your songs if you gave a folder, to count how often a maqam, makam or raga scale wrongly replaces an ordinary key. That number decides how cautious the "Automatic" setting should be.
- It takes about 30–60 minutes the first time. Nothing is uploaded or changed. It keeps each song's measurements in its own data folder (never next to your music), so running it again is much quicker.

At the end, upload `SUMMARY.md` and the `.json` files from the new `results\` folder to our chat. None of them has song names: `SUMMARY.md` has totals, and the `.json` files have one line of numbers per song. The folder also has `your-music-tier3.csv`, listing any of your songs that got a maqam, makam or raga name. It's yours to look through; there's no need to send it.

---

## If something goes wrong

**First,** just double-click the same file again. All the scripts can safely be run more than once.

| What you see | What to do |
|---|---|
| "No NVIDIA driver found" | Do Step 1, restart, and run it again. |
| "PyTorch cannot see the GPU" | Update the NVIDIA driver, restart Windows, then run setup again. If it still happens: open **PowerShell**, run `wsl --update`, restart, and try again. |
| "Could not reach Ubuntu" | Open **Ubuntu** from the Start menu once, finish its first-time setup (username and password), close it, then run the script again. |
| Some music files fail to download | A few missing files are fine; they are simply left out. If *most* fail, the download server may be down. Try again later. |
| Anything else | Every run writes log files into `results\` next to `setup-windows.cmd`, right from the start. Send me the newest `.log` files (open them in Notepad and paste them) and I'll fix the script. |

**Where things are**

- Everything lives inside Ubuntu, in your Linux home folder. You can open it from File Explorer at `\\wsl$\Ubuntu-24.04\home\<your Linux username>\`:
  - `stoned-mango` is a working copy of the project.
  - `stoned-mango-data` holds the datasets, practice songs and training runs, about 10 GB.
- **Removing everything later:** open PowerShell and run `wsl --unregister Ubuntu-24.04`. This deletes Ubuntu and all of the above. Your Windows files are not touched.

**Advanced (optional):** for a bigger or quicker run, open **Ubuntu** from the Start menu and run the command below. Its results stay in `stoned-mango-data\runs\` rather than being copied to your Windows folder.

```bash
PER_SCALE=500 EPOCHS=80 bash ~/stoned-mango/scripts/linux/train.sh
```
