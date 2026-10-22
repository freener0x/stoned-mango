// A compressed file's length from its header, before the browser decodes any of it.
// decodeAudioData (the main-thread fallback for FLAC, Ogg, M4A, AIFF...) has no limit and
// keeps the whole decoded file in memory, so a long file is refused up front rather than
// after gigabytes of decoding. A header can lie: this protects against long files, not
// against every crafted one (decodeWhole still checks the decoded length afterwards).
//
//   FLAC  STREAMINFO: sample rate, channels, total samples
//   Ogg   Vorbis or Opus identification header, and the last page's granule position
//   AIFF  COMM chunk: channels, sample frames, sample rate
//   MP4   moov/mvhd: duration and time scale (M4A, AAC in MP4, ALAC)

export interface Length {
  /** null when the header doesn't say */
  seconds: number | null;
  channels: number | null;
}

const ascii = (b: Uint8Array, a: number, n: number) => String.fromCharCode(...b.subarray(a, a + n));
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const read = async (file: Blob, start: number, end: number) => new Uint8Array(await file.slice(start, end).arrayBuffer());
const MAX_BOXES = 100; // boxes or chunks walked before giving up (real files have a handful)

/** The file's length from its header, or null for formats (or headers) this doesn't read. */
export async function probeLength(file: Blob): Promise<Length | null> {
  let head = await read(file, 0, 64);
  let offset = 0;
  if (ascii(head, 0, 3) === 'ID3' && head.length >= 10) {
    // an ID3v2 tag in front (some FLAC files have one)
    offset = 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f)) + (head[5] & 0x10 ? 10 : 0);
    head = await read(file, offset, offset + 64);
  }
  if (ascii(head, 0, 4) === 'fLaC') return flac(head);
  if (offset) return null;
  if (ascii(head, 0, 4) === 'OggS') return ogg(file);
  if (ascii(head, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(head, 8, 4))) return aiff(file);
  if (ascii(head, 4, 4) === 'ftyp') return mp4(file);
  return null;
}

function flac(b: Uint8Array): Length | null {
  if (b.length < 26 || (b[4] & 0x7f) !== 0) return null; // the first block must be STREAMINFO
  const rate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  const channels = ((b[20] >> 1) & 0x07) + 1;
  const total = (b[21] & 0x0f) * 2 ** 32 + u32be(b, 22);
  return { seconds: rate && total ? total / rate : null, channels };
}

async function ogg(file: Blob): Promise<Length | null> {
  const first = await read(file, 0, 512);
  const segments = first[26];
  const packet = first.subarray(27 + segments);
  const serial = u32le(first, 14);
  let rate: number;
  let channels: number;
  let preSkip = 0;
  if (packet[0] === 1 && ascii(packet, 1, 6) === 'vorbis') {
    channels = packet[11];
    rate = u32le(packet, 12);
  } else if (ascii(packet, 0, 8) === 'OpusHead') {
    channels = packet[9];
    preSkip = packet[10] | (packet[11] << 8);
    rate = 48000; // Opus granule positions always count 48 kHz samples
  } else return null;
  if (!rate) return { seconds: null, channels };
  // The last page of this stream carries the total sample count (its granule position).
  const tailStart = Math.max(0, file.size - 65536);
  const tail = await read(file, tailStart, file.size);
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] !== 0x4f || ascii(tail, i, 4) !== 'OggS' || tail[i + 4] !== 0 || u32le(tail, i + 14) !== serial) continue;
    const low = u32le(tail, i + 6);
    const high = u32le(tail, i + 10);
    if (low === 0xffffffff && high === 0xffffffff) continue; // no granule position on this page
    return { seconds: Math.max(0, high * 2 ** 32 + low - preSkip) / rate, channels };
  }
  return { seconds: null, channels };
}

async function aiff(file: Blob): Promise<Length | null> {
  let pos = 12;
  for (let n = 0; n < MAX_BOXES && pos + 8 <= file.size; n++) {
    const h = await read(file, pos, pos + 26);
    const size = u32be(h, 4);
    if (ascii(h, 0, 4) === 'COMM' && h.length >= 26) {
      const channels = u16be(h, 8);
      const frames = u32be(h, 10);
      const rate = extended(h.subarray(16, 26));
      return { seconds: rate > 0 ? frames / rate : null, channels };
    }
    pos += 8 + size + (size & 1);
  }
  return null;
}

/** An 80-bit IEEE 754 extended float (AIFF's sample rate). */
function extended(b: Uint8Array): number {
  const exponent = ((b[0] & 0x7f) << 8) | b[1];
  const mantissa = u32be(b, 2) * 2 ** 32 + u32be(b, 6);
  if (!exponent && !mantissa) return 0;
  return (b[0] & 0x80 ? -1 : 1) * mantissa * 2 ** (exponent - 16383 - 63);
}

/** The box at ``pos``: its type, where its contents start, and where it ends. */
async function box(file: Blob, pos: number, end: number): Promise<{ type: string; body: number; end: number } | null> {
  if (pos + 8 > end) return null;
  const h = await read(file, pos, pos + 16);
  const size32 = u32be(h, 0);
  const type = ascii(h, 4, 4);
  if (size32 === 1) {
    const size = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
    return size >= 16 ? { type, body: pos + 16, end: Math.min(end, pos + size) } : null;
  }
  if (size32 === 0) return { type, body: pos + 8, end };
  return size32 >= 8 ? { type, body: pos + 8, end: Math.min(end, pos + size32) } : null;
}

async function mp4(file: Blob): Promise<Length | null> {
  let pos = 0;
  for (let n = 0; n < MAX_BOXES; n++) {
    const b = await box(file, pos, file.size);
    if (!b) return null;
    if (b.type === 'moov') {
      let child = b.body;
      for (let m = 0; m < MAX_BOXES; m++) {
        const c = await box(file, child, b.end);
        if (!c) return null;
        if (c.type === 'mvhd') {
          const h = await read(file, c.body, c.body + 32);
          const v1 = h[0] === 1;
          const timescale = u32be(h, v1 ? 20 : 12);
          const duration = v1 ? u32be(h, 24) * 2 ** 32 + u32be(h, 28) : u32be(h, 16);
          // a duration of 0 (fragmented files keep it elsewhere) means unknown
          return { seconds: timescale && duration ? duration / timescale : null, channels: null };
        }
        child = c.end;
      }
      return null;
    }
    pos = b.end;
  }
  return null;
}
