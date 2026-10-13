"""Phase 0: build a placeholder key CNN as ONNX (fp32 + int8) for the browser spike.

The weights are random: this model only exists to measure ONNX Runtime Web
speed, memory and int8 support on the kind of network phase 2 will train.
Its shape follows the fully convolutional design of Korzeniowski & Widmer
(2018), made about 2-4x heavier so the timings err on the slow side:

    input  spec    [1, 1, T, 105]   log-frequency spectrogram, 5 frames/s,
                                    24 bins/octave from ~65 Hz (C2)
    5 x conv3x3(16) + ELU, maxpool 2x2
    2 x conv3x3(32) + ELU, maxpool 2x2
    2 x conv3x3(64) + ELU, maxpool 2x2
    conv1x1(24), mean over frequency
    output logits  [1, 24, T/8]    per-frame scores: 12 tonics + 12 scale families

Because the network is fully convolutional, one pass over a whole track gives
frame-level scores; the global key and the timeline windows are both just
averages over those frames, so the timeline costs no extra inference.

Writes, into web/public/spike/ by default:
    key-cnn-placeholder.fp32.onnx, key-cnn-placeholder.int8.onnx,
    golden-input.f32 (raw little-endian float32), golden.json (shapes + outputs)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static

N_BINS = 105
GOLDEN_FRAMES = 200  # 40 s at 5 frames/s
OPSET = 17


def build(seed: int = 0) -> onnx.ModelProto:
    rng = np.random.default_rng(seed)
    nodes, inits = [], []
    x = "spec"
    c_in = 1
    layer = 0

    def conv(x: str, c_in: int, c_out: int, k: int, act: bool) -> str:
        nonlocal layer
        layer += 1
        w = (rng.standard_normal((c_out, c_in, k, k)) * np.sqrt(2.0 / (c_in * k * k))).astype(np.float32)
        b = np.zeros(c_out, np.float32)
        inits.extend([numpy_helper.from_array(w, f"w{layer}"), numpy_helper.from_array(b, f"b{layer}")])
        y = f"conv{layer}"
        p = k // 2
        nodes.append(helper.make_node("Conv", [x, f"w{layer}", f"b{layer}"], [y], kernel_shape=[k, k], pads=[p] * 4))
        if act:
            nodes.append(helper.make_node("Elu", [y], [f"{y}_elu"]))
            y = f"{y}_elu"
        return y

    for c_out, n in ((16, 5), (32, 2), (64, 2)):
        for _ in range(n):
            x = conv(x, c_in, c_out, 3, act=True)
            c_in = c_out
        nodes.append(helper.make_node("MaxPool", [x], [f"{x}_pool"], kernel_shape=[2, 2], strides=[2, 2]))
        x = f"{x}_pool"
    x = conv(x, c_in, 24, 1, act=False)
    nodes.append(helper.make_node("ReduceMean", [x], ["logits"], axes=[3], keepdims=0))

    graph = helper.make_graph(
        nodes,
        "key_cnn_placeholder",
        [helper.make_tensor_value_info("spec", TensorProto.FLOAT, [1, 1, "frames", N_BINS])],
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 24, "out_frames"])],
        inits,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", OPSET)], producer_name="stoned-mango")
    model.ir_version = 8  # widest ORT Web compatibility
    onnx.checker.check_model(model)
    return model


class _Calibration(CalibrationDataReader):
    def __init__(self, n: int = 8, seed: int = 1):
        rng = np.random.default_rng(seed)
        # Log-magnitude spectrogram-like input: non-negative, smooth-ish.
        self._batches = iter(
            [{"spec": np.abs(rng.standard_normal((1, 1, 64, N_BINS))).astype(np.float32)} for _ in range(n)]
        )

    def get_next(self):
        return next(self._batches, None)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root = Path(__file__).resolve().parents[2]
    ap.add_argument("--out", type=Path, default=root / "web" / "public" / "spike")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    fp32 = args.out / "key-cnn-placeholder.fp32.onnx"
    int8 = args.out / "key-cnn-placeholder.int8.onnx"
    onnx.save(build(), fp32)
    # Static QDQ quantisation: int8 weights and activations, the format ORT Web's
    # WASM backend runs with integer kernels.
    quantize_static(str(fp32), str(int8), _Calibration(), quant_format=QuantFormat.QDQ,
                    activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8)

    rng = np.random.default_rng(2)
    golden = np.abs(rng.standard_normal((1, 1, GOLDEN_FRAMES, N_BINS))).astype(np.float32)
    golden.tofile(args.out / "golden-input.f32")
    meta = {"input_shape": list(golden.shape), "models": {}}
    for path in (fp32, int8):
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        (out,) = sess.run(None, {"spec": golden})
        n_params = sum(int(np.prod(t.dims)) for t in onnx.load(path).graph.initializer)
        meta["models"][path.name] = {
            "bytes": path.stat().st_size,
            "params": n_params,
            "output_shape": list(out.shape),
            "output": [round(float(v), 6) for v in out.ravel()],
        }
        print(f"{path.name}: {path.stat().st_size / 1024:.0f} KiB, output {out.shape}")
    (args.out / "golden.json").write_text(json.dumps(meta))


if __name__ == "__main__":
    main()
