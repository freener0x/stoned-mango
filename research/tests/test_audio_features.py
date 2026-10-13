import numpy as np
import pytest

from stoned_mango.audio import Decimator, Resampler
from stoned_mango.features import extract_array


def _sine(freq, seconds, sr, cents=0.0):
    t = np.arange(int(seconds * sr)) / sr
    return np.sin(2 * np.pi * freq * 2 ** (cents / 1200) * t).astype(np.float32)


def test_decimator_is_chunk_invariant():
    x = np.random.default_rng(0).standard_normal(50_001).astype(np.float32)
    whole = Decimator().push(x)
    d = Decimator()
    pieces = np.concatenate([d.push(x[i:i + 777]) for i in range(0, len(x), 777)])
    assert len(whole) == len(pieces) == 25_001
    np.testing.assert_allclose(whole, pieces, atol=1e-6)


def test_decimator_passes_pitch_range_and_blocks_aliases():
    sr = 44100
    low = Decimator().push(_sine(1000, 1.0, sr))[500:]
    high = Decimator().push(_sine(15000, 1.0, sr))[500:]
    assert 0.95 < np.abs(low).max() < 1.05
    assert np.abs(high).max() < 0.01  # > 40 dB down


@pytest.mark.parametrize("rate,expected", [(44100, 22050), (48000, 24000), (96000, 24000), (22050, 22050), (16000, 16000)])
def test_resampler_rates(rate, expected):
    assert Resampler(rate).output_rate == expected


def test_features_are_chunk_invariant(render_piece, sr):
    x = render_piece(2, "dorian", [1, 4, 1, 7])
    a = extract_array(x, sr)
    b = extract_array(x, sr, chunk=9_999)
    assert a.frames == b.frames
    np.testing.assert_allclose(a.hpcp, b.hpcp, atol=1e-5)
    assert a.tuning_cents == pytest.approx(b.tuning_cents, abs=1e-6)


@pytest.mark.parametrize("cents", [-35.0, -10.0, 0.0, 20.0, 45.0])
def test_tuning_estimate(cents, sr):
    # A major triad plus octave, detuned as a whole.
    x = sum(_sine(f, 4.0, sr, cents) for f in (220.0, 277.18, 329.63, 440.0)) / 4
    f = extract_array(x, sr)
    assert f.tuning_cents == pytest.approx(cents, abs=3.0)


def test_detuned_chroma_lands_on_the_right_notes(sr):
    x = sum(_sine(f, 4.0, sr, 40.0) for f in (261.63, 329.63, 392.0)) / 3  # C major triad, +40 cents
    chroma = extract_array(x, sr).chroma()
    assert set(np.argsort(-chroma)[:3]) == {0, 4, 7}


def test_silence_has_no_voiced_frames(sr):
    f = extract_array(np.zeros(sr * 3, np.float32), sr)
    assert f.frames > 0 and f.voiced().size == 0
