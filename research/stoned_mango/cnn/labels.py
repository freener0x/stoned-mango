"""Output layout of the key CNN, shared by training, export and inference.

The network emits, per frame, one logit for every (scale, tonic) pair:
index ``scale_index * 12 + tonic`` over the tier 1-2 scales of
shared/scales.json (30 scales -> 360 outputs). Major/minor-only labels are
trained through the marginal: every scale whose third matches.
"""

from __future__ import annotations

import numpy as np

from ..scales import library

THIRDS = ("major", "minor")


def scale_ids(max_tier: int = 2) -> list[str]:
    return [s.id for s in library().values() if s.tier <= max_tier]


def n_outputs(max_tier: int = 2) -> int:
    return 12 * len(scale_ids(max_tier))


def joint_index(scale_index: int, tonic: int) -> int:
    return scale_index * 12 + tonic % 12


def third_mask(max_tier: int = 2) -> np.ndarray:
    """[2, S] booleans: which scales count as major (row 0) or minor (row 1)."""
    lib = library()
    ids = scale_ids(max_tier)
    return np.array([[lib[s].third == t for s in ids] for t in THIRDS])
