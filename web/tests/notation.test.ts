// Key names and DJ codes (src/ui/notation.ts), and the settings and export helpers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { label, scaleIds } from '../src/engine/scales.ts';
import { clock, CSV_COLUMNS, referenceHz, toCsv, toJson } from '../src/ui/exporters.ts';
import {
  camelot, camelotOrder, compatible, homeKey, isApprox, mixKey, mixKeyName, openKey, pretty, respell, scaleNotes, standardKey,
  showsMixKey,
} from '../src/ui/notation.ts';
import { keyTags } from '../src/ui/tagging/keys.ts';
import { DEFAULT_VIEW, filterRows } from '../src/ui/table.ts';
import type { Row } from '../src/ui/store.ts';
import { DEFAULTS, parseSettings, serialiseSettings } from '../src/ui/settings.ts';
import type { Result } from '../src/engine/analysis.ts';

const C = 0, D = 2, E = 4, F = 5, G = 7, A = 9, B = 11;

test('Camelot and Open Key codes for all 24 keys', () => {
  // The published wheels, in fifths order.
  const majors = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'];
  const minors = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm'];
  const PC: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, Ab: 8,
    A: 9, Bb: 10, B: 11 };
  const pc = (n: string) => PC[n];
  majors.forEach((n, i) => {
    const m = { tonic: pc(n), minor: false };
    assert.equal(camelot(m), `${((i + 7) % 12) + 1}B`, n);
    assert.equal(openKey(m), `${i + 1}d`, n);
  });
  minors.forEach((n, i) => {
    const m = { tonic: pc(n.slice(0, -1)), minor: true };
    assert.equal(camelot(m), `${((i + 7) % 12) + 1}A`, n);
    assert.equal(openKey(m), `${i + 1}m`, n);
  });
  assert.equal(camelot({ tonic: A, minor: true }), '8A');
  assert.equal(camelot({ tonic: C, minor: false }), '8B');
  assert.equal(openKey({ tonic: D, minor: true }), '12m');
});

test('mixing key: "same notes" rule', () => {
  const mk = (tonic: number, s: string) => {
    const m = mixKey({ tonic, scale: s });
    return `${mixKeyName(m)} ${camelot(m)}`;
  };
  assert.equal(mk(C, 'ionian'), 'C major 8B');
  assert.equal(mk(A, 'aeolian'), 'A minor 8A');
  assert.equal(mk(D, 'dorian'), 'C major 8B'); // the approved display: "D Dorian · 8B (C major)"
  assert.equal(mk(E, 'phrygian'), 'C major 8B');
  assert.equal(mk(F, 'lydian'), 'C major 8B');
  assert.equal(mk(G, 'mixolydian'), 'C major 8B');
  assert.equal(mk(B, 'locrian'), 'C major 8B');
  assert.equal(mk(A, 'harmonic_minor'), 'A minor 8A');
  assert.equal(mk(E, 'phrygian_dominant'), 'A minor 8A'); // 5th mode of A harmonic minor; E major would differ by 3 notes
  assert.equal(mk(A, 'minor_pentatonic'), 'A minor 8A');
  assert.equal(mk(C, 'major_pentatonic'), 'C major 8B');
  assert.equal(mk(A, 'blues'), 'A minor 8A');
  assert.equal(mk(A, 'hungarian_minor'), 'A minor 8A');
  assert.equal(mk(C, 'whole_tone'), 'C major 8B'); // no close key: the home-note key
});

test('mixing key: "home note" rule and the home-note key', () => {
  const m = mixKey({ tonic: D, scale: 'dorian' }, 'home');
  assert.deepEqual(m, { tonic: D, minor: true });
  assert.equal(camelot(m), '7A');
  assert.equal(standardKey(m), 'Dm');
  assert.deepEqual(homeKey({ tonic: E, scale: 'phrygian_dominant' }), { tonic: E, minor: false });
});

test('every scale and tonic maps to a key that shares most of its notes', () => {
  for (const id of scaleIds()) {
    for (let t = 0; t < 12; t++) {
      const m = mixKey({ tonic: t, scale: id });
      assert.ok(m.tonic >= 0 && m.tonic < 12);
      assert.match(camelot(m), /^(1[0-2]|[1-9])[AB]$/);
      assert.match(openKey(m), /^(1[0-2]|[1-9])[dm]$/);
    }
  }
});

test('standard key names (TKEY) and spelling', () => {
  assert.equal(standardKey({ tonic: 6, minor: true }), 'F#m');
  assert.equal(standardKey({ tonic: 6, minor: false }), 'Gb');
  assert.equal(standardKey({ tonic: 3, minor: true }), 'Ebm');
  assert.equal(standardKey({ tonic: 10, minor: true }, 'sharps'), 'A#m');
  assert.equal(standardKey({ tonic: 1, minor: false }, 'flats'), 'Db');
  for (let t = 0; t < 12; t++) for (const minor of [false, true]) assert.ok(standardKey({ tonic: t, minor }).length <= 3);
});

test('respell and pretty', () => {
  assert.equal(respell('Gb major', 'sharps'), 'F# major');
  assert.equal(respell('F# minor', 'flats'), 'Gb minor');
  assert.equal(respell('E Phrygian dominant (5th mode of A harmonic minor)', 'flats'), 'E Phrygian dominant (5th mode of A harmonic minor)');
  assert.equal(respell('Home note unclear: Eb major or C minor (same notes)', 'sharps'), 'Home note unclear: D# major or C minor (same notes)');
  assert.equal(respell('Bb Dorian ♭2', 'sharps'), 'A# Dorian ♭2');
  assert.equal(respell('No clear key', 'sharps'), 'No clear key');
  assert.equal(pretty('F# minor or Bb major: the 6th note is barely played'), 'F♯ minor or B♭ major: the 6th note is barely played');
  assert.equal(pretty('Ab'), 'A♭');
  assert.equal(pretty('Aeolian'), 'Aeolian');
});

test('Camelot order and compatibility', () => {
  const am = { tonic: A, minor: true }; // 8A
  assert.ok(compatible(am, { tonic: E, minor: true })); // 9A
  assert.ok(compatible(am, { tonic: D, minor: true })); // 7A
  assert.ok(compatible(am, { tonic: C, minor: false })); // 8B
  assert.ok(!compatible(am, { tonic: G, minor: false })); // 9B
  assert.ok(compatible({ tonic: 8, minor: true }, { tonic: 1, minor: true })); // 1A (G#m) and 12A (C#m) wrap around
  assert.equal(camelotOrder({ tonic: 8, minor: true }), 0); // 1A
  assert.equal(camelotOrder({ tonic: 4, minor: false }), 23); // 12B
  assert.ok(showsMixKey({ tonic: D, scale: 'dorian' }, mixKey({ tonic: D, scale: 'dorian' })));
  assert.ok(!showsMixKey({ tonic: A, scale: 'aeolian' }, mixKey({ tonic: A, scale: 'aeolian' })));
  assert.equal(label(D, 'dorian'), 'D Dorian');
});

test('settings: defaults, validation and storage form', () => {
  assert.deepEqual(parseSettings(null), DEFAULTS);
  assert.deepEqual(parseSettings('not json'), DEFAULTS);
  const s = parseSettings(JSON.stringify({ skin: 'mango', notation: 'openkey', workers: 3, batchLimit: 999999, tagging: true,
    spelling: 'nonsense', extra: 1 }));
  assert.equal(s.skin, 'mango');
  assert.equal(s.notation, 'openkey');
  assert.equal(s.workers, 3);
  assert.equal(s.batchLimit, 5000);
  assert.equal(s.tagging, true);
  assert.equal(s.spelling, 'key');
  assert.equal(serialiseSettings(DEFAULTS), '{}');
  assert.deepEqual(JSON.parse(serialiseSettings({ ...DEFAULTS, skin: 'minimal' })), { skin: 'minimal' });
  assert.equal(DEFAULTS.skin, 'studio');
  assert.equal(DEFAULTS.notation, 'name+camelot');
  assert.equal(DEFAULTS.tagging, false);
  assert.equal(DEFAULTS.traditions, 'western'); // 'auto' named ~1 in 10 ordinary songs in real libraries
  assert.equal(parseSettings('{"traditions":"indian"}').traditions, 'indian');
  assert.equal(parseSettings('{"traditions":"klingon"}').traditions, 'western');
});

const result = (over: Partial<Result> = {}): Result => ({
  key: { tonic: D, scale: 'dorian', third: 'minor' }, label: 'D Dorian', parent: 'same notes as C major', confidence: 0.61,
  key_confidence: 0.83, ambiguity: null, alternatives: [{ label: 'D minor', score: 0.2 }], tuning_cents: 14, duration: 201.37,
  engine: 'fusion', segments: [
    { start: 0, end: 120, key: { tonic: D, scale: 'dorian', third: 'minor' }, label: 'D Dorian', confidence: 0.6, key_confidence: 0.8 },
    { start: 120, end: 201.37, key: { tonic: E, scale: 'dorian', third: 'minor' }, label: 'E Dorian', confidence: 0.5, key_confidence: 0.7 },
  ], ...over,
});

test('CSV export', () => {
  const csv = toCsv([
    { path: '=evil.mp3', result: result() },
    { path: 'noise.wav', result: result({ key: null, label: 'No clear key', parent: null, best_guess: 'F# minor', segments: [] }) },
    { path: 'broken.mp3', error: 'can\'t decode this file' },
  ], { codeRule: 'notes', spelling: 'key' });
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith(`"'=evil.mp3","D Dorian",8B,1d,"C major","same notes as C major",0.61,0.83,`), lines[1]);
  assert.ok(lines[1].includes('"0:00 D Dorian (8B); 2:00 E Dorian (10B)"'), lines[1]);
  assert.ok(lines[1].includes(',14,443.6,201.4,"D E F G A B C",,"",""'), lines[1]);
  assert.ok(lines[2].startsWith('"noise.wav","No clear key",,,"",""'), lines[2]);
  assert.ok(lines[2].includes('"F# minor"'));
  assert.ok(lines[3].endsWith('"can\'t decode this file"'));
});

test('JSON export keeps the engine result and adds the codes', () => {
  const out = JSON.parse(toJson([{ path: 'a.mp3', result: result() }, { path: 'b.mp3', error: 'x' }], { codeRule: 'home', spelling: 'key' }));
  assert.equal(out[0].file, 'a.mp3');
  assert.equal(out[0].label, 'D Dorian');
  assert.equal(out[0].camelot, '7A');
  assert.equal(out[0].segments[1].camelot, '9A');
  assert.equal(out[0].reference_hz, 443.57);
  assert.deepEqual(out[0].scale_notes, ['D', 'E', 'F', 'G', 'A', 'B', 'C']);
  assert.deepEqual(out[1], { file: 'b.mp3', error: 'x' });
});

test('clock and reference pitch', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(75.9), '1:15');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(referenceHz(0), 440);
  assert.ok(Math.abs(referenceHz(100) - 466.16) < 0.01);
});

test('scale notes, spelled as on a score', () => {
  const n = (tonic: number, s: string, spelling: 'key' | 'sharps' | 'flats' = 'key') => scaleNotes({ tonic, scale: s }, spelling).join(' ');
  assert.equal(n(C, 'ionian'), 'C D E F G A B');
  assert.equal(n(D, 'dorian'), 'D E F G A B C');
  assert.equal(n(6, 'aeolian'), 'F# G# A B C# D E');
  assert.equal(n(3, 'ionian'), 'Eb F G Ab Bb C D');
  assert.equal(n(D, 'harmonic_minor'), 'D E F G A Bb C#'); // one letter each, not Db
  assert.equal(n(E, 'phrygian_dominant'), 'E F G# A B C D');
  assert.equal(n(A, 'minor_pentatonic'), 'A C D E G');
  assert.equal(n(3, 'ionian', 'sharps'), 'D# F G G# A# C D');
  assert.equal(n(6, 'aeolian', 'flats'), 'Gb Ab A B Db D E');
  for (const id of scaleIds()) {
    for (let t = 0; t < 12; t++) {
      const notes = scaleNotes({ tonic: t, scale: id });
      assert.ok(notes.every((x) => /^[A-G](#|b)?$/.test(x)), `${id} ${t}: ${notes}`);
      assert.equal(new Set(notes).size, notes.length);
    }
  }
});

test('tier 3: the nearest key\'s code (≈), notes with quarter tones and cents, tags', () => {
  const sikah = { tonic: E, scale: 'maqam_sikah', tonic_cents: 350 };
  const bayati = { tonic: D, scale: 'maqam_bayati', tonic_cents: 200 };
  const hijaz = { tonic: D, scale: 'maqam_hijaz', tonic_cents: 200 };
  const kalyan = { tonic: D, scale: 'mela_65', tonic_cents: 200 };
  assert.ok(isApprox(sikah) && !isApprox({ tonic: D, scale: 'dorian' }));
  assert.deepEqual(mixKey(bayati), { tonic: D, minor: true }); // ≈ 7A
  assert.deepEqual(mixKey(hijaz), { tonic: G, minor: true }); // G minor (its chord is in the scale), not Bb major
  assert.deepEqual(mixKey(kalyan), { tonic: A, minor: false }); // Lydian notes: A major
  assert.deepEqual(mixKey(sikah), { tonic: C, minor: false });
  assert.deepEqual(mixKey(bayati, 'home'), { tonic: D, minor: true });
  assert.ok(showsMixKey(bayati, mixKey(bayati)));
  assert.equal(scaleNotes(sikah).join(' '), 'E½♭ F G A B½♭ C D');
  assert.equal(scaleNotes(bayati, 'sharps').join(' '), 'D E½♭ F G A B♭ C'); // spelled by letter whatever the setting
  assert.equal(scaleNotes(kalyan).join(' '), 'D E F♯−14¢ G♯−10¢ A B−16¢ C♯−12¢'); // just intonation
  assert.equal(scaleNotes({ tonic: 1, scale: 'mela_65', tonic_cents: 100 })[0], 'D♭'); // C# Kalyan would need F double-sharp
  assert.equal(respell('Maqam Sikah on Bb half-flat', 'sharps'), 'Maqam Sikah on Bb half-flat');
  assert.equal(respell('Kalyan thaat, Sa = Db', 'sharps'), 'Kalyan thaat, Sa = C#');
  const r = result({ key: { ...bayati, third: 'minor' }, label: 'Maqam Bayati on D', parent: null, tradition: 'arabic',
    nearest_key: { tonic: D, minor: true }, segments: [] });
  const s = { codeRule: 'notes', spelling: 'key', tagFormat: 'standard', tagModeFrame: true } as const;
  assert.deepEqual(keyTags(r, s), { tkey: 'Dm', keyMode: 'Maqam Bayati on D' });
  const csv = toCsv([{ path: 'a.mp3', result: { ...r, tradition: 'indian', ragas: ['Yaman', 'Kalyani'] } }], { codeRule: 'notes', spelling: 'key' });
  assert.ok(csv.includes(',"D E½♭ F G A B♭ C",indian,"Yaman; Kalyani",""'), csv);
  const rows = [{ result: r, status: 'done', path: 'a' }, { result: result(), status: 'done', path: 'b' }] as unknown as Row[];
  assert.deepEqual(filterRows(rows, { ...DEFAULT_VIEW, category: 'world' }, 'notes').map((x) => x.path), ['a']);
});
