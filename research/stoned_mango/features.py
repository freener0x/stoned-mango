"""Streaming pitch features: stage [2] tuning and [4] pitch profiles in PLAN.md.

Audio goes in chunk by chunk; per frame we keep only small vectors:

* ``hpcp``: 120-bin pitch profile (10 cents per bin, bin 0 = A at 440 Hz),
  over the whole range. Folded to 12 bins after tuning is known, and kept
  at full resolution for microtonal scales (tier 3).
* ``bass``: the same, restricted to 30-250 Hz. Bass notes are strong
  evidence of the tonic.
* ``rms``: frame loudness, for skipping silence and weighting windows.
* ``logspec``: 105-band log-frequency spectrogram (24 bands per octave from
  C2), the key CNN's input. The filter bank is the same one the browser
  builds in web/src/spike/logfilter.ts.

Tuning is a running, magnitude-weighted circular mean of every spectral
peak's offset from the 12-tone grid, so it needs no second pass.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import essentia
import essentia.standard as es
import numpy as np

from .audio import Resampler, stream

essentia.log.infoActive = False
essentia.log.warningActive = False

FRAME_SIZE = 4096  # ~186 ms at 22.05 kHz
HOP_SIZE = 2048
HPCP_BINS = 120  # 10 cents per bin
BINS_PER_SEMITONE = HPCP_BINS // 12
SILENCE_RMS = 1e-3  # about -60 dBFS

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

LOGSPEC_BANDS = 105
LOGSPEC_FMIN = 65.406  # C2
LOGSPEC_BANDS_PER_OCTAVE = 24


def _round_half_up(x: float) -> int:
    return int(np.floor(x + 0.5))  # JavaScript's Math.round, for browser parity


def log_filterbank(fft_size: int, sample_rate: int) -> np.ndarray:
    """[105, fft_size // 2 + 1] triangular filters centred 1/24 octave apart from C2.

    A band narrower than one FFT bin still covers the nearest bin, so no band is empty.
    Mirrors makeFilterbank() in web/src/spike/logfilter.ts.
    """
    n_bins = fft_size // 2 + 1
    bin_hz = sample_rate / fft_size
    fb = np.zeros((LOGSPEC_BANDS, n_bins))
    for k in range(LOGSPEC_BANDS):
        lo, mid, hi = (LOGSPEC_FMIN * 2 ** ((k + d) / LOGSPEC_BANDS_PER_OCTAVE) / bin_hz for d in (-1, 0, 1))
        start = min(int(np.floor(lo)), _round_half_up(mid))
        end = max(int(np.ceil(hi)), _round_half_up(mid))
        for b in range(start, end + 1):
            w = (b - lo) / (mid - lo) if b <= mid else (hi - b) / (hi - mid)
            if 0 <= b < n_bins:
                fb[k, b] = max(0.0, w)
        if not fb[k].any():
            fb[k, _round_half_up(mid)] = 1.0
    return fb


@dataclass
class Features:
    sample_rate: int  # analysis rate, after decimation
    hop_seconds: float
    duration: float
    hpcp: np.ndarray  # [frames, 120], A-based, reference 440 Hz
    bass: np.ndarray  # [frames, 120]
    rms: np.ndarray  # [frames]
    logspec: np.ndarray  # [frames, 105], log(1 + filtered magnitude)
    tuning_cents: float  # offset of the recording from A=440, in (-50, 50]
    tuning_confidence: float  # 0..1, how concentrated the peak offsets are

    @property
    def frames(self) -> int:
        return len(self.rms)

    def voiced(self, start: int = 0, stop: int | None = None) -> np.ndarray:
        """Indices of non-silent frames in [start, stop)."""
        idx = np.arange(start, self.frames if stop is None else min(stop, self.frames))
        return idx[self.rms[idx] > SILENCE_RMS]

    def profile120(self, bass: bool = False, start: int = 0, stop: int | None = None) -> np.ndarray:
        """Mean 120-bin profile over voiced frames, rotated so bin 0 is C at the recording's tuning."""
        src = self.bass if bass else self.hpcp
        idx = self.voiced(start, stop)
        if len(idx) == 0:
            return np.zeros(HPCP_BINS)
        mean = src[idx].mean(axis=0).astype(np.float64)
        # Undo the detuning (fractional circular shift), then move bin 0 from A to C.
        shifted = _circular_shift(mean, -self.tuning_cents / 10.0)
        return np.roll(shifted, -3 * BINS_PER_SEMITONE)

    def chroma(self, bass: bool = False, start: int = 0, stop: int | None = None) -> np.ndarray:
        """12-bin chroma, C first, tuned: each semitone gathers the bins within +/-50 cents."""
        p = self.profile120(bass, start, stop)
        # Bin j covers cents [10j, 10j+10); semitone s is centred on bin 10s. Bins at +/-5 are
        # shared equally between neighbouring semitones.
        w = np.ones(BINS_PER_SEMITONE + 1)
        w[0] = w[-1] = 0.5
        out = np.zeros(12)
        for s in range(12):
            bins = (np.arange(-BINS_PER_SEMITONE // 2, BINS_PER_SEMITONE // 2 + 1) + s * BINS_PER_SEMITONE) % HPCP_BINS
            out[s] = np.dot(w, p[bins])
        return out


def _circular_shift(v: np.ndarray, shift: float) -> np.ndarray:
    """out[i] = v[i - shift] with linear interpolation, circularly."""
    n = len(v)
    pos = (np.arange(n) - shift) % n
    lo = np.floor(pos).astype(int)
    frac = pos - lo
    return (1 - frac) * v[lo % n] + frac * v[(lo + 1) % n]


class FeatureExtractor:
    """Feed mono chunks at ``input_rate`` with push(); call finish() for the Features."""

    def __init__(self, input_rate: int):
        self.resampler = Resampler(input_rate)
        sr = self.resampler.output_rate
        self.sample_rate = sr
        self._buf = np.zeros(0, np.float32)
        self._frames_emitted = 0
        self._samples_in = 0
        self._hpcp: list[np.ndarray] = []
        self._bass: list[np.ndarray] = []
        self._rms: list[float] = []
        self._logspec: list[np.ndarray] = []
        self._filterbank = log_filterbank(FRAME_SIZE, sr).astype(np.float32)
        self._tuning_vec = 0j
        self._tuning_weight = 0.0

        self._window = es.Windowing(type="blackmanharris62", size=FRAME_SIZE, normalized=True)
        self._spectrum = es.Spectrum(size=FRAME_SIZE)
        self._peaks = es.SpectralPeaks(
            sampleRate=sr, maxPeaks=100, magnitudeThreshold=1e-5, minFrequency=30, maxFrequency=5000, orderBy="magnitude"
        )
        common = dict(sampleRate=sr, size=HPCP_BINS, referenceFrequency=440, weightType="squaredCosine",
                      windowSize=0.5, normalized="unitMax", nonLinear=False, harmonics=0)
        self._hpcp_full = es.HPCP(minFrequency=40, maxFrequency=5000, bandPreset=True, bandSplitFrequency=500, **common)
        self._hpcp_bass = es.HPCP(minFrequency=30, maxFrequency=250, bandPreset=False, **common)

    def push(self, chunk: np.ndarray) -> None:
        x = self.resampler.push(np.asarray(chunk, np.float32))
        self._samples_in += len(x)
        self._buf = np.concatenate([self._buf, x])
        while len(self._buf) >= FRAME_SIZE:
            self._frame(self._buf[:FRAME_SIZE])
            self._buf = self._buf[HOP_SIZE:]

    def finish(self) -> Features:
        # One last zero-padded frame if the tail holds samples no frame has seen yet.
        unseen = len(self._buf) - (FRAME_SIZE - HOP_SIZE if self._frames_emitted else 0)
        if unseen > 0:
            self._frame(np.concatenate([self._buf, np.zeros(FRAME_SIZE - len(self._buf), np.float32)]))
        self._buf = np.zeros(0, np.float32)
        if self._tuning_weight > 0:
            tuning = float(np.angle(self._tuning_vec) * 100 / (2 * np.pi))
            confidence = float(abs(self._tuning_vec) / self._tuning_weight)
        else:
            tuning, confidence = 0.0, 0.0
        empty = np.zeros((0, HPCP_BINS), np.float32)
        return Features(
            sample_rate=self.sample_rate,
            hop_seconds=HOP_SIZE / self.sample_rate,
            duration=self._samples_in / self.sample_rate,
            hpcp=np.array(self._hpcp, np.float32) if self._hpcp else empty,
            bass=np.array(self._bass, np.float32) if self._bass else empty,
            rms=np.array(self._rms, np.float32),
            logspec=np.array(self._logspec, np.float32) if self._logspec else np.zeros((0, LOGSPEC_BANDS), np.float32),
            tuning_cents=tuning if tuning > -50 else tuning + 100,
            tuning_confidence=confidence,
        )

    def _frame(self, frame: np.ndarray) -> None:
        self._frames_emitted += 1
        self._rms.append(float(np.sqrt(np.mean(frame.astype(np.float64) ** 2))))
        spectrum = self._spectrum(self._window(frame))
        self._logspec.append(np.log1p(self._filterbank @ spectrum))
        freqs, mags = self._peaks(spectrum)
        self._hpcp.append(self._hpcp_full(freqs, mags))
        low = freqs <= 250
        self._bass.append(self._hpcp_bass(freqs[low], mags[low]) if low.any() else np.zeros(HPCP_BINS, np.float32))
        # Tuning: each peak's offset from the nearest semitone as a point on a circle.
        mid = (freqs >= 80) & (freqs <= 2000)
        if mid.any():
            cents = 1200 * np.log2(freqs[mid] / 440.0)
            self._tuning_vec += np.sum(mags[mid] * np.exp(2j * np.pi * cents / 100.0))
            self._tuning_weight += float(np.sum(mags[mid]))


def extract(path: str | Path, block_seconds: float = 10.0) -> Features:
    rate, chunks = stream(path, block_seconds)
    fx = FeatureExtractor(rate)
    for chunk in chunks:
        fx.push(chunk)
    return fx.finish()


def extract_array(audio: np.ndarray, rate: int, chunk: int | None = None) -> Features:
    """Features for an in-memory mono signal, optionally fed in ``chunk``-sample pieces."""
    fx = FeatureExtractor(rate)
    step = chunk or len(audio) or 1
    for i in range(0, len(audio), step):
        fx.push(audio[i:i + step])
    return fx.finish()
