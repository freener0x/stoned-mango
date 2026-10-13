// The "write key tags" flow: says what will happen, asks the browser for permission where
// files can be changed in place, writes and checks each file, and offers tagged copies
// (one file, or a .zip) for the rest.

import { useState, type ReactNode } from 'react';
import { useSettings, useStore } from '../context.ts';
import { Dialog } from '../Dialog.tsx';
import type { Store } from '../store.ts';
import { tagFile, toBlob, writeInPlace, type KeyTags, type Part } from './files.ts';
import { TagError } from './id3.ts';
import { isTaggable, keyTags } from './keys.ts';
import { zip, ZIP_LIMIT } from './zip.ts';

interface Plan {
  inPlace: number[];
  copies: number[];
  skipped: { id: number; reason: string }[];
}

type Phase =
  | { step: 'confirm'; plan: Plan }
  | { step: 'working'; done: number; total: number }
  | { step: 'finished'; lines: string[] };

function makePlan(store: Store, ids: number[], keysFor: (id: number) => KeyTags | null): Plan {
  const plan: Plan = { inPlace: [], copies: [], skipped: [] };
  for (const id of ids) {
    const src = store.source(id);
    const job = store.job(id);
    if (!src || !job || job.status !== 'done') continue; // not analysed (yet)
    if (!keysFor(id)) plan.skipped.push({ id, reason: 'no clear key' });
    else if (!isTaggable(job.file.name)) plan.skipped.push({ id, reason: 'only MP3 and WAV files can be tagged' });
    else if (src.handle) plan.inPlace.push(id);
    else plan.copies.push(id);
  }
  return plan;
}

async function permitted(handle: FileSystemHandle): Promise<boolean> {
  try {
    if ((await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
    return (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function useTagging(): { start(ids: number[]): void; dialog: ReactNode } {
  const store = useStore();
  const { settings } = useSettings();
  const [phase, setPhase] = useState<Phase | null>(null);
  const keysFor = (id: number) => {
    const r = store.job(id)?.result;
    return r ? keyTags(r, settings) : null;
  };

  const start = (ids: number[]) => setPhase({ step: 'confirm', plan: makePlan(store, ids, keysFor) });

  const run = async (plan: Plan) => {
    const total = plan.inPlace.length + plan.copies.length;
    let done = 0;
    setPhase({ step: 'working', done, total });
    for (const s of plan.skipped) store.setTag(s.id, { state: 'skipped', message: `Not tagged: ${s.reason}.` });
    // One permission prompt per folder; files picked one by one ask one by one.
    const allowed = new Map<FileSystemHandle, boolean>();
    for (const id of plan.inPlace) {
      const src = store.source(id)!;
      const h = src.root ?? src.handle!;
      if (!allowed.has(h)) allowed.set(h, await permitted(h));
    }
    let written = 0, failed = 0, refused = 0;
    const copies: { id: number; name: string; parts: Part[]; size: number; tkey: string }[] = [];
    for (const id of [...plan.inPlace, ...plan.copies]) {
      const src = store.source(id)!;
      const keys = keysFor(id)!;
      const inPlace = !!src.handle && !!allowed.get(src.root ?? src.handle);
      try {
        if (src.handle && !inPlace) {
          refused++;
          store.setTag(id, { state: 'skipped', message: 'Not tagged: the browser was not allowed to change this file.' });
          continue;
        }
        store.setTag(id, { state: 'writing', message: 'Writing the key tag…' });
        const file = src.handle ? await src.handle.getFile() : store.job(id)!.file;
        const tagged = await tagFile(file, keys);
        if (inPlace) {
          store.replaceFile(id, await writeInPlace(src.handle!, tagged, keys));
          written++;
          store.setTag(id, { state: 'done', message: `Key tag written: ${keys.tkey}${keys.keyMode ? ` (${keys.keyMode})` : ''}.` });
        } else copies.push({ id, name: src.path, parts: tagged.parts, size: tagged.size, tkey: keys.tkey });
      } catch (e) {
        failed++;
        const reason = e instanceof TagError ? e.message : (e as Error)?.message ?? String(e);
        store.setTag(id, { state: e instanceof TagError ? 'skipped' : 'error', message: `Not tagged: ${reason}.` });
      }
      setPhase({ step: 'working', done: ++done, total });
    }
    if (copies.length === 1) {
      const c = copies[0];
      download(toBlob({ parts: c.parts, size: c.size, kind: /\.mp3$/i.test(c.name) ? 'mp3' : 'wav' }), c.name.split('/').pop()!);
    } else if (copies.length > 1) {
      // Split into zips under 4 GB.
      const groups: (typeof copies)[] = [[]];
      let size = 0;
      for (const c of copies) {
        if (size + c.size > ZIP_LIMIT && groups[groups.length - 1].length) {
          groups.push([]);
          size = 0;
        }
        groups[groups.length - 1].push(c);
        size += c.size;
      }
      for (const [i, g] of groups.entries()) {
        download(await zip(g.map((c) => ({ name: c.name, parts: c.parts }))),
          groups.length > 1 ? `stoned-mango-tagged-${i + 1}.zip` : 'stoned-mango-tagged.zip');
      }
    }
    for (const c of copies) store.setTag(c.id, { state: 'done', message: `Tagged copy downloaded: ${c.tkey}.` });
    const lines: string[] = [];
    if (written) lines.push(`${plural(written, 'file')} updated in place.`);
    if (copies.length) lines.push(`${plural(copies.length, 'tagged copy', 'tagged copies')} downloaded${copies.length > 1 ? ' as a .zip' : ''}.`);
    if (refused) lines.push(`${plural(refused, 'file')} not changed: the browser wasn’t given permission.`);
    if (failed) lines.push(`${plural(failed, 'file')} couldn’t be tagged (see the list for why).`);
    if (plan.skipped.length) lines.push(`${plural(plan.skipped.length, 'file')} skipped (no clear key, or not MP3/WAV).`);
    setPhase({ step: 'finished', lines: lines.length ? lines : ['Nothing to tag.'] });
  };

  let dialog: ReactNode = null;
  if (phase) {
    const close = () => setPhase(null);
    const example = settings.tagFormat === 'camelot' ? '8A' : settings.tagFormat === 'openkey' ? '1m' : 'Am';
    if (phase.step === 'confirm') {
      const { inPlace, copies, skipped } = phase.plan;
      const folders = new Set(inPlace.map((id) => store.source(id)?.root?.name).filter(Boolean));
      const any = inPlace.length + copies.length > 0;
      dialog = (
        <Dialog open title={any ? `Write the key into ${plural(inPlace.length + copies.length, 'file')}?` : 'Nothing to tag'} onClose={close}
          actions={<>
            <button onClick={close}>Cancel</button>
            {any && <button className="primary" onClick={() => void run(phase.plan)}>{inPlace.length ? 'Write tags' : 'Download tagged copies'}</button>}
          </>}>
          <ul>
            {inPlace.length > 0 && <li>{plural(inPlace.length, 'file')} will be updated in place.{' '}
              {folders.size > 0 ? `Your browser will ask to let this page edit ${[...folders].map((f) => `“${f}”`).join(', ')}.`
                : 'Your browser will ask to let this page edit them.'}</li>}
            {copies.length > 0 && <li>{plural(copies.length, 'tagged copy', 'tagged copies')} will be downloaded{copies.length > 1 ? ' as a .zip' : ''}
              {' '}(this browser can’t change files on disk{inPlace.length ? ', or they were added without a folder' : ''}).</li>}
            {skipped.length > 0 && <li>{plural(skipped.length, 'file')} will be skipped: {[...new Set(skipped.map((s) => s.reason))].join('; ')}.</li>}
          </ul>
          <p className="muted small">The key is written as {settings.tagFormat === 'standard' ? 'standard notation' : settings.tagFormat === 'camelot' ? 'a Camelot code' : 'an Open Key code'} (like “{example}”)
            {settings.tagModeFrame ? ', with the full result in a KEY_MODE tag' : ''}. Only the tag changes; the audio and your other tags stay as they are.</p>
        </Dialog>
      );
    } else if (phase.step === 'working') {
      dialog = (
        <Dialog open busy title="Writing key tags…" onClose={close}>
          <p>{phase.done} of {phase.total}</p>
          <div className="progress solo"><div style={{ width: `${(phase.done / Math.max(1, phase.total)) * 100}%` }} /></div>
        </Dialog>
      );
    } else {
      dialog = (
        <Dialog open title="Key tags" onClose={close} actions={<button className="primary" onClick={close}>Done</button>}>
          <ul>{phase.lines.map((l) => <li key={l}>{l}</li>)}</ul>
        </Dialog>
      );
    }
  }
  return { start, dialog };
}
