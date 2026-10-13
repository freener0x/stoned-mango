import numpy as np
import pytest

from stoned_mango.cnn.data import BINS_PER_SEMITONE, Example, targets, transpose
from stoned_mango.cnn.labels import joint_index, n_outputs, scale_ids, third_mask
from stoned_mango.scales import library
from stoned_mango.songgen import DRUM_CHANNEL, arrange, render_additive


@pytest.mark.parametrize("scale_id", scale_ids())
def test_every_generated_note_is_in_the_scale(scale_id):
    rng = np.random.default_rng(1)
    tonic = 7
    allowed = {(tonic + p) % 12 for p in library()[scale_id].semitones}
    for i in range(3):
        song = arrange(f"t{i}", tonic, scale_id, 20.0, rng)
        pitched = [n.pitch % 12 for n in song.notes if n.channel != DRUM_CHANNEL]
        assert pitched and set(pitched) <= allowed, scale_id


def test_additive_render_runs_and_is_audible():
    song = arrange("t", 0, "dorian", 6.0, np.random.default_rng(0))
    audio = render_additive(song)
    assert audio.ndim == 1 and np.abs(audio).max() > 0.01


def test_transpose_moves_two_bands_per_semitone():
    x = np.zeros((5, 105), np.float32)
    x[:, 40] = 1
    assert np.argmax(transpose(x, 3)[0]) == 40 + 3 * BINS_PER_SEMITONE
    assert np.argmax(transpose(x, -2)[0]) == 40 - 2 * BINS_PER_SEMITONE


def test_targets_follow_transposition():
    dorian = scale_ids().index("dorian")
    ex = Example("x", np.zeros((10, 105), np.float16), tonic=2, third="minor", scale=dorian, source="t")
    assert targets(ex, 0) == (joint_index(dorian, 2), 2, 1)
    assert targets(ex, 11) == (joint_index(dorian, 1), 1, 1)
    mm_only = Example("y", np.zeros((10, 105), np.float16), tonic=9, third="major", scale=-1, source="t")
    assert targets(mm_only, 3) == (-1, 0, 0)


def test_third_mask_and_output_size():
    mask = third_mask()
    ids = scale_ids()
    assert mask[0, ids.index("ionian")] and mask[1, ids.index("aeolian")]
    assert (mask[0] ^ mask[1]).all()  # every scale is exactly one of major/minor
    assert n_outputs() == 12 * len(ids)


# ---- PyTorch parts (skipped where torch isn't installed, e.g. CI) ----------------------------


def test_model_shape_and_transposition_equivariance():
    torch = pytest.importorskip("torch")
    from stoned_mango.cnn.model import KeyNet

    torch.manual_seed(0)
    m = KeyNet().eval()
    x = torch.zeros(1, 1, 64, 105)
    x[..., 20:80] = torch.rand(1, 1, 64, 60)
    x_up = torch.from_numpy(transpose(x[0, 0].numpy(), 1))[None, None]
    with torch.no_grad():
        a, b = m(x), m(x_up)
    assert a.shape == (1, n_outputs(), 16)
    a = a.reshape(1, -1, 12, 16)
    b = b.reshape(1, -1, 12, 16)
    assert float((torch.roll(a, 1, dims=2) - b).abs().max()) < 0.05


def test_marginal_loss_prefers_the_right_third():
    torch = pytest.importorskip("torch")
    from stoned_mango.cnn.train import loss_fn

    thirds = torch.from_numpy(third_mask())
    logits = torch.zeros(1, n_outputs(), 4)
    logits[0, joint_index(scale_ids().index("aeolian"), 9)] = 5.0  # confident: A Aeolian
    a_minor = loss_fn(logits, torch.tensor([[-1, 9, 1]]), thirds)
    a_major = loss_fn(logits, torch.tensor([[-1, 9, 0]]), thirds)
    exact = loss_fn(logits, torch.tensor([[joint_index(scale_ids().index("aeolian"), 9), 9, 1]]), thirds)
    assert a_minor < a_major and exact >= a_minor - 1e-6


def test_onnx_export_matches_torch_and_engine_reads_it(tmp_path):
    torch = pytest.importorskip("torch")
    pytest.importorskip("onnxruntime")
    import json

    from stoned_mango.cnn.engine import CnnEngine
    from stoned_mango.cnn.export import model_card, to_onnx
    from stoned_mango.cnn.model import KeyNet, pooled

    torch.manual_seed(0)
    model = KeyNet().eval()
    path = tmp_path / "m.onnx"
    to_onnx(model, path)
    path.with_suffix(".json").write_text(json.dumps(model_card({"config": model.config, "epoch": 0, "val": {}}, {})))
    spec = np.abs(np.random.default_rng(0).standard_normal((120, 105))).astype(np.float32)
    with torch.no_grad():
        ref = pooled(model(torch.from_numpy(spec)[None, None]))[0].numpy()
    best = CnnEngine(path).candidates(spec)[0]
    s, t = divmod(int(np.argmax(ref)), 12)
    assert (best.tonic, best.scale) == (t, scale_ids()[s])
