"""Checks on the shipped key CNN (web/public/models/key-cnn.fp32.onnx).

A retrained model replaces the file; it must pass these too before it ships.
"""

import json

import pytest

from stoned_mango.analysis import DEFAULT_MODEL, analyse_features, default_cnn, default_fusion
from stoned_mango.cnn.labels import scale_ids
from stoned_mango.features import LOGSPEC_BANDS, LOGSPEC_BANDS_PER_OCTAVE, extract_array

pytestmark = pytest.mark.skipif(default_cnn() is None, reason="needs onnxruntime and the bundled model")


def test_model_card_matches_this_code():
    card = json.loads(DEFAULT_MODEL.with_suffix(".json").read_text())
    assert card["license"] == "CC-BY-SA-4.0"
    assert card["outputs"]["scales"] == scale_ids()
    assert card["inputs"]["bands"] == LOGSPEC_BANDS
    assert card["inputs"]["bands_per_octave"] == LOGSPEC_BANDS_PER_OCTAVE


@pytest.mark.parametrize("tonic,mode,prog,expected", [
    (0, "ionian", [1, 4, 5, 1], "C major"),
    (2, "dorian", [1, 4, 1, 7], "D Dorian"),
    (4, "phrygian", [1, 2, 1, 7], "E Phrygian"),
    (5, "lydian", [1, 2, 1, 5], "F Lydian"),
    (7, "mixolydian", [1, 7, 4, 1], "G Mixolydian"),
    (11, "locrian", [1, 2, 1, 7], "B Locrian"),
])
def test_modes_and_transposition(render_piece, sr, tonic, mode, prog, expected):
    r = analyse_features(extract_array(render_piece(tonic, mode, prog), sr), engine="cnn")
    assert r["label"] == expected and r["engine"] == "cnn"
    up = analyse_features(extract_array(render_piece((tonic + 5) % 12, mode, prog), sr), engine="cnn")
    assert up["key"]["scale"] == r["key"]["scale"]
    assert (up["key"]["tonic"] - r["key"]["tonic"]) % 12 == 5


def test_auto_uses_the_best_engine_available(render_piece, sr):
    want = "fusion" if default_fusion() is not None else "cnn"
    assert analyse_features(extract_array(render_piece(2, "dorian", [1, 4, 1, 7]), sr))["engine"] == want
