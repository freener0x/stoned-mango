"""Streaming audio input: read a file in chunks, downmix to mono, halve the rate.

Nothing here ever holds a whole song in memory, which is the design the
browser engine follows too (PLAN.md section 3, stage [1]). Every step is a
small stateful object with a ``push(chunk)`` method, so the TypeScript port
is a line-by-line translation.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import numpy as np
import soundfile as sf

# Formats libsndfile (>= 1.1) streams natively. Anything else falls back to a
# whole-file decode through Essentia, like decodeAudioData in the browser.
STREAMABLE = {".wav", ".wave", ".flac", ".ogg", ".oga", ".mp3", ".aiff", ".aif"}
AUDIO_EXTENSIONS = STREAMABLE | {".m4a", ".aac", ".opus", ".wma"}

# Analysis runs at 16-32 kHz: key detection needs nothing above ~5 kHz.
MAX_ANALYSIS_RATE = 32000


def halfband_taps(n_taps: int = 63) -> np.ndarray:
    """Hamming-windowed sinc low-pass at 0.45x the output Nyquist, for decimation by 2.

    Written out rather than taken from scipy.signal.firwin so the browser can
    compute the identical taps.
    """
    m = (n_taps - 1) / 2
    k = np.arange(n_taps) - m
    fc = 0.225  # cycles per input sample; output Nyquist is 0.25
    h = 2 * fc * np.sinc(2 * fc * k) * (0.54 - 0.46 * np.cos(2 * np.pi * np.arange(n_taps) / (n_taps - 1)))
    return (h / h.sum()).astype(np.float64)


class Decimator:
    """Low-pass and keep every other sample, across chunk boundaries."""

    def __init__(self, n_taps: int = 63):
        self.taps = halfband_taps(n_taps)
        self._history = np.zeros(n_taps - 1)
        self._position = 0  # absolute index of the next input sample

    def push(self, x: np.ndarray) -> np.ndarray:
        if len(x) == 0:
            return np.zeros(0, np.float32)
        ext = np.concatenate([self._history, x.astype(np.float64)])
        filtered = np.convolve(ext, self.taps, mode="valid")  # one output per input sample
        first_even = self._position % 2  # offset of the first even absolute index in this chunk
        out = filtered[first_even::2]
        self._history = ext[-(len(self.taps) - 1):]
        self._position += len(x)
        return out.astype(np.float32)


class Resampler:
    """Chains decimators until the rate is at most MAX_ANALYSIS_RATE (44.1k -> 22.05k, 96k -> 24k)."""

    def __init__(self, input_rate: int):
        self.stages: list[Decimator] = []
        rate = input_rate
        while rate > MAX_ANALYSIS_RATE:
            self.stages.append(Decimator())
            rate //= 2
        self.output_rate = rate

    def push(self, x: np.ndarray) -> np.ndarray:
        for stage in self.stages:
            x = stage.push(x)
        return x


def stream(path: str | Path, block_seconds: float = 10.0) -> tuple[int, Iterator[np.ndarray]]:
    """Returns (sample_rate, iterator of mono float32 chunks) for ``path``."""
    path = Path(path)
    if path.suffix.lower() in STREAMABLE:
        try:
            info = sf.info(str(path))
        except RuntimeError:
            info = None
        if info is not None:
            block = max(1024, int(block_seconds * info.samplerate))

            def chunks() -> Iterator[np.ndarray]:
                for b in sf.blocks(str(path), blocksize=block, dtype="float32", always_2d=True):
                    yield b.mean(axis=1)

            return info.samplerate, chunks()
    return _whole_file(path)


def _whole_file(path: Path) -> tuple[int, Iterator[np.ndarray]]:
    import essentia.standard as es

    audio, rate, channels, *_ = es.AudioLoader(filename=str(path))()
    mono = audio.mean(axis=1).astype(np.float32) if channels > 1 else audio[:, 0].astype(np.float32)
    return int(rate), iter([mono])
