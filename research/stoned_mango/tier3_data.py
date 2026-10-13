"""Tier 3 scales (PLAN.md section 4): Arabic maqam, Turkish makam, and the Indian parent
scales (the 72 Carnatic melakartas, which include the 10 Hindustani thaats).

    python -m stoned_mango.tier3_data      # rewrites the tier 3 part of shared/scales.json and shared/ragas.json

The scales are written as cents above the tonic, in each tradition's own intonation:

* Arabic maqam in quarter tones (24 equal steps): a "half-flat" E sits at 350 cents above C.
* Turkish makam in Holdrian commas (53 equal steps, Arel-Ezgi-Uzdilek theory), built from its
  tetrachords and pentachords. Bestenigar is left out: its theory varies too much between sources.
* Indian scales in just intonation (komal Re 90, Ga 386, tivra Ma 590 ...), Sa at any pitch.

Each scale also names its dominant degree (ghammaz, güçlü, Pa): the second most important
note, which tells apart scales with the same notes (Uşşak's is the 4th, Hüseyni's the 5th).
Scales with the same notes *and* dominant can't be told apart from a pitch profile alone
(Uşşak and Beyati, Mahur and Acemaşiran); the app says so.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "shared"
COMMA = 1200 / 53

# (id, name, cents, dominant degree (1-based), typical tonic)
ARABIC = [
    ("rast", "Rast", [0, 200, 350, 500, 700, 900, 1050], 5, "C"),
    ("bayati", "Bayati", [0, 150, 300, 500, 700, 800, 1000], 4, "D"),
    ("sikah", "Sikah", [0, 150, 350, 550, 700, 850, 1050], 3, "E half-flat"),
    ("hijaz", "Hijaz", [0, 100, 400, 500, 700, 800, 1000], 4, "D"),
    ("saba", "Saba", [0, 150, 300, 400, 700, 800, 1000], 3, "D"),
    ("nahawand", "Nahawand", [0, 200, 300, 500, 700, 800, 1100], 5, "C"),
    ("kurd", "Kurd", [0, 100, 300, 500, 700, 800, 1000], 4, "D"),
    ("ajam", "Ajam", [0, 200, 400, 500, 700, 900, 1100], 5, "B flat"),
    ("huzam", "Huzam", [0, 150, 350, 450, 750, 850, 1050], 3, "E half-flat"),
    ("nikriz", "Nikriz", [0, 200, 300, 600, 700, 900, 1000], 5, "C"),
    ("nawa_athar", "Nawa Athar", [0, 200, 300, 600, 700, 800, 1100], 5, "C"),
    ("hijaz_kar", "Hijaz Kar", [0, 100, 400, 500, 700, 800, 1100], 5, "C"),
    ("suznak", "Suznak", [0, 200, 350, 500, 700, 800, 1100], 5, "C"),
    ("iraq", "Iraq", [0, 150, 350, 500, 650, 850, 1050], 3, "B half-flat"),
    ("bayati_shuri", "Bayati Shuri", [0, 150, 300, 500, 600, 900, 1000], 4, "D"),
]

# Steps in commas (they add up to 53).
TURKISH = [
    ("rast", "Rast", [9, 8, 5, 9, 9, 8, 5], 5, "G"),
    ("ussak", "Uşşak", [8, 5, 9, 9, 4, 9, 9], 4, "A"),
    ("beyati", "Beyati", [8, 5, 9, 9, 4, 9, 9], 4, "A"),
    ("huseyni", "Hüseyni", [8, 5, 9, 9, 8, 5, 9], 5, "A"),
    ("muhayyer", "Muhayyer", [8, 5, 9, 9, 8, 5, 9], 5, "A"),
    ("neva", "Neva", [8, 5, 9, 9, 8, 5, 9], 4, "A"),
    ("hicaz", "Hicaz", [5, 12, 5, 9, 8, 5, 9], 4, "A"),
    ("hicazkar", "Hicazkar", [5, 12, 5, 9, 5, 12, 5], 5, "G"),
    ("karcigar", "Karcığar", [8, 5, 9, 5, 12, 5, 9], 4, "A"),
    ("kurdilihicazkar", "Kürdilihicazkar", [4, 9, 9, 9, 5, 12, 5], 5, "G"),
    ("nihavent", "Nihavent", [9, 4, 9, 9, 4, 9, 9], 5, "G"),
    ("mahur", "Mahur", [9, 9, 4, 9, 9, 9, 4], 5, "G"),
    ("acemasiran", "Acemaşiran", [9, 9, 4, 9, 9, 9, 4], 5, "F"),
    ("acemkurdi", "Acemkürdi", [4, 9, 9, 9, 4, 9, 9], 4, "A"),
    ("huzzam", "Hüzzam", [5, 9, 5, 12, 5, 9, 8], 3, "B koma-flat"),
    ("segah", "Segah", [5, 9, 9, 8, 5, 9, 8], 3, "B koma-flat"),
    ("saba", "Saba", [8, 5, 5, 13, 4, 9, 9], 3, "A"),
    ("sultaniyegah", "Sultaniyegah", [9, 4, 9, 9, 5, 12, 5], 5, "D"),
    ("suzinak", "Suzinak", [9, 8, 5, 9, 5, 12, 5], 5, "G"),
]

# Just-intonation cents for the Indian swaras.
R1, R2, R3 = 90, 204, 316
G1, G2, G3 = 204, 316, 386
M1, M2 = 498, 590
D1, D2, D3 = 792, 884, 996
N1, N2, N3 = 884, 996, 1088
MELAKARTA_NAMES = [
    "Kanakangi", "Ratnangi", "Ganamurti", "Vanaspati", "Manavati", "Tanarupi", "Senavati", "Hanumatodi", "Dhenuka",
    "Natakapriya", "Kokilapriya", "Rupavati", "Gayakapriya", "Vakulabharanam", "Mayamalavagowla", "Chakravakam",
    "Suryakantam", "Hatakambari", "Jhankaradhwani", "Natabhairavi", "Keeravani", "Kharaharapriya", "Gourimanohari",
    "Varunapriya", "Mararanjani", "Charukesi", "Sarasangi", "Harikambhoji", "Dheerasankarabharanam", "Naganandini",
    "Yagapriya", "Ragavardhini", "Gangeyabhushani", "Vagadheeswari", "Shulini", "Chalanata", "Salagam", "Jalarnavam",
    "Jhalavarali", "Navaneetam", "Pavani", "Raghupriya", "Gavambhodi", "Bhavapriya", "Shubhapantuvarali",
    "Shadvidamargini", "Suvarnangi", "Divyamani", "Dhavalambari", "Namanarayani", "Kamavardhini", "Ramapriya",
    "Gamanashrama", "Vishwambari", "Shamalangi", "Shanmukhapriya", "Simhendramadhyamam", "Hemavati", "Dharmavati",
    "Neetimati", "Kantamani", "Rishabhapriya", "Latangi", "Vachaspati", "Mechakalyani", "Chitrambari", "Sucharitra",
    "Jyotiswarupini", "Dhatuvardhani", "Nasikabhushani", "Kosalam", "Rasikapriya",
]
THAATS = {29: "Bilawal", 65: "Kalyan", 28: "Khamaj", 22: "Kafi", 20: "Asavari", 8: "Bhairavi", 15: "Bhairav",
          51: "Purvi", 53: "Marwa", 45: "Todi"}
RG = [(R1, G1), (R1, G2), (R1, G3), (R2, G2), (R2, G3), (R3, G3)]
DN = [(D1, N1), (D1, N2), (D1, N3), (D2, N2), (D2, N3), (D3, N3)]


def melakarta(n: int) -> list[float]:
    """The n-th melakarta (1..72): Ma by half, Re/Ga by chakra, Dha/Ni by position in the chakra."""
    ma = M1 if n <= 36 else M2
    k = (n - 1) % 36
    r, g = RG[k // 6]
    d, ni = DN[k % 6]
    return [0, r, g, ma, 702, d, ni]


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def tier3() -> list[dict]:
    out = []
    for sid, name, cents, dom, tonic in ARABIC:
        out.append({"id": f"maqam_{sid}", "name": name, "family": "maqam", "tier": 3, "tradition": "arabic",
                    "cents": cents, "dominant": dom, "tonic_hint": tonic})
    for sid, name, steps, dom, tonic in TURKISH:
        assert sum(steps) == 53, (sid, sum(steps))
        acc = [0]
        for s in steps[:-1]:
            acc.append(acc[-1] + s)
        out.append({"id": f"makam_{sid}", "name": name, "family": "makam", "tier": 3, "tradition": "turkish",
                    "cents": [round(c * COMMA, 1) for c in acc], "commas": acc, "dominant": dom, "tonic_hint": tonic})
    for n, name in enumerate(MELAKARTA_NAMES, start=1):
        entry = {"id": f"mela_{n}", "name": name, "family": "melakarta", "tier": 3, "tradition": "indian",
                 "cents": melakarta(n), "dominant": 5, "number": n, "ordinal": _ordinal(n)}
        if n in THAATS:
            entry["thaat"] = THAATS[n]
        out.append(entry)
    return out


# Common ragas, by the notes they use (semitones above Sa) and their parent melakarta.
RAGAS = [
    # Hindustani
    ("Yaman", "hindustani", 65, [0, 2, 4, 6, 7, 9, 11]),
    ("Bhupali", "hindustani", 29, [0, 2, 4, 7, 9]),
    ("Durga", "hindustani", 29, [0, 2, 5, 7, 9]),
    ("Bihag", "hindustani", 29, [0, 4, 5, 6, 7, 11]),
    ("Hamsadhwani", "both", 29, [0, 2, 4, 7, 11]),
    ("Desh", "hindustani", 28, [0, 2, 5, 7, 10, 11]),
    ("Khamaj", "hindustani", 28, [0, 4, 5, 7, 9, 10, 11]),
    ("Kafi", "hindustani", 22, [0, 2, 3, 5, 7, 9, 10]),
    ("Bageshree", "hindustani", 22, [0, 2, 3, 5, 9, 10]),
    ("Bhimpalasi", "hindustani", 22, [0, 2, 3, 5, 7, 9, 10]),
    ("Malkauns", "hindustani", 20, [0, 3, 5, 8, 10]),
    ("Darbari Kanada", "hindustani", 20, [0, 2, 3, 5, 7, 8, 10]),
    ("Jaunpuri", "hindustani", 20, [0, 2, 3, 5, 7, 8, 10]),
    ("Bhairavi", "hindustani", 8, [0, 1, 3, 5, 7, 8, 10]),
    ("Bhairav", "hindustani", 15, [0, 1, 4, 5, 7, 8, 11]),
    ("Ahir Bhairav", "hindustani", 14, [0, 1, 4, 5, 7, 9, 10]),
    ("Todi", "hindustani", 45, [0, 1, 3, 6, 7, 8, 11]),
    ("Multani", "hindustani", 45, [0, 1, 3, 6, 7, 8, 11]),
    ("Puriya Dhanashri", "hindustani", 51, [0, 1, 4, 6, 7, 8, 11]),
    ("Shree", "hindustani", 51, [0, 1, 4, 6, 7, 8, 11]),
    ("Marwa", "hindustani", 53, [0, 1, 4, 6, 9, 11]),
    ("Sohini", "hindustani", 53, [0, 1, 4, 6, 9, 11]),
    ("Puriya", "hindustani", 53, [0, 1, 4, 6, 9, 11]),
    ("Kirwani", "hindustani", 21, [0, 2, 3, 5, 7, 8, 11]),
    # Carnatic
    ("Kalyani", "carnatic", 65, [0, 2, 4, 6, 7, 9, 11]),
    ("Shankarabharanam", "carnatic", 29, [0, 2, 4, 5, 7, 9, 11]),
    ("Mohanam", "carnatic", 28, [0, 2, 4, 7, 9]),
    ("Bilahari", "carnatic", 29, [0, 2, 4, 5, 7, 9, 11]),
    ("Kambhoji", "carnatic", 28, [0, 2, 4, 5, 7, 9, 10, 11]),
    ("Kharaharapriya", "carnatic", 22, [0, 2, 3, 5, 7, 9, 10]),
    ("Abhogi", "carnatic", 22, [0, 2, 3, 5, 9]),
    ("Sriranjani", "carnatic", 22, [0, 2, 3, 5, 9, 10]),
    ("Madhyamavati", "carnatic", 22, [0, 2, 5, 7, 10]),
    ("Shivaranjani", "both", 22, [0, 2, 3, 7, 9]),
    ("Hindolam", "carnatic", 20, [0, 3, 5, 8, 10]),
    ("Natabhairavi", "carnatic", 20, [0, 2, 3, 5, 7, 8, 10]),
    ("Thodi", "carnatic", 8, [0, 1, 3, 5, 7, 8, 10]),
    ("Mayamalavagowla", "carnatic", 15, [0, 1, 4, 5, 7, 8, 11]),
    ("Revati", "carnatic", 2, [0, 1, 5, 7, 10]),
    ("Keeravani", "carnatic", 21, [0, 2, 3, 5, 7, 8, 11]),
    ("Charukesi", "carnatic", 26, [0, 2, 4, 5, 7, 8, 10]),
    ("Shanmukhapriya", "carnatic", 56, [0, 2, 3, 6, 7, 8, 10]),
    ("Simhendramadhyamam", "carnatic", 57, [0, 2, 3, 6, 7, 8, 11]),
    ("Hemavati", "carnatic", 58, [0, 2, 3, 6, 7, 9, 10]),
    ("Pantuvarali", "carnatic", 51, [0, 1, 4, 6, 7, 8, 11]),
    ("Saveri", "carnatic", 15, [0, 1, 4, 5, 7, 8, 11]),
    ("Kalyana Vasantham", "carnatic", 21, [0, 3, 5, 7, 8, 11]),
]


def ragas() -> list[dict]:
    out = []
    for name, tradition, parent, notes in RAGAS:
        assert 1 <= parent <= 72 and notes[0] == 0 and notes == sorted(set(notes)), name
        out.append({"name": name, "tradition": tradition, "parent": f"mela_{parent}", "notes": notes})
    return out


def main() -> None:
    path = ROOT / "scales.json"
    doc = json.loads(path.read_text())
    doc["scales"] = [s for s in doc["scales"] if s["tier"] <= 2] + tier3()
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    (ROOT / "ragas.json").write_text(json.dumps({
        "$comment": "Common ragas for the shortlist shown with an Indian result: the notes each uses (semitones above Sa) "
                    "and its parent scale. A raga is more than its notes, so this is a shortlist, not an answer. "
                    "Written by `python -m stoned_mango.tier3_data`.",
        "ragas": ragas()}, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(doc['scales'])} scales ({len(tier3())} tier 3), {len(RAGAS)} ragas")


if __name__ == "__main__":
    main()
