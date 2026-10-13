"""Engine fusion (phase 3): one calibrated answer from every engine and tonic cue.

Every (tonic, scale) candidate, 12 x 30 = 360 of them, gets a feature vector:

    cnn       the key CNN's log-probability
    template  the phase 1 template engine's correlation score
    bass, ending, drone   the tonic cues of ``tonic.py`` at the candidate's tonic

and a score ``w . f``. A softmax over the 360 scores gives the answer's
probabilities (a conditional-logit model). The weights ``w`` are fitted by
maximising the probability of the right answer, which also *calibrates* them:
a 0.8 should mean right about 80% of the time. Songs with only a major/minor
label count as right for every scale with that third at the labelled tonic.

When real music is given, the fitted weights are then all scaled by one factor
(a "temperature") that makes the confidence honest on the real songs alone.
Scaling never changes an answer, only how sure it sounds; real music is what
people upload, so its calibration comes first.

    python -m stoned_mango.fusion fit --synthetic CACHE [--real CACHE] --out ../shared/fusion.json

The weights live in shared/fusion.json, read by Python now and by the browser later.

The fit also sets ``no_key_below``, the "No clear key" floor: a margin above the
most confident answer given to audio with no key (noise, drum loops;
keyless.py), capped so that at most ``MAX_WITHHELD`` of the fitting songs of
*each* source (synthetic, real) lose their answer. The floor applies to the *key* confidence (``key_confidence``:
home note plus major/minor family), not to the exact mode, because real music
often spreads its probability over close modes of one clear key.

    python -m stoned_mango.fusion floor WEIGHTS.json --synthetic CACHE --out OUT.json   # re-choose the floor only
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

from .cnn.labels import scale_ids, third_mask
from .engines import Candidate, score_scales
from .scales import library
from .tonic import CUES, TonicCues, tonic_cues

FEATURES = ("cnn", "template") + CUES
FUSION_JSON = Path(__file__).resolve().parents[2] / "shared" / "fusion.json"
CNN_FLOOR = -20.0  # log-probabilities below this carry no extra information
NO_KEY_MARGIN = 1.5  # the floor sits 50% above the most confident keyless clip
MAX_WITHHELD = 0.02  # ... but never withholds more than 2% of the fitting songs


@dataclass
class Fusion:
    weights: dict[str, float]
    no_key_below: float = 0.0  # top probability under which the answer is "No clear key"
    meta: dict = field(default_factory=dict)

    @property
    def vector(self) -> np.ndarray:
        return np.array([self.weights.get(f, 0.0) for f in FEATURES])

    @classmethod
    def load(cls, path: Path = FUSION_JSON) -> "Fusion":
        d = json.loads(Path(path).read_text())
        return cls(weights=d["weights"], no_key_below=d.get("no_key_below", 0.0), meta=d.get("meta", {}))

    def save(self, path: Path = FUSION_JSON) -> None:
        doc = {"$comment": "Engine-fusion weights, fitted by `python -m stoned_mango.fusion fit`. See fusion.py.",
               "format": 1, "features": list(FEATURES), "weights": self.weights,
               "no_key_below": self.no_key_below, "meta": self.meta}
        Path(path).write_text(json.dumps(doc, indent=1) + "\n")

    def log_probs(self, feats: np.ndarray) -> np.ndarray:
        s = feats @ self.vector
        s -= s.max()
        return s - np.log(np.exp(s).sum())

    def candidates(self, feats: np.ndarray, max_tier: int = 2) -> list[Candidate]:
        lp = self.log_probs(feats)
        ids = scale_ids()
        out = [Candidate(t, ids[s], float(lp[s * 12 + t]), float(np.exp(lp[s * 12 + t])))
               for s in range(len(ids)) for t in range(12)]
        return sorted(out, key=lambda c: -c.score)


def key_confidence(cands: list[Candidate]) -> float:
    """Probability that the best answer's home note and major/minor family are right
    (its own probability plus that of every scale with the same tonic and third)."""
    if not cands:
        return 0.0
    lib = library()
    best = cands[0]
    third = lib[best.scale].third
    return float(sum(c.prob for c in cands if c.tonic == best.tonic and lib[c.scale].third == third))


def candidate_features(cnn_lp: np.ndarray | None, chroma: np.ndarray, cues: TonicCues) -> np.ndarray:
    """[360, len(FEATURES)] feature matrix, row ``scale * 12 + tonic``."""
    ids = scale_ids()
    n = 12 * len(ids)
    f = np.zeros((n, len(FEATURES)))
    if cnn_lp is not None:
        f[:, 0] = np.maximum(cnn_lp, CNN_FLOOR)
    index = {sid: i for i, sid in enumerate(ids)}
    for c in score_scales(chroma, max_tier=2):
        f[index[c.scale] * 12 + c.tonic, 1] = c.score
    for t in range(12):
        f[t::12, 2:] = cues.at(t)  # same cue values for every scale at tonic t
    return f


def song_features(logspec: np.ndarray, chroma: np.ndarray, bass: np.ndarray, cnn=None) -> np.ndarray:
    if cnn is not None and list(cnn.scales) != list(scale_ids()):
        raise ValueError(f"{cnn.path.name} orders its scales differently from shared/scales.json")
    cnn_lp = cnn.log_probs(logspec) if cnn is not None else None
    return candidate_features(cnn_lp, chroma, tonic_cues(logspec, bass))


# ---- fitting ------------------------------------------------------------------


def target_mask(tonic: int, third: str | None, scale: str | None) -> np.ndarray:
    """Which of the 360 candidates count as correct for this label."""
    ids = scale_ids()
    mask = np.zeros(12 * len(ids), bool)
    if scale is not None and scale in ids:
        mask[ids.index(scale) * 12 + tonic] = True
    elif third in ("major", "minor"):
        for s in np.flatnonzero(third_mask()[0 if third == "major" else 1]):
            mask[s * 12 + tonic] = True
    return mask


def nll(w: np.ndarray, feats: list[np.ndarray], masks: list[np.ndarray], weights: np.ndarray,
        w0: np.ndarray, l2: float) -> tuple[float, np.ndarray]:
    """Weighted mean negative log-likelihood of the correct set, and its gradient."""
    total, grad = 0.0, np.zeros_like(w)
    for f, m, sw in zip(feats, masks, weights):
        s = f @ w
        s -= s.max()
        p = np.exp(s)
        z = p.sum()
        zm = p[m].sum()
        total += sw * (np.log(z) - np.log(zm))
        grad += sw * ((p @ f) / z - (p[m] @ f[m]) / zm)
    d = w - w0
    return total + l2 * float(d @ d), grad + 2 * l2 * d


def fit(feats: list[np.ndarray], masks: list[np.ndarray], sample_weights: np.ndarray,
        w0: np.ndarray | None = None, l2: float = 1e-3) -> np.ndarray:
    w0 = np.array([1.0] + [0.0] * (len(FEATURES) - 1)) if w0 is None else w0
    sw = sample_weights / sample_weights.sum()
    # Every feature is evidence *for* a candidate, so no weight may go negative. Training
    # clips are cut mid-song (Beatport previews, songgen), which can make a cue such as
    # "ending" look anti-correlated there while it points home in full-length songs.
    res = minimize(nll, w0.copy(), args=(feats, masks, sw, w0, l2), jac=True, method="L-BFGS-B",
                   bounds=[(0.0, None)] * len(w0))
    return res.x


def fit_temperature(w: np.ndarray, feats: list[np.ndarray], masks: list[np.ndarray]) -> float:
    """The factor t for which weights ``t * w`` give these songs the best likelihood."""
    from scipy.optimize import minimize_scalar

    sw = np.full(len(feats), 1.0 / max(1, len(feats)))
    res = minimize_scalar(lambda t: nll(t * w, feats, masks, sw, w, 0.0)[0], bounds=(0.05, 5.0), method="bounded")
    return float(res.x)


def expected_calibration_error(conf: np.ndarray, correct: np.ndarray, bins: int = 10) -> float:
    conf, correct = np.asarray(conf, float), np.asarray(correct, float)
    edges = np.linspace(0, 1, bins + 1)
    ece = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (conf > lo) & (conf <= hi) if lo > 0 else (conf >= lo) & (conf <= hi)
        if sel.any():
            ece += sel.mean() * abs(conf[sel].mean() - correct[sel].mean())
    return float(ece)


def keyless_confidences(fusion: Fusion, cnn) -> dict[str, float]:
    """The fusion's key confidence for each keyless clip (keyless.py); silent clips are skipped."""
    from .features import extract_array
    from .keyless import clips
    from .synth import SR

    out = {}
    for name, audio in clips():
        f = extract_array(audio, SR)
        chroma = f.chroma()
        if f.voiced().size and chroma.max() > 0:
            out[name] = key_confidence(fusion.candidates(song_features(f.logspec, chroma, f.chroma(bass=True), cnn)))
    return out


def choose_no_key_below(keyless: list[float], *sources: list[float]) -> float:
    """A margin above the keyless clips, lowered until no source of songs loses more than
    MAX_WITHHELD of its answers."""
    floor = NO_KEY_MARGIN * max(keyless, default=0.0)
    for songs in sources:
        if len(songs):
            floor = min(floor, float(np.quantile(songs, MAX_WITHHELD)))
    return round(floor, 3)


def load_songs(root: Path, cnn, val_only: bool = False) -> tuple[list[np.ndarray], list[np.ndarray], list[dict]]:
    """Features and target masks for every song in a feature cache.

    ``val_only`` keeps only the validation split that CNN training held out
    (same deterministic split as ``cnn.train``), so the fusion never learns
    from songs the CNN has memorised.
    """
    from .cnn.data import split

    paths = sorted(Path(root).glob("*.npz"))
    if val_only:
        _, paths = split(paths, 0.1, 0)
    feats, masks, labels = [], [], []
    for p in paths:
        with np.load(p) as z:
            lab = json.loads(str(z["labels"]))
            feats.append(song_features(z["logspec"].astype(np.float32), z["chroma"], z["bass"], cnn))
        masks.append(target_mask(lab["tonic"], lab.get("third"), lab.get("scale")))
        labels.append(lab)
    return feats, masks, labels


def _confidence(fusion: Fusion, feats: np.ndarray, label: dict) -> float:
    """What the answer's probability should be compared with: the exact scale when the
    label has one, else the home note + major/minor family (``key_confidence``)."""
    return float(np.exp(fusion.log_probs(feats).max())) if label.get("scale") else key_confidence(fusion.candidates(feats))


def set_floor(fusion: Fusion, cnn, feats: list[np.ndarray], sources: list[str]) -> None:
    """Choose ``no_key_below`` from the keyless clips and each source's key confidences."""
    keyless = keyless_confidences(fusion, cnn)
    songs = np.array([key_confidence(fusion.candidates(x)) for x in feats])
    by_source = {s: songs[[i for i, t in enumerate(sources) if t == s]] for s in dict.fromkeys(sources)}
    fusion.no_key_below = choose_no_key_below(list(keyless.values()), *by_source.values())
    fusion.meta["keyless_max"] = round(max(keyless.values(), default=0.0), 4)
    fusion.meta["withheld"] = {s: round(float((v < fusion.no_key_below).mean()), 4) for s, v in by_source.items()}
    fusion.meta["floor_on"] = "key_confidence"


def _load_groups(args, cnn):
    groups = [(r, "synthetic", False) for r in args.synthetic] + [(r, "real", True) for r in args.real]
    feats, masks, labels, sw, sources, summary = [], [], [], [], [], {}
    for root, kind, val_only in groups:
        fs, ms, ls = load_songs(root, cnn, val_only)
        feats += fs
        masks += ms
        labels += ls
        sources += [f"{kind}:{root.name}"] * len(fs)
        sw += [1.0 / max(1, len(fs))] * len(fs)  # each source counts equally, whatever its size
        summary[f"{kind}:{root.name}"] = len(fs)
        print(f"{kind} {root}: {len(fs)} songs")
    return feats, masks, labels, np.array(sw), sources, summary


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fit", help="fit fusion weights on feature caches")
    fl = sub.add_parser("floor", help="re-choose only the No-clear-key floor of a fitted fusion")
    fl.add_argument("weights", type=Path)
    for p in (f, fl):
        p.add_argument("--synthetic", type=Path, nargs="*", default=[], help="songgen --features caches")
        p.add_argument("--real", type=Path, nargs="*", default=[],
                       help="real-music caches (only their CNN-validation split is used)")
        p.add_argument("--model", type=Path, help="key CNN .onnx (default: the bundled model)")
        p.add_argument("--out", type=Path, default=FUSION_JSON)
    f.add_argument("--l2", type=float, default=1e-3)
    args = ap.parse_args()

    from .analysis import default_cnn
    from .cnn.engine import CnnEngine

    cnn = CnnEngine(args.model) if args.model else default_cnn()
    feats, masks, labels, sw, sources, summary = _load_groups(args, cnn)
    if args.cmd == "floor":
        fusion = Fusion.load(args.weights)
        fusion.meta["floor_songs"] = summary
        fusion.meta.pop("withheld_fraction", None)
    else:
        w = fit(feats, masks, sw, l2=args.l2)
        real = [i for i, src in enumerate(sources) if src.startswith("real:")]
        temperature = fit_temperature(w, [feats[i] for i in real], [masks[i] for i in real]) if real else 1.0
        w = w * temperature
        model_id = f"{cnn.path.name} sha256:{hashlib.sha256(cnn.path.read_bytes()).hexdigest()[:16]}" if cnn else None
        fusion = Fusion(weights={k: round(float(v), 5) for k, v in zip(FEATURES, w)},
                        meta={"fitted_on": summary, "model": model_id})
        conf = np.array([_confidence(fusion, x, lab) for x, lab in zip(feats, labels)])
        correct = np.array([m[int(np.argmax(fusion.log_probs(x)))] for x, m in zip(feats, masks)])
        fusion.meta["fit_accuracy"] = round(float(correct.mean()), 4)
        fusion.meta["fit_ece"] = round(expected_calibration_error(conf, correct), 4)
        fusion.meta["real_temperature"] = round(temperature, 4)
        src = np.array(sources)
        fusion.meta["fit_ece_by_source"] = {s: round(expected_calibration_error(conf[src == s], correct[src == s]), 4)
                                            for s in dict.fromkeys(sources)}
        print(json.dumps(fusion.weights), "| fit accuracy", fusion.meta["fit_accuracy"], "ECE", fusion.meta["fit_ece"],
              "| real-music temperature", fusion.meta["real_temperature"], "| ECE by source", fusion.meta["fit_ece_by_source"])
    set_floor(fusion, cnn, feats, sources)
    fusion.save(args.out)
    withheld = ", ".join(f"{s} {v:.1%}" for s, v in fusion.meta["withheld"].items())
    print(f"no clear key below {fusion.no_key_below} (keyless clips up to {fusion.meta['keyless_max']}; "
          f"songs withheld: {withheld})")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
