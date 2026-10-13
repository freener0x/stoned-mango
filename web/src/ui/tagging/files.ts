// Tagged versions of MP3 and WAV files, described as "parts": new bytes plus untouched
// slices of the original file. The audio itself is never decoded or re-encoded, and
// nothing large is copied into memory: the parts become a download (a Blob) or are
// written into the file in place.
//
//   MP3  the ID3v2 tag at the start is replaced (if the new one fits the old one's space,
//        the audio stays exactly where it was)
//   WAV  any "id3 " chunk is removed and a new one is appended; the RIFF size is updated

import { buildTag, parseTag, readKeys, tagLength, TagError, withKeys, type Tag } from './id3.ts';

export type Part = Uint8Array | Blob;

export interface TaggedFile {
  parts: Part[];
  size: number;
  kind: 'mp3' | 'wav';
}

export interface KeyTags {
  tkey: string;
  keyMode: string | null;
}

const bytes = async (b: Blob, start: number, end: number) => new Uint8Array(await b.slice(start, end).arrayBuffer());
const ascii = (b: Uint8Array, a: number, n: number) => String.fromCharCode(...b.subarray(a, a + n));
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le32 = (n: number) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
export const partsSize = (parts: Part[]) => parts.reduce((n, p) => n + (p instanceof Uint8Array ? p.length : p.size), 0);

export async function fileKind(file: Blob): Promise<'mp3' | 'wav' | null> {
  const head = await bytes(file, 0, 12);
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'wav';
  if (ascii(head, 0, 3) === 'ID3') return 'mp3';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && ((head[1] >> 1) & 3) === 1) return 'mp3'; // a Layer III frame
  return null;
}

async function mp3Tag(file: Blob): Promise<{ tag: Tag; audioStart: number }> {
  const total = tagLength(await bytes(file, 0, 10));
  const tag = parseTag(total ? await bytes(file, 0, total) : new Uint8Array(0));
  return { tag, audioStart: total };
}

interface Chunk {
  id: string;
  start: number; // header offset
  end: number; // past the data and its pad byte
}

/** The chunks of a RIFF/WAVE file; strict, so that an unusual layout is never rewritten. */
async function riffChunks(file: Blob): Promise<Chunk[]> {
  const head = await bytes(file, 0, 12);
  if (ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 4) !== 'WAVE') throw new TagError('not a WAV file');
  const chunks: Chunk[] = [];
  let pos = 12;
  while (pos + 8 <= file.size) {
    const h = await bytes(file, pos, pos + 8);
    const id = ascii(h, 0, 4);
    if (!/^[\x20-\x7e]{4}$/.test(id)) throw new TagError('unusual WAV layout');
    const size = u32le(h, 4);
    const end = pos + 8 + size + (size & 1);
    if (pos + 8 + size > file.size) throw new TagError('the WAV file looks cut short');
    chunks.push({ id, start: pos, end: Math.min(end, file.size) });
    pos = end;
  }
  if (!chunks.some((c) => c.id === 'data')) throw new TagError('the WAV file has no audio data');
  return chunks;
}

const isId3Chunk = (c: Chunk) => c.id === 'id3 ' || c.id === 'ID3 ';

async function wavTag(file: Blob, chunks: Chunk[]): Promise<Tag> {
  const old = chunks.find(isId3Chunk);
  return old ? parseTag(await bytes(file, old.start + 8, old.end)) : parseTag(new Uint8Array(0));
}

/** The file with its key tags set; throws TagError with a reason when it can't be done safely. */
export async function tagFile(file: Blob, keys: KeyTags): Promise<TaggedFile> {
  const kind = await fileKind(file);
  if (kind === 'mp3') {
    const { tag, audioStart } = await mp3Tag(file);
    const out = buildTag(withKeys(tag, keys.tkey, keys.keyMode));
    const parts = [out, file.slice(audioStart)];
    return { parts, size: partsSize(parts), kind };
  }
  if (kind === 'wav') {
    const chunks = await riffChunks(file);
    const tag = await wavTag(file, chunks);
    const id3 = buildTag(withKeys({ ...tag, size: 0 }, keys.tkey, keys.keyMode), 0);
    const parts: Part[] = [];
    for (const c of chunks.filter((c) => !isId3Chunk(c))) {
      parts.push(file.slice(c.start, c.end));
      if ((c.end - c.start) % 2) parts.push(new Uint8Array(1)); // a missing pad byte at the end of the file
    }
    const chunk = new Uint8Array(8 + id3.length + (id3.length & 1));
    chunk.set([0x69, 0x64, 0x33, 0x20, ...le32(id3.length)]);
    chunk.set(id3, 8);
    parts.push(chunk);
    const size = 12 + partsSize(parts);
    if (size > 0xffffffff) throw new TagError('file too large');
    parts.unshift(Uint8Array.of(0x52, 0x49, 0x46, 0x46, ...le32(size - 8), 0x57, 0x41, 0x56, 0x45));
    return { parts, size, kind };
  }
  throw new TagError('only MP3 and WAV files can be tagged');
}

/** The key tags a file has now (to check a write). */
export async function readKeyTags(file: Blob): Promise<{ tkey: string | null; keyMode: string | null }> {
  const kind = await fileKind(file);
  if (kind === 'mp3') return readKeys((await mp3Tag(file)).tag);
  if (kind === 'wav') return readKeys(await wavTag(file, await riffChunks(file)));
  return { tkey: null, keyMode: null };
}

export function toBlob(t: TaggedFile, type = t.kind === 'mp3' ? 'audio/mpeg' : 'audio/wav'): Blob {
  return new Blob(t.parts as BlobPart[], { type });
}

/**
 * Rewrites a file in place through the File System Access API. The browser writes into a
 * temporary copy and only replaces the file when everything was written, so an
 * interrupted write leaves the original intact. Then reads the tag back to check it.
 */
export async function writeInPlace(handle: FileSystemFileHandle, t: TaggedFile, keys: KeyTags): Promise<File> {
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    for (const p of t.parts) {
      if (p instanceof Uint8Array) await writable.write(p as Uint8Array<ArrayBuffer>);
      else for (let o = 0; o < p.size; o += 8 << 20) await writable.write(p.slice(o, o + (8 << 20)));
    }
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => undefined);
    throw e;
  }
  const file = await handle.getFile();
  const check = await readKeyTags(file);
  if (file.size !== t.size || check.tkey !== keys.tkey) throw new Error('the tag could not be verified after writing');
  return file;
}
