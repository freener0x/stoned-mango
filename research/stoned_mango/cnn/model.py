"""The key CNN (PyTorch). Needs torch; inference in the app uses the ONNX export.

1. Small 3x3 convolutions over the log-frequency spectrogram learn local
   patterns (notes, harmonics, chords), as in Korzeniowski & Widmer (2018).
2. The frequency axis is folded into one octave: 24 bins per octave, so
   bin 2t is pitch class t (C = 0), whatever octave it sounded in.
3. A circular convolution around that 24-bin circle scores every scale at
   every rotation with the *same* weights: a learned template matcher. The
   output at rotation t is the score for "tonic t, scale s", so the network
   is transposition-equivariant by construction and the tonic and scale are
   decided jointly.

The network is fully convolutional in time: averaging frame outputs gives the
song's key, averaging a window gives that window's key (timeline).

    input  spec    [batch, 1, frames, 105]
    output logits  [batch, 12 * S, frames / 4]     index = scale * 12 + tonic
"""

from __future__ import annotations

import torch
from torch import nn

from ..features import LOGSPEC_BANDS, LOGSPEC_BANDS_PER_OCTAVE
from .labels import scale_ids

OCTAVE = LOGSPEC_BANDS_PER_OCTAVE  # 24
# Fold only whole octaves (bands 0-95, C2 up to C6) so every pitch class gets the same
# number of contributions; the top 9 bands still inform the convolutions below them.
FOLDED_OCTAVES = LOGSPEC_BANDS // OCTAVE  # 4


def _block(c_in: int, c_out: int, n: int) -> list[nn.Module]:
    layers: list[nn.Module] = []
    for i in range(n):
        layers += [nn.Conv2d(c_in if i == 0 else c_out, c_out, 3, padding=1), nn.BatchNorm2d(c_out), nn.ELU()]
    return layers


class KeyNet(nn.Module):
    def __init__(self, width: int = 16, dense: int = 64, dropout: float = 0.3, max_tier: int = 2):
        super().__init__()
        self.config = {"width": width, "dense": dense, "dropout": dropout, "max_tier": max_tier}
        self.n_scales = len(scale_ids(max_tier))
        self.features = nn.Sequential(
            *_block(1, width, 5),
            nn.MaxPool2d((2, 1)),  # halve time, keep every frequency band
            nn.Dropout(dropout / 2),
            *_block(width, 2 * width, 2),
            nn.MaxPool2d((2, 1)),
            nn.Dropout(dropout / 2),
        )
        # Circular convolution over the folded octave: the kernel spans all 24 bins.
        self.circular = nn.Sequential(nn.Conv2d(2 * width, dense, (1, OCTAVE)), nn.BatchNorm2d(dense), nn.ELU(),
                                      nn.Dropout(dropout))
        self.head = nn.Conv2d(dense, self.n_scales, 1)
        # Read each tonic from bins 2t-1, 2t, 2t+1 (tolerates up to a quarter tone of detuning).
        self.tonic_pool = nn.MaxPool2d((1, 3), stride=(1, 2))

    def forward(self, spec: torch.Tensor) -> torch.Tensor:
        x = self.features(spec)  # [B, C, T, 105]
        b, c, t, _ = x.shape
        x = x[..., : FOLDED_OCTAVES * OCTAVE].reshape(b, c, t, FOLDED_OCTAVES, OCTAVE).sum(dim=3)  # [B, C, T, 24], bin 0 = C
        x = torch.cat([x, x[..., : OCTAVE - 1]], dim=3)  # circular padding
        x = self.head(self.circular(x))  # [B, S, T, 24]
        x = torch.cat([x[..., -1:], x], dim=3)  # bin -1 in front, for the 3-bin tonic window
        x = self.tonic_pool(x)  # [B, S, T, 12]
        return x.permute(0, 1, 3, 2).reshape(b, self.n_scales * 12, t)  # index = scale * 12 + tonic


def pooled(logits: torch.Tensor) -> torch.Tensor:
    """Song-level logits: the mean over frames."""
    return logits.mean(dim=2)
