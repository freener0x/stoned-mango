// A small ID3v2 editor: sets the key frames and keeps every other frame byte for byte
// (artwork, artist, comments, frames it doesn't understand). Reads ID3v2.3 and v2.4; an
// old v2.2 tag is refused rather than risked. Writes the tag back in its own version,
// or a new v2.3 tag (the version DJ software reads most widely).
//
//   TKEY           the key DJ software reads ("Am", "8A" or "1m", up to 3 characters)
//   TXXX:KEY_MODE  the full result ("D Dorian"), optional

export const KEY_MODE = 'KEY_MODE';

export class TagError extends Error {}

export interface Frame {
  id: string;
  flags: [number, number];
  data: Uint8Array;
}

export interface Tag {
  version: 3 | 4;
  frames: Frame[];
  /** Bytes the old tag occupied at the start (header, body, footer); 0 if there was none. */
  size: number;
}

const ascii = (b: Uint8Array, a: number, n: number) => String.fromCharCode(...b.subarray(a, a + n));
const syncsafe = (b: Uint8Array, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const putSyncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const putU32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** Undo unsynchronisation: every 0xFF 0x00 becomes 0xFF. */
export function deunsync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

/** The total size of an ID3v2 tag at the start of ``head`` (10+ bytes), or 0. */
export function tagLength(head: Uint8Array): number {
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return 0;
  return 10 + syncsafe(head, 6) + (head[3] === 4 && head[5] & 0x10 ? 10 : 0);
}

const FRAME_ID = /^[A-Z0-9]{4}$/;

function readFrames(body: Uint8Array, version: 3 | 4, start: number, plainSizes: boolean): Frame[] | null {
  if (start > body.length) return null;
  const frames: Frame[] = [];
  let pos = start;
  while (pos + 10 <= body.length && body[pos] !== 0) {
    const id = ascii(body, pos, 4);
    if (!FRAME_ID.test(id)) return null;
    const size = version === 4 && !plainSizes ? syncsafe(body, pos + 4) : u32(body, pos + 4);
    if (pos + 10 + size > body.length) return null;
    frames.push({ id, flags: [body[pos + 8], body[pos + 9]], data: body.slice(pos + 10, pos + 10 + size) });
    pos += 10 + size;
  }
  // after the frames: padding (zeros) only
  for (let i = pos; i < body.length; i++) if (body[i] !== 0) return null;
  return frames;
}

/**
 * Whether ``b`` can be unsynchronised data: no 0xFF followed by 0xE0 or more, and no 0xFF at the end.
 * Some taggers set the unsync flag on data that isn't; that is read as it is (as mutagen does).
 */
function unsynchronised(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] === 0xff && (i + 1 === b.length || b[i + 1] >= 0xe0)) return false;
  return true;
}

/**
 * Where the frames start when the extended-header flag is set. Some taggers set the flag without
 * writing the header: when a frame ID is already there, there is none (as mutagen reads it).
 * Otherwise the size must be one the version allows (v2.3: 6 or 10 bytes after its own 4; v2.4: 6
 * or more, itself included), or the tag is refused.
 */
function framesStart(body: Uint8Array, version: 3 | 4): number {
  if (body.length >= 4 && FRAME_ID.test(ascii(body, 0, 4))) return 0;
  const n = body.length < 4 ? 0 : version === 3 ? 4 + u32(body, 0) : syncsafe(body, 0);
  if (!(version === 3 ? n === 10 || n === 14 : n >= 6) || n > body.length) throw new TagError("its tag couldn't be read safely");
  return n;
}

/** Parses the tag at the start of ``bytes`` (which must hold all of it). No tag: an empty v2.3 tag. */
export function parseTag(bytes: Uint8Array): Tag {
  const total = tagLength(bytes);
  if (!total) return { version: 3, frames: [], size: 0 };
  const major = bytes[3];
  if (major === 2) throw new TagError('it has an old ID3v2.2 tag');
  if (major !== 3 && major !== 4) throw new TagError(`unknown ID3 version 2.${major}`);
  if (bytes.length < total) throw new TagError('the file ends inside its tag');
  const version = major as 3 | 4;
  const flags = bytes[5];
  let body = bytes.subarray(10, 10 + syncsafe(bytes, 6));
  if (version === 3 && flags & 0x80 && unsynchronised(body)) body = deunsync(body);
  const start = flags & 0x40 ? framesStart(body, version) : 0;
  // Some taggers wrote v2.4 frame sizes as plain integers: try that if the proper reading fails.
  const frames = readFrames(body, version, start, false) ?? (version === 4 ? readFrames(body, version, start, true) : null);
  if (!frames) throw new TagError("its tag couldn't be read safely");
  if (version === 4 && flags & 0x80) for (const f of frames) f.flags[1] |= 0x02; // each frame keeps its own unsync flag
  return { version, frames, size: total };
}

const isAscii = (s: string) => [...s].every((c) => c.charCodeAt(0) < 0x80);

function encode(s: string, enc: number): number[] {
  if (enc === 0) return [...s].map((c) => c.charCodeAt(0));
  if (enc === 3) return [...new TextEncoder().encode(s)];
  const out = [0xff, 0xfe]; // UTF-16 with a byte-order mark
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
  return out;
}

function decode(b: Uint8Array, enc: number): string {
  if (enc === 0) {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return s;
  }
  if (enc === 3) return new TextDecoder().decode(b);
  if (enc === 2) return new TextDecoder('utf-16be').decode(b);
  const be = b[0] === 0xfe && b[1] === 0xff;
  const bom = (b[0] === 0xff && b[1] === 0xfe) || be;
  return new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(b.subarray(bom ? 2 : 0));
}

const stripNuls = (s: string) => {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 0) n--;
  return s.slice(0, n);
};

/**
 * A text frame's value (and TXXX description), or null for frames that are compressed or encrypted.
 * ``value: false`` decodes only a TXXX frame's description (a big value is never decoded for nothing).
 */
function frameText(f: Frame, version: 3 | 4, value = true): { description?: string; value: string } | null {
  const opaque = version === 3 ? f.flags[1] & 0xc0 : f.flags[1] & 0x0c;
  if (opaque || !f.data.length) return null;
  let data = f.data;
  if (version === 4 && f.flags[1] & 0x01) data = data.subarray(4); // a data length indicator comes first
  if (version === 4 && f.flags[1] & 0x02) data = deunsync(data);
  if (!data.length) return null;
  const enc = data[0];
  if (f.id !== 'TXXX') return { value: value ? stripNuls(decode(data.subarray(1), enc)) : '' };
  const wide = enc === 1 || enc === 2;
  let end = 1;
  if (wide) while (end + 1 < data.length && !(data[end] === 0 && data[end + 1] === 0)) end += 2;
  else while (end < data.length && data[end] !== 0) end += 1;
  const description = decode(data.subarray(1, end), enc);
  return { description, value: value ? stripNuls(decode(data.subarray(end + (wide ? 2 : 1)), enc)) : '' };
}

export function readKeys(tag: Tag): { tkey: string | null; keyMode: string | null } {
  let tkey: string | null = null;
  let keyMode: string | null = null;
  for (const f of tag.frames) {
    if (f.id === 'TKEY') tkey = frameText(f, tag.version)?.value ?? null;
    if (f.id === 'TXXX' && frameText(f, tag.version, false)?.description === KEY_MODE) keyMode = frameText(f, tag.version)?.value ?? null;
  }
  return { tkey, keyMode };
}

function textFrame(id: string, version: 3 | 4, value: string, description?: string): Frame {
  const enc = isAscii(value + (description ?? '')) ? 0 : version === 4 ? 3 : 1;
  const term = enc === 1 ? [0, 0] : [0];
  const bytes = [enc, ...(description !== undefined ? [...encode(description, enc), ...term] : []), ...encode(value, enc)];
  return { id, flags: [0, 0], data: Uint8Array.from(bytes) };
}

/** The tag with the key frames replaced (or removed when ``keyMode`` is null). */
export function withKeys(tag: Tag, tkey: string, keyMode: string | null): Tag {
  if (!/^[A-Za-z0-9#]{1,3}$/.test(tkey)) throw new TagError(`not a key: ${tkey}`);
  const frames = tag.frames.filter((f) => f.id !== 'TKEY' && !(f.id === 'TXXX' && frameText(f, tag.version, false)?.description === KEY_MODE));
  frames.push(textFrame('TKEY', tag.version, tkey));
  if (keyMode) frames.push(textFrame('TXXX', tag.version, keyMode, KEY_MODE));
  return { ...tag, frames };
}

export const NEW_TAG_PADDING = 1024;

/**
 * The tag's bytes. It keeps the old tag's size when the frames fit (so the audio doesn't
 * move); otherwise it adds ``padding`` bytes of room for later edits.
 */
export function buildTag(tag: Tag, padding = NEW_TAG_PADDING): Uint8Array {
  const framesLength = tag.frames.reduce((n, f) => n + 10 + f.data.length, 0);
  const body = tag.size && framesLength <= tag.size - 10 ? tag.size - 10 : framesLength + padding;
  if (body >= 1 << 28) throw new TagError('tag too large');
  const out = new Uint8Array(10 + body);
  out.set([0x49, 0x44, 0x33, tag.version, 0, 0, ...putSyncsafe(body)]);
  let o = 10;
  for (const f of tag.frames) {
    out.set([...[...f.id].map((c) => c.charCodeAt(0)), ...(tag.version === 4 ? putSyncsafe(f.data.length) : putU32(f.data.length)), ...f.flags], o);
    out.set(f.data, o + 10);
    o += 10 + f.data.length;
  }
  return out;
}
