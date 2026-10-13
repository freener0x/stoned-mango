// The results table's filters and sort orders (pure functions over the rows).

import { camelotOrder, compatible, mixKey, type CodeRule, type MixKey } from './notation.ts';
import type { Row } from './store.ts';

export type SortKey = 'added' | 'name' | 'key' | 'sure' | 'tuning' | 'changes' | 'length';
export type Category = 'all' | 'major' | 'minor' | 'modes' | 'world' | 'changes' | 'unsure' | 'nokey' | 'problems';

export interface TableView {
  query: string;
  category: Category;
  sort: SortKey;
  descending: boolean;
  /** Only keys that mix with this one (Camelot neighbours). */
  mixWith: MixKey | null;
}

export const DEFAULT_VIEW: TableView = { query: '', category: 'all', sort: 'added', descending: false, mixWith: null };

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'all', label: 'All files' },
  { id: 'major', label: 'Major keys' },
  { id: 'minor', label: 'Minor keys' },
  { id: 'modes', label: 'Modes and other scales' },
  { id: 'world', label: 'Maqam, makam and raga' },
  { id: 'changes', label: 'With key changes' },
  { id: 'unsure', label: 'Less than 50% sure' },
  { id: 'nokey', label: 'No clear key' },
  { id: 'problems', label: 'Problems' },
];

export const UNSURE_BELOW = 0.5;

const sure = (r: Row) => (r.result ? r.result.key_confidence ?? r.result.confidence : -1);

function inCategory(r: Row, c: Category): boolean {
  const res = r.result;
  switch (c) {
    case 'all': return true;
    case 'major': return res?.key?.third === 'major';
    case 'minor': return res?.key?.third === 'minor';
    case 'modes': return !!res?.key && res.key.scale !== 'ionian' && res.key.scale !== 'aeolian';
    case 'world': return !!res?.tradition;
    case 'changes': return (res?.segments.length ?? 0) > 1;
    case 'unsure': return !!res?.key && sure(r) < UNSURE_BELOW;
    case 'nokey': return r.status === 'done' && !res?.key;
    case 'problems': return r.status === 'error' || r.status === 'cancelled';
  }
}

export function filterRows(rows: Row[], v: TableView, rule: CodeRule): Row[] {
  const q = v.query.trim().toLowerCase();
  return rows.filter((r) => (!q || r.path.toLowerCase().includes(q)) && inCategory(r, v.category)
    && (!v.mixWith || (!!r.result?.key && compatible(mixKey(r.result.key, rule), v.mixWith))));
}

/** Finished results first in the chosen order; unfinished and failed files keep their place at the end. */
export function sortRows(rows: Row[], v: TableView, rule: CodeRule): Row[] {
  if (v.sort === 'added') return v.descending ? [...rows].reverse() : rows;
  const value = (r: Row): number | string | null => {
    const res = r.result;
    switch (v.sort) {
      case 'name': return r.name.toLowerCase();
      case 'key': return res?.key ? camelotOrder(mixKey(res.key, rule)) : res ? 99 : null;
      case 'sure': return res ? sure(r) : null;
      case 'tuning': return res?.tuning_cents ?? null;
      case 'changes': return res ? Math.max(0, res.segments.length - 1) : null;
      case 'length': return res?.duration ?? null;
      default: return r.id;
    }
  };
  const keyed = rows.map((r) => ({ r, k: value(r) }));
  const dir = v.descending ? -1 : 1;
  keyed.sort((a, b) => {
    if (a.k === null || b.k === null) return a.k === null && b.k === null ? a.r.id - b.r.id : a.k === null ? 1 : -1;
    const c = typeof a.k === 'string' ? a.k.localeCompare(b.k as string, undefined, { numeric: true }) : a.k - (b.k as number);
    return c ? c * dir : a.r.id - b.r.id;
  });
  return keyed.map((x) => x.r);
}
