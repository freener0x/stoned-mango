// The main screen: add files, watch the batch, browse results, open a song.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { go, useMediaQuery, useSettings, useStore, useStoreState } from './context.ts';
import { Dialog } from './Dialog.tsx';
import { toCsv, toJson } from './exporters.ts';
import { canPickWithHandles, fromDrop, fromFileList, isPhone, pickFiles, pickFolder, type Intake, type Picked } from './files.ts';
import { Results } from './Results.tsx';
import { SongView } from './SongView.tsx';
import type { StoreState } from './store.ts';
import { DEFAULT_VIEW, filterRows, sortRows, type TableView } from './table.ts';
import { useTagging } from './tagging/useTagging.tsx';

export const PHONE_WARNING_FILES = 20;

interface Notice {
  id: number;
  text: string;
  tone?: 'warn';
}

let noticeId = 0;

export function Workspace({ songId, active }: { songId?: number; active: boolean }) {
  const store = useStore();
  const state = useStoreState();
  const { settings } = useSettings();
  const [view, setView] = useState<TableView>(DEFAULT_VIEW);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [phoneAsk, setPhoneAsk] = useState<Picked[] | null>(null);
  const wide = useMediaQuery('(min-width: 1100px)');
  const tagging = useTagging();

  const notify = (text: string, tone?: 'warn') => setNotices((n) => [...n.slice(-2), { id: ++noticeId, text, tone }]);
  const visible = useMemo(() => sortRows(filterRows(state.rows, view, settings.codeRule), view, settings.codeRule),
    [state.rows, view, settings.codeRule]);
  const song = songId !== undefined ? state.rows.find((r) => r.id === songId) : undefined;

  useEffect(() => {
    if (active && songId !== undefined && !song) go('', true); // a stale link (the results are gone after a reload)
  }, [active, songId, song]);

  const accept = ({ picked, ignored }: Intake) => {
    const notes: string[] = [];
    if (ignored) notes.push(`${ignored} file${ignored > 1 ? 's' : ''} skipped (not audio).`);
    const room = Math.max(0, settings.batchLimit - state.rows.length);
    let take = picked;
    if (picked.length > room) {
      take = picked.slice(0, room);
      notify(`Only ${take.length} of ${picked.length} files were added: the list holds ${settings.batchLimit} at most. `
        + 'Clear the list, or raise the limit in Settings.', 'warn');
    }
    if (notes.length) notify(notes.join(' '));
    if (!take.length) {
      if (!picked.length && !ignored) notify('No audio files found there.');
      return;
    }
    if (isPhone() && take.length > PHONE_WARNING_FILES) setPhoneAsk(take);
    else store.add(take);
  };

  const download = (name: string, body: string, type: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const exportRows = visible.filter((r) => r.status === 'done' || r.status === 'error')
    .map((r) => ({ path: r.path, result: r.result, error: r.error }));
  const opts = { codeRule: settings.codeRule, spelling: settings.spelling };

  return (
    <div className={`workspace${song ? ' with-song' : ''}`}>
      <section className="workspace-main" aria-label="Your files" hidden={!!song && !wide}>
        <IntakePanel compact={state.rows.length > 0} onIntake={accept} />
        {notices.length > 0 && (
          <ul className="notices" aria-live="polite">
            {notices.map((n) => (
              <li key={n.id} className={n.tone === 'warn' ? 'warn' : undefined}>
                <span>{n.text}</span>
                <button className="icon-button" aria-label="Dismiss" onClick={() => setNotices((all) => all.filter((x) => x.id !== n.id))}>×</button>
              </li>
            ))}
          </ul>
        )}
        {state.rows.length > 0 && (
          <Transport state={state} exportCount={exportRows.length}
            onCsv={() => download('stoned-mango-keys.csv', toCsv(exportRows, opts), 'text/csv;charset=utf-8')}
            onJson={() => download('stoned-mango-keys.json', toJson(exportRows, opts), 'application/json')}
            onTagAll={settings.tagging ? () => tagging.start(visible.map((r) => r.id)) : undefined} />
        )}
        {state.rows.length > 0 && <Results rows={visible} total={state.rows.length} view={view} setView={setView} selected={songId} />}
      </section>
      {song && <SongView key={song.id} row={song} onMixWith={(m) => setView((v) => ({ ...v, mixWith: m, category: 'all' }))}
        onWriteTag={(id) => tagging.start([id])} />}
      {active && <DropOverlay onIntake={accept} />}
      <Dialog open={!!phoneAsk} title={`Analyse ${phoneAsk?.length ?? 0} files on this phone?`} onClose={() => setPhoneAsk(null)}
        actions={<>
          <button onClick={() => { store.add(phoneAsk!.slice(0, PHONE_WARNING_FILES)); setPhoneAsk(null); }}>Just the first {PHONE_WARNING_FILES}</button>
          <button className="primary" onClick={() => { store.add(phoneAsk!); setPhoneAsk(null); }}>Analyse all {phoneAsk?.length}</button>
        </>}>
        <p>Big batches take a while on a phone (roughly 10–20 seconds a song) and use a lot of battery. Keep this page open
          while it works; you can pause at any time.</p>
      </Dialog>
      {tagging.dialog}
    </div>
  );
}

function IntakePanel({ compact, onIntake }: { compact: boolean; onIntake(i: Intake): void }) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const engineState = useStoreState().engine;
  const handles = canPickWithHandles();
  const chooseFiles = async () => {
    if (!handles) return files.current?.click();
    const got = await pickFiles().catch(() => null);
    if (got) onIntake(got);
  };
  const chooseFolder = async () => {
    if (!handles) return folder.current?.click();
    const got = await pickFolder().catch(() => null);
    if (got) onIntake(got);
  };
  const inputs = (
    <>
      <input ref={files} id="files" type="file" multiple hidden accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg,.aif,.aiff"
        onChange={(e) => { onIntake(fromFileList(e.target.files ?? [])); e.target.value = ''; }} />
      <input ref={folder} id="folder" type="file" multiple hidden {...{ webkitdirectory: '' }}
        onChange={(e) => { onIntake(fromFileList(e.target.files ?? [])); e.target.value = ''; }} />
    </>
  );
  if (compact) {
    return (
      <div className="intake compact">
        {inputs}
        <span className="muted">Drop more files anywhere, or</span>
        <button onClick={chooseFiles}>Add files</button>
        <button onClick={chooseFolder}>Add a folder</button>
      </div>
    );
  }
  return (
    <div className="intake">
      {inputs}
      <div className="intake-art" aria-hidden="true">♪</div>
      <h1>Find the key of your songs</h1>
      <p>Drop MP3 or WAV files here, or a whole folder. Every key and mode, key changes over time, Camelot codes.</p>
      <div className="intake-buttons">
        <button className="primary" onClick={chooseFiles}>Choose songs</button>
        <button onClick={chooseFolder}>Choose a folder</button>
      </div>
      <p className="privacy-line">
        <span aria-hidden="true">🔒</span> Your music stays on this device. It's analysed here, in your browser, and never uploaded.
      </p>
      {engineState === 'loading' && <p className="muted small">Loading the analysis engine…</p>}
    </div>
  );
}

function DropOverlay({ onIntake }: { onIntake(i: Intake): void }) {
  const [over, setOver] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(onIntake);
  useEffect(() => {
    latest.current = onIntake;
  });
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      setOver(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOver(false), 200);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setOver(false);
      fromDrop(e.dataTransfer!).then((i) => latest.current(i), () => undefined);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
  return over ? <div className="drop-overlay" aria-hidden="true"><div>Drop to find the keys</div></div> : null;
}

function eta(s: number): string {
  if (s < 45) return 'less than a minute left';
  if (s < 90) return 'about a minute left';
  if (s < 3600) return `about ${Math.round(s / 60)} min left`;
  return `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`;
}

interface TransportProps {
  state: StoreState;
  exportCount: number;
  onCsv(): void;
  onJson(): void;
  onTagAll?(): void;
}

function Transport({ state, exportCount, onCsv, onJson, onTagAll }: TransportProps) {
  const store = useStore();
  const b = state.batch;
  const done = state.rows.filter((r) => r.status === 'done').length;
  let status: ReactNode;
  if (state.engine === 'failed') status = <span className="bad">The analysis engine failed to load: {state.engineError}</span>;
  else if (b.busy) {
    status = (
      <>
        <strong>{b.paused ? 'Paused' : 'Analysing'}</strong> {b.finished} of {b.total}
        {b.etaSeconds !== null && !b.paused && <> · {eta(b.etaSeconds)}</>}
      </>
    );
  } else status = <><strong>{done}</strong> analysed{state.rows.length > done ? ` · ${state.rows.length - done} not` : ''}</>;

  return (
    <div className="transport" role="region" aria-label="Batch">
      <div className="transport-controls">
        <button onClick={() => (b.paused ? store.resume() : store.pause())} disabled={!b.busy} aria-pressed={b.paused}>
          {b.paused ? '▶ Resume' : '❚❚ Pause'}
        </button>
        <button onClick={() => store.cancel()} disabled={!b.busy}>■ Cancel</button>
      </div>
      <div className="lcd" aria-live="polite">
        <div className="lcd-text">{status}</div>
        <div className="progress" role="progressbar" aria-label="Batch progress" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(b.progress * 100)}>
          <div style={{ width: `${(b.busy ? b.progress : 1) * 100}%` }} />
        </div>
        <div className="lcd-sub">{state.workers} worker{state.workers === 1 ? '' : 's'}</div>
      </div>
      <div className="transport-actions">
        <button onClick={() => store.clear()} disabled={state.rows.every((r) => r.status === 'queued' || r.status === 'running')}>
          {b.busy ? 'Clear finished' : 'Clear list'}
        </button>
        <div className="button-group" role="group" aria-label="Export">
          <button onClick={onCsv} disabled={!exportCount} title="Spreadsheet (opens in Excel, Numbers, Google Sheets)">Export CSV</button>
          <button onClick={onJson} disabled={!exportCount}>JSON</button>
        </div>
        {onTagAll && <button onClick={onTagAll} disabled={!done}>Write key tags…</button>}
      </div>
    </div>
  );
}
