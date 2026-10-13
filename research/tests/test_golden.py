"""The golden files (shared/golden) must match what this engine computes now.

If this fails after a deliberate change (a new model, new fusion weights, a feature
change), regenerate them with `python -m stoned_mango.golden` and commit the result;
the browser engine's parity tests (web/tests/parity.test.ts) then check it against them.
"""

import json

import numpy as np
import pytest

from stoned_mango.analysis import default_cnn
from stoned_mango.golden import GOLDEN, expected

MANIFEST = json.loads((GOLDEN / "manifest.json").read_text())
pytestmark = pytest.mark.skipif(default_cnn() is None, reason="needs the bundled model")


@pytest.mark.parametrize("name", sorted(MANIFEST["clips"]))
def test_golden_files_are_current(name):
    stored = json.loads((GOLDEN / f"{name}.json").read_text())
    now = expected(GOLDEN / f"{name}.wav")
    assert now["result"]["label"] == stored["result"]["label"]
    assert [s["label"] for s in now["result"]["segments"]] == [s["label"] for s in stored["result"]["segments"]]
    assert np.allclose(now["features"]["chroma"], stored["features"]["chroma"], atol=1e-6)
    assert np.allclose(now["cnn_log_probs"], stored["cnn_log_probs"], atol=1e-5)
    if "fusion_log_probs" in stored:
        assert np.allclose(now["fusion_log_probs"], stored["fusion_log_probs"], atol=1e-5)
