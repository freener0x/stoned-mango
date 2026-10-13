"""The browser's key-tag writer, checked by an independent reader (mutagen).

shared/golden/tags/in holds files tagged by mutagen (stoned_mango.tag_fixtures);
web/tests/tagging.test.ts tags them in TypeScript and keeps the results in
shared/golden/tags/out. Here mutagen must read our key frames and still find every tag
it wrote itself.
"""

import zipfile
from pathlib import Path

import pytest

mutagen = pytest.importorskip("mutagen")
from mutagen.id3 import ID3, ID3NoHeaderError  # noqa: E402
from mutagen.mp3 import MP3  # noqa: E402
from mutagen.wave import WAVE  # noqa: E402

TAGS = Path(__file__).resolve().parents[2] / "shared" / "golden" / "tags"
NAMES = sorted(p.name for p in (TAGS / "in").iterdir())


def tags_of(path: Path):
    if path.suffix == ".wav":
        return WAVE(path).tags
    try:
        return ID3(path)
    except ID3NoHeaderError:
        return None


@pytest.mark.parametrize("name", NAMES)
def test_key_frames_readable_and_others_kept(name):
    before = tags_of(TAGS / "in" / name)
    after = tags_of(TAGS / "out" / name)
    assert str(after["TKEY"]) == "8A"
    assert str(after["TXXX:KEY_MODE"]) == "D Dorian ♯4"
    if before is not None:
        for key, frame in before.items():
            if key in ("TKEY", "TXXX:KEY_MODE"):
                continue
            assert key in after, key
            assert after[key] == frame, key


@pytest.mark.parametrize("name", [n for n in NAMES if n.endswith(".mp3")])
def test_mp3_still_decodes(name):
    a, b = MP3(TAGS / "in" / name), MP3(TAGS / "out" / name)
    assert b.info.length == pytest.approx(a.info.length)
    assert b.info.sample_rate == a.info.sample_rate


def test_wav_still_reads():
    import soundfile as sf

    for name in [n for n in NAMES if n.endswith(".wav")]:
        a, ra = sf.read(TAGS / "in" / name)
        b, rb = sf.read(TAGS / "out" / name)
        assert ra == rb and (a == b).all()


def test_zip_of_copies():
    with zipfile.ZipFile(TAGS / "out" / "copies.zip") as z:
        assert z.testzip() is None
        assert z.namelist() == ["Music/Sub folder/untagged.mp3", "Music/Sub folder/info-id3.wav"]
        assert z.read("Music/Sub folder/untagged.mp3") == (TAGS / "out" / "untagged.mp3").read_bytes()
