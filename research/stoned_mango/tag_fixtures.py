"""Test files for the browser's key-tag writer (web/src/ui/tagging), made with mutagen.

    python -m stoned_mango.tag_fixtures

Writes shared/golden/tags/in/: short MP3 and WAV files that already carry tags written by
an independent tagger (artwork, UTF-16 text, an old TKEY, other TXXX frames, ID3v1,
RIFF INFO). web/tests/tagging.test.ts tags them and keeps its outputs in
shared/golden/tags/out/; research/tests/test_tag_fixtures.py reads those outputs back
with mutagen, so each side checks the other.
"""

from __future__ import annotations

import io
import struct
import wave
from pathlib import Path

import numpy as np
from mutagen.id3 import APIC, COMM, ID3, TALB, TIT2, TKEY, TPE1, TXXX
from mutagen.wave import WAVE

ROOT = Path(__file__).resolve().parents[2] / "shared" / "golden"
OUT = ROOT / "tags" / "in"

# A 1x1 PNG, as stand-in artwork.
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6de6d0000000049454e44ae426082")


def mp3_frames(n: int = 40) -> bytes:
    """The first ``n`` MP3 frames of the golden MP3 (no tag)."""
    data = (ROOT / "modulating-22k.mp3").read_bytes()
    pos, count = 0, 0
    if data[:3] == b"ID3":
        pos = 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9])
    start = pos
    rates = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}
    kbps = {1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
            2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
    while count < n:
        b1, b2 = data[pos + 1], data[pos + 2]
        assert data[pos] == 0xFF and b1 & 0xE0 == 0xE0, "lost MP3 sync"
        version = (b1 >> 3) & 3
        rate = rates[version][(b2 >> 2) & 3]
        br = kbps[1 if version == 3 else 2][b2 >> 4]
        pos += (144 if version == 3 else 72) * br * 1000 // rate + ((b2 >> 1) & 1)
        count += 1
    return data[start:pos]


def id3v1(title: str) -> bytes:
    return b"TAG" + title.encode()[:30].ljust(30, b"\0") + b"Artist".ljust(30, b"\0") + b"Album".ljust(30, b"\0") \
        + b"2024" + b"".ljust(30, b"\0") + bytes([12])


def tagged_mp3(path: Path, version: int, extra: bool) -> None:
    path.write_bytes(mp3_frames() + (id3v1("v1 title") if extra else b""))
    tags = ID3()
    tags.add(TIT2(encoding=1, text="Song ♪ title"))
    tags.add(TPE1(encoding=1 if version == 3 else 3, text="Ärtist"))
    tags.add(TALB(encoding=0, text="Album"))
    tags.add(TKEY(encoding=0, text="Am"))
    tags.add(TXXX(encoding=1, desc="KEY_MODE", text="A Aeolian"))
    tags.add(TXXX(encoding=1, desc="OTHER", text="keep me"))
    tags.add(COMM(encoding=1, lang="eng", desc="", text="a comment"))
    tags.add(APIC(encoding=0, mime="image/png", type=3, desc="cover", data=PNG * 40))
    tags.save(path, v2_version=version, padding=lambda info: 64 if version == 3 else 4000)


def wav_bytes(seconds: float = 0.25, rate: int = 22050) -> bytes:
    t = np.arange(int(seconds * rate)) / rate
    pcm = (0.3 * np.sin(2 * np.pi * 220 * t) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def with_info_chunk(riff: bytes) -> bytes:
    """Adds a LIST/INFO chunk with an odd-length title (so a pad byte follows it)."""
    title = b"Title\0"[:5]  # 5 bytes: odd
    info = b"INFO" + b"INAM" + struct.pack("<I", len(title)) + title + b"\0"
    chunk = b"LIST" + struct.pack("<I", len(info)) + info
    body = riff[12:] + chunk
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WAVE" + body


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tagged_mp3(OUT / "v23-artwork-v1.mp3", 3, extra=True)
    tagged_mp3(OUT / "v24-padding.mp3", 4, extra=False)
    (OUT / "untagged.mp3").write_bytes(mp3_frames(12))
    (OUT / "untagged.wav").write_bytes(wav_bytes(0.1))
    path = OUT / "info-id3.wav"
    path.write_bytes(with_info_chunk(wav_bytes()))
    w = WAVE(path)
    w.add_tags()
    w.tags.add(TIT2(encoding=1, text="Wave ♪ title"))
    w.tags.add(TKEY(encoding=0, text="C"))
    w.save()
    for p in sorted(OUT.iterdir()):
        print(f"{p.name}: {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
