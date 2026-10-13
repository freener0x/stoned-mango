import numpy as np
import pytest

from stoned_mango.synth import SR, Piece, Section, render


@pytest.fixture(scope="session")
def render_piece():
    """Render a short synthetic piece (cached per session)."""
    cache = {}

    def _render(tonic: int, mode: str, progression: list[int], seconds: float = 16.0, **kw) -> np.ndarray:
        key = (tonic, mode, tuple(progression), seconds, tuple(sorted(kw.items())))
        if key not in cache:
            cache[key] = render(Piece("t", [Section(tonic, mode, progression, 8)], **kw), seconds, seed=7)
        return cache[key]

    return _render


@pytest.fixture
def sr() -> int:
    return SR
