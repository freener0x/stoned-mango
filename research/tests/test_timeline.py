"""Phase 4: the key-changes timeline."""

import numpy as np
import pytest
import soundfile as sf

from stoned_mango import analysis, cli
from stoned_mango.cnn.labels import scale_ids
from stoned_mango.features import extract_array
from stoned_mango.synth import Piece, Section, render
from stoned_mango.timeline import (Segment, merge_short, segment_path, timeline, transition_costs, viterbi,
                                   windows)
from stoned_mango.timeline_eval import score_song

IDS = scale_ids()


def state(tonic, scale):
    return IDS.index(scale) * 12 + tonic


def test_transition_costs_follow_shared_notes():
    cost = transition_costs(6.0, 1.0)
    c_major = state(0, "ionian")
    assert cost[c_major, c_major] == 0
    assert cost[c_major, state(9, "aeolian")] == 6.0  # relative minor: same notes
    assert cost[c_major, state(2, "dorian")] == 6.0  # a mode of the same notes
    assert cost[c_major, state(7, "ionian")] == 8.0  # a fifth up: F -> F#
    assert cost[c_major, state(0, "aeolian")] == 12.0  # parallel minor: E, A, B flattened
    assert cost[c_major, state(6, "ionian")] > cost[c_major, state(7, "ionian")]  # tritone is further


def test_viterbi_switches_only_when_worth_it():
    n = 12 * len(IDS)
    em = np.full((10, n), -10.0)
    a, b = state(0, "ionian"), state(7, "ionian")
    em[:5, a] = 0.0
    em[5:, b] = 0.0
    em[2, b] = 1.0  # one stray window prefers the other key a little
    path = viterbi(em, transition_costs(6.0, 1.0))
    assert list(path) == [a] * 5 + [b] * 5


def test_merge_short_and_segment_path():
    cost = transition_costs(6.0, 1.0)
    a, b, c = state(0, "ionian"), state(9, "aeolian"), state(7, "ionian")
    segs = [Segment(0, 30, a), Segment(30, 35, c), Segment(35, 60, a), Segment(60, 90, b)]
    merged = merge_short(segs, 10.0, cost)
    assert [(s.start, s.end, s.state) for s in merged] == [(0, 60, a), (60, 90, b)]


def _features(sections, seed=3):
    return extract_array(render(Piece("t", [Section(*s) for s in sections]), seed=seed), 44100)


def test_windows_cover_the_song():
    f = _features([(0, "ionian", [1, 4, 5, 1], 12)])
    bounds = windows(f)
    assert bounds[0][0] == 0 and bounds[-1][1] == f.frames
    short = extract_array(np.zeros(44100 * 3, np.float32), 44100)
    assert windows(short) == [(0, short.frames)]
    path = np.array([0] * len(bounds))
    assert [(s.start, s.end) for s in segment_path(f, bounds, path)] == [(0.0, f.duration)]


def test_score_song():
    ref = [{"start": 0, "end": 30, "tonic": 0, "scale": "ionian"}, {"start": 30, "end": 60, "tonic": 7, "scale": "ionian"}]
    est = [{"start": 0, "end": 31.5, "key": {"tonic": 0, "scale": "ionian"}},
           {"start": 31.5, "end": 60, "key": {"tonic": 4, "scale": "aeolian"}}]
    m = score_song(ref, est)
    assert m["boundary_f"] == 1.0 and m["found"] == [True]
    assert m["key_time"] == pytest.approx(0.5, abs=0.01)
    assert m["notes_time"] == pytest.approx(0.975, abs=0.01)  # E minor shares G major's notes
    assert score_song(ref, [{"start": 0, "end": 60, "key": {"tonic": 0, "scale": "ionian"}}])["boundary_f"] == 0.0


needs_cnn = pytest.mark.skipif(analysis.default_cnn() is None, reason="needs the bundled model")


@needs_cnn
def test_modulation_at_30_seconds_is_found_within_3_seconds():
    # PLAN.md section 7: "a synthetic track that modulates at 30 s must show a segment boundary within +/-3 s".
    f = _features([(0, "ionian", [1, 4, 5, 1], 15), (7, "ionian", [1, 4, 5, 1], 15)])  # 120 BPM: 15 bars = 30 s
    segs = timeline(f, analysis.default_fusion(), analysis.default_cnn())
    assert len(segs) == 2
    assert abs(segs[1]["start"] - 30.0) <= 3.0
    assert segs[0]["label"] == "C major" and segs[1]["label"] == "G major"


@needs_cnn
def test_single_key_song_stays_one_section():
    f = _features([(2, "dorian", [1, 4, 1, 7], 30)])
    segs = timeline(f, analysis.default_fusion(), analysis.default_cnn())
    assert len(segs) == 1 and segs[0]["label"] == "D Dorian"
    assert segs[0]["start"] == 0.0 and segs[0]["end"] == pytest.approx(f.duration, abs=0.01)


def test_template_engine_timeline_works_without_the_cnn():
    f = _features([(0, "ionian", [1, 4, 5, 1], 15), (7, "ionian", [1, 4, 5, 1], 15)])
    segs = timeline(f)
    assert segs and all(s["end"] > s["start"] for s in segs)


@needs_cnn
def test_analysis_and_cli_report_key_changes(tmp_path, capsys):
    audio = render(Piece("t", [Section(0, "ionian", [1, 4, 5, 1], 15), Section(7, "ionian", [1, 4, 5, 1], 15)]), seed=3)
    r = analysis.analyse_features(extract_array(audio, 44100))
    assert len(r["segments"]) == 2 and r["segments"][1]["label"] == "G major" and "parent" in r["segments"][0]
    assert analysis.analyse_features(extract_array(audio, 44100), timeline=False)["segments"] == []
    sf.write(tmp_path / "mod.wav", audio, 44100)
    assert cli.main([str(tmp_path / "mod.wav")]) == 0
    out = capsys.readouterr().out
    assert "key changes: 0:00" in out and "G major" in out
    assert cli.main([str(tmp_path / "mod.wav"), "--format", "csv"]) == 0
    assert "0:00 C major; 0:" in capsys.readouterr().out
