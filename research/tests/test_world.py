"""Tier 3 (maqam, makam, raga families): the scale data, names, and the engine on short
synthetic songs, including leaving Western music and noise alone."""

import json

import numpy as np
import pytest

from stoned_mango import world
from stoned_mango.analysis import analyse_features
from stoned_mango.features import extract_array
from stoned_mango.keyless import clips
from stoned_mango.scales import SCALES_JSON, library
from stoned_mango.synth import SR as SYNTH_SR, Piece, Section, render
from stoned_mango.tier3_data import THAATS, melakarta, ragas, tier3
from stoned_mango.worldgen import SR, WorldPiece, render as render_world


def test_tier3_data_is_in_scales_json():
    doc = json.loads(SCALES_JSON.read_text())
    assert [s for s in doc["scales"] if s["tier"] == 3] == json.loads(json.dumps(tier3()))
    lib = library()
    assert sum(1 for s in lib.values() if s.tradition == "indian") == 72
    assert {lib[f"mela_{n}"].name for n in THAATS} >= {"Mechakalyani", "Dheerasankarabharanam", "Kharaharapriya"}
    for s in (x for x in lib.values() if x.tier == 3):
        assert s.cents[0] == 0 and list(s.cents) == sorted(s.cents) and s.cents[-1] < 1200, s.id
        assert 1 <= s.dominant <= len(s.cents)


def test_melakartas_and_thaats():
    assert melakarta(29) == [0, 204, 386, 498, 702, 884, 1088]  # Dheerasankarabharanam = Bilawal = major
    assert melakarta(65) == [0, 204, 386, 590, 702, 884, 1088]  # Mechakalyani = Kalyan = Lydian
    assert melakarta(1)[1:3] == [90, 204]  # Kanakangi: R1 G1
    assert len({tuple(melakarta(n)) for n in range(1, 73)}) == 72
    for r in ragas():  # a raga may borrow one note from outside its parent (Bihag's tivra Ma)
        assert len(set(r["notes"]) - {round(c / 100) % 12 for c in library()[r["parent"]].cents}) <= 1, r["name"]


def test_names():
    c = world.Tier3Candidate(tonic_step=4, scale="maqam_bayati", score=0)
    assert world.label(c) == "Maqam Bayati on D"
    assert world.label(world.Tier3Candidate(7, "maqam_sikah", 0)) == "Maqam Sikah on E half-flat"
    assert world.label(world.Tier3Candidate(14, "makam_hicaz", 0)) == "Makam Hicaz on G"
    assert world.label(world.Tier3Candidate(2, "mela_65", 0)) == "Kalyan thaat, Sa = C#"
    assert world.parent(world.Tier3Candidate(2, "mela_65", 0)) == "Mechakalyani, the 65th melakarta"
    assert world.label(world.Tier3Candidate(0, "mela_56", 0)) == "Shanmukhapriya, Sa = C"
    assert world.nearest_key(world.Tier3Candidate(4, "maqam_bayati", 0)) == {"tonic": 2, "minor": True}  # ≈ D minor
    assert world.nearest_key(world.Tier3Candidate(0, "mela_29", 0)) == {"tonic": 0, "minor": False}
    assert world.nearest_key(world.Tier3Candidate(4, "maqam_hijaz", 0)) == {"tonic": 7, "minor": True}  # G minor, not Bb major
    assert world.parse_traditions("arabic, indian") == ("only", ("arabic", "indian"))
    with pytest.raises(ValueError):
        world.parse_traditions("klingon")


def _world(scale, tonic, seed, drone=False, tuning=0.0):
    p = WorldPiece("t", scale, tonic, tuning, 30.0, drone, seed)
    return extract_array(render_world(p), SR)


@pytest.mark.parametrize("scale,tonic,drone,label", [
    ("maqam_saba", 200.0, False, "Maqam Saba on D"),
    ("maqam_rast", 0.0, True, "Maqam Rast on C"),
    ("mela_65", 200.0, True, "Kalyan thaat, Sa = D"),
    ("makam_hicaz", 900.0, False, "Makam Hicaz on A"),
])
def test_engine_finds_scale_and_home(scale, tonic, drone, label):
    f = _world(scale, tonic, seed=12, drone=drone)
    r = analyse_features(f, timeline=False, traditions="all")  # the engine itself; the "auto" gate is tested below
    assert r["label"] == label, r
    assert r["tradition"] == library()[scale].tradition
    assert r["engine"] == "tier3"
    assert r["key"]["tonic_cents"] == tonic


def test_ragas_shortlist_for_indian_result():
    r = analyse_features(_world("mela_65", 200.0, seed=12, drone=True), timeline=False, traditions="all")
    assert "Yaman" in r["ragas"] or "Kalyani" in r["ragas"], r["ragas"]


def test_western_song_and_noise_left_alone():
    song = render(Piece("w", [Section(9, "aeolian", [1, 6, 7, 1], 8)], bpm=120.0), seed=3)
    r = analyse_features(extract_array(song, SYNTH_SR), timeline=False, traditions="auto")
    assert "tradition" not in r and r["label"] == "A minor"
    for i, (_, audio) in enumerate(clips(seconds=8.0, noise=1, drums=2)):
        d = world.decide(extract_array(audio, SYNTH_SR))
        assert d is not None and not d.use


def test_traditions_setting():
    f = _world("maqam_saba", 200.0, seed=12)
    assert world.decide(f, "western") is None
    assert "tradition" not in analyse_features(f, timeline=False, traditions="western")
    only = world.decide(f, "indian")
    assert only.use and all(library()[c.scale].tradition == "indian" for c in only.cands[:5])


def test_plausible_in_auto_mode():
    ev = world.Evidence(deviation=3.0, quarter_tones=0.0, drone=0.0, drone_step=None)
    kurd = world.Tier3Candidate(14, "maqam_kurd", 0, fit=0.8)  # on the piano's keys: Phrygian by another name
    assert world.on_keys(kurd) and not world._plausible(kurd, ev)
    assert world._plausible(kurd, world.Evidence(6.0, 0.0, 0.0, None))  # clearly non-piano intonation
    assert not world._plausible(kurd, world.Evidence(6.0, 0.0, 0.0, None), western_confidence=0.95)  # a sure Western key
    assert not world._plausible(world.Tier3Candidate(14, "maqam_kurd", 0, fit=0.6), world.Evidence(6.0, 0.0, 0.0, None))
    bayati = world.Tier3Candidate(4, "maqam_bayati", 0, fit=0.8)
    assert world.needs_quarter_tones(bayati) and not world._plausible(bayati, ev)
    assert world._plausible(bayati, world.Evidence(3.0, 0.2, 0.0, None))
    kalyan = world.Tier3Candidate(4, "mela_65", 0, fit=0.8)
    assert world._plausible(kalyan, world.Evidence(0.5, 0.0, 0.8, 4), western_confidence=0.99)  # a drone; Lydian anyway
    assert not world._plausible(kalyan, world.Evidence(9.0, 0.0, 0.3, 4))  # no drone: not Indian


def test_auto_margin_per_tradition():
    """Fitted on real music: a maqam or makam must beat the Western scales clearly (0.10), an Indian
    scale (which needs a drone) just beat them."""
    assert world.AUTO_MARGIN == {"arabic": 0.10, "turkish": 0.10, "indian": 0.0}
    lead = np.zeros(120)
    lead[[0, 15, 30, 50, 70, 80, 100]] = 1.0  # Bayati on C: E half-flat
    bass, share = np.zeros(120), np.zeros(world.STEPS)
    d = world.decide_from(lead, bass, share, traditions="auto")
    assert d.use == (d.cands[0].score >= d.western + 0.10) and world.library()[d.cands[0].scale].tradition != "indian"


def test_ending_cue_picks_the_home_note():
    lead = np.zeros(120)
    lead[[0, 20, 40, 50, 70, 90, 110]] = 1.0  # C major's notes, evenly: C Ionian, A Aeolian... are all alike
    ending = np.zeros(120)
    ending[90] = 1.0  # the performance ends on A
    bass, share = np.zeros(120), np.zeros(world.STEPS)
    d = world.decide_from(lead, bass, share, traditions="indian", ending=ending)
    assert d.cands[0].tonic_step == 18  # A


def test_evidence_measures():
    p = np.zeros(120)
    p[[0, 20, 40, 50, 70, 90, 110]] = 1  # equal-tempered peaks
    dev, qt = world.intonation(p)
    assert dev < 0.5 and qt == 0
    p2 = np.zeros(120)
    p2[[0, 15, 30, 50, 70, 80, 100]] = 1  # Bayati on C: 150 cents
    assert world.intonation(p2)[1] > 0.1
