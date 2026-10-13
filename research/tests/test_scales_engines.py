import json

import numpy as np
import pytest

from stoned_mango.engines import score_scales, template
from stoned_mango.scales import SCALES_JSON, label, library, parent_label


def test_scales_json_is_well_formed():
    doc = json.loads(SCALES_JSON.read_text())
    ids = [s["id"] for s in doc["scales"]]
    assert len(ids) == len(set(ids))
    for s in doc["scales"]:
        cents = s["cents"]
        assert cents[0] == 0 and cents == sorted(cents) and cents[-1] < 1200, s["id"]
        assert s["tier"] in (1, 2, 3)


def test_mode_of_relationships_are_true_rotations():
    lib = library()
    for s in lib.values():
        if s.mode_of is None:
            continue
        parent = lib[s.mode_of[0]]
        root = parent.semitones[s.mode_of[1] - 1]
        assert tuple(sorted((p - root) % 12 for p in parent.semitones)) == s.semitones, s.id


@pytest.mark.parametrize("tonic,scale,expected", [
    (0, "ionian", "C major"),
    (9, "aeolian", "A minor"),
    (6, "ionian", "Gb major"),
    (6, "aeolian", "F# minor"),
    (3, "aeolian", "Eb minor"),
    (2, "dorian", "D Dorian"),
    (4, "phrygian_dominant", "E Phrygian dominant"),
])
def test_labels(tonic, scale, expected):
    assert label(tonic, scale) == expected


def test_parent_labels():
    assert parent_label(2, "dorian") == "same notes as C major"
    assert parent_label(4, "phrygian_dominant") == "5th mode of A Harmonic minor"
    assert parent_label(0, "ionian") is None


def _asymmetric_scales():
    # Symmetric scales repeat under transposition, so their tonic can't come from the notes alone.
    return [s.id for s in library().values() if s.family != "symmetric" and s.tier <= 2]


@pytest.mark.parametrize("scale_id", _asymmetric_scales())
def test_an_ideal_profile_scores_its_own_scale_first(scale_id):
    t = template(library()[scale_id])
    for tonic in (0, 5, 10):
        best = score_scales(np.roll(t, tonic))[0]
        assert (best.tonic, best.scale) == (tonic, scale_id)


def test_scores_are_transposition_invariant():
    chroma = np.random.default_rng(3).random(12)
    base = score_scales(chroma)
    for k in range(1, 12):
        moved = score_scales(np.roll(chroma, k))
        assert [(c.scale, (c.tonic - k) % 12) for c in moved[:5]] == [(c.scale, c.tonic) for c in base[:5]]
        assert moved[0].score == pytest.approx(base[0].score)
