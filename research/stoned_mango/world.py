"""Tier 3: Arabic maqam, Turkish makam and Indian raga families (PLAN.md section 4).

These scales use notes between the piano's keys (quarter tones, Holdrian commas, just
intonation), so they are matched on the 120-bin pitch profile (10 cents per bin), not on
12-note chroma, and the home note (tonic, Sa) can sit on a quarter tone.

    candidates(f)        every tier 3 scale at each of 24 quarter-tone home notes, best first
    evidence(f)          the signs of these traditions in the audio: notes between the keys, a drone
    decide(f, western)   the tier 3 answer to report instead of the Western one, or None

When it is used (``traditions``):
    "auto"     only when the audio shows notes between the keys or a drone, *and* a tier 3
               scale fits better than the best Western one: ordinary songs keep their
               Western answer (the default)
    "western"  never
    "all"      whenever a tier 3 scale fits better than the Western ones
    "arabic", "turkish", "indian" (comma-separated)   always, from those traditions only
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import numpy as np

from .features import BINS_PER_SEMITONE, HPCP_BINS, Features
from .scales import library

RAGAS_JSON = Path(__file__).resolve().parents[2] / "shared" / "ragas.json"
TRADITIONS = ("arabic", "turkish", "indian")
STEPS = 24  # home notes on a quarter-tone grid
BINS_PER_STEP = HPCP_BINS // STEPS  # 5

# Template shape: a bump per scale degree (sigma in bins of 10 cents), by role.
SIGMA_BINS = 1.5
ROLE = {"tonic": 1.0, "dominant": 0.85, "degree": 0.55, "outside": 0.12}
# Cues for the home note, added to the template fit (pooled to quarter tones, 0..1).
BASS_WEIGHT = 0.15
DRONE_WEIGHT = 0.25
ENDING_WEIGHT = 0.1  # the lead line's last notes: these traditions end on the home note (karar, Sa)
ENDING_SECONDS = 5.0
TEMPERATURE = 0.012  # fitted on synthetic songs (world_eval.fit_temperature)
# The lead line: per frame, the strongest pitch above the steady background (drone, pads).
BACKGROUND_PERCENTILE = 30
# The "auto" gate (fitted on synthetic songs; see docs/phase8/REPORT.md):
DEVIATION_MIN = 2.5  # cents: the melody's notes sit this far, on average, from the piano's tuning
DRONE_MIN = 0.55  # a note and its fifth or fourth among the two loudest this often
FIT_MIN = 0.6  # the best tier 3 template itself (before the cues) must fit this well (noise and drums don't)
# "auto" mode, fitted on real music on the author's PC (docs/phase8/REPORT.md §8): a tier 3 scale must beat
# the best Western one by this much. Real recordings never sit exactly on the piano's tuning, so the
# intonation evidence alone doesn't tell a maqam from a pop song; the margin does most of the work.
AUTO_MARGIN = {"arabic": 0.10, "turkish": 0.10, "indian": 0.0}
AUTO_FIT_MIN = 0.65  # ... and its template must fit at least this well
QUARTER_TONES_MIN = 0.05  # a scale with quarter tones wins only if this share of the melody's peaks has them
WESTERN_SURE = 0.9  # a maqam or makam doesn't replace a Western key the Western engine is this sure of
ON_KEYS_DEVIATION_MIN = 5.0  # cents: a maqam or makam on the piano's keys (Kurd, Nihavent) needs this, or quarter tones
PEAK_LEVEL = 0.1


@dataclass
class Tier3Candidate:
    tonic_step: int  # home note in quarter tones above C (0..23)
    scale: str
    score: float
    prob: float = 0.0
    fit: float = 0.0  # the template's fit alone, without the home-note cues

    @property
    def tonic_cents(self) -> int:
        return self.tonic_step * 50


def _bump_template(cents: list[float], dominant: int | None) -> np.ndarray:
    """120-bin template: Gaussian bumps at each degree, weighted by its role."""
    x = np.arange(HPCP_BINS, dtype=np.float64)
    t = np.full(HPCP_BINS, ROLE["outside"])
    for i, c in enumerate(cents):
        w = ROLE["tonic"] if i == 0 else ROLE["dominant"] if dominant is not None and i == dominant - 1 else ROLE["degree"]
        d = np.abs(x - c / 10.0)
        d = np.minimum(d, HPCP_BINS - d)
        t = np.maximum(t, w * np.exp(-0.5 * (d / SIGMA_BINS) ** 2))
    return t


def _zscore(v: np.ndarray) -> np.ndarray:
    sd = v.std()
    return (v - v.mean()) / sd if sd > 1e-12 else np.zeros_like(v)


@cache
def tier3_ids(traditions: tuple[str, ...] = TRADITIONS) -> tuple[str, ...]:
    return tuple(s.id for s in library().values() if s.tier == 3 and s.tradition in traditions)


@cache
def _templates(ids: tuple[str, ...]) -> np.ndarray:
    """[scales, 120] z-scored templates for a set of scale ids."""
    lib = library()
    return np.stack([_zscore(_bump_template(list(lib[i].cents), lib[i].dominant)) for i in ids])


@cache
def _western_templates() -> tuple[tuple[str, ...], np.ndarray]:
    """The tier 1-2 scales as 120-bin templates in equal temperament, dominant = the fifth."""
    ids = tuple(s.id for s in library().values() if s.tier <= 2)
    lib = library()
    rows = []
    for i in ids:
        cents = sorted({round(c / 100) % 12 * 100 for c in lib[i].cents})
        dom = next((k + 1 for k, c in enumerate(cents) if c == 700), None)
        rows.append(_zscore(_bump_template(cents, dom)))
    return ids, np.stack(rows)


def _pool(p: np.ndarray) -> np.ndarray:
    """120 bins -> 24 quarter tones (each step gathers the bins within +/-25 cents)."""
    idx = (np.arange(HPCP_BINS) + BINS_PER_STEP // 2) % HPCP_BINS // BINS_PER_STEP
    out = np.zeros(STEPS)
    np.add.at(out, idx, p)
    return out


def _unit_max(v: np.ndarray) -> np.ndarray:
    m = float(v.max()) if v.size else 0.0
    return v / m if m > 0 else np.zeros_like(v)


def _tuned_frames(f: Features) -> np.ndarray:
    """Voiced 120-bin frames, rotated (to the nearest bin) so bin 0 is C at the recording's tuning."""
    idx = f.voiced()
    shift = -int(np.round(f.tuning_cents / 10.0)) - 3 * BINS_PER_SEMITONE
    return np.roll(f.hpcp[idx].astype(np.float64), shift, axis=1)


def lead_line(frames: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per frame, the strongest bin once the steady background (each bin's 30th percentile over
    the song: drones, held chords) is taken away, and its strength."""
    if len(frames) == 0:
        return np.zeros(0, int), np.zeros(0)
    rest = np.maximum(frames - np.percentile(frames, BACKGROUND_PERCENTILE, axis=0), 0.0)
    top = np.argmax(rest, axis=1)
    return top, rest[np.arange(len(rest)), top]


def _histogram(top: np.ndarray, weights: np.ndarray) -> np.ndarray:
    h = np.bincount(top, weights=weights, minlength=HPCP_BINS).astype(np.float64)
    return 0.5 * h + 0.25 * np.roll(h, 1) + 0.25 * np.roll(h, -1)


def lead_profile(frames: np.ndarray) -> np.ndarray:
    """A pitch histogram of the lead line (lead_line), weighted by strength and lightly smoothed.
    Melodies carry these traditions' intervals, and a drone would otherwise swamp them."""
    return _histogram(*lead_line(frames))


def ending_profile(frames: np.ndarray, hop_seconds: float) -> np.ndarray:
    """The lead line over the last ENDING_SECONDS of sound: where the performance comes home."""
    top, w = lead_line(frames)
    n = max(1, int(round(ENDING_SECONDS / hop_seconds)))
    return _histogram(top[-n:], w[-n:])


@dataclass
class Evidence:
    deviation: float  # cents: how far the lead line's notes sit from the nearest equal-tempered grid
    quarter_tones: float  # share of the lead line's peaks 30-50 cents off that grid
    drone: float  # how constantly a note and its fifth or fourth sound (0..1)
    drone_step: int | None  # where that drone is (quarter tones above C)

    def fires(self) -> bool:
        return self.deviation >= DEVIATION_MIN or self.drone >= DRONE_MIN


def _drone(frames: np.ndarray) -> tuple[float, int | None, np.ndarray]:
    """Per quarter tone, the share of frames in which it is among the two loudest; and the
    strongest note-plus-fifth (or fourth) pair, min of the two shares."""
    if len(frames) == 0:
        return 0.0, None, np.zeros(STEPS)
    pooled = np.stack([_pool(fr) for fr in frames])
    top2 = np.argsort(-pooled, axis=1, kind="stable")[:, :2]
    share = np.bincount(top2.ravel(), minlength=STEPS) / len(frames)
    best, where = 0.0, None
    for q in range(STEPS):
        partner = max(share[(q + 14) % STEPS], share[(q + 10) % STEPS])  # a fifth (700) or fourth (500) up
        v = min(share[q], partner)
        if v > best + 1e-12:
            best, where = float(v), q
    return best, where, share


def peaks(p: np.ndarray, level: float = PEAK_LEVEL) -> list[tuple[float, float]]:
    """(cents, height) of the profile's local maxima above level x the highest, refined by a parabola."""
    p = np.asarray(p, np.float64)
    if p.max() <= 0:
        return []
    out = []
    for i in range(HPCP_BINS):
        a, b, c = p[i - 1], p[i], p[(i + 1) % HPCP_BINS]
        if b > a and b >= c and b >= level * p.max():
            den = a - 2 * b + c
            out.append(((i + (0.5 * (a - c) / den if den else 0.0)) * 10.0, float(b)))
    return out


def intonation(p: np.ndarray) -> tuple[float, float]:
    """(mean distance in cents of the peaks from the best-fitting equal-tempered grid, weighted by
    height; share of peak height 30+ cents off it). Equal temperament scores ~0."""
    pk = peaks(p)
    if not pk:
        return 0.0, 0.0
    offs = np.array([c % 100 for c, _ in pk])
    h = np.array([w for _, w in pk])
    dist = lambda g: np.minimum(np.abs(offs - g) % 100, 100 - np.abs(offs - g) % 100)  # noqa: E731
    grid = max(range(100), key=lambda g: (h[dist(g) <= 8].sum(), -g))
    d = dist(grid)
    return float((h * d).sum() / h.sum()), float(h[d >= 30].sum() / h.sum())


def evidence(f: Features, frames: np.ndarray | None = None) -> Evidence:
    fr = _tuned_frames(f) if frames is None else frames
    dev, qt = intonation(lead_profile(fr))
    d, where, _ = _drone(fr)
    return Evidence(dev, qt, d, where)


def candidates(f: Features, traditions: tuple[str, ...] = TRADITIONS) -> list[Tier3Candidate]:
    frames = _tuned_frames(f)
    return _rank(lead_profile(frames), f.profile120(bass=True), _drone(frames)[2], traditions,
                 ending_profile(frames, f.hop_seconds))


def _cues(bass: np.ndarray, drone_share: np.ndarray, ending: np.ndarray | None) -> np.ndarray:
    """Per quarter tone, the home-note cues added to every template's fit: bass, drone, ending."""
    e = _unit_max(_pool(np.asarray(ending, np.float64))) if ending is not None else np.zeros(STEPS)
    return (BASS_WEIGHT * _unit_max(_pool(np.asarray(bass, np.float64))) + DRONE_WEIGHT * _unit_max(drone_share)
            + ENDING_WEIGHT * e)


def _rank(p: np.ndarray, bass: np.ndarray, drone_share: np.ndarray, traditions: tuple[str, ...],
          ending: np.ndarray | None = None) -> list[Tier3Candidate]:
    ids = tier3_ids(tuple(t for t in TRADITIONS if t in traditions))
    if not ids or np.max(p) <= 0:
        return []
    zp = _zscore(np.asarray(p, np.float64))
    templates = _templates(ids)
    cue = _cues(bass, drone_share, ending)
    out = []
    for q in range(STEPS):
        fit = np.roll(templates, q * BINS_PER_STEP, axis=1) @ zp / HPCP_BINS
        for k, sid in enumerate(ids):
            out.append(Tier3Candidate(q, sid, float(fit[k] + cue[q]), fit=float(fit[k])))
    return _normalise(out)


def _normalise(cands: list[Tier3Candidate]) -> list[Tier3Candidate]:
    """Sort by score and set probabilities (softmax over the scores)."""
    cands.sort(key=lambda c: -c.score)
    if cands:
        scores = np.array([c.score for c in cands])
        w = np.exp((scores - scores[0]) / TEMPERATURE)
        w /= w.sum()
        for c, wi in zip(cands, w):
            c.prob = float(wi)
    return cands


def western_fit(p: np.ndarray, bass: np.ndarray, drone_share: np.ndarray, ending: np.ndarray | None = None) -> float:
    """The best fit of any Western scale (equal temperament, 12 home notes), scored like tier 3."""
    _, templates = _western_templates()
    zp = _zscore(np.asarray(p, np.float64))
    cue = _cues(bass, drone_share, ending)
    best = -np.inf
    for s in range(12):
        q = 2 * s
        fit = np.roll(templates, q * BINS_PER_STEP, axis=1) @ zp / HPCP_BINS
        best = max(best, float(fit.max() + cue[q]))
    return best


def parse_traditions(value: str) -> tuple[str, tuple[str, ...]]:
    """'auto' | 'western' | 'all' | 'arabic,indian' -> (mode, traditions)."""
    v = value.strip().lower()
    if v in ("auto", "western", "all"):
        return v, TRADITIONS if v != "western" else ()
    picked = tuple(t for t in TRADITIONS if t in {x.strip() for x in v.split(",")})
    if not picked:
        raise ValueError(f"unknown traditions: {value!r} (auto, western, all, or any of {', '.join(TRADITIONS)})")
    return "only", picked


@dataclass
class Decision:
    cands: list[Tier3Candidate]
    evidence: Evidence
    western: float
    use: bool


def decide(f: Features, traditions: str = "auto", western_confidence: float | None = None) -> Decision | None:
    """Whether to answer with a tier 3 scale, and the ranked candidates. ``western_confidence``:
    the Western engine's key confidence for this audio, when known (analysis.py)."""
    mode, picked = parse_traditions(traditions)
    if mode == "western" or f.voiced().size == 0:
        return None
    frames = _tuned_frames(f)
    d, where, share = _drone(frames)
    return decide_from(lead_profile(frames), f.profile120(bass=True), share, d, where, traditions,
                       ending_profile(frames, f.hop_seconds), western_confidence)


def decide_from(lead: np.ndarray, bass: np.ndarray, share: np.ndarray, drone: float = 0.0, drone_step: int | None = None,
                traditions: str = "auto", ending: np.ndarray | None = None,
                western_confidence: float | None = None) -> Decision:
    """decide() from the measurements: the lead-line profile (bin 0 = C at the tuning), the bass
    profile, the drone's per-quarter-tone shares (zeros when unknown, as for pitch tracks) and the
    ending's profile."""
    mode, picked = parse_traditions(traditions)
    dev, qt = intonation(lead)
    ev = Evidence(dev, qt, drone, drone_step)
    cands = _rank(lead, bass, share, picked, ending)
    west = western_fit(lead, bass, share, ending) if cands else 0.0
    if not cands or cands[0].fit < FIT_MIN:
        use = False
    elif mode == "only":
        use = True
    elif mode == "all":
        use = cands[0].score > west
    else:
        # Each tradition's best scale must match the evidence; the best of those must beat the
        # Western scales by its tradition's margin. Shown: the plausible scales from there down.
        best: dict[str, Tier3Candidate] = {}
        for c in cands:
            best.setdefault(library()[c.scale].tradition, c)
        ok = [c for c in best.values() if _plausible(c, ev, western_confidence)]
        top = max(ok, key=lambda c: c.score) if ok else None
        use = top is not None and top.score >= west + AUTO_MARGIN[library()[top.scale].tradition]
        cands = _normalise([c for c in cands if top is not None and c.score <= top.score
                            and _plausible(c, ev, western_confidence)])
    return Decision(cands, ev, west, use)


def _off_keys(c: Tier3Candidate) -> list[float]:
    """How far each note of this scale at this home note is from the nearest piano key, in cents."""
    return [min((c.tonic_cents + x) % 100, 100 - (c.tonic_cents + x) % 100) for x in library()[c.scale].cents]


def needs_quarter_tones(c: Tier3Candidate) -> bool:
    """Whether this scale at this home note has notes 30+ cents from the piano's keys."""
    return max(_off_keys(c)) >= 30


def on_keys(c: Tier3Candidate) -> bool:
    """Whether every note is within 10 cents of a piano key: a Western scale under another name."""
    return max(_off_keys(c)) <= 10


def _plausible(c: Tier3Candidate, ev: Evidence, western_confidence: float | None = None) -> bool:
    """In "auto" mode, a scale must fit well and match the evidence: quarter tones only if they're
    heard; an Indian scale only with a drone (their hallmark; a sure Western key doesn't rule them
    out, as the thaats are Western modes by other names); and a maqam or makam only when the notes
    stray from the piano's tuning, the Western engine is unsure of its key (detuned samples in
    electronic music look like quarter tones, but the Western engine still hears the key), and, for
    one that sits on the piano's keys, with clearly non-piano intonation (else the Western name says
    the same)."""
    if c.fit < AUTO_FIT_MIN or (needs_quarter_tones(c) and ev.quarter_tones < QUARTER_TONES_MIN):
        return False
    if library()[c.scale].tradition == "indian":
        return ev.drone >= DRONE_MIN
    if ev.deviation < DEVIATION_MIN or (western_confidence is not None and western_confidence >= WESTERN_SURE):
        return False
    return not on_keys(c) or ev.quarter_tones >= QUARTER_TONES_MIN or ev.deviation >= ON_KEYS_DEVIATION_MIN


# ---- names ---------------------------------------------------------------------------------

_FLAT_NAMES = ["C", "D flat", "D", "E flat", "E", "F", "G flat", "G", "A flat", "A", "B flat", "B"]
_SHARP_NAMES = ["C", "C sharp", "D", "E flat", "E", "F", "F sharp", "G", "G sharp", "A", "B flat", "B"]
SHORT = {"C": "C", "C sharp": "C#", "D flat": "Db", "D": "D", "E flat": "Eb", "E": "E", "F": "F", "F sharp": "F#",
         "G flat": "Gb", "G": "G", "G sharp": "G#", "A flat": "Ab", "A": "A", "B flat": "Bb", "B": "B"}


def tonic_name(step: int, tradition: str) -> str:
    """'D', 'Bb', 'E half-flat' (a quarter tone below E), 'C#'."""
    step %= STEPS
    if step % 2 == 0:
        names = _SHARP_NAMES if tradition == "indian" else _FLAT_NAMES
        return SHORT[names[step // 2]]
    upper = SHORT[_FLAT_NAMES[(step + 1) // 2 % 12]]
    return f"{upper} half-flat"


def label(c: Tier3Candidate) -> str:
    s = library()[c.scale]
    tonic = tonic_name(c.tonic_step, s.tradition or "")
    if s.tradition == "arabic":
        return f"Maqam {s.name} on {tonic}"
    if s.tradition == "turkish":
        return f"Makam {s.name} on {tonic}"
    info = scale_info(c.scale)
    name = f"{info['thaat']} thaat" if info.get("thaat") else s.name
    return f"{name}, Sa = {tonic}"


def parent(c: Tier3Candidate) -> str | None:
    """The second line: the melakarta behind a thaat, or a melakarta's number."""
    info = scale_info(c.scale)
    if info.get("tradition") != "indian":
        return None
    if info.get("thaat"):
        return f"{info['name']}, the {info['ordinal']} melakarta"
    return f"the {info['ordinal']} melakarta"


@cache
def _scales_json() -> dict[str, dict]:
    from .scales import SCALES_JSON

    return {s["id"]: s for s in json.loads(SCALES_JSON.read_text())["scales"]}


def scale_info(sid: str) -> dict:
    return _scales_json()[sid]


@cache
def _ragas() -> list[dict]:
    return json.loads(RAGAS_JSON.read_text())["ragas"]


def present_notes(p: np.ndarray, tonic_step: int, level: float = 0.2) -> list[int]:
    """Semitones above the tonic that are clearly played (energy within +/-50 cents >= level x the most)."""
    e = np.zeros(12)
    for s in range(12):
        centre = (tonic_step * BINS_PER_STEP + s * BINS_PER_SEMITONE) % HPCP_BINS
        bins = (centre + np.arange(-BINS_PER_SEMITONE // 2, BINS_PER_SEMITONE // 2 + 1)) % HPCP_BINS
        e[s] = p[bins].sum()
    e = _unit_max(e)
    return [s for s in range(12) if e[s] >= level]


def raga_shortlist(p: np.ndarray, best: Tier3Candidate, top: int = 3) -> list[str]:
    """Ragas whose notes match the notes played (a raga is more than its notes: a shortlist)."""
    notes = set(present_notes(p, best.tonic_step))
    scored = []
    for r in _ragas():
        rn = set(r["notes"])
        jac = len(notes & rn) / len(notes | rn)
        if jac >= 0.7:
            scored.append((jac + (0.1 if r["parent"] == best.scale else 0.0), r["name"]))
    scored.sort(key=lambda x: (-x[0], x[1]))
    names: list[str] = []
    for _, n in scored:
        if n not in names:
            names.append(n)
    return names[:top]


def nearest_key(c: Tier3Candidate) -> dict:
    """The major or minor key whose notes are closest (quarter tones rounded up), for the ≈ code.
    Ties go to the key on the same home note, then to one whose own chord is in the scale
    (Maqam Hijaz on D: G minor, not B flat major), then to the same third."""
    cents = list(library()[c.scale].cents)
    pcs = {int(np.floor((c.tonic_cents + x) / 100 + 0.5)) % 12 for x in cents}
    tonic = int(np.floor(c.tonic_cents / 100 + 0.5)) % 12
    third_minor = library()[c.scale].third == "minor"
    major = [0, 2, 4, 5, 7, 9, 11]
    minor = [0, 2, 3, 5, 7, 8, 10]
    best = None
    for t in range(12):
        for is_minor in (False, True):
            notes = {(t + i) % 12 for i in (minor if is_minor else major)}
            diff = len(notes ^ pcs)
            triad = {t, (t + (3 if is_minor else 4)) % 12, (t + 7) % 12} <= pcs  # its chord is in the scale
            rank = (diff, 0 if (t == tonic and is_minor == third_minor) else 1, 0 if t == tonic else 1,
                    0 if triad else 1, 0 if is_minor == third_minor else 1, t, is_minor)
            if best is None or rank < best[0]:
                best = (rank, t, is_minor)
    return {"tonic": best[1], "minor": best[2]}


def ambiguity_note(cands: list[Tier3Candidate]) -> dict | None:
    """Two scales the profile can't tell apart: same notes and emphasis, or a close runner-up."""
    if len(cands) < 2:
        return None
    best = cands[0]
    lib = library()
    for c in cands[1:6]:
        if c.tonic_step != best.tonic_step or c.prob < 0.5 * best.prob:
            continue
        same = lib[c.scale].cents == lib[best.scale].cents and lib[c.scale].dominant == lib[best.scale].dominant
        a, b = label(best), label(c)
        text = (f"{a} or {lib[c.scale].name}: same notes and emphasis; only the melody tells them apart" if same
                else f"{a} or {b}: the two differ in notes that are hard to place here")
        return {"kind": "same_notes" if same else "close", "labels": [a, b], "text": text}
    return None


def result(f: Features, d: Decision, western_label: str | None = None) -> dict:
    """The tier 3 answer, in the same shape as analysis.analyse_features (plus tradition fields
    and, when given, the Western engine's answer for comparison)."""
    p = lead_profile(_tuned_frames(f))
    best = d.cands[0]
    s = library()[best.scale]
    same_tonic = sum(c.prob for c in d.cands if c.tonic_step == best.tonic_step)
    lab = label(best)
    out = {
        "key": {"tonic": int(np.floor(best.tonic_cents / 100 + 0.5)) % 12, "scale": best.scale, "third": s.third,
                "tonic_cents": best.tonic_cents},
        "label": lab,
        "parent": parent(best),
        "tradition": s.tradition,
        "confidence": round(best.prob, 3),
        "key_confidence": round(same_tonic, 3),
        "ambiguity": ambiguity_note(d.cands),
        "alternatives": [{"label": label(c), "score": round(c.prob, 3)} for c in d.cands[1:4]],
        "nearest_key": nearest_key(best),
        "evidence": {"deviation_cents": round(d.evidence.deviation, 1), "quarter_tones": round(d.evidence.quarter_tones, 3),
                     "drone": round(d.evidence.drone, 3)},
        "tuning_cents": round(f.tuning_cents, 1),
        "duration": round(f.duration, 2),
        "engine": "tier3",
        "segments": [{"start": 0.0, "end": round(f.duration, 2), "label": lab,
                      "key": {"tonic": int(np.floor(best.tonic_cents / 100 + 0.5)) % 12, "scale": best.scale,
                              "third": s.third, "tonic_cents": best.tonic_cents},
                      "confidence": round(best.prob, 3), "key_confidence": round(same_tonic, 3)}],
    }
    if s.tradition == "indian":
        out["ragas"] = raga_shortlist(p, best)
    if western_label:
        out["western"] = western_label
    return out
