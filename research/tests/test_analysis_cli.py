import json

import numpy as np
import pytest
import soundfile as sf

from stoned_mango import cli
from stoned_mango.analysis import analyse_features
from stoned_mango.features import extract_array


@pytest.mark.parametrize("tonic,mode,prog,expected", [
    (0, "ionian", [1, 4, 5, 1], "C major"),
    (2, "dorian", [1, 4, 1, 7], "D Dorian"),
    (4, "phrygian", [1, 2, 1, 7], "E Phrygian"),
    (7, "mixolydian", [1, 7, 4, 1], "G Mixolydian"),
])
def test_synthetic_pieces(render_piece, sr, tonic, mode, prog, expected):
    r = analyse_features(extract_array(render_piece(tonic, mode, prog), sr), engine="template")
    assert r["label"] == expected


def test_transposed_piece_moves_the_tonic(render_piece, sr):
    base = analyse_features(extract_array(render_piece(2, "dorian", [1, 4, 1, 7]), sr), engine="template")
    up = analyse_features(extract_array(render_piece(7, "dorian", [1, 4, 1, 7]), sr), engine="template")
    assert (up["key"]["tonic"] - base["key"]["tonic"]) % 12 == 5
    assert up["key"]["scale"] == base["key"]["scale"]


def test_detuned_piece_reports_tuning(render_piece, sr):
    r = analyse_features(extract_array(render_piece(9, "aeolian", [1, 4, 5, 1], tuning_cents=30.0), sr), engine="template")
    assert r["tuning_cents"] == pytest.approx(30, abs=3)
    assert r["key"]["tonic"] == 9


def test_silence_is_no_clear_key(sr):
    r = analyse_features(extract_array(np.zeros(sr * 2, np.float32), sr))
    assert r["key"] is None and r["label"] == "No clear key"


def test_cli_json_over_a_folder(tmp_path, render_piece, sr, capsys):
    sub = tmp_path / "set"
    sub.mkdir()
    sf.write(sub / "a.wav", render_piece(2, "dorian", [1, 4, 1, 7]), sr)
    (sub / "notes.txt").write_text("not audio")
    assert cli.main([str(tmp_path), "--format", "json", "--engine", "template"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert [r["label"] for r in out] == ["D Dorian"]
    assert out[0]["parent"] == "same notes as C major"
