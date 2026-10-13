// Getting files from the user: drag and drop (files or whole folders), file and folder
// pickers, and plain file inputs. Folders are searched recursively; anything that isn't
// audio is skipped. Where the browser gives file handles (Chromium), they are kept so
// that key tags can later be written in place, with the user's permission.

import { AUDIO_EXTENSIONS, isAudioFile } from '../engine/pool.ts';

export interface Picked {
  file: File;
  /** Shown in the table and used in exports: "Folder/Sub/song.mp3". */
  path: string;
  handle?: FileSystemFileHandle;
  /** The folder it was opened from: one permission prompt covers all its files. */
  root?: FileSystemDirectoryHandle;
}

export interface Intake {
  picked: Picked[];
  /** Files skipped because they aren't audio (or are hidden system files). */
  ignored: number;
}

// "._song.mp3" files are macOS metadata on external drives, not audio.
const wanted = (name: string) => !name.startsWith('.') && isAudioFile(name);

export function fromFileList(list: Iterable<File>): Intake {
  const picked: Picked[] = [];
  let ignored = 0;
  for (const file of list) {
    if (wanted(file.name)) picked.push({ file, path: file.webkitRelativePath || file.name });
    else ignored++;
  }
  return { picked, ignored };
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true });

async function walkHandle(dir: FileSystemDirectoryHandle, prefix: string, root: FileSystemDirectoryHandle, out: Intake): Promise<void> {
  const children: (FileSystemFileHandle | FileSystemDirectoryHandle)[] = [];
  for await (const h of dir.values()) children.push(h);
  for (const h of children.sort(byName)) {
    if (h.kind === 'directory') {
      if (!h.name.startsWith('.')) await walkHandle(h, `${prefix}${h.name}/`, root, out);
    } else if (wanted(h.name)) out.picked.push({ file: await h.getFile(), path: `${prefix}${h.name}`, handle: h, root });
    else out.ignored++;
  }
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: Intake): Promise<void> {
  if (entry.isFile) {
    if (!wanted(entry.name)) {
      out.ignored++;
      return;
    }
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.picked.push({ file, path: `${prefix}${entry.name}` });
  } else if (entry.isDirectory && !entry.name.startsWith('.')) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      children.push(...batch);
    }
    for (const child of children.sort(byName)) await walkEntry(child, `${prefix}${entry.name}/`, out);
  }
}

/** Everything dropped: call it straight from the drop event (the items expire after it). */
export function fromDrop(dt: DataTransfer): Promise<Intake> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const handles = items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null));
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const files = [...dt.files];
  return (async () => {
    if (handles.length && handles.every((h) => h)) {
      try {
        const out: Intake = { picked: [], ignored: 0 };
        for (const h of await Promise.all(handles)) {
          if (!h) throw new Error('no handle');
          if (h.kind === 'directory') await walkHandle(h as FileSystemDirectoryHandle, `${h.name}/`, h as FileSystemDirectoryHandle, out);
          else if (wanted(h.name)) out.picked.push({ file: await (h as FileSystemFileHandle).getFile(), path: h.name, handle: h as FileSystemFileHandle });
          else out.ignored++;
        }
        return out;
      } catch {
        // fall back to the entries below
      }
    }
    if (entries.length && entries.every((e) => e)) {
      const out: Intake = { picked: [], ignored: 0 };
      for (const e of entries) await walkEntry(e!, '', out);
      return out;
    }
    return fromFileList(files);
  })();
}

export const canPickWithHandles = () => typeof window.showOpenFilePicker === 'function' && typeof window.showDirectoryPicker === 'function';

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** The browser's file picker with handles (Chromium); null if the user closed it. */
export async function pickFiles(): Promise<Intake | null> {
  try {
    const handles = await window.showOpenFilePicker!({
      multiple: true, id: 'music', types: [{ description: 'Audio files', accept: { 'audio/*': AUDIO_EXTENSIONS } }],
    });
    const out: Intake = { picked: [], ignored: 0 };
    for (const h of handles) {
      if (wanted(h.name)) out.picked.push({ file: await h.getFile(), path: h.name, handle: h });
      else out.ignored++;
    }
    return out;
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** The browser's folder picker with handles (Chromium); null if the user closed it. */
export async function pickFolder(): Promise<Intake | null> {
  try {
    const dir = await window.showDirectoryPicker!({ id: 'music', mode: 'read' });
    const out: Intake = { picked: [], ignored: 0 };
    await walkHandle(dir, `${dir.name}/`, dir, out);
    return out;
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** Phones get a warning before big batches (PLAN.md section 5). */
export function isPhone(): boolean {
  const mobile = navigator.userAgentData?.mobile;
  if (mobile !== undefined) return mobile;
  return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
}
