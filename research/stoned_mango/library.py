"""Compare stoned-mango with the keys written in your own music library's file names or tags.

    python -m stoned_mango.library MUSIC_DIR --out RUN_DIR [--limit 1000] [--fusion FILE]

Tags written by DJ and music software are often wrong, so agreement with them is
not accuracy. They are still useful, because:

* everything is measured against the same tags, so engines can be compared;
* the tracks are full-length, unlike the previews in the public datasets, so the
  "ending" home-note cue can finally be tested (it is switched off until then);
* the kind of disagreement (a fifth apart, relative major/minor ...) shows whether
  a tag or the analysis is the likelier culprit.

Nothing leaves the computer. ``SUMMARY.md`` holds only totals (no file names);
``tracks.csv`` lists each file with its tag and our answer, for your own use.

Keys are read from the file name first ("Artist - Title (Am)", "8A - Title",
"01 - F#m - Title"; see ``key_from_name``), else from the key tag: ID3 ``TKEY``
(MP3, AIFF, WAV), MP4 ``initialkey`` (M4A), and Vorbis / FLAC ``INITIALKEY`` or
``KEY``. Notations: standard ("Am", "F#", "Bb minor"), Camelot ("8A") and Open
Key ("1m").
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from .audio import AUDIO_EXTENSIONS

_LETTER = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_ACCIDENTAL = {"": 0, "#": 1, "♯": 1, "b": -1, "♭": -1}
_STANDARD = re.compile(r"^([A-Ga-g])\s*([#b♯♭]?)\s*((?i:minor|major|min|maj)|m|M)?$")
_CAMELOT = re.compile(r"^(1[0-2]|0?[1-9])\s*([ABab])$")
_OPEN_KEY = re.compile(r"^(1[0-2]|0?[1-9])\s*([dmDM])$")
ENDING_WEIGHTS = (0.5, 1.0, 2.0)  # "ending" cue weights tried on top of the fusion
MIN_SECONDS = 90.0  # shorter files are not full-length songs ...
MIN_CLIP_SECONDS = 5.0  # ... but clips (loops, samples) this long are checked as their own group
CHECK = 12  # most confident disagreements listed for a listen


def parse_key(text: str) -> tuple[int, str] | None:
    """'Am' / '8A' / '1m' / 'F# major' / '8A - Am' -> (tonic, 'major'|'minor'); None if unreadable."""
    for part in re.split(r"\s*[/,;|]\s*|\s+-\s+", text.strip()):
        part = part.strip()
        m = _CAMELOT.match(part)
        if m:  # 8B = C major; each step is a fifth; A is the relative minor
            major = 7 * (int(m.group(1)) - 8) % 12
            return ((major, "major") if m.group(2).upper() == "B" else ((major + 9) % 12, "minor"))
        m = _OPEN_KEY.match(part)
        if m:  # 1d = C major, 1m = A minor
            major = 7 * (int(m.group(1)) - 1) % 12
            return ((major, "major") if m.group(2).lower() == "d" else ((major + 9) % 12, "minor"))
        m = _STANDARD.match(part)
        if m:
            tonic = (_LETTER[m.group(1).upper()] + _ACCIDENTAL[m.group(2)]) % 12
            q = m.group(3) or ""
            minor = q == "m" or q.lower() in ("min", "minor") or (q == "" and m.group(1).islower())
            return tonic, "minor" if minor else "major"
    return None


def read_key_tag(path: Path) -> str | None:
    """The raw key tag of an audio file, or None."""
    import mutagen

    try:
        tags = getattr(mutagen.File(path), "tags", None)
    except Exception:
        tags = None
    if not tags:  # files mutagen can't identify may still carry a bare ID3 tag
        from mutagen.id3 import ID3

        try:
            tags = ID3(path)
        except Exception:
            return None
    for name, value in tags.items():
        lname = str(name).lower()
        if lname == "tkey" or lname.endswith("initialkey") or lname == "key":
            if hasattr(value, "text"):
                value = value.text
            if isinstance(value, (list, tuple)):
                value = value[0] if value else ""
            if isinstance(value, bytes):
                value = value.decode("utf-8", "replace")
            value = str(value).strip()
            if value:
                return value
    return None


def relation(tag: tuple[int, str], ours: tuple[int, str]) -> str:
    """How an answer relates to the tag: same, fifth, relative, parallel or other."""
    (t, tq), (o, oq) = tag, ours
    if (t, tq) == (o, oq):
        return "same"
    if tq == oq and (o - t) % 12 in (5, 7):
        return "fifth"
    if tq != oq and ((tq == "minor" and (o - t) % 12 == 3) or (tq == "major" and (o - t) % 12 == 9)):
        return "relative"
    if t == o:
        return "parallel"
    return "other"


def describe(tag: tuple[int, str], ours: tuple[int, str]) -> str:
    """``relation`` with the direction of a fifth: "fifth above" means the app's home note is
    a fifth above yours (you: C, app: G)."""
    rel = relation(tag, ours)
    if rel == "fifth":
        return "fifth above" if (ours[0] - tag[0]) % 12 == 7 else "fifth below"
    return rel


def _analyse(job: tuple[str, str, str | None]) -> dict:
    """One track: answers from every engine, plus where each tonic cue points."""
    from .analysis import default_cnn
    from .features import extract
    from .fusion import Fusion, key_confidence, song_features
    from .scales import library
    from .tonic import tonic_cues

    path, tag_text, fusion_path = job
    f = extract(path)
    out = {"duration": f.duration}
    if f.voiced().size == 0 or f.chroma().max() <= 0:
        return out | {"silent": True}
    lib = library()
    cnn = default_cnn()
    chroma, bass = f.chroma(), f.chroma(bass=True)
    feats = song_features(f.logspec, chroma, bass, cnn)
    base = Fusion.load(Path(fusion_path)) if fusion_path else None
    answers = {}
    net = cnn.candidates(f.logspec)
    answers["cnn"] = (net[0].tonic, lib[net[0].scale].third, key_confidence(net), net[0].label)
    variants = {"fusion": base}
    for e in ENDING_WEIGHTS:
        variants[f"fusion_ending{e:g}"] = Fusion(base.weights | {"ending": e}, base.no_key_below)
    for name, fu in variants.items():
        c = fu.candidates(feats)
        kc = key_confidence(c)
        answers[name] = (c[0].tonic, lib[c[0].scale].third, kc, c[0].label)
        if name == "fusion":
            out["no_key"] = kc < fu.no_key_below
    from .timeline import timeline as key_changes

    out["sections"] = len(key_changes(f, base, cnn))
    cues = tonic_cues(f.logspec, bass)
    out["cues"] = {k: int(np.argmax(getattr(cues, k))) for k in ("bass", "ending", "drone")}
    return out | {"answers": answers}


_BRACKETS = re.compile(r"[(\[{]([^()\[\]{}]{1,24})[)\]}]")
_SEGMENTS = re.compile(r"\s+[-\u2013\u2014|]\s+|_+-_+|\s*_\s*")
_CAMELOT_TOKEN = re.compile(r"(?<![\w#])(1[0-2]|0?[1-9])[AB](?![\w#])")
_IN_KEY = re.compile(r"\bin ([A-G])(?:[- ]?(flat|sharp)|([#b\u266f\u266d]))?[- ](major|minor)\b", re.I)
# A key written as a word among other words: "Title C#m 128". Only spellings that are not
# English words: "Am" counts only when a number (a tempo) follows it ("Here I Am" stays a title).
_TOKEN_KEY = re.compile(r"^(?:[A-G][#b\u266f\u266d]?(?:m|(?i:min|maj|minor|major))|[a-g][#b\u266f\u266d]?(?:min|maj))$")
_NAMES_LIKE_KEYS = {"Am", "Amin"}  # an English word and a first name: keys only before a number
_KEYISH = re.compile(r"^([A-Ga-g][#b\u266f\u266d]?(m|min|maj|minor|major)?|\d{1,2}[ABabdm]|minor|major|flat|sharp|in)$", re.I)


def key_from_name(stem: str) -> tuple[str, tuple[int, str]] | None:
    """A key written into a file name, e.g. "Artist - Title (Am)", "8A - Artist - Title",
    "01 - F#m - Title", "Title [C major]", "Symphony No. 40 in G minor". Read only where a
    key can't be part of a title: a whole bracketed group, a whole " - "-separated part (not a
    lone letter: that could be an artist), "in <note> major/minor", or a Camelot code anywhere.
    A key can also stand as a word among others ("Title C#m 128", "Artist D#min Title",
    "artist g#min title") when it is spelled in a way no English word or name is.
    So "Here I Am", "A Minor Incident" or an artist called "B" are *not* read as keys."""
    candidates = [m.group(1) for m in _BRACKETS.finditer(stem)]
    candidates += [part for part in _SEGMENTS.split(stem) if part and len(part.strip()) > 1]
    for text in candidates:
        key = parse_key(text)
        if key is not None:
            return text.strip(), key
    m = _IN_KEY.search(stem)
    if m:
        accidental = {"flat": "b", "sharp": "#"}.get((m.group(2) or "").lower(), m.group(3) or "")
        return m.group(0), parse_key(f"{m.group(1).upper()}{accidental} {m.group(4).lower()}")
    m = _CAMELOT_TOKEN.search(stem)
    if m:
        return m.group(0), parse_key(m.group(0))
    tokens = [t.strip(".,;:!?'\"") for t in stem.split()]
    for i, tok in enumerate(tokens):
        if _TOKEN_KEY.match(tok):
            if tok in _NAMES_LIKE_KEYS and not (i + 1 < len(tokens) and tokens[i + 1].isdigit()):
                continue
            return tok, parse_key(tok)
    return None


def name_shape(stem: str) -> str:
    """A file name with every word replaced by "w" except key-like ones, to show how
    names are laid out without revealing titles: "w w - w (Am)"."""
    return re.sub(r"[^\s\-\u2013\u2014_()\[\]{}|.,&+]+", lambda m: m.group(0) if _KEYISH.match(m.group(0)) else "w", stem)


def find_tagged(root: Path) -> tuple[list[tuple[Path, str, tuple[int, str]]], Counter, list[str]]:
    """Every audio file with a readable key: from its file name first (hand-written keys),
    else from its key tag. Also returns name shapes of up to 10 files without a key."""
    counts = Counter()
    found, shapes = [], []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        counts["audio files"] += 1
        from_name = key_from_name(p.stem)
        if from_name is not None:
            counts["key in file name"] += 1
            found.append((p, f"name:{from_name[0]}", from_name[1]))
            continue
        raw = read_key_tag(p)
        key = parse_key(raw) if raw is not None else None
        if key is not None:
            counts["key in tag"] += 1
            found.append((p, f"tag:{raw}", key))
            continue
        counts["no key found" if raw is None else "unreadable key tag"] += 1
        if len(shapes) < 10:
            shapes.append(name_shape(p.stem))
    counts["with a key"] = len(found)
    return found, counts, shapes


def engine_stats(rows: list[dict], eng: str) -> dict:
    """Agreement of one engine with the written keys, and how the disagreements relate."""
    import mir_eval

    from .features import NOTE_NAMES

    def name(k):
        return f"{NOTE_NAMES[k[0]]} {k[1]}"

    rel = Counter(relation(r["tag"], r["answers"][eng][:2]) for r in rows)
    up = sum(relation(r["tag"], r["answers"][eng][:2]) == "fifth" and (r["answers"][eng][0] - r["tag"][0]) % 12 == 7
             for r in rows)
    weighted = np.mean([mir_eval.key.weighted_score(name(r["tag"]), name(r["answers"][eng][:2])) for r in rows])
    conf = np.array([r["answers"][eng][2] for r in rows])
    same = np.array([relation(r["tag"], r["answers"][eng][:2]) == "same" for r in rows])
    sure = conf >= 0.8
    return {
        "n": len(rows), "weighted": round(float(weighted), 3), "agree": round(float(same.mean()), 3),
        "relations": {k: round(v / len(rows), 3) for k, v in rel.items()},
        "fifth_above": round(up / len(rows), 3), "fifth_below": round((rel["fifth"] - up) / len(rows), 3),
        "sure_share": round(float(sure.mean()), 3),
        "agree_when_sure": round(float(same[sure].mean()), 3) if sure.any() else None,
        "agree_when_unsure": round(float(same[~sure].mean()), 3) if (~sure).any() else None,
    }


def summarise(rows: list[dict], counts: Counter, fusion_path: str | None) -> tuple[str, dict]:
    engines = list(rows[0]["answers"]) if rows else []
    stats = {"counts": dict(counts), "fusion": fusion_path, "n": len(rows),
             "engines": {eng: engine_stats(rows, eng) for eng in engines}}
    cue_hits = defaultdict(list)
    for r in rows:
        for cue, pc in r["cues"].items():
            cue_hits[cue].append(pc == r["tag"][0])
    stats["cue_points_at_tag_tonic"] = {k: round(float(np.mean(v)), 3) for k, v in cue_hits.items()}
    stats["no_key"] = round(float(np.mean([r["no_key"] for r in rows])), 3) if rows else 0.0
    stats["with_key_changes"] = round(float(np.mean([r["sections"] > 1 for r in rows])), 3) if rows else 0.0

    lines = ["# Library check: stoned-mango vs your keys", "",
             "Your keys (from file names or tags) may be wrong, so *agree* is not accuracy; compare the rows with each other.", "",
             "- Files: " + ", ".join(f"{k} {v}" for k, v in counts.items()),
             f"- Analysed: {len(rows)} full-length tracks with a key; fusion weights: `{Path(fusion_path).name if fusion_path else '-'}`",
             f"- \"No clear key\" (fusion): {stats['no_key']:.1%}",
             f"- Songs the timeline splits into more than one key: {stats['with_key_changes']:.1%}", "",
             "| Engine | agree | weighted | fifth above | fifth below | relative | parallel | other | sure (key conf >= 0.8) | agree when sure | agree when unsure |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for eng, s in stats["engines"].items():
        r = s["relations"]
        lines.append(f"| {eng} | {s['agree']:.3f} | {s['weighted']:.3f} | {s['fifth_above']:.3f} | {s['fifth_below']:.3f} "
                     f"| {r.get('relative', 0):.3f} "
                     f"| {r.get('parallel', 0):.3f} | {r.get('other', 0):.3f} | {s['sure_share']:.3f} "
                     f"| {s['agree_when_sure'] if s['agree_when_sure'] is not None else '-'} "
                     f"| {s['agree_when_unsure'] if s['agree_when_unsure'] is not None else '-'} |")
    lines += ["", "Where each home-note cue points (share of tracks where it is the tagged home note; chance is 0.083):", ""]
    lines += [f"- {k}: {v:.3f}" for k, v in stats["cue_points_at_tag_tonic"].items()]
    lines += ["", "`fusion_endingX` = the fusion with the \"ending\" cue switched on at weight X.",
              "*fifth above*: the app's home note is a fifth above yours (you: C, app: G); *fifth below*: a fifth below (you: C, app: F)."]
    return "\n".join(lines) + "\n", stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("music", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=1000, help="analyse at most this many files with a key (random sample)")
    ap.add_argument("--fusion", type=Path, help="fusion weights (default: shared/fusion.json)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--min-seconds", type=float, default=MIN_SECONDS, help="skip shorter files (not full songs)")
    args = ap.parse_args(argv)

    from .fusion import FUSION_JSON

    fusion_path = str(args.fusion or FUSION_JSON)
    if not Path(fusion_path).exists():
        sys.exit(f"no fusion weights at {fusion_path}")
    if not args.music.is_dir():
        sys.exit(f"{args.music} is not a folder")
    print(f"Looking for key tags under {args.music} ...")
    found, counts, shapes = find_tagged(args.music)
    print(", ".join(f"{k} {v}" for k, v in counts.items()))
    if not found:
        print("Name layouts of files without a key (words shown as w):\n  " + "\n  ".join(shapes))
        sys.exit("No keys found in file names or key tags.")
    rng = np.random.default_rng(args.seed)
    order = rng.permutation(len(found))[: args.limit]
    sample = [found[i] for i in order]

    args.out.mkdir(parents=True, exist_ok=True)
    rows, clips, csv_rows = [], [], []
    t0 = time.time()
    jobs = [(str(p), raw, fusion_path) for p, raw, _ in sample]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for i, ((p, raw, key), res) in enumerate(zip(sample, pool.map(_analyse, jobs, chunksize=1)), 1):
            if i % 10 == 0 or i == len(sample):
                print(f"  {i}/{len(sample)} tracks, {time.time() - t0:.0f}s", flush=True)
            if res.get("silent"):
                counts["silent"] += 1
                continue
            if res["duration"] < args.min_seconds:
                counts[f"shorter than {args.min_seconds:.0f} s"] += 1
                if res["duration"] >= MIN_CLIP_SECONDS:
                    clips.append({"tag": key, "answers": res["answers"]})
                continue
            rows.append({"tag": key, "answers": res["answers"], "cues": res["cues"], "no_key": res["no_key"],
                         "sections": res["sections"]})
            fu = res["answers"]["fusion"]
            csv_rows.append({"file": str(p), "tag": raw, "fusion": fu[3], "key_confidence": round(fu[2], 3),
                             "cnn": res["answers"]["cnn"][3], "relation_to_tag": describe(key, fu[:2])})
    text, stats = summarise(rows, counts, fusion_path)
    if clips:  # loops and samples: their written keys are often the pack maker's, so worth a separate look
        stats["clips"] = {eng: engine_stats(clips, eng) for eng in ("cnn", "fusion")}
        text += (f"\nShort clips ({MIN_CLIP_SECONDS:.0f}-{args.min_seconds:.0f} s, e.g. loops and samples): {len(clips)} with a key\n\n"
                 "| Engine | agree | weighted | fifth above | fifth below | relative | parallel | other | agree when sure |\n"
                 "|---|---|---|---|---|---|---|---|---|\n"
                 + "".join(f"| {eng} | {c['agree']:.3f} | {c['weighted']:.3f} | {c['fifth_above']:.3f} | {c['fifth_below']:.3f} "
                           f"| {c['relations'].get('relative', 0):.3f} | {c['relations'].get('parallel', 0):.3f} "
                           f"| {c['relations'].get('other', 0):.3f} | {c['agree_when_sure'] if c['agree_when_sure'] is not None else '-'} |\n"
                           for eng, c in stats["clips"].items()))
    # The app's most confident disagreements: worth a listen, to tell who is right.
    check = sorted((r for r in csv_rows if r["relation_to_tag"] != "same"), key=lambda r: -r["key_confidence"])[:CHECK]
    if check:
        text += ("\nThe app's most confident disagreements with your keys (file names are in `to-check.csv`, "
                 "same numbers):\n\n| # | how they differ | app's key confidence |\n|---|---|---|\n"
                 + "".join(f"| {i} | {r['relation_to_tag']} | {r['key_confidence']:.2f} |\n" for i, r in enumerate(check, 1)))
    with open(args.out / "to-check.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["#", "file", "your key", "app's key", "app's key confidence", "how they differ"])
        w.writerows([i, r["file"], r["tag"].split(":", 1)[-1], r["fusion"], r["key_confidence"], r["relation_to_tag"]]
                    for i, r in enumerate(check, 1))
    if shapes:
        text += ("\nName layouts of some files where no key was found (each word shown as `w`; keys kept):\n\n"
                 + "\n".join(f"- `{x}`" for x in shapes) + "\n")
    (args.out / "SUMMARY.md").write_text(text)
    (args.out / "library-stats.json").write_text(json.dumps(stats, indent=1))
    with open(args.out / "tracks.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["file", "tag", "fusion", "key_confidence", "cnn", "relation_to_tag"])
        w.writeheader()
        w.writerows(csv_rows)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
