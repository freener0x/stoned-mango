"""The scale library (shared/scales.json) and human-readable names."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from .features import NOTE_NAMES

SCALES_JSON = Path(__file__).resolve().parents[2] / "shared" / "scales.json"

# Flat-side tonics are spelled with flats, the rest with sharps (F# minor, but Gb major).
_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
# Major keys (by tonic) that use flats in their key signature; F# major is written Gb.
_FLAT_MAJOR_TONICS = {1, 3, 5, 6, 8, 10}


@dataclass(frozen=True)
class Scale:
    id: str
    name: str
    family: str
    tier: int
    cents: tuple[int, ...]
    label: str | None = None
    mode_of: tuple[str, int] | None = None
    aliases: tuple[str, ...] = ()
    tradition: str | None = None  # tier 3: "arabic", "turkish" or "indian"
    dominant: int | None = None  # tier 3: the dominant degree (1-based)

    @property
    def semitones(self) -> tuple[int, ...]:
        """Pitch classes relative to the tonic (tiers 1-2 are all on the 12-tone grid)."""
        return tuple(sorted({round(c / 100) % 12 for c in self.cents}))

    @property
    def third(self) -> str:
        """'major' or 'minor', for scoring against major/minor-only datasets."""
        pcs = self.semitones
        if 4 in pcs and 3 not in pcs:
            return "major"
        if 3 in pcs and 4 not in pcs:
            return "minor"
        return "major" if self.id in ("major_blues",) else "minor"


@cache
def library(path: Path = SCALES_JSON) -> dict[str, Scale]:
    doc = json.loads(path.read_text())
    out = {}
    for s in doc["scales"]:
        m = s.get("mode_of")
        out[s["id"]] = Scale(
            id=s["id"], name=s["name"], family=s["family"], tier=s["tier"], cents=tuple(s["cents"]),
            label=s.get("label"), mode_of=(m["scale"], m["degree"]) if m else None, aliases=tuple(s.get("aliases", [])),
            tradition=s.get("tradition"), dominant=s.get("dominant"),
        )
    return out


def note_name(pc: int, scale: Scale | None = None) -> str:
    """Spell a tonic by key-signature convention for the scale's parent major key."""
    pc %= 12
    if scale is None:
        return NOTE_NAMES[pc]
    # Find the major key whose notes this scale's tonic sits in, for diatonic modes;
    # otherwise use the scale's own third.
    parent = parent_key(pc, scale)
    ref_major = parent[0] if parent and library()[parent[1]].id == "ionian" else (pc if scale.third == "major" else (pc + 3) % 12)
    return (_FLAT if ref_major in _FLAT_MAJOR_TONICS else _SHARP)[pc]


def parent_key(tonic: int, scale: Scale) -> tuple[int, str] | None:
    """For a mode, the tonic and id of the scale it is a rotation of (D Dorian -> C Ionian)."""
    if scale.mode_of is None:
        return None
    parent = library()[scale.mode_of[0]]
    degree_offset = round(parent.cents[scale.mode_of[1] - 1] / 100)
    return (tonic - degree_offset) % 12, parent.id


def label(tonic: int, scale_id: str) -> str:
    """'C major', 'A minor', 'D Dorian', 'E Phrygian dominant'."""
    scale = library()[scale_id]
    return f"{note_name(tonic, scale)} {scale.label or scale.name}"


def parent_label(tonic: int, scale_id: str) -> str | None:
    """'same notes as C major' / '5th mode of A harmonic minor', or None for parent scales."""
    scale = library()[scale_id]
    parent = parent_key(tonic, scale)
    if parent is None:
        return None
    ptonic, pid = parent
    degree = scale.mode_of[1]
    if pid == "ionian":
        return f"same notes as {label(ptonic, pid)}"
    suffix = {1: "st", 2: "nd", 3: "rd"}.get(degree, "th")
    return f"{degree}{suffix} mode of {label(ptonic, pid)}"
