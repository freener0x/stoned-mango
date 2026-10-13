"""Key and mode changes over time (PLAN.md stage [7b]).

1. **Windows.** ~12 s windows every ~3 s each get scores for all 360 answers
   (12 home notes x 30 scales), from the same engines as the whole-song answer:
   the fusion when fitted, else the CNN, else the template engine. The CNN runs
   once over the whole song (it is fully convolutional); windows average its
   output over their frames.
2. **HMM.** A Viterbi path through the windows picks one answer per window.
   Staying put is free; a change costs ``change`` plus ``per_note`` for every note
   the two scales do not share. So relative keys and modes of the same notes are
   cheap neighbours, a fifth away (one note differs) is moderate, and distant
   keys are expensive.
3. **Merging.** Sections shorter than ~10 s are merged into a neighbour, so
   passing chords don't show up as key changes.
4. **Labels.** Each section is scored again over all of its audio, which gives
   its label, confidence and ambiguity note just like a whole song. A section
   below the "No clear key" floor (a drum intro, say) says so.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache

import numpy as np

from .ambiguity import ambiguity
from .engines import Candidate, score_scales
from .features import Features
from .scales import library

WINDOW_SECONDS = 12.0
HOP_SECONDS = 3.0
MIN_SEGMENT_SECONDS = 10.0
CHANGE_COST = 18.0  # tuned on synthetic modulating songs (docs/phase4/REPORT.md)
PER_NOTE_COST = 1.0
TEMPLATE_SHARPNESS = 20.0  # turns template correlations into log-probabilities (fallback engine only)
CNN_DOWNSAMPLE = 4  # input frames per CNN output frame
REFINE_SECONDS = 6.0  # a boundary may move this far when refined ...
BLOCK_SECONDS = 1.5  # ... in steps of short blocks scored for the two keys on either side


def _ids() -> list[str]:
    from .cnn.labels import scale_ids

    return scale_ids()


def _log_softmax(x: np.ndarray) -> np.ndarray:
    x = x - x.max()
    return x - np.log(np.exp(x).sum())


def candidates_from(lp: np.ndarray) -> list[Candidate]:
    """Sorted candidates from a [360] log-probability vector (index scale * 12 + tonic)."""
    ids = _ids()
    out = [Candidate(t, ids[s], float(lp[s * 12 + t]), float(np.exp(lp[s * 12 + t])))
           for s in range(len(ids)) for t in range(12)]
    return sorted(out, key=lambda c: -c.score)


@cache
def _note_matrix() -> np.ndarray:
    """[360, 12] booleans: the notes of each answer."""
    lib = library()
    m = np.zeros((12 * len(_ids()), 12), bool)
    for s, sid in enumerate(_ids()):
        for t in range(12):
            m[s * 12 + t, [(t + p) % 12 for p in lib[sid].semitones]] = True
    return m


@cache
def transition_costs(change: float = CHANGE_COST, per_note: float = PER_NOTE_COST) -> np.ndarray:
    """[360, 360] cost of moving from one answer to another (0 to stay)."""
    m = _note_matrix().astype(np.int16)
    differ = (m[:, None, :] != m[None, :, :]).sum(-1)
    cost = change + per_note * differ
    np.fill_diagonal(cost, 0.0)
    return cost.astype(np.float64)


def viterbi(emissions: np.ndarray, cost: np.ndarray) -> np.ndarray:
    """Best state path for [windows, states] log-likelihoods and a [states, states] cost."""
    n, k = emissions.shape
    score = emissions[0].copy()
    back = np.zeros((n, k), np.int32)
    for i in range(1, n):
        cand = score[:, None] - cost  # [from, to]
        back[i] = np.argmax(cand, axis=0)
        score = cand[back[i], np.arange(k)] + emissions[i]
    path = np.zeros(n, np.int32)
    path[-1] = int(np.argmax(score))
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    return path


class RangeScorer:
    """Scores for any stretch of a song, from features computed once."""

    def __init__(self, f: Features, fusion=None, cnn=None):
        self.f, self.fusion, self.cnn = f, fusion, cnn
        self.logits = cnn.frame_logits(f.logspec) if cnn is not None else None

    def log_probs(self, a: int, b: int) -> np.ndarray | None:
        """[360] log-probabilities for frames [a, b), or None if that stretch is silent."""
        f = self.f
        chroma = f.chroma(start=a, stop=b)
        if f.voiced(a, b).size == 0 or chroma.max() <= 0:
            return None
        cnn_lp = None
        if self.logits is not None:
            lo = a // CNN_DOWNSAMPLE
            hi = max(lo + 1, -(-b // CNN_DOWNSAMPLE))
            cnn_lp = _log_softmax(self.logits[:, lo:hi].mean(axis=1))
        if self.fusion is not None and cnn_lp is not None:
            from .fusion import candidate_features
            from .tonic import tonic_cues

            bass = f.chroma(bass=True, start=a, stop=b)
            return self.fusion.log_probs(candidate_features(cnn_lp, chroma, tonic_cues(f.logspec[a:b], bass)))
        if cnn_lp is not None:
            return cnn_lp
        ids = {sid: i for i, sid in enumerate(_ids())}
        scores = np.full(12 * len(ids), -1.0)
        for c in score_scales(chroma, f.chroma(bass=True, start=a, stop=b)):
            if c.scale in ids:
                scores[ids[c.scale] * 12 + c.tonic] = c.score
        return _log_softmax(TEMPLATE_SHARPNESS * scores)


@dataclass
class Segment:
    start: float  # seconds
    end: float
    state: int  # scale * 12 + tonic


def windows(f: Features, window: float = WINDOW_SECONDS, hop: float = HOP_SECONDS) -> list[tuple[int, int]]:
    """Frame ranges of the analysis windows; one window for a song shorter than ``window``."""
    w = max(1, int(round(window / f.hop_seconds)))
    h = max(1, int(round(hop / f.hop_seconds)))
    if f.frames <= w:
        return [(0, f.frames)]
    starts = list(range(0, f.frames - w + 1, h))
    if starts[-1] + w < f.frames:  # cover the tail
        starts.append(f.frames - w)
    return [(s, s + w) for s in starts]


def segment_path(f: Features, bounds: list[tuple[int, int]], path: np.ndarray) -> list[Segment]:
    """Window states -> time segments; a boundary falls halfway between two window centres."""
    centres = [(a + b) / 2 * f.hop_seconds for a, b in bounds]
    segs = [Segment(0.0, f.duration, int(path[0]))]
    for i in range(1, len(path)):
        if path[i] != path[i - 1]:
            t = (centres[i - 1] + centres[i]) / 2
            segs[-1].end = t
            segs.append(Segment(t, f.duration, int(path[i])))
    return segs


def merge_short(segs: list[Segment], min_seconds: float, cost: np.ndarray) -> list[Segment]:
    """Fold segments shorter than ``min_seconds`` into the neighbour with the closer key."""
    segs = [Segment(s.start, s.end, s.state) for s in segs]
    while len(segs) > 1:
        i = min(range(len(segs)), key=lambda j: segs[j].end - segs[j].start)
        if segs[i].end - segs[i].start >= min_seconds:
            break
        nbrs = [j for j in (i - 1, i + 1) if 0 <= j < len(segs)]
        j = min(nbrs, key=lambda n: (cost[segs[i].state, segs[n].state], -(segs[n].end - segs[n].start)))
        if j < i:
            segs[j].end = segs[i].end
        else:
            segs[j].start = segs[i].start
        del segs[i]
        segs = _join_equal(segs)
    return segs


def _join_equal(segs: list[Segment]) -> list[Segment]:
    out = [segs[0]]
    for s in segs[1:]:
        if s.state == out[-1].state:
            out[-1].end = s.end
        else:
            out.append(s)
    return out


def refine_boundaries(f: Features, segs: list[Segment], scorer: RangeScorer,
                      reach: float = REFINE_SECONDS, block: float = BLOCK_SECONDS) -> list[Segment]:
    """Move each boundary to where the two neighbouring keys explain the audio best.

    Windows are long, so a change is first placed only roughly. Around it, short
    blocks are scored for just the two keys involved, and the boundary goes where the
    total (first key before, second key after) is highest.
    """
    bl = max(1, int(round(block / f.hop_seconds)))
    for i in range(1, len(segs)):
        left, right = segs[i - 1], segs[i]
        lo = max(left.start + block, right.start - reach)
        hi = min(right.end - block, right.start + reach)
        if hi <= lo:
            continue
        a0 = int(round(lo / f.hop_seconds))
        n_blocks = max(1, int(round((hi - lo) / block)))
        diffs = []  # per block: how much better the left key explains it than the right key
        for k in range(n_blocks):
            lp = scorer.log_probs(a0 + k * bl, a0 + (k + 1) * bl)
            diffs.append(0.0 if lp is None else lp[left.state] - lp[right.state])
        gain = np.concatenate([[0.0], np.cumsum(diffs)])  # boundary after k blocks
        k = int(np.argmax(gain))
        t = (a0 + k * bl) * f.hop_seconds
        left.end = right.start = float(np.clip(t, left.start + block, right.end - block))
    return segs


@dataclass
class Prepared:
    """Everything about a song the timeline needs, computed once (decoding is cheap)."""
    f: Features
    scorer: RangeScorer
    bounds: list[tuple[int, int]]
    emissions: np.ndarray  # [windows, 360]
    allowed: np.ndarray  # [360] scale tiers allowed
    floor: float  # "No clear key" floor on the key confidence


def prepare(f: Features, fusion=None, cnn=None, window: float = WINDOW_SECONDS, hop: float = HOP_SECONDS,
            max_tier: int = 2) -> Prepared:
    scorer = RangeScorer(f, fusion, cnn)
    bounds = windows(f, window, hop)
    n = 12 * len(_ids())
    emissions = np.array([lp if (lp := scorer.log_probs(a, b)) is not None else np.zeros(n) for a, b in bounds])
    allowed = np.array([library()[sid].tier <= max_tier for sid in _ids() for _ in range(12)])
    emissions[:, ~allowed] = -1e9
    return Prepared(f, scorer, bounds, emissions, allowed, fusion.no_key_below if fusion is not None else 0.0)


def decode(prep: Prepared, change: float = CHANGE_COST, per_note: float = PER_NOTE_COST,
           min_seconds: float = MIN_SEGMENT_SECONDS) -> list[dict]:
    """The song's sections, each with its own key, confidence and ambiguity note."""
    from .fusion import key_confidence

    f, scorer, allowed = prep.f, prep.scorer, prep.allowed
    cost = transition_costs(change, per_note)
    segs = merge_short(segment_path(f, prep.bounds, viterbi(prep.emissions, cost)), min_seconds, cost)
    segs = refine_boundaries(f, segs, scorer)

    def frame(t: float) -> int:
        return int(round(t / f.hop_seconds))

    # Score each section over all of its audio; neighbours that agree on the answer join up.
    while True:
        for s in segs:
            lp = scorer.log_probs(frame(s.start), max(frame(s.end), frame(s.start) + 1))
            if lp is not None:
                s.state = int(np.argmax(np.where(allowed, lp, -np.inf)))
        joined = _join_equal(segs)
        if len(joined) == len(segs):
            break
        segs = joined

    out = []
    for s in segs:
        a, b = frame(s.start), max(frame(s.end), frame(s.start) + 1)
        lp = scorer.log_probs(a, b)
        seg = {"start": round(s.start, 2), "end": round(s.end, 2)}
        if lp is None:
            out.append(seg | {"key": None, "label": "No clear key", "confidence": 0.0, "key_confidence": 0.0})
            continue
        cands = [c for c in candidates_from(np.where(allowed, lp, -np.inf)) if np.isfinite(c.score)]
        best, kc = cands[0], key_confidence(cands)
        if kc < prep.floor:
            seg |= {"key": None, "label": "No clear key", "best_guess": best.label}
        else:
            seg |= {"key": {"tonic": best.tonic, "scale": best.scale, "third": library()[best.scale].third},
                    "label": best.label, "ambiguity": ambiguity(cands, f.chroma(start=a, stop=b))}
        out.append(seg | {"confidence": round(best.prob, 3), "key_confidence": round(kc, 3)})
    return out


def timeline(f: Features, fusion=None, cnn=None, **kwargs) -> list[dict]:
    """``prepare`` + ``decode`` in one call; keyword arguments go to whichever takes them."""
    prep_keys = {"window", "hop", "max_tier"}
    prep = prepare(f, fusion, cnn, **{k: v for k, v in kwargs.items() if k in prep_keys})
    return decode(prep, **{k: v for k, v in kwargs.items() if k not in prep_keys})
