// CSV and JSON exports, made on the device (nothing is sent anywhere).

import type { Result } from '../engine/analysis.ts';
import type { Section } from '../engine/timeline.ts';
import { camelot, mixKey, mixKeyName, openKey, respell, scaleNotes, type CodeRule, type Spelling } from './notation.ts';

export interface ExportRow {
  path: string;
  result?: Result;
  error?: string;
}

export interface ExportOptions {
  codeRule: CodeRule;
  spelling: Spelling;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** Reference pitch for a tuning offset: A4 = 440 * 2^(cents / 1200). */
export const referenceHz = (cents: number) => 440 * 2 ** (cents / 1200);

function codes(key: Section['key'] | Result['key'], o: ExportOptions) {
  if (!key) return { camelot: '', open_key: '', mix_key: '' };
  const m = mixKey(key, o.codeRule);
  return { camelot: camelot(m), open_key: openKey(m), mix_key: mixKeyName(m, o.spelling) };
}

function changes(r: Result, o: ExportOptions): string {
  if (r.segments.length < 2) return '';
  return r.segments.map((s) => {
    const c = codes(s.key, o).camelot;
    return `${clock(s.start)} ${respell(s.label, o.spelling)}${c ? ` (${c})` : ''}`;
  }).join('; ');
}

const round = (x: number | null | undefined, digits: number) => (x == null ? '' : String(Number(x.toFixed(digits))));

export const CSV_COLUMNS = ['file', 'key', 'camelot', 'open_key', 'mix_key', 'parent', 'confidence', 'key_confidence', 'note',
  'best_guess', 'key_changes', 'tuning_cents', 'reference_hz', 'duration_s', 'scale_notes', 'tradition', 'ragas', 'error'] as const;

/** Spreadsheet-safe text: quoted, and never read as a formula (=, +, -, @ at the start). */
function text(s: string): string {
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: ExportRow[], o: ExportOptions): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const { path, result: r, error } of rows) {
    const c = codes(r?.key ?? null, o);
    const cells: Record<(typeof CSV_COLUMNS)[number], string> = {
      file: text(path),
      key: text(r ? respell(r.label, o.spelling) : ''),
      camelot: c.camelot,
      open_key: c.open_key,
      mix_key: text(c.mix_key),
      parent: text(r?.parent ? respell(r.parent, o.spelling) : ''),
      confidence: round(r?.confidence, 3),
      key_confidence: round(r?.key_confidence, 3),
      note: text(r?.ambiguity ? respell(r.ambiguity.text, o.spelling) : ''),
      best_guess: text(r?.best_guess ? respell(r.best_guess, o.spelling) : ''),
      key_changes: text(r ? changes(r, o) : ''),
      tuning_cents: round(r?.tuning_cents, 1),
      reference_hz: r?.tuning_cents == null ? '' : round(referenceHz(r.tuning_cents), 1),
      duration_s: round(r?.duration, 1),
      scale_notes: text(r?.key ? scaleNotes(r.key, o.spelling).join(' ') : ''),
      tradition: r?.tradition ?? '',
      ragas: text(r?.ragas?.join('; ') ?? ''),
      error: text(error ?? ''),
    };
    lines.push(CSV_COLUMNS.map((k) => cells[k]).join(','));
  }
  // The byte-order mark makes Excel read the file as UTF-8 (file names, and scale names such as "Dorian ♯4").
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function toJson(rows: ExportRow[], o: ExportOptions): string {
  const out = rows.map(({ path, result: r, error }) => {
    if (!r) return { file: path, error: error ?? 'not analysed' };
    return {
      file: path,
      ...r,
      ...codes(r.key, o),
      scale_notes: r.key ? scaleNotes(r.key, o.spelling) : null,
      reference_hz: r.tuning_cents == null ? null : Number(referenceHz(r.tuning_cents).toFixed(2)),
      segments: r.segments.map((s) => ({ ...s, ...codes(s.key, o) })),
    };
  });
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** "+14", "-3", "0" (never "-0"). */
export function cents(x: number): string {
  const c = Math.round(x) || 0;
  return `${c > 0 ? '+' : ''}${c}`;
}
