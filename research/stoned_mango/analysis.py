"""One-call analysis of a file: features -> engines -> a result dict.

Engines (``engine=``):

* ``"cnn"``: the trained key CNN (web/public/models/key-cnn.fp32.onnx). Best on
  real music so far (docs/phase2/REPORT.md).
* ``"template"``: the phase 1 scale-template engine with the bass tonic cue.
* ``"fusion"``: every engine and the tonic cues combined with the calibrated
  weights in shared/fusion.json (phase 3).
* ``"auto"`` (default): fusion when its weights and the CNN are available, else
  the CNN, else the template engine.

Every answer has ``segments``: the key over time, with changes (timeline.py).
Every answer carries an ``ambiguity`` note when the audio can't decide
(ambiguity.py). ``confidence`` is the probability of the exact answer (home
note and scale); ``key_confidence`` that of its home note and major/minor
family, which is what the "No clear key" floor applies to: a fusion answer
below it becomes "No clear key" (with the best guess kept).
"""

from __future__ import annotations

import os
from functools import cache
from pathlib import Path

from .ambiguity import ambiguity
from .engines import ESSENTIA_PROFILES, essentia_keys, score_scales
from .features import Features, extract
from .scales import library, parent_label

# Tuned on the phase 1 synthetic set (docs/phase1/REPORT.md); revisited in phase 3.
DEFAULT_BASS_WEIGHT = 0.3
DEFAULT_MODEL = Path(__file__).resolve().parents[2] / "web" / "public" / "models" / "key-cnn.fp32.onnx"


@cache
def default_cnn():
    """The bundled key CNN, or None if onnxruntime or the model file is missing."""
    path = Path(os.environ.get("STONED_MANGO_MODEL", DEFAULT_MODEL))
    try:
        from .cnn.engine import CnnEngine

        return CnnEngine(path) if path.exists() else None
    except ImportError:
        return None


@cache
def default_fusion():
    """The fitted fusion weights (shared/fusion.json), or None."""
    from .fusion import FUSION_JSON, Fusion

    path = Path(os.environ.get("STONED_MANGO_FUSION", FUSION_JSON))
    return Fusion.load(path) if path.exists() else None


def analyse_features(f: Features, bass_weight: float = DEFAULT_BASS_WEIGHT, max_tier: int = 2,
                     engine: str = "auto", timeline: bool = True, traditions: str = "western") -> dict:
    """``traditions``: when to answer with a maqam, makam or raga-family scale (world.py):
    "western" (never; the default), "auto" (only when a song clearly shows them: safe on ordinary
    music, but it misses most real maqam and raga recordings; docs/phase8/REPORT.md §8), "all", or
    a comma-separated list of "arabic", "turkish", "indian" (always, from those)."""
    chroma = f.chroma()
    bass = f.chroma(bass=True)
    if f.voiced().size == 0 or chroma.max() <= 0:
        return {"key": None, "label": "No clear key", "confidence": 0.0, "alternatives": [],
                "tuning_cents": None, "duration": round(f.duration, 2), "engine": None, "segments": []}
    western = _western(f, chroma, bass, bass_weight, max_tier, engine, timeline)
    if traditions != "western":
        from . import world

        # the Western answer first: in "auto" mode a maqam or makam doesn't replace a key it is sure of
        decision = world.decide(f, traditions, western_confidence=western.get("key_confidence"))
        if decision is not None and decision.use:
            return world.result(f, decision, western_label=western["label"] if western["key"] else None)
    return western


def western_result(f: Features) -> dict | None:
    """The Western engine's answer for this audio, without the timeline (None when there's no sound)."""
    chroma, bass = f.chroma(), f.chroma(bass=True)
    if f.voiced().size == 0 or chroma.max() <= 0:
        return None
    return _western(f, chroma, bass, DEFAULT_BASS_WEIGHT, 2, "auto", False)


def western_confidence(f: Features) -> float | None:
    """The Western engine's key confidence for this audio (what the "auto" tier 3 gate weighs)."""
    r = western_result(f)
    return r.get("key_confidence") if r else None


def _western(f: Features, chroma, bass, bass_weight: float, max_tier: int, engine: str, timeline: bool) -> dict:
    """The answer from the Western scales (tiers 1-2): fusion, CNN or templates."""
    cnn = default_cnn() if engine in ("auto", "cnn", "fusion") else None
    fusion = default_fusion() if engine in ("auto", "fusion") and cnn is not None else None
    if engine in ("cnn", "fusion") and cnn is None:
        raise RuntimeError(f"the key CNN is not available (needs onnxruntime and {DEFAULT_MODEL})")
    if engine == "fusion" and fusion is None:
        raise RuntimeError("no fusion weights (shared/fusion.json); run `python -m stoned_mango.fusion fit`")
    if fusion is not None:
        from .fusion import song_features

        cands, used = fusion.candidates(song_features(f.logspec, chroma, bass, cnn)), "fusion"
    elif cnn is not None:
        cands, used = cnn.candidates(f.logspec), "cnn"
    else:
        cands, used = score_scales(chroma, bass, bass_weight=bass_weight, max_tier=max_tier), "template"
    from .fusion import key_confidence

    cands = [c for c in cands if library()[c.scale].tier <= max_tier]
    best = cands[0]
    key_conf = key_confidence(cands)
    segments = _segments(f, fusion, cnn, max_tier) if timeline else []
    if fusion is not None and key_conf < fusion.no_key_below:
        return {"key": None, "label": "No clear key", "confidence": round(best.prob, 3),
                "key_confidence": round(key_conf, 3), "best_guess": best.label,
                "alternatives": [{"label": c.label, "score": round(c.prob, 3)} for c in cands[1:4]],
                "tuning_cents": round(f.tuning_cents, 1), "duration": round(f.duration, 2), "engine": used,
                "segments": segments}
    return {
        "key": {"tonic": best.tonic, "scale": best.scale, "third": library()[best.scale].third},
        "label": best.label,
        "parent": parent_label(best.tonic, best.scale),
        "confidence": round(best.prob, 3),  # calibrated for the fusion engine only
        "key_confidence": round(key_conf, 3),
        "ambiguity": ambiguity(cands, chroma),
        "alternatives": [{"label": c.label, "score": round(c.prob, 3)} for c in cands[1:4]],
        "tuning_cents": round(f.tuning_cents, 1),
        "duration": round(f.duration, 2),
        "engine": used,
        "engines": {"essentia": {p: v["label"] for p, v in essentia_keys(chroma, ESSENTIA_PROFILES).items()}},
        "segments": segments,
    }


def _segments(f: Features, fusion, cnn, max_tier: int) -> list[dict]:
    """Key changes over time (timeline.py); each section also gets its parent key."""
    from .timeline import timeline

    segs = timeline(f, fusion, cnn, max_tier=max_tier)
    for s in segs:
        if s.get("key"):
            s["parent"] = parent_label(s["key"]["tonic"], s["key"]["scale"])
    return segs


def analyse(path: str | Path, **kwargs) -> dict:
    return analyse_features(extract(path), **kwargs)
