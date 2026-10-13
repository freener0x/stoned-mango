"""Run an exported key CNN with onnxruntime (no PyTorch needed).

A model is a pair of files: ``<name>.onnx`` and its model card ``<name>.json``
(scale order, feature settings, licence, training summary), written by
``stoned_mango.cnn.export``.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from ..engines import Candidate

TIME_DOWNSAMPLE = 4
MIN_FRAMES = 8


def _log_softmax(x: np.ndarray) -> np.ndarray:
    x = x - x.max()
    return x - np.log(np.exp(x).sum())


class CnnEngine:
    def __init__(self, model_path: str | Path):
        import onnxruntime as ort

        self.path = Path(model_path)
        self.card = json.loads(self.path.with_suffix(".json").read_text())
        self.scales: list[str] = self.card["outputs"]["scales"]
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1  # evaluation runs many files; parallelise across files instead
        self.session = ort.InferenceSession(str(self.path), opts, providers=["CPUExecutionProvider"])

    def frame_logits(self, logspec: np.ndarray) -> np.ndarray:
        """[outputs, frames / 4] for a [frames, 105] log-spectrogram."""
        x = np.asarray(logspec, np.float32)
        if len(x) < MIN_FRAMES:
            x = np.concatenate([x, np.zeros((MIN_FRAMES - len(x), x.shape[1]), np.float32)])
        (out,) = self.session.run(None, {"spec": x[None, None]})
        return out[0]

    def log_probs(self, logspec: np.ndarray, start: int = 0, stop: int | None = None) -> np.ndarray:
        """Log-probabilities over all (scale, tonic) pairs, index ``scale * 12 + tonic``.

        ``start``/``stop`` are input frames, for scoring a window (timeline).
        """
        logits = self.frame_logits(logspec)
        a = start // TIME_DOWNSAMPLE
        b = logits.shape[1] if stop is None else max(a + 1, -(-stop // TIME_DOWNSAMPLE))
        return _log_softmax(logits[:, a:b].mean(axis=1))

    def candidates(self, logspec: np.ndarray, start: int = 0, stop: int | None = None) -> list[Candidate]:
        """(tonic, scale) candidates, best first."""
        lp = self.log_probs(logspec, start, stop)
        out = [Candidate(tonic, sid, float(lp[si * 12 + tonic]))
               for si, sid in enumerate(self.scales) for tonic in range(12)]
        out.sort(key=lambda c: -c.score)
        scores = np.array([c.score for c in out])
        p = np.exp(scores - scores[0])
        p /= p.sum()
        for c, pi in zip(out, p):
            c.prob = float(pi)
        return out
