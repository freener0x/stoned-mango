"""The library check: key tag reading and parsing, and a small end-to-end run."""

import numpy as np
import pytest
import soundfile as sf

from stoned_mango import library
from stoned_mango.analysis import default_cnn
from stoned_mango.library import describe, key_from_name, name_shape, parse_key, read_key_tag, relation


@pytest.mark.parametrize("text,expected", [
    ("Am", (9, "minor")), ("A minor", (9, "minor")), ("F#m", (6, "minor")), ("Ebm", (3, "minor")),
    ("Bb", (10, "major")), ("C major", (0, "major")), ("C# Minor", (1, "minor")), ("Bb MAJOR", (10, "major")), ("Abmaj", (8, "major")), ("G♯m", (8, "minor")),
    ("8B", (0, "major")), ("8A", (9, "minor")), ("9B", (7, "major")), ("1A", (8, "minor")), ("12B", (4, "major")),
    ("1d", (0, "major")), ("1m", (9, "minor")), ("2d", (7, "major")),
    ("8A - Am", (9, "minor")), ("Am/8A", (9, "minor")),
    ("", None), ("o", None), ("Off key", None),
])
def test_parse_key(text, expected):
    assert parse_key(text) == expected


def test_camelot_wheel_is_consistent():
    # Every Camelot number's A is the relative minor of its B, and neighbours are a fifth apart.
    for n in range(1, 13):
        (maj, _), (mnr, _) = parse_key(f"{n}B"), parse_key(f"{n}A")
        assert (maj - mnr) % 12 == 3
        assert (parse_key(f"{n % 12 + 1}B")[0] - maj) % 12 == 7


def test_relation():
    assert relation((9, "minor"), (9, "minor")) == "same"
    assert relation((9, "minor"), (4, "minor")) == "fifth"
    assert relation((9, "minor"), (2, "minor")) == "fifth"
    assert relation((9, "minor"), (0, "major")) == "relative"
    assert relation((0, "major"), (9, "minor")) == "relative"
    assert relation((9, "minor"), (9, "major")) == "parallel"
    assert relation((9, "minor"), (1, "major")) == "other"
    assert describe((0, "major"), (7, "major")) == "fifth above"
    assert describe((0, "major"), (5, "major")) == "fifth below"
    assert describe((0, "major"), (9, "minor")) == "relative"


def _tagged(path, key, sr=22050, seconds=2.0, audio=None):
    from mutagen.flac import FLAC

    x = audio if audio is not None else 0.1 * np.sin(2 * np.pi * 220 * np.arange(int(sr * seconds)) / sr)
    sf.write(path, x.astype(np.float32), sr)
    f = FLAC(path)
    f["INITIALKEY"] = key
    f.save()


def test_read_key_tag_flac_and_mp3(tmp_path):
    from mutagen.id3 import ID3, TKEY

    _tagged(tmp_path / "a.flac", "8A")
    assert read_key_tag(tmp_path / "a.flac") == "8A"
    sf.write(tmp_path / "b.wav", np.zeros(1000, np.float32), 22050)
    assert read_key_tag(tmp_path / "b.wav") is None
    mp3 = tmp_path / "c.mp3"
    mp3.write_bytes(b"")
    tags = ID3()
    tags.add(TKEY(encoding=3, text=["F#m"]))
    tags.save(mp3)
    assert read_key_tag(mp3) == "F#m"


def test_read_key_tag_cuts_long_text(tmp_path):
    import time

    from mutagen.id3 import ID3, TKEY

    mp3 = tmp_path / "long.mp3"
    mp3.write_bytes(b"")
    tags = ID3()
    tags.add(TKEY(encoding=3, text=["A" + " " * 50_000 + "x"]))  # the key patterns took minutes on this
    tags.save(mp3)
    t0 = time.time()
    raw = read_key_tag(mp3)
    assert len(raw) <= 256 and parse_key(raw) is None  # unreadable, not 'A'
    assert time.time() - t0 < 1


@pytest.mark.skipif(default_cnn() is None, reason="needs the bundled model")
def test_library_end_to_end(tmp_path, render_piece, sr, capsys):
    music = tmp_path / "music"
    music.mkdir()
    _tagged(music / "dorian.flac", "Dm", sr=sr, audio=render_piece(2, "dorian", [1, 4, 1, 7]))
    _tagged(music / "ionian.flac", "8B", sr=sr, audio=render_piece(0, "ionian", [1, 4, 5, 1]))
    _tagged(music / "short.flac", "Am", sr=sr)
    sf.write(music / "Some Artist - Mixo Song (G).wav", render_piece(7, "ionian", [1, 4, 5, 1]), sr)  # key in the name
    (music / "untagged.wav").write_bytes(b"")
    (music / "Secret Song (Am).m4a").write_bytes(b"")  # unreadable, with a key in its name
    out = tmp_path / "run"
    assert library.main([str(music), "--out", str(out), "--min-seconds", "10", "--workers", "1"]) == 0
    text = (out / "SUMMARY.md").read_text()
    assert "3 full-length tracks with a key" in text and "dorian" not in text  # no file names in the summary
    assert "unreadable 1" in text  # counted, and the run carried on
    assert "Secret Song" not in capsys.readouterr().out  # the log never shows its name
    stats = __import__("json").loads((out / "library-stats.json").read_text())
    assert stats["engines"]["fusion"]["agree"] == 1.0
    assert (out / "tracks.csv").read_text().count("\n") == 4
    assert "name:G" in (out / "tracks.csv").read_text()
    assert (out / "to-check.csv").read_text().startswith("#,file,your key")


@pytest.mark.parametrize("name,expected", [
    ("Artist - Title (Am)", (9, "minor")), ("8A - Artist - Title", (9, "minor")), ("01 - F#m - Title", (6, "minor")),
    ("Title [C major]", (0, "major")), ("Artist_-_Title_(Ebm)", (3, "minor")), ("Artist - Song 12B", (4, "major")),
    ("Mozart - Symphony No. 40 in G minor", (7, "minor")), ("Sonata in B flat major", (10, "major")),
    ("Prelude in C-sharp minor", (1, "minor")), ("Artist - Title (G)", (7, "major")),
    ("Artist - C# Minor - Title", (1, "minor")), ("Artist D#min Title", (3, "minor")), ("Song Title C#m 98", (1, "minor")),
    ("My Song Cm 120", (0, "minor")), ("Song Title Am 128", (9, "minor")), ("Here I Am Now", None),
    ("artist title-x g#min one two", (8, "minor")), ("a b-c fmin d e", (5, "minor")), ("x y dmin z w-v", (2, "minor")),
    ("x y-z c#min w", (1, "minor")), ("song emaj mix", (4, "major")), ("Feat. Amin - Track", None), ("x b y z", None),
    # not keys: words in titles, lone letters as artists, track numbers
    ("Here I Am", None), ("A Minor Incident", None), ("Artist - I Am (Original Mix)", None), ("B - Title", None),
    ("Track 01", None), ("2Pax - Changes", None), ("Artist - Title in a minute", None),
])
def test_key_from_name(name, expected):
    got = key_from_name(name)
    assert (got[1] if got else None) == expected


def test_name_shape_hides_titles_but_keeps_keys():
    assert name_shape("Secret Artist - Hidden Title (Am)") == "w w - w w (Am)"
    assert name_shape("8A - Someone - Something") == "8A - w - w"


@pytest.mark.skipif(default_cnn() is None, reason="needs the bundled model")
def test_library_short_clips_are_a_separate_group(tmp_path, render_piece, sr):
    music = tmp_path / "music"
    music.mkdir()
    sf.write(music / "loop 140 dmin.wav", render_piece(2, "aeolian", [1, 4, 5, 1]), sr)  # 16 s: a clip
    out = tmp_path / "run"
    assert library.main([str(music), "--out", str(out), "--workers", "1"]) == 0
    text = (out / "SUMMARY.md").read_text()
    assert "Short clips" in text and "1 with a key" in text
    assert __import__("json").loads((out / "library-stats.json").read_text())["clips"]["fusion"]["n"] == 1
