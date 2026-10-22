// Stream-decode inside the worker (PLAN.md stage [1]): mono float32 chunks, a few
// seconds at a time, so memory stays flat whatever the song's length.
//
//   WAV  read directly with Blob.slice (wav.ts)
//   MP3  split into frames here, decoded by WebCodecs' AudioDecoder (available in workers)
//   else NeedsMainThreadDecode: the pool decodes it with decodeAudioData on the main
//        thread (whole file at once, so with tighter limits) and sends the samples over

import { probeLength } from './probe.ts';
import { readWavHeader, wavChunks } from './wav.ts';

export const MAX_STREAM_SECONDS = 60 * 60;
export const MAX_STREAM_BYTES = 500 * 2 ** 20;
export const MAX_WHOLE_SECONDS = 15 * 60;
export const MAX_WHOLE_BYTES = 150 * 2 ** 20;
/** For a format whose length can't be read from its header (WebM, unusual files). */
export const MAX_WHOLE_BYTES_UNKNOWN_LENGTH = 40 * 2 ** 20;

export class NeedsMainThreadDecode extends Error {
  constructor() {
    super('this format is decoded on the main thread');
  }
}

export interface OpenedAudio {
  sampleRate: number;
  method: 'wav' | 'mp3-webcodecs';
  /** Mono chunks; ``progress`` is the share of the file read so far. */
  chunks: AsyncGenerator<{ samples: Float32Array; progress: number }>;
}

export async function openAudio(file: Blob, name = ''): Promise<OpenedAudio> {
  if (file.size > MAX_STREAM_BYTES) throw new Error(`file too large (over ${MAX_STREAM_BYTES / 2 ** 20} MB)`);
  const wav = await readWavHeader(file);
  if (wav) {
    const seconds = wav.dataBytes / (wav.channels * wav.bitsPerSample / 8) / wav.sampleRate;
    if (seconds > MAX_STREAM_SECONDS) throw new Error('longer than 60 minutes');
    const total = wav.dataBytes;
    return {
      sampleRate: wav.sampleRate, method: 'wav',
      chunks: (async function* () {
        let done = 0;
        for await (const samples of wavChunks(file, wav, 10)) {
          done += samples.length * wav.channels * wav.bitsPerSample / 8;
          yield { samples, progress: Math.min(1, done / total) };
        }
      })(),
    };
  }
  const mp3 = await probeMp3(file);
  if (mp3 && typeof AudioDecoder !== 'undefined') {
    const config = { codec: 'mp3', sampleRate: mp3.sampleRate, numberOfChannels: mp3.channels };
    if ((await AudioDecoder.isConfigSupported(config)).supported) {
      return { sampleRate: mp3.sampleRate, method: 'mp3-webcodecs', chunks: mp3Chunks(file, mp3.start, config) };
    }
  }
  void name;
  throw new NeedsMainThreadDecode();
}

// ---- MP3 framing -------------------------------------------------------------

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2/2.5 Layer III
};
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface FrameHeader {
  length: number;
  sampleRate: number;
  channels: number;
  samples: number;
  version: number;
}

/** A Layer III frame header at ``o``, or null. */
function frameHeader(b: Uint8Array, o: number): FrameHeader | null {
  if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[o + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (b[o + 1] >> 1) & 3; // 1 = Layer III
  const brIndex = b[o + 2] >> 4;
  const srIndex = (b[o + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const sampleRate = RATES[version][srIndex];
  const kbps = BITRATES[version === 3 ? 1 : 2][brIndex];
  const padding = (b[o + 2] >> 1) & 1;
  const length = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / sampleRate) + padding;
  return { length, sampleRate, channels: (b[o + 3] >> 6) === 3 ? 1 : 2, samples: version === 3 ? 1152 : 576, version };
}

/** Offset just past an ID3v2 tag at the start, if there is one. */
function id3Size(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
  return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

/** The first frame confirmed by a second identical-format frame right after it. */
function findSync(b: Uint8Array, from: number): { at: number; h: FrameHeader } | null {
  for (let o = from; o + 4 <= b.length; o++) {
    const h = frameHeader(b, o);
    if (!h) continue;
    const next = frameHeader(b, o + h.length);
    if (next && next.sampleRate === h.sampleRate && next.version === h.version) return { at: o, h };
  }
  return null;
}

async function probeMp3(file: Blob): Promise<{ start: number; sampleRate: number; channels: number } | null> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const skip = id3Size(head);
  const probe = new Uint8Array(await file.slice(skip, skip + 64 * 1024).arrayBuffer());
  const sync = findSync(probe, 0);
  return sync ? { start: skip + sync.at, sampleRate: sync.h.sampleRate, channels: sync.h.channels } : null;
}

const SLICE_BYTES = 2 * 2 ** 20; // ~2 min of 128 kbps audio per decode round

async function* mp3Chunks(file: Blob, start: number, config: AudioDecoderConfig): AsyncGenerator<{ samples: Float32Array; progress: number }> {
  let pending: Float32Array[] = [];
  let failure: Error | null = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      pending.push(downmix(data));
      data.close();
    },
    error: (e) => (failure = e instanceof Error ? e : new Error(String(e))),
  });
  decoder.configure(config);
  let carry = new Uint8Array(0);
  let pos = start;
  let timestamp = 0;
  let decodedSeconds = 0;
  try {
    while (pos < file.size || carry.length) {
      const fresh = pos < file.size ? new Uint8Array(await file.slice(pos, pos + SLICE_BYTES).arrayBuffer()) : new Uint8Array(0);
      pos += fresh.length;
      const b = new Uint8Array(carry.length + fresh.length);
      b.set(carry);
      b.set(fresh, carry.length);
      let o = 0;
      const atEnd = pos >= file.size;
      while (o + 4 <= b.length) {
        const h = frameHeader(b, o);
        if (!h) {
          const s = findSync(b, o + 1); // lost sync (junk or a tag in the stream): look for the next frame
          if (!s) { o = atEnd ? b.length : Math.max(o, b.length - 4096); break; }
          o = s.at;
          continue;
        }
        if (o + h.length > b.length) break; // frame continues in the next slice
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: b.subarray(o, o + h.length) }));
        timestamp += (h.samples / h.sampleRate) * 1e6;
        o += h.length;
      }
      carry = atEnd ? new Uint8Array(0) : b.slice(o);
      await decoder.flush();
      if (failure) throw failure;
      const out = concat(pending);
      pending = [];
      decodedSeconds += out.length / (config.sampleRate as number);
      if (decodedSeconds > MAX_STREAM_SECONDS) throw new Error('longer than 60 minutes');
      yield { samples: out, progress: Math.min(1, pos / file.size) };
      if (atEnd) break;
    }
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
}

/** AudioData -> mono float32 (channels averaged). */
function downmix(data: AudioData): Float32Array {
  const n = data.numberOfFrames;
  const ch = data.numberOfChannels;
  const out = new Float32Array(n);
  const plane = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    for (let i = 0; i < n; i++) out[i] = Math.fround(out[i] + plane[i]);
  }
  if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Throws if a file is too long to decode whole: its length is read from its header first, since
 * decodeAudioData holds everything it decodes in memory (15 minutes of stereo, or the same amount
 * of audio in more channels, is the limit).
 */
export async function checkWholeDecode(file: Blob): Promise<void> {
  if (file.size > MAX_WHOLE_BYTES) throw new Error(`file too large for this format (over ${MAX_WHOLE_BYTES / 2 ** 20} MB)`);
  const length = await probeLength(file);
  if (length?.seconds == null) {
    if (file.size > MAX_WHOLE_BYTES_UNKNOWN_LENGTH) throw new Error(`file too large for this format (over ${MAX_WHOLE_BYTES_UNKNOWN_LENGTH / 2 ** 20} MB)`);
    return;
  }
  if (length.seconds > MAX_WHOLE_SECONDS) throw new Error('longer than 15 minutes (the limit for this format)');
  if (length.seconds * Math.max(2, length.channels ?? 2) > MAX_WHOLE_SECONDS * 2) throw new Error('too long for its number of channels (the limit for this format)');
}

/** Main-thread fallback: the whole file through decodeAudioData, then mono (needs a window context). */
export async function decodeWhole(file: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  await checkWholeDecode(file);
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  if (buf.duration > MAX_WHOLE_SECONDS) throw new Error('longer than 15 minutes (the limit for this format)');
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] = Math.fround(out[i] + d[i]);
  }
  if (buf.numberOfChannels > 1) for (let i = 0; i < out.length; i++) out[i] /= buf.numberOfChannels;
  return { samples: out, sampleRate: buf.sampleRate };
}
