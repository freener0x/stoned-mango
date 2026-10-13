// One song in detail: the key with its code and mixing key, how sure the app is, honest
// notes, the timeline with local playback, alternatives, tuning and the engines' views.

import { useEffect, useRef, useState } from 'react';
import { go, useSettings, useStore } from './context.ts';
import { cents, clock, referenceHz } from './exporters.ts';
import { Chip, KeyLabel, Meter, sureOf, useText } from './keys.tsx';
import { camelot, codeFor, isApprox, mixKey, mixKeyName, parseLabel, pretty, scaleNotes, type KeyRef, type MixKey } from './notation.ts';
import type { Row } from './store.ts';
import { Timeline } from './Timeline.tsx';

const METHODS: Record<string, string> = {
  wav: 'WAV, read directly', 'mp3-webcodecs': 'MP3, decoded by the browser (WebCodecs)', decodeAudioData: 'decoded by the browser',
};
const PROFILES: Record<string, string> = { edma: 'EDMA (electronic)', bgate: 'Beatport (electronic)', temperley: 'Temperley', krumhansl: 'Krumhansl' };

interface Props {
  row: Row;
  onMixWith(m: MixKey): void;
  onWriteTag?(id: number): void;
}

export function SongView({ row, onMixWith, onWriteTag }: Props) {
  const store = useStore();
  const { settings } = useSettings();
  const text = useText();
  const r = row.result;
  const close = () => go('');
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [row.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('dialog[open]') && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const altKey = (label: string) => {
    const k = parseLabel(label);
    if (!k) return null;
    const m = mixKey(k, settings.codeRule);
    return <Chip m={m} code={codeFor(m, settings.notation) ?? camelot(m)} />;
  };

  return (
    <aside className="song" aria-label="Song details">
      <header className="song-head">
        <button className="icon-button back" onClick={close} aria-label="Back to the list">←</button>
        <div className="song-title">
          <h2 ref={heading} tabIndex={-1} title={row.path}>{row.name}</h2>
          <div className="song-sub">
            {row.folder && <span title={row.folder}>{row.folder}</span>}
            {r && <span>{clock(r.duration)}</span>}
            {row.method && <span>{METHODS[row.method] ?? row.method}</span>}
            {row.ms !== undefined && <span>analysed in {(row.ms / 1000).toFixed(1)} s</span>}
          </div>
        </div>
        <button className="icon-button close" onClick={close} aria-label="Close">×</button>
      </header>

      {row.status === 'queued' && <p className="song-wait">Waiting for its turn…</p>}
      {row.status === 'running' && (
        <div className="song-wait">
          <p>Analysing… {Math.round(row.progress * 100)}%</p>
          <Meter value={row.progress} label="Progress" />
        </div>
      )}
      {row.status === 'cancelled' && <p className="song-wait">Cancelled.</p>}
      {row.status === 'error' && <p className="callout bad">Couldn't analyse this file: {row.error}</p>}

      {r && (
        <>
          <section className="song-key" aria-label="Key">
            <KeyLabel r={r} full large />
            {r.key ? <KeySummary row={row} /> : (
              <p className="muted">
                The audio doesn't settle on one key: it may be drums, speech, noise, or music that keeps moving.
                {r.best_guess && <> Best guess: <strong>{text(r.best_guess)}</strong> ({Math.round(r.confidence * 100)}%).</>}
              </p>
            )}
            {r.ambiguity && <p className="callout">{text(r.ambiguity.text)}</p>}
          </section>

          <Player row={row} file={store.job(row.id)?.file} />

          {r.segments.length > 1 && (
            <section aria-label="Key changes">
              <h3>Key changes</h3>
              <ol className="sections">
                {r.segments.map((s, i) => (
                  <li key={i}>
                    <span className="mono">{clock(s.start)}–{clock(s.end)}</span>
                    <KeyLabel r={s} />
                    {s.key && <span className="muted small">{Math.round((s.key_confidence ?? s.confidence) * 100)}%</span>}
                    {s.key && <span className="muted small mono section-notes">{scaleNotes(s.key, settings.spelling).map(pretty).join(' ')}</span>}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="song-facts" aria-label="Details">
            {r.alternatives.length > 0 && (
              <div>
                <h3>Next most likely</h3>
                <ul className="alts">
                  {r.alternatives.map((a) => (
                    <li key={a.label}>{altKey(a.label)} <span>{text(a.label)}</span> <span className="muted small">{Math.round(a.score * 100)}%</span></li>
                  ))}
                </ul>
              </div>
            )}
            {r.tuning_cents !== null && (
              <div>
                <h3>Tuning</h3>
                <p>
                  <span className="mono">{cents(r.tuning_cents)} cents</span>{' '}
                  <span className="muted">(A = {referenceHz(r.tuning_cents).toFixed(1)} Hz
                    {Math.abs(r.tuning_cents) < 5 ? ', standard tuning' : r.tuning_cents > 0 ? ', a little sharp' : ', a little flat'})</span>
                </p>
              </div>
            )}
            {r.engines && (
              <details>
                <summary>What the classic key methods say</summary>
                <p className="muted small">Major/minor only, for comparison. The answer above combines the app's own neural network with these
                  and with bass and home-note cues.</p>
                <ul className="alts">
                  {Object.entries(r.engines.essentia).map(([p, label]) => (
                    <li key={p}>{altKey(label)} <span>{text(label)}</span> <span className="muted small">{PROFILES[p] ?? p}</span></li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <div className="song-actions">
            {r.key && (
              <button onClick={() => {
                onMixWith(mixKey(r.key!, settings.codeRule));
                if (matchMedia('(max-width: 1099px)').matches) close();
              }}>Show songs that mix with {codeFor(mixKey(r.key, settings.codeRule), settings.notation) ?? mixKeyName(mixKey(r.key, settings.codeRule))}</button>
            )}
            {settings.tagging && onWriteTag && r.key && <button onClick={() => onWriteTag(row.id)}>Write key tag</button>}
          </div>
          {row.tag && <p className={`callout${row.tag.state === 'error' ? ' bad' : ''}`}>{row.tag.message}</p>}
        </>
      )}
    </aside>
  );
}

function KeySummary({ row }: { row: Row }) {
  const { settings } = useSettings();
  const text = useText();
  const r = row.result!;
  if (r.tradition) return <WorldSummary row={row} />;
  const family = `${text(mixKeyName({ tonic: r.key!.tonic, minor: r.key!.third === 'minor' }, settings.spelling))}`;
  const exact = r.key!.scale !== 'ionian' && r.key!.scale !== 'aeolian';
  return (
    <div className="sure">
      <div className="sure-row">
        <Meter value={sureOf(r)} label="Key confidence" />
        <span><strong>{Math.round(sureOf(r) * 100)}%</strong> sure of the key ({family.replace(' major', ' major-type').replace(' minor', ' minor-type')})</span>
      </div>
      {exact && (
        <div className="sure-row">
          <Meter value={r.confidence} label="Mode confidence" />
          <span><strong>{Math.round(r.confidence * 100)}%</strong> sure of exactly {text(r.label)}</span>
        </div>
      )}
      {r.parent && <p className="muted small">{text(r.parent)[0].toUpperCase() + text(r.parent).slice(1)}.</p>}
      <ScaleNotes k={r.key!} label={r.label} />
    </div>
  );
}

const TRADITION: Record<string, string> = { arabic: 'Arabic maqam', turkish: 'Turkish makam', indian: 'Indian raga family' };

/** A maqam, makam or raga-family answer: how sure of the home note and the scale, and why tier 3 was used. */
function WorldSummary({ row }: { row: Row }) {
  const text = useText();
  const r = row.result!;
  const home = text(r.label.replace(/^.* (on|Sa =) /, ''));
  const ev = r.evidence;
  const heard = [
    ev && ev.deviation_cents >= 2.5 && `notes ${Math.round(ev.deviation_cents)} cents off the piano’s tuning on average`,
    ev && ev.quarter_tones >= 0.05 && 'quarter tones',
    ev && ev.drone >= 0.55 && 'a steady drone',
  ].filter(Boolean);
  return (
    <div className="sure">
      <p className="muted small">{TRADITION[r.tradition!] ?? r.tradition}{heard.length > 0 && <>; heard: {heard.join(', ')}</>}.</p>
      <div className="sure-row">
        <Meter value={sureOf(r)} label="Home note confidence" />
        <span><strong>{Math.round(sureOf(r) * 100)}%</strong> sure of the home note ({home})</span>
      </div>
      <div className="sure-row">
        <Meter value={r.confidence} label="Scale confidence" />
        <span><strong>{Math.round(r.confidence * 100)}%</strong> sure of exactly {text(r.label)}</span>
      </div>
      {r.parent && <p className="muted small">{text(r.parent)[0].toUpperCase() + text(r.parent).slice(1)}.</p>}
      {r.western && <p className="muted small">In Western terms: {text(r.western)}.</p>}
      {r.ragas && r.ragas.length > 0 && (
        <p className="small">Ragas with these notes: <strong>{r.ragas.join(', ')}</strong>{' '}
          <span className="muted">(a raga is more than its notes, so this is a shortlist)</span></p>
      )}
      <ScaleNotes k={r.key!} label={r.label} />
    </div>
  );
}

/** The scale's notes, for a piano roll's scale highlighting (FL Studio and the like). */
function ScaleNotes({ k, label }: { k: KeyRef; label: string }) {
  const { settings } = useSettings();
  const text = useText();
  const [copied, setCopied] = useState(false);
  const notes = scaleNotes(k, settings.spelling);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(notes.join(' '));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="scale-notes">
      <span className="muted small">Notes</span>
      <span className="notes mono" aria-label={`Notes of ${text(label)}`}>
        {notes.map((n, i) => <span key={i} className={i === 0 ? 'home' : undefined}>{pretty(n)}</span>)}
      </span>
      <button className="small-button" onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy'}</button>
      {isApprox(k) ? (
        <p className="muted small">The first note is home.{notes.some((n) => n.includes('½')) && ' ½♭ is a quarter tone flat.'}
          {notes.some((n) => n.includes('¢')) && ' Cents show how far a note sits from the step it’s named after.'} A piano roll
          can only come close: its nearest key is {pretty(mixKeyName(mixKey(k, 'notes'), settings.spelling))}, or retune the
          notes with your synth’s microtuning.</p>
      ) : (
        <p className="muted small">For a piano roll’s scale highlighting (FL Studio and others): root {pretty(notes[0])},
          {' '}{text(label).slice(notes[0].length + 1)}. The first note is home.</p>
      )}
    </div>
  );
}

/** Plays the file from this device (an object URL; nothing is fetched). */
function Player({ row, file }: { row: Row; file?: File }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const r = row.result!;

  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    setTime(0);
    setPlaying(false);
    setFailed(false);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (audio.current) setTime(audio.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = (t: number) => {
    setTime(t);
    if (audio.current && !failed) audio.current.currentTime = t;
  };
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => setFailed(true));
    else a.pause();
  };

  return (
    <section className="player" aria-label="Timeline">
      <div className="player-bar">
        <button className="play" onClick={toggle} disabled={!url || failed} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="mono">{clock(time)} / {clock(r.duration)}</span>
        {failed && <span className="muted small">This browser can't play this format (the analysis is unaffected).</span>}
      </div>
      <Timeline duration={r.duration} segments={r.segments} envelope={row.envelope} time={time} onSeek={seek} />
      {url && (
        <audio ref={audio} src={url} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)} onError={() => setFailed(true)} onSeeked={(e) => setTime(e.currentTarget.currentTime)} />
      )}
    </section>
  );
}
