"""Phase 3: tonic cues, engine fusion, calibration, ambiguity notes, "No clear key"."""

import json
from pathlib import Path

import numpy as np
import pytest

from stoned_mango import analysis, cli
from stoned_mango.ambiguity import ambiguity
from stoned_mango.cnn.labels import scale_ids, third_mask
from stoned_mango.engines import Candidate
from stoned_mango.features import LOGSPEC_BANDS, extract_array
from stoned_mango.fusion import (FEATURES, Fusion, candidate_features, expected_calibration_error, fit, nll,
                                 target_mask)
from stoned_mango.tonic import TonicCues, frame_chroma, tonic_cues

N = 12 * len(scale_ids())


# ---- tonic cues ------------------------------------------------------------------


def test_frame_chroma_folds_bands_to_pitch_classes():
    spec = np.zeros((3, LOGSPEC_BANDS))
    spec[0, 14] = 1.0  # 7 semitones above C2: G
    spec[1, 24 + 9 * 2] = 1.0  # an octave higher, A
    spec[2, 1] = 1.0  # a quarter tone above C: split C / C#
    ch = frame_chroma(spec)
    assert np.argmax(ch[0]) == 7 and np.argmax(ch[1]) == 9
    assert ch[2, 0] == ch[2, 1] == 0.5


def _notes_spec(frames_pcs):
    spec = np.zeros((len(frames_pcs), LOGSPEC_BANDS))
    for i, pcs in enumerate(frames_pcs):
        for pc in pcs:
            spec[i, 24 + 2 * pc] = 1.0
    return spec


def test_tonic_cues_find_the_ending_and_the_drone():
    # 80 frames of a D drone with changing notes above, ending on A.
    frames = [(2, (i % 5) * 2 + 4) for i in range(80)] + [(9,)] * 20
    cues = tonic_cues(_notes_spec(frames), np.eye(12)[5] * 0.7)
    assert np.argmax(cues.ending) == 9 and cues.ending.max() == 1.0
    assert np.argmax(cues.drone) == 2
    assert np.argmax(cues.bass) == 5 and cues.bass.max() == 1.0
    assert cues.at(14).tolist() == cues.at(2).tolist() == [0.0, cues.ending[2], cues.drone[2]]


def test_tonic_cues_of_silence_are_zero():
    cues = tonic_cues(np.zeros((0, LOGSPEC_BANDS)), np.zeros(12))
    assert not cues.bass.any() and not cues.ending.any() and not cues.drone.any()


# ---- fusion ----------------------------------------------------------------------


def test_candidate_features_layout():
    ids = scale_ids()
    cnn = np.full(N, -30.0)
    cnn[ids.index("dorian") * 12 + 2] = -0.1
    cues = TonicCues(bass=np.eye(12)[2], ending=np.eye(12)[2], drone=np.zeros(12))
    chroma = np.zeros(12)
    chroma[[2, 4, 5, 7, 9, 11, 0]] = 1.0
    f = candidate_features(cnn, chroma, cues)
    assert f.shape == (N, len(FEATURES))
    row = ids.index("dorian") * 12 + 2
    assert f[row, 0] == pytest.approx(-0.1) and f[:, 0].min() == -20.0  # CNN floor
    assert (f[2::12, 2] == 1).all() and f[3::12, 2:].sum() == 0  # cues depend on the tonic only
    assert f[:, 1].max() > 0.5  # template correlations filled in


def test_target_mask():
    ids = scale_ids()
    exact = target_mask(9, "minor", "dorian")
    assert exact.sum() == 1 and exact[ids.index("dorian") * 12 + 9]
    mm = target_mask(9, "minor", None)
    assert mm.sum() == third_mask()[1].sum()
    assert all(i % 12 == 9 for i in np.flatnonzero(mm))
    assert not target_mask(0, None, None).any()


def test_nll_gradient_matches_finite_differences():
    rng = np.random.default_rng(0)
    feats = [rng.normal(size=(N, len(FEATURES))) for _ in range(3)]
    masks = [target_mask(t, "major", None) for t in (0, 5, 7)]
    sw = np.array([0.5, 0.25, 0.25])
    w0 = np.array([1.0, 0, 0, 0, 0])
    w = rng.normal(size=len(FEATURES))
    _, g = nll(w, feats, masks, sw, w0, 1e-2)
    eps = 1e-6
    num = [(nll(w + eps * e, feats, masks, sw, w0, 1e-2)[0] - nll(w - eps * e, feats, masks, sw, w0, 1e-2)[0]) / (2 * eps)
           for e in np.eye(len(FEATURES))]
    assert np.allclose(g, num, atol=1e-5)


def test_fit_learns_an_informative_cue():
    # The CNN is right half the time; the "ending" cue always points at the right tonic.
    rng = np.random.default_rng(1)
    ids = scale_ids()
    feats, masks = [], []
    for i in range(60):
        tonic = int(rng.integers(12))
        right = ids.index("ionian") * 12 + tonic
        f = np.zeros((N, len(FEATURES)))
        f[:, 0] = np.log(np.full(N, 1e-4))
        guess = right if i % 2 else ids.index("aeolian") * 12 + (tonic + 9) % 12
        f[guess, 0] = np.log(0.9)
        f[tonic::12, FEATURES.index("ending")] = 1.0
        feats.append(f)
        masks.append(target_mask(tonic, "major", "ionian"))
    w = dict(zip(FEATURES, fit(feats, masks, np.ones(len(feats)))))
    assert w["ending"] > 1.0
    fused = Fusion(w)
    assert all(m[int(np.argmax(fused.log_probs(f)))] for f, m in zip(feats, masks))


def test_fusion_round_trip_and_candidates(tmp_path):
    fu = Fusion({"cnn": 1.0, "template": 2.0, "ending": 0.5}, no_key_below=0.2, meta={"x": 1})
    fu.save(tmp_path / "f.json")
    doc = json.loads((tmp_path / "f.json").read_text())
    assert doc["features"] == list(FEATURES) and doc["format"] == 1
    back = Fusion.load(tmp_path / "f.json")
    assert back.weights == fu.weights and back.no_key_below == 0.2
    assert back.vector.tolist() == [1.0, 2.0, 0.0, 0.5, 0.0]
    feats = np.random.default_rng(2).normal(size=(N, len(FEATURES)))
    cands = back.candidates(feats)
    assert len(cands) == N and sum(c.prob for c in cands) == pytest.approx(1.0)
    assert [c.score for c in cands] == sorted((c.score for c in cands), reverse=True)


def test_expected_calibration_error():
    assert expected_calibration_error([0.8] * 10, [1] * 8 + [0] * 2) == pytest.approx(0.0)
    assert expected_calibration_error([0.9] * 10, [1] * 5 + [0] * 5) == pytest.approx(0.4)
    assert expected_calibration_error([0.0, 1.0], [0, 1]) == pytest.approx(0.0)


# ---- ambiguity notes ------------------------------------------------------------


def _cands(*spec):
    return [Candidate(t, s, 0.0, p) for t, s, p in spec]


def test_missing_note():
    chroma = np.zeros(12)
    chroma[[9, 11, 0, 2, 4, 7]] = 1.0  # A minor / A Dorian without their 6th (F / F#)
    note = ambiguity(_cands((9, "aeolian", 0.5), (9, "dorian", 0.3), (0, "ionian", 0.1)), chroma)
    assert note["kind"] == "missing_note"
    assert note["text"] == "A minor or A Dorian: the 6th note is barely played"


def test_home_note():
    chroma = np.zeros(12)
    chroma[[0, 2, 4, 5, 7, 9, 11]] = 1.0
    note = ambiguity(_cands((0, "ionian", 0.45), (9, "aeolian", 0.4)), chroma)
    assert note == {"kind": "home_note", "labels": ["C major", "A minor"],
                    "text": "Home note unclear: C major or A minor (same notes)"}


def test_clear_answers_have_no_note():
    chroma = np.zeros(12)
    chroma[[0, 2, 4, 5, 7, 9, 11]] = 1.0
    assert ambiguity(_cands((0, "ionian", 0.9), (9, "aeolian", 0.05)), chroma) is None
    # The runner-up differs in a note that *is* played: no missing-note excuse.
    assert ambiguity(_cands((0, "ionian", 0.5), (0, "lydian", 0.4)), chroma) is None
    assert ambiguity([], chroma) is None


# ---- analysis with fusion -------------------------------------------------------

needs_cnn = pytest.mark.skipif(analysis.default_cnn() is None, reason="needs onnxruntime and the bundled model")


@pytest.fixture
def with_fusion(monkeypatch):
    def use(fu):
        monkeypatch.setattr(analysis, "default_fusion", lambda: fu)
    return use


@needs_cnn
def test_fusion_engine_answers(render_piece, sr, with_fusion):
    with_fusion(Fusion({"cnn": 1.0, "template": 1.0, "bass": 0.5}))
    r = analysis.analyse_features(extract_array(render_piece(2, "dorian", [1, 4, 1, 7]), sr))
    assert r["engine"] == "fusion" and r["label"] == "D Dorian"
    assert "ambiguity" in r and 0 < r["confidence"] <= 1


@needs_cnn
def test_below_the_floor_is_no_clear_key(render_piece, sr, with_fusion, tmp_path, capsys):
    with_fusion(Fusion({"cnn": 1.0}, no_key_below=1.01))
    audio = render_piece(2, "dorian", [1, 4, 1, 7])
    r = analysis.analyse_features(extract_array(audio, sr))
    assert r["key"] is None and r["label"] == "No clear key" and r["best_guess"] == "D Dorian"

    import soundfile as sf

    sf.write(tmp_path / "a.wav", audio, sr)
    assert cli.main([str(tmp_path / "a.wav")]) == 0
    out = capsys.readouterr().out
    assert "No clear key" in out and "best guess: D Dorian" in out


def test_fusion_engine_without_weights_is_an_error(render_piece, sr, with_fusion):
    with_fusion(None)
    if analysis.default_cnn() is None:
        pytest.skip("needs the bundled model")
    with pytest.raises(RuntimeError, match="fusion"):
        analysis.analyse_features(extract_array(render_piece(2, "dorian", [1, 4, 1, 7]), sr), engine="fusion")


def test_cli_prints_ambiguity_notes(tmp_path, capsys, monkeypatch):
    note = {"kind": "home_note", "labels": ["C major", "A minor"], "text": "Home note unclear: C major or A minor (same notes)"}
    monkeypatch.setattr(cli, "analyse", lambda p, **kw: {
        "key": {"tonic": 0, "scale": "ionian", "third": "major"}, "label": "C major", "parent": None,
        "confidence": 0.5, "ambiguity": note, "alternatives": [{"label": "A minor", "score": 0.4}],
        "tuning_cents": 0.0, "duration": 1.0, "engine": "fusion"})
    (tmp_path / "a.wav").write_bytes(b"")
    assert cli.main([str(tmp_path / "a.wav")]) == 0
    assert "note: Home note unclear: C major or A minor (same notes)" in capsys.readouterr().out
    assert cli.main([str(tmp_path / "a.wav"), "--format", "csv"]) == 0
    assert "Home note unclear" in capsys.readouterr().out


# ---- the "No clear key" floor ---------------------------------------------------


def test_keyless_clips():
    from stoned_mango.keyless import clips

    got = list(clips(seconds=2.0, noise=1, drums=2))
    assert [n.split("-")[0] for n, _ in got] == ["white", "pink", "brown", "drums", "drums"]
    assert all(a.dtype == np.float32 and 0 < np.abs(a).max() <= 0.8 for _, a in got)


def test_choose_no_key_below():
    from stoned_mango.fusion import MAX_WITHHELD, NO_KEY_MARGIN, choose_no_key_below

    assert choose_no_key_below([0.1, 0.12], [0.5] * 100) == pytest.approx(0.12 * NO_KEY_MARGIN)
    # Never more than MAX_WITHHELD of the songs lose their answer, even if keyless clips look confident.
    songs = list(np.linspace(0.2, 1.0, 101))
    floor = choose_no_key_below([0.5], songs)
    assert np.mean(np.array(songs) < floor) <= MAX_WITHHELD


PROVISIONAL = Path(__file__).resolve().parents[2] / "docs" / "phase3" / "fusion-synthetic.json"


@needs_cnn
def test_fitted_fusion_says_no_clear_key_for_noise_and_drums(with_fusion):
    from stoned_mango.keyless import clips
    from stoned_mango.synth import SR

    fu = analysis.default_fusion() or Fusion.load(PROVISIONAL)
    with_fusion(fu)
    # A different seed from the clips the floor was chosen on.
    for name, audio in clips(seconds=12.0, seed=123, noise=1, drums=3):
        r = analysis.analyse_features(extract_array(audio, SR))
        assert r["key"] is None and r["label"] == "No clear key", (name, r.get("confidence"))


def test_fusion_summary(tmp_path):
    from stoned_mango.fusion_summary import summary

    Fusion({"cnn": 1.0}, no_key_below=0.2, meta={"fitted_on": {"synthetic:x": 3}}).save(tmp_path / "fusion-a.json")
    metrics = {"weighted": 0.8, "mm_exact": 0.75, "tonic": 0.8, "conf": 0.7, "ece": 0.05, "n": 4}
    (tmp_path / "eval-giantsteps.json").write_text(json.dumps(
        {"n": 4, "overall": {"fusion_fusion-a": metrics, "cnn": metrics | {"weighted": 0.7}, "essentia_edma": metrics}}))
    text = summary(tmp_path)
    assert "no clear key below 0.200" in text and "| Fusion (fusion-a) | 0.800" in text
    assert "| CNN alone | 0.700" in text and "essentia" not in text


def test_key_confidence_sums_the_family():
    from stoned_mango.fusion import key_confidence

    cands = _cands((2, "dorian", 0.4), (2, "aeolian", 0.3), (5, "ionian", 0.2), (2, "ionian", 0.1))
    assert key_confidence(cands) == pytest.approx(0.7)  # D Dorian + D minor; not F major or D major
    assert key_confidence([]) == 0.0


def test_floor_cap_applies_to_each_source():
    from stoned_mango.fusion import choose_no_key_below

    synthetic, real = list(np.linspace(0.5, 1.0, 100)), list(np.linspace(0.1, 1.0, 100))
    assert choose_no_key_below([0.3], synthetic) == pytest.approx(0.45)
    assert choose_no_key_below([0.3], synthetic, real) < 0.13  # real songs are less sure: the floor drops


def test_fit_temperature_undoes_overconfidence():
    from stoned_mango.fusion import fit_temperature

    rng = np.random.default_rng(3)
    w_true = np.array([1.0, 2.0, 0.5, 0.0, 0.5])
    feats, masks = [], []
    for _ in range(300):
        f = rng.normal(size=(N, len(FEATURES)))
        s = f @ w_true
        p = np.exp(s - s.max())
        p /= p.sum()
        m = np.zeros(N, bool)
        m[rng.choice(N, p=p)] = True
        feats.append(f)
        masks.append(m)
    assert fit_temperature(3 * w_true, feats, masks) == pytest.approx(1 / 3, rel=0.15)
