"""Tier 3 (maqam, makam, raga families) on real recordings, and how often it wrongly takes
over ordinary music. Run on the author's PC by world-windows.cmd (scripts/linux/world.sh):

    python -m stoned_mango.world_real makam OTMM_DIR --out RUN/makam.json
    python -m stoned_mango.world_real raga MIRDATA_HOME --out RUN/raga.json
    python -m stoned_mango.world_real western FOLDER [--limit N] --out RUN/western-NAME.json [--files RUN/files.csv]
    python -m stoned_mango.world_real summary RUN > RUN/SUMMARY.md

makam: the OTMM makam recognition dataset (github.com/MTG/otmm_makam_recognition_dataset;
  1000 Ottoman-Turkish recordings, 20 makams, CC BY-NC-SA 4.0). It has no audio, only each
  recording's melody as a pitch track, with the makam and the tonic. The pitch track becomes the
  lead-line profile (one count per voiced frame, no bass or drone cues), so this measures the
  templates, the home-note grid and the "auto" gate's intonation test on real performances.
raga: the Indian Art Music Raga Recognition Dataset's features (mirdata "compmusic_raga",
  Zenodo; 480 Carnatic and 300 Hindustani recordings, CC BY 4.0): pitch tracks, Sa and raga.
  Sa is checked everywhere; the scale, for the ragas in shared/ragas.json and the melakartas.
western: audio files (GiantSteps, or your own music folder): how often "auto" mode answers
  with a tier 3 scale. SUMMARY.md has totals only; --files lists the flagged files and stays
  on the PC.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from . import world
from .features import HPCP_BINS
from .scales import library

C4 = 261.6256
MARGINS = (0.02, 0.04, 0.06, 0.08, 0.10, 0.12)  # Western margins to report (world.AUTO_MARGIN is per tradition)
TONIC_TOLERANCE = 25.0  # cents: half a quarter tone, the home-note grid's resolution
AUDIO = (".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aiff", ".aif")


def circ(a: float, b: float, period: float = 1200.0) -> float:
    d = (a - b) % period
    return min(d, period - d)


def cents_above_c(hz: float) -> float:
    return float(1200 * np.log2(hz / C4) % 1200)


OTMM_HOP = 128 / 44100  # the OTMM pitch tracks' frame step (predominant melody, 44.1 kHz audio)


def pitch_profile(freqs: np.ndarray, hop_seconds: float) -> tuple[np.ndarray, np.ndarray, float]:
    """A pitch track (Hz, 0 = unvoiced) -> (lead-line profile with bin 0 = C at the tuning, the same
    over the last ENDING_SECONDS of voiced frames, tuning in cents from A=440). The tuning is the
    circular mean of the notes' offsets from the piano's keys, as features.py measures it."""
    f = np.asarray(freqs, np.float64)
    f = f[np.isfinite(f) & (f > 20)]
    if f.size == 0:
        return np.zeros(HPCP_BINS), np.zeros(HPCP_BINS), 0.0
    cents = 1200 * np.log2(f / C4)
    vec = np.exp(2j * np.pi * cents / 100).sum()
    tuning = float(np.angle(vec) * 100 / (2 * np.pi))
    tuning = tuning if tuning > -50 else tuning + 100
    bins = np.floor(((cents - tuning) % 1200) / 10 + 0.5).astype(int) % HPCP_BINS
    n = max(1, int(round(world.ENDING_SECONDS / hop_seconds)))
    ones = np.ones(len(bins))
    return world._histogram(bins, ones), world._histogram(bins[-n:], ones[-n:]), tuning


def _zeros() -> tuple[np.ndarray, np.ndarray]:
    return np.zeros(HPCP_BINS), np.zeros(world.STEPS)


def gap(d: world.Decision) -> float | None:
    """How far the best tier 3 scale beats the best Western one, when everything else in the
    "auto" gate passes (else None): tier 3 answers when this is at least its tradition's AUTO_MARGIN."""
    if not d.cands or d.cands[0].fit < world.FIT_MIN or not d.evidence.fires():
        return None
    return round(d.cands[0].score - d.western, 4)


def _same_template(a: str, b: str) -> bool:
    lib = library()
    return lib[a].cents == lib[b].cents and lib[a].dominant == lib[b].dominant


def score_profile(profile: np.ndarray, ending: np.ndarray, tuning: float, tonic_cents: float, scale: str | None,
                  only: str) -> dict:
    """One recording: the "auto" decision, and the answer with only its tradition allowed."""
    bass, share = _zeros()
    auto = world.decide_from(profile, bass, share, traditions="auto", ending=ending)
    forced = world.decide_from(profile, bass, share, traditions=only, ending=ending)
    out = {"used": bool(auto.use), "gap": gap(auto), "deviation": round(auto.evidence.deviation, 2),
           "quarter_tones": round(auto.evidence.quarter_tones, 3), "western_fit": round(auto.western, 4)}
    full = world.decide_from(profile, bass, share, traditions="all", ending=ending)
    for c in full.cands:  # the best candidate of each tradition, as gate_row records them for audio
        t = library()[c.scale].tradition
        if f"{t}_score" not in out:
            out |= {f"{t}_score": round(c.score, 4), f"{t}_fit": round(c.fit, 4), f"{t}_on_keys": world.on_keys(c),
                    f"{t}_quarter_tones": world.needs_quarter_tones(c),
                    f"{t}_plausible": world._plausible(c, auto.evidence)}
    if auto.use:
        b = auto.cands[0]
        out["auto_tradition"] = library()[b.scale].tradition
        out["auto_tonic_ok"] = circ(b.tonic_cents + tuning, tonic_cents) <= TONIC_TOLERANCE
        out["auto_scale_ok"] = scale is not None and b.scale == scale
    if forced.cands:
        b = forced.cands[0]
        err = circ(b.tonic_cents + tuning, tonic_cents)
        out |= {"pred": b.scale, "prob": round(b.prob, 3), "tonic_err": round(err, 1), "tonic_ok": err <= TONIC_TOLERANCE,
                "tonic_fifth": abs(err - 500) <= TONIC_TOLERANCE}  # the dominant or the fourth taken for home
        if scale is not None:
            out |= {"scale_ok": b.scale == scale, "scale_ok_same": _same_template(b.scale, scale),
                    "both_ok": out["tonic_ok"] and _same_template(b.scale, scale)}
    return out


def _ascii(name: str) -> str:
    s = unicodedata.normalize("NFKD", name)
    return "".join(c for c in s if c.isalpha() and not unicodedata.combining(c)).lower()


# ---- Turkish makam (OTMM) -----------------------------------------------------------------

def makam_id(name: str) -> str | None:
    sid = f"makam_{_ascii(name)}"
    return sid if sid in library() else None


def load_pitch(path: Path) -> np.ndarray:
    a = np.loadtxt(path, ndmin=2)
    return a[:, 1] if a.shape[1] >= 2 else a[:, 0]  # (time, Hz[, salience]) or Hz alone


def run_makam(root: Path) -> list[dict]:
    ann = json.loads((root / "annotations.json").read_text())
    rows = []
    for i, a in enumerate(ann):
        mbid = a["mbid"].rstrip("/").split("/")[-1]
        path = root / "data" / a["makam"] / f"{mbid}.pitch"
        if not path.exists():
            continue
        profile, ending, tuning = pitch_profile(load_pitch(path), OTMM_HOP)
        sid = makam_id(a["makam"])
        row = {"group": a["makam"], "in_library": sid is not None}
        row |= score_profile(profile, ending, tuning, cents_above_c(float(a["tonic"])), sid, "turkish")
        rows.append(row)
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{len(ann)}", file=sys.stderr)
    return rows


# ---- Indian raga (compmusic_raga features via mirdata) --------------------------------------

ALIASES = {"yamankalyan": "yaman", "sankarabharanam": "shankarabharanam",
           "dhirasankarabharanam": "shankarabharanam", "kamboji": "kambhoji",
           "bageshri": "bageshree", "bagesri": "bageshree", "malkosh": "malkauns", "bhup": "bhupali", "bhoop": "bhupali",
           "darbari": "darbarikanada", "mayamalavagaula": "mayamalavagowla", "mayamalavagoula": "mayamalavagowla",
           "kiravani": "keeravani", "shanmukapriya": "shanmukhapriya", "sanmukhapriya": "shanmukhapriya",
           "kamavardhani": "pantuvarali",
           "mohana": "mohanam", "hamsadvani": "hamsadhwani", "hamsadhvani": "hamsadhwani",
           "madhyamavathi": "madhyamavati", "sriranjini": "sriranjani", "revathi": "revati",
           "charukeshi": "charukesi", "hemavathi": "hemavati", "puriyadhanashri": "puriyadhanashri",
           "puriyadhanashree": "puriyadhanashri", "shri": "shree", "sri": "shree", "marva": "marwa"}


def _raga_table() -> dict[str, tuple[str, list[int] | None]]:
    """normalised raga name -> (parent melakarta id, raga notes as semitones from Sa or None = all of the parent's)."""
    table: dict[str, tuple[str, list[int] | None]] = {}
    for s in library().values():
        if s.tradition == "indian":
            table[_ascii(s.name)] = (s.id, None)
    for r in world._ragas():
        table[_ascii(r["name"])] = (r["parent"], r["notes"])
    for a, b in ALIASES.items():
        if b in table and a not in table:
            table[a] = table[b]
    return table


def _canon(name: str) -> str:
    n = _ascii(name)
    return ALIASES.get(n, n)


def run_raga(home: Path) -> list[dict]:
    import mirdata

    ds = mirdata.initialize("compmusic_raga", data_home=str(home))
    table = _raga_table()
    lib = library()
    rows = []
    tracks = ds.load_tracks()
    for i, (tid, t) in enumerate(tracks.items()):
        try:
            pitch = t.pitch
            tonic = t.tonic_fine_tuned or t.tonic
        except Exception as e:  # a missing or unreadable file: count it, keep going
            rows.append({"group": "error", "error": type(e).__name__})
            continue
        if pitch is None or not tonic:
            continue
        hop = float(np.median(np.diff(pitch.times))) if len(pitch.times) > 1 else 0.0029
        profile, ending, tuning = pitch_profile(pitch.frequencies, hop)
        known = table.get(_ascii(t.raga or ""))
        row = {"group": t.tradition or "indian", "raga_known": known is not None}
        row |= score_profile(profile, ending, tuning, cents_above_c(float(tonic)), None, "indian")
        if known and "pred" in row:
            parent, notes = known
            pred = lib[row["pred"]]
            want = set(notes) if notes is not None else {round(c / 100) % 12 for c in lib[parent].cents}
            have = {round(c / 100) % 12 for c in pred.cents}
            row["parent_ok"] = row["tonic_ok"] and row["pred"] == parent
            row["notes_ok"] = row["tonic_ok"] and want <= have  # the raga's notes are all in the scale found
            bass, share = _zeros()
            d = world.decide_from(profile, bass, share, traditions="indian", ending=ending)
            names = {_canon(n) for n in world.raga_shortlist(profile, d.cands[0])} if d.cands else set()
            row["shortlist_ok"] = row["tonic_ok"] and _canon(t.raga) in names
        rows.append(row)
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{len(tracks)}", file=sys.stderr)
    return rows


# ---- ordinary music: does tier 3 stay out? ---------------------------------------------------

def gate_row(f, western: dict | None) -> dict:
    """Every measurement the "auto" gate looks at, for one audio file (no names): to fit the
    gate on real music. ``western``: the Western engine's answer (analysis.western_result)."""
    wc = western.get("key_confidence") if western else None
    d = world.decide(f, "auto", western_confidence=wc)
    row = {"used": bool(d and d.use), "western_confidence": wc, "duration": round(f.duration, 1),
           "tuning": round(f.tuning_cents, 1), "tuning_confidence": round(f.tuning_confidence, 3)}
    if western:
        row |= {"western_scale": western["key"]["scale"] if western.get("key") else None,
                "western_tonic": western["key"]["tonic"] if western.get("key") else None}
    if d is None:
        return row
    ev = d.evidence
    row |= {"deviation": round(ev.deviation, 2), "quarter_tones": round(ev.quarter_tones, 3), "drone": round(ev.drone, 3),
            "fires": bool(ev.fires()), "gap": gap(d), "western_fit": round(d.western, 4)}
    if d.use:
        row["tradition"] = library()[d.cands[0].scale].tradition
    full = world.decide(f, "all", western_confidence=wc)  # the ranking before the "auto" filters
    lib = library()
    for c in full.cands:  # the best candidate of each tradition
        t = lib[c.scale].tradition
        if f"{t}_score" in row:
            continue
        row |= {f"{t}_score": round(c.score, 4), f"{t}_fit": round(c.fit, 4), f"{t}_on_keys": world.on_keys(c),
                f"{t}_quarter_tones": world.needs_quarter_tones(c), f"{t}_plausible": world._plausible(c, ev, wc),
                f"{t}_tonic": int(np.floor(c.tonic_cents / 100 + 0.5)) % 12, f"{t}_tonic_cents": c.tonic_cents}
        if all(f"{x}_score" in row for x in world.TRADITIONS):
            break
    return row


def _cache_path(cache_dir: Path | None, p: Path) -> Path | None:
    """Where an audio file's features are kept between runs: a folder of ours, never next to the music."""
    if cache_dir is None:
        return None
    import hashlib

    st = p.stat()
    key = hashlib.sha1(f"{p.resolve()}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:20]
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{key}.features.npz"


def run_western(root: Path, limit: int | None, files_csv: Path | None, cache_dir: Path | None = None) -> list[dict]:
    from .analysis import western_result
    from .world_eval import cached_features

    paths = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in AUDIO)
    if limit:
        rng = np.random.default_rng(0)
        paths = sorted(rng.choice(paths, size=min(limit, len(paths)), replace=False).tolist()) if paths else []
    rows, flagged = [], []
    for i, p in enumerate(paths):
        try:
            f = cached_features(p, _cache_path(cache_dir, p)) if cache_dir else _extract(p)
        except Exception as e:
            rows.append({"error": type(e).__name__})
            continue
        row = gate_row(f, western_result(f))
        if row["used"]:
            wc = row["western_confidence"]
            r = world.result(f, world.decide(f, "auto", western_confidence=wc))
            flagged.append({"file": str(p), "label": r["label"], "confidence": r["confidence"]})
        rows.append(row)
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(paths)}", file=sys.stderr)
    if files_csv and flagged:
        with files_csv.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=["file", "label", "confidence"])
            w.writeheader()
            w.writerows(flagged)
    return rows


def _extract(p: Path):
    from .features import extract

    return extract(p)


# ---- summary ---------------------------------------------------------------------------------

def _rate(rows: list[dict], key: str) -> str:
    vals = [bool(r[key]) for r in rows if key in r]
    return f"{np.mean(vals):.1%} ({sum(vals)}/{len(vals)})" if vals else "–"


def summarise_eval(rows: list[dict], scale_key: str = "scale_ok") -> list[str]:
    lines = ["| | recordings | used in auto mode | home note (±25¢) | home note on the fifth/fourth | scale exact | "
             "same notes | home and scale |", "|---|---|---|---|---|---|---|---|"]
    groups = defaultdict(list)
    for r in rows:
        groups[r.get("group", "?")].append(r)
    for name, rs in [("**all**", rows)] + sorted(groups.items()):
        lines.append(f"| {name} | {len(rs)} | {_rate(rs, 'used')} | {_rate(rs, 'tonic_ok')} | {_rate(rs, 'tonic_fifth')} | "
                     f"{_rate(rs, scale_key)} | {_rate(rs, 'scale_ok_same')} | {_rate(rs, 'both_ok')} |")
    return lines


def _margins() -> str:
    return ", ".join(f"{t} {m}" for t, m in world.AUTO_MARGIN.items())


def _by_margin(rows: list[dict]) -> str:
    n = max(1, len(rows))
    return ", ".join(f"{m}: {sum(1 for r in rows if r.get('gap') is not None and r['gap'] >= m) / n:.1%}" for m in MARGINS)


def summary(run: Path) -> str:
    out = ["# Tier 3 on real recordings", "",
           "Home note within 25 cents (half a quarter tone). \"Used in auto mode\": tier 3 would answer instead of "
           "the Western engine (from the pitch track alone, so without the drone cue). The scale columns are "
           "with only that tradition allowed (the setting \"Always, …\").", ""]
    mk = run / "makam.json"
    if mk.exists():
        rows = json.loads(mk.read_text())
        lib_rows = [r for r in rows if r.get("in_library")]
        auto = [r for r in rows if r.get("used")]
        out += ["## Turkish makam (OTMM, pitch tracks)", ""] + summarise_eval(lib_rows) + [
            "", f"Recordings in makams not in the library (Bestenigar): {len(rows) - len(lib_rows)}; "
            f"home note {_rate([r for r in rows if not r.get('in_library')], 'tonic_ok')}.",
            f"When auto mode answers: tradition {dict(Counter(r.get('auto_tradition') for r in auto))}, "
            f"home note {_rate(auto, 'auto_tonic_ok')}, exact makam {_rate(auto, 'auto_scale_ok')}.",
            f"Median deviation from the piano's tuning: {np.median([r['deviation'] for r in rows]):.1f} cents; "
            f"quarter-tone share {np.median([r['quarter_tones'] for r in rows]):.3f}.",
            f"Used in auto mode at each Western margin (now {_margins()}): {_by_margin(rows)}.", ""]
    rg = run / "raga.json"
    if rg.exists():
        rows = [r for r in json.loads(rg.read_text()) if r.get("group") != "error"]
        known = [r for r in rows if r.get("raga_known")]
        out += ["## Indian raga (CompMusic raga dataset, pitch tracks)", "",
                "| | recordings | used in auto mode | Sa (±25¢) | Sa on Pa or Ma | ragas we know | parent melakarta | "
                "raga's notes in the scale | raga in the shortlist |", "|---|---|---|---|---|---|---|---|---|"]
        groups = defaultdict(list)
        for r in rows:
            groups[r["group"]].append(r)
        for name, rs in [("**all**", rows)] + sorted(groups.items()):
            kn = [r for r in rs if r.get("raga_known")]
            out.append(f"| {name} | {len(rs)} | {_rate(rs, 'used')} | {_rate(rs, 'tonic_ok')} | {_rate(rs, 'tonic_fifth')} | "
                       f"{len(kn)} | {_rate(kn, 'parent_ok')} | {_rate(kn, 'notes_ok')} | {_rate(kn, 'shortlist_ok')} |")
        out += ["", f"Ragas recognised by name: {len(known)} of {len(rows)} recordings. Used in auto mode at each "
                f"Western margin (now {_margins()}): {_by_margin(rows)}.", ""]
    for w in sorted(run.glob("western-*.json")):
        rows = json.loads(w.read_text())
        ok = [r for r in rows if "error" not in r]
        used = [r for r in ok if r.get("used")]
        out += [f"## Ordinary music: {w.stem.removeprefix('western-')}", "",
                f"{len(ok)} files ({len(rows) - len(ok)} unreadable). Tier 3 answered for **{_rate(ok, 'used')}**"
                f" (by tradition: {dict(Counter(r.get('tradition') for r in used)) or 'none'}); the gate's evidence "
                f"fired for {_rate(ok, 'fires')}. At each Western margin (now {_margins()}): {_by_margin(ok)}.", ""]
    return "\n".join(out) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["makam", "raga", "western", "summary"])
    ap.add_argument("path", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--files", type=Path, help="western: write the files tier 3 answered for (stays on this PC)")
    ap.add_argument("--cache", type=Path, help="western: keep each file's features here, so a re-run is quick")
    args = ap.parse_args()
    if args.what == "summary":
        print(summary(args.path), end="")
        return
    rows = (run_makam(args.path) if args.what == "makam" else run_raga(args.path) if args.what == "raga"
            else run_western(args.path, args.limit, args.files, args.cache))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(rows, indent=0) + "\n")
    print(f"{len(rows)} recordings", file=sys.stderr)


if __name__ == "__main__":
    main()
