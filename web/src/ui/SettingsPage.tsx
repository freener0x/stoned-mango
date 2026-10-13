// Settings: how keys look, how the analysis runs, and optional key tags.
// Only these preferences are stored (in this browser); results never are.

import type { ReactNode } from 'react';
import { defaultWorkerCount, MAX_WORKERS } from '../engine/pool.ts';
import { useSettings } from './context.ts';
import { Chip } from './keys.tsx';
import { camelot, codeFor, mixKey, mixKeyName, openKey, pretty, respell, standardKey, type KeyRef } from './notation.ts';
import { BATCH_LIMIT_MAX, type Settings, type Skin, type TagFormat, type Traditions } from './settings.ts';
import { label } from '../engine/scales.ts';

const SKINS: { id: Skin; name: string; text: string }[] = [
  { id: 'studio', name: 'Studio', text: 'Dark, like a DAW' },
  { id: 'mango', name: 'Mango', text: 'Warm and light' },
  { id: 'minimal', name: 'Minimal', text: 'Plain; follows your device’s light or dark mode' },
];

const EXAMPLES: KeyRef[] = [{ tonic: 9, scale: 'aeolian' }, { tonic: 2, scale: 'dorian' }, { tonic: 6, scale: 'aeolian' }];

function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-control">{children}</div>
      {hint && <p className="hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

function Example({ k, s }: { k: KeyRef; s: Settings }) {
  const m = mixKey(k, s.codeRule);
  const code = codeFor(m, s.notation);
  const name = pretty(respell(label(k.tonic, k.scale), s.spelling));
  const codeOnly = s.notation === 'camelot' || s.notation === 'openkey';
  const mix = k.scale !== 'aeolian' && k.scale !== 'ionian' ? pretty(mixKeyName(m, s.spelling)) : null;
  return (
    <span className="key">
      {!codeOnly && <span className="key-name">{name}</span>}
      {code && <Chip m={m} code={code} />}
      {mix && !codeOnly && <span className="key-mix">({mix})</span>}
    </span>
  );
}

export function SettingsPage() {
  const { settings: s, update, reset } = useSettings();
  const auto = defaultWorkerCount();
  const dorian: KeyRef = { tonic: 2, scale: 'dorian' };
  const tkey = (f: TagFormat, k: KeyRef) => {
    const m = mixKey(k, s.codeRule);
    return f === 'camelot' ? camelot(m) : f === 'openkey' ? openKey(m) : standardKey(m, s.spelling);
  };

  return (
    <main className="page settings">
      <h1>Settings</h1>
      <p className="muted">Saved in this browser only. Your results, file names and music are never saved anywhere.</p>

      <section>
        <h2>Look</h2>
        <div className="skins" role="radiogroup" aria-label="Skin">
          {SKINS.map((k) => (
            <button key={k.id} role="radio" aria-checked={s.skin === k.id} className={`skin-option skin-${k.id}`} data-skin-preview={k.id}
              onClick={() => update({ skin: k.id })}>
              <span className="skin-swatch" aria-hidden="true"><span /><span /><span /></span>
              <span className="skin-name">{k.name}</span>
              <span className="skin-text">{k.text}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>Keys</h2>
        <Field id="notation" label="Show keys as">
          <select id="notation" value={s.notation} onChange={(e) => update({ notation: e.target.value as Settings['notation'] })}>
            <option value="name+camelot">Name and Camelot code</option>
            <option value="name+openkey">Name and Open Key code</option>
            <option value="name">Name only</option>
            <option value="camelot">Camelot code only</option>
            <option value="openkey">Open Key code only</option>
          </select>
        </Field>
        <div className="examples" aria-label="Examples">{EXAMPLES.map((k, i) => <Example key={i} k={k} s={s} />)}</div>
        <Field id="code-rule" label="Codes for modes" hint={<>
          A mode such as D Dorian isn’t major or minor, so it borrows a code. <em>Same notes</em> uses the major key with exactly
          its notes, which is what harmonic mixing needs. <em>Same home note</em> uses the major or minor key on the same note,
          which is closer to what other key finders report.</>}>
          <select id="code-rule" value={s.codeRule} onChange={(e) => update({ codeRule: e.target.value as Settings['codeRule'] })}>
            <option value="notes">Same notes: D Dorian is {camelot(mixKey(dorian, 'notes'))} ({mixKeyName(mixKey(dorian, 'notes'))})</option>
            <option value="home">Same home note: D Dorian is {camelot(mixKey(dorian, 'home'))} ({mixKeyName(mixKey(dorian, 'home'))})</option>
          </select>
        </Field>
        <Field id="spelling" label="Sharps and flats">
          <select id="spelling" value={s.spelling} onChange={(e) => update({ spelling: e.target.value as Settings['spelling'] })}>
            <option value="key">As in the key signature (F♯ minor, G♭ major)</option>
            <option value="sharps">Always sharps (F♯, G♯, C♯)</option>
            <option value="flats">Always flats (G♭, A♭, D♭)</option>
          </select>
        </Field>
      </section>

      <section>
        <h2>Analysis</h2>
        <Field id="workers" label="Songs analysed at once" hint="More is faster on computers with many cores, but uses more memory.">
          <select id="workers" value={s.workers} onChange={(e) => update({ workers: Number(e.target.value) })}>
            <option value={0}>Automatic ({auto} on this device)</option>
            {Array.from({ length: MAX_WORKERS }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field id="traditions" label="Maqam, makam and raga scales" hint={<>
          Arabic maqamat, Turkish makams and Indian thaats and melakartas use notes between the piano’s keys. Their DJ code is
          the nearest major or minor key’s, shown with ≈. <em>Automatic</em> names one only when it clearly beats every Western
          scale (none of 604 real electronic tracks was renamed), so it misses most real maqam and raga recordings: if you play
          that music, choose <em>Always</em> for its tradition. Applies to files analysed after the change.</>}>
          <select id="traditions" value={s.traditions} onChange={(e) => update({ traditions: e.target.value as Traditions })}>
            <option value="western">Never: Western scales only</option>
            <option value="auto">Automatic: only when a song clearly shows them</option>
            <option value="all">Whenever one fits better than a Western scale</option>
            <option value="arabic">Always, Arabic maqamat</option>
            <option value="turkish">Always, Turkish makams</option>
            <option value="indian">Always, Indian thaats and melakartas</option>
          </select>
        </Field>
        <Field id="batch-limit" label="Most files in the list" hint="A very long list can make the page slow on older devices.">
          <input id="batch-limit" type="number" min={1} max={BATCH_LIMIT_MAX} value={s.batchLimit}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (n >= 1) update({ batchLimit: Math.min(BATCH_LIMIT_MAX, n) });
            }} />
        </Field>
      </section>

      <section>
        <h2>Key tags</h2>
        <div className="field toggle">
          <label>
            <input type="checkbox" checked={s.tagging} onChange={(e) => update({ tagging: e.target.checked })} />
            Write keys into the files’ tags, for DJ software
          </label>
          <p className="hint">Off unless you switch it on, because it changes your files. Rekordbox, Serato, Traktor and Engine DJ
            read the key from the tag. Only the tag is changed: the audio is never re-encoded, and other tags (artist, artwork…)
            are kept. In Chrome and Edge the files can be updated in place, after the browser asks your permission; other
            browsers download tagged copies.</p>
        </div>
        {s.tagging && (
          <>
            <Field id="tag-format" label="Key format in the tag">
              <select id="tag-format" value={s.tagFormat} onChange={(e) => update({ tagFormat: e.target.value as TagFormat })}>
                <option value="standard">Standard: {tkey('standard', { tonic: 9, scale: 'aeolian' })}, {tkey('standard', { tonic: 6, scale: 'ionian' })}</option>
                <option value="camelot">Camelot: {tkey('camelot', { tonic: 9, scale: 'aeolian' })}, {tkey('camelot', { tonic: 6, scale: 'ionian' })}</option>
                <option value="openkey">Open Key: {tkey('openkey', { tonic: 9, scale: 'aeolian' })}, {tkey('openkey', { tonic: 6, scale: 'ionian' })} (Traktor’s notation)</option>
              </select>
            </Field>
            <p className="hint">Modes are tagged with their code’s key (see “Codes for modes”): D Dorian is written as {tkey(s.tagFormat, dorian)}.
              MP3: ID3 “initial key” (TKEY). WAV: an ID3 chunk, which some DJ programs don’t read.</p>
            <p className="hint"><strong>Traktor:</strong> the tag shows in the <em>Key Text</em> column (run Check Consistency for
              tracks already in your collection). Traktor’s own Key column doesn’t take Camelot codes, so Open Key or standard
              works best. Traktor keeps its own data for WAV files, so check one tagged WAV there before tagging a whole folder.</p>
            <div className="field toggle">
              <label>
                <input type="checkbox" checked={s.tagModeFrame} onChange={(e) => update({ tagModeFrame: e.target.checked })} />
                Also save the full result (“D Dorian”) in a KEY_MODE tag
              </label>
            </div>
          </>
        )}
      </section>

      <section>
        <button onClick={reset}>Reset all settings</button>
      </section>
    </main>
  );
}
