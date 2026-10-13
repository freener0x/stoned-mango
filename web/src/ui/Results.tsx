// The results: a sortable, filterable table on wide screens, a list of cards on phones.

import { memo, type ReactNode } from 'react';
import { go, useMediaQuery, useSettings } from './context.ts';
import { cents, clock } from './exporters.ts';
import { Chip, KeyLabel, Meter, sureOf, useText } from './keys.tsx';
import { codeFor, mixKeyName, type Notation } from './notation.ts';
import type { Row } from './store.ts';
import { CATEGORIES, DEFAULT_VIEW, type Category, type SortKey, type TableView } from './table.ts';

interface Props {
  rows: Row[];
  total: number;
  view: TableView;
  setView(update: (v: TableView) => TableView): void;
  selected?: number;
}

const COLUMNS: { key: SortKey; label: string; className?: string; title?: string }[] = [
  { key: 'name', label: 'File' },
  { key: 'key', label: 'Key', title: 'Sorted around the Camelot wheel: 1A, 1B, 2A…' },
  { key: 'sure', label: 'Confidence', className: 'col-sure', title: 'How sure the app is of the home note and major/minor' },
  { key: 'changes', label: 'Changes', className: 'col-num' },
  { key: 'tuning', label: 'Tuning', className: 'col-num wide-only' },
  { key: 'length', label: 'Length', className: 'col-num wide-only' },
];

export function Results({ rows, total, view, setView, selected }: Props) {
  const { settings } = useSettings();
  const text = useText();
  const narrow = useMediaQuery('(max-width: 719px)');
  const open = (id: number) => go(`song/${id}`, selected !== undefined);
  const sortBy = (key: SortKey) => setView((v) => ({ ...v, sort: key, descending: v.sort === key ? !v.descending : key === 'sure' }));
  const filtered = view.query || view.category !== 'all' || view.mixWith;

  return (
    <section className="results" aria-label="Results">
      <div className="filters">
        <input type="search" placeholder="Filter by name" aria-label="Filter by name" value={view.query}
          onChange={(e) => setView((v) => ({ ...v, query: e.target.value }))} />
        <select aria-label="Show" value={view.category} onChange={(e) => setView((v) => ({ ...v, category: e.target.value as Category }))}>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {narrow && (
          <select aria-label="Sort by" value={view.sort} onChange={(e) => setView((v) => ({ ...v, sort: e.target.value as SortKey,
            descending: e.target.value === 'sure' }))}>
            <option value="added">In the order added</option>
            <option value="name">By name</option>
            <option value="key">By key (Camelot order)</option>
            <option value="sure">Most confident first</option>
            <option value="changes">By key changes</option>
          </select>
        )}
        {view.mixWith && (
          <span className="filter-chip">
            Mixes with <Chip m={view.mixWith} code={codeFor(view.mixWith, settings.notation) ?? text(mixKeyName(view.mixWith, settings.spelling))} />
            <button className="icon-button" aria-label="Remove the key filter" onClick={() => setView((v) => ({ ...v, mixWith: null }))}>×</button>
          </span>
        )}
        {filtered && <span className="muted small">{rows.length} of {total}</span>}
        {filtered && <button className="link" onClick={() => setView(() => DEFAULT_VIEW)}>Show all</button>}
      </div>

      {rows.length === 0 && <p className="muted empty">Nothing matches.</p>}
      {narrow ? (
        <ul className="cards">
          {rows.map((r) => <Card key={r.id} row={r} selected={r.id === selected} onOpen={open} notation={settings.notation} />)}
        </ul>
      ) : rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} className={c.className} title={c.title}
                  aria-sort={view.sort === c.key ? (view.descending ? 'descending' : 'ascending') : undefined}>
                  <button className="sort" onClick={() => sortBy(c.key)}>
                    {c.label}<span className="sort-mark" aria-hidden="true">{view.sort === c.key ? (view.descending ? '▼' : '▲') : ''}</span>
                  </button>
                </th>
              ))}
              {settings.tagging && <th className="col-tag"><span className="visually-hidden">Tag</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <TableRow key={r.id} row={r} selected={r.id === selected} onOpen={open} tagging={settings.tagging}
              notation={settings.notation} />)}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Status({ row }: { row: Row }): ReactNode {
  if (row.status === 'queued') return <span className="muted">Waiting…</span>;
  if (row.status === 'running') return <span className="running"><Meter value={row.progress} label="Progress" /> <span className="muted small">{Math.round(row.progress * 100)}%</span></span>;
  if (row.status === 'cancelled') return <span className="muted">Cancelled</span>;
  if (row.status === 'error') return <span className="bad" title={row.error}>Couldn't analyse: {row.error}</span>;
  return row.result ? <KeyLabel r={row.result} /> : null;
}

const TAG_ICONS = { writing: '…', done: '✓', skipped: '–', error: '!' } as const;

// Rows only re-render when their own snapshot changes (notation is passed so a settings change re-renders them).
const TableRow = memo(function TableRow({ row, selected, onOpen, tagging }: { row: Row; selected: boolean; onOpen(id: number): void;
  tagging: boolean; notation: Notation }) {
  const r = row.result;
  return (
    <tr className={`${selected ? 'selected' : ''} status-${row.status}`} onClick={() => onOpen(row.id)}>
      <td className="col-file">
        <button className="file-button" onClick={(e) => { e.stopPropagation(); onOpen(row.id); }} title={row.path}>
          <span className="file-name">{row.name}</span>
          {row.folder && <span className="file-folder">{row.folder}</span>}
        </button>
      </td>
      <td className="col-key"><Status row={row} /></td>
      <td className="col-sure">{r?.key && <><Meter value={sureOf(r)} label="Confidence" /> <span className="pct">{Math.round(sureOf(r) * 100)}%</span></>}</td>
      <td className="col-num">{r ? (r.segments.length > 1 ? r.segments.length - 1 : '–') : ''}</td>
      <td className="col-num wide-only">{r?.tuning_cents != null ? `${cents(r.tuning_cents)}¢` : ''}</td>
      <td className="col-num wide-only">{r ? clock(r.duration) : ''}</td>
      {tagging && <td className={`col-tag tag-${row.tag?.state ?? 'none'}`} title={row.tag?.message}>{row.tag ? TAG_ICONS[row.tag.state] : ''}</td>}
    </tr>
  );
});

const Card = memo(function Card({ row, selected, onOpen }: { row: Row; selected: boolean; onOpen(id: number): void; notation: Notation }) {
  const r = row.result;
  return (
    <li className={`card${selected ? ' selected' : ''} status-${row.status}`}>
      <button className="card-button" onClick={() => onOpen(row.id)}>
        <span className="card-top">
          <span className="file-name">{row.name}</span>
          {r && <span className="muted small mono">{clock(r.duration)}</span>}
        </span>
        <span className="card-key"><Status row={row} /></span>
        {r?.key && (
          <span className="card-meta">
            <Meter value={sureOf(r)} label="Confidence" /> <span className="pct">{Math.round(sureOf(r) * 100)}%</span>
            {r.segments.length > 1 && <span className="muted small">{r.segments.length - 1} key change{r.segments.length > 2 ? 's' : ''}</span>}
            {row.tag?.state === 'done' && <span className="muted small">tagged ✓</span>}
          </span>
        )}
      </button>
    </li>
  );
});
