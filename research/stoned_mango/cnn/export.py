"""Export a trained key CNN to ONNX (fp32 and int8) with its model card.

    python -m stoned_mango.cnn.export runs/NAME/best.pt --calibration CACHE_DIR [--out ../web/public/models]

Writes ``key-cnn.fp32.onnx``, ``key-cnn.int8.onnx`` and a model card
``.json`` next to each. Checks that ONNX matches PyTorch, and reports how much
int8 quantisation changes the answers on the calibration songs. The app ships
fp32 unless int8 agrees on at least 99% of songs: at ~300 KB the fp32 model is
already small next to ONNX Runtime itself.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from ..features import FRAME_SIZE, HOP_SIZE, LOGSPEC_BANDS, LOGSPEC_BANDS_PER_OCTAVE, LOGSPEC_FMIN
from .data import load_cache
from .engine import CnnEngine
from .labels import scale_ids
from .model import KeyNet

LICENSE = "CC-BY-SA-4.0"


def to_onnx(model: KeyNet, path: Path) -> None:
    model.eval()
    dummy = torch.randn(1, 1, 64, LOGSPEC_BANDS)
    kwargs = dict(input_names=["spec"], output_names=["logits"], opset_version=17)
    try:
        torch.onnx.export(model, (dummy,), str(path), dynamic_axes={"spec": {2: "frames"}, "logits": {2: "out_frames"}},
                          dynamo=False, **kwargs)
    except (TypeError, RuntimeError):  # newer torch without the TorchScript exporter
        frames = torch.export.Dim("frames", min=8, max=200_000)
        torch.onnx.export(model, (dummy,), str(path), dynamic_shapes={"spec": {2: frames}}, dynamo=True, **kwargs)


def model_card(ckpt: dict, extra: dict) -> dict:
    return {
        "format": 1,
        "license": LICENSE,
        "inputs": {
            "name": "spec", "shape": ["batch", 1, "frames", LOGSPEC_BANDS],
            "transform": "log1p(triangular log-frequency filterbank @ |STFT|)",
            "bands": LOGSPEC_BANDS, "fmin_hz": LOGSPEC_FMIN, "bands_per_octave": LOGSPEC_BANDS_PER_OCTAVE,
            "frame_size": FRAME_SIZE, "hop_size": HOP_SIZE, "window": "blackmanharris62 (normalized)",
            "sample_rate": "input halved until <= 32 kHz (22.05 kHz for 44.1 kHz audio)",
        },
        "outputs": {
            "name": "logits", "shape": ["batch", "12 * scales", "frames / 4"],
            "index": "scale_index * 12 + tonic (tonic 0 = C); song logits = mean over frames, then softmax",
            "scales": scale_ids(ckpt["config"]["max_tier"]),
            "time_downsample": 4,
        },
        "architecture": ckpt["config"],
        "training": {"epoch": ckpt["epoch"], "validation": ckpt["val"], "args": ckpt.get("args", {})},
    } | extra


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint", type=Path)
    ap.add_argument("--calibration", type=Path, nargs="+", required=True, help="feature caches for int8 calibration")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[3] / "web" / "public" / "models")
    ap.add_argument("--name", default="key-cnn")
    ap.add_argument("--calibration-songs", type=int, default=64)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model = KeyNet(**ckpt["config"])
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    rng = np.random.default_rng(0)
    songs = [e for root in args.calibration for e in load_cache(root)]
    songs = [songs[i] for i in rng.permutation(len(songs))[: args.calibration_songs]]
    if not songs:
        raise SystemExit("calibration caches are empty")

    fp32 = args.out / f"{args.name}.fp32.onnx"
    int8 = args.out / f"{args.name}.int8.onnx"
    to_onnx(model, fp32)

    # 1. ONNX fp32 must match PyTorch.
    import onnxruntime as ort

    sess = ort.InferenceSession(str(fp32), providers=["CPUExecutionProvider"])
    max_diff = 0.0
    for ex in songs[:8]:
        x = ex.logspec.astype(np.float32)[None, None]
        with torch.no_grad():
            ref = model(torch.from_numpy(x)).numpy()
        (got,) = sess.run(None, {"spec": x})
        max_diff = max(max_diff, float(np.abs(ref - got).max()))
    if max_diff > 1e-3:
        raise SystemExit(f"ONNX output differs from PyTorch by {max_diff:.2e}")

    # 2. int8: static QDQ quantisation calibrated on real features.
    from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static

    class Reader(CalibrationDataReader):
        def __init__(self):
            self._it = iter({"spec": ex.logspec[:512].astype(np.float32)[None, None]} for ex in songs)

        def get_next(self):
            return next(self._it, None)

    from onnxruntime.quantization.shape_inference import quant_pre_process

    prepped = int8.with_suffix(".prep.onnx")
    quant_pre_process(str(fp32), str(prepped))
    quantize_static(str(prepped), str(int8), Reader(), quant_format=QuantFormat.QDQ,
                    activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8, per_channel=True)

    prepped.unlink()
    base = {"onnx_vs_torch_max_abs_diff": max_diff}
    for path in (fp32, int8):
        path.with_suffix(".json").write_text(json.dumps(model_card(ckpt, base), indent=1))
    e32, e8 = CnnEngine(fp32), CnnEngine(int8)
    agree = np.mean([e32.candidates(ex.logspec)[0].label == e8.candidates(ex.logspec)[0].label for ex in songs])
    for path in (fp32, int8):
        card = json.loads(path.with_suffix(".json").read_text())
        card["int8_top1_agreement_with_fp32"] = round(float(agree), 4)
        card["bytes"] = path.stat().st_size
        path.with_suffix(".json").write_text(json.dumps(card, indent=1))
    print(f"fp32 {fp32.stat().st_size / 1024:.0f} KiB (ONNX vs torch max diff {max_diff:.1e}); "
          f"int8 {int8.stat().st_size / 1024:.0f} KiB, top-1 agreement with fp32 {agree:.1%} on {len(songs)} songs")


if __name__ == "__main__":
    main()
