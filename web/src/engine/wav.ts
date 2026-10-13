// Streaming WAV reader: parses the header, then reads the samples a few seconds at a
// time with Blob.slice, so a long file never sits in memory whole (PLAN.md stage [1]).
// Downmix and sample conversion match research/stoned_mango/audio.py (libsndfile).

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  float: boolean;
  dataOffset: number;
  dataBytes: number;
}

const tag = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

/** The WAV's format and where its samples are, or null if it isn't a PCM/float WAV this reader handles. */
export async function readWavHeader(blob: Blob): Promise<WavInfo | null> {
  const head = new DataView(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer());
  if (head.byteLength < 12 || tag(head, 0) !== 'RIFF' || tag(head, 8) !== 'WAVE') return null;
  let pos = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataBytes'> | null = null;
  while (pos + 8 <= head.byteLength) {
    const id = tag(head, pos);
    const size = head.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      let format = head.getUint16(pos + 8, true);
      const channels = head.getUint16(pos + 10, true);
      const sampleRate = head.getUint32(pos + 12, true);
      const bitsPerSample = head.getUint16(pos + 22, true);
      if (format === 0xfffe && size >= 26) format = head.getUint16(pos + 32, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      if (format !== 1 && format !== 3) return null;
      fmt = { sampleRate, channels, bitsPerSample, float: format === 3 };
    } else if (id === 'data') {
      if (!fmt) return null;
      const dataBytes = Math.min(size, blob.size - (pos + 8));
      return { ...fmt, dataOffset: pos + 8, dataBytes };
    }
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

/** Mono float32 chunks of about ``seconds`` each (channels averaged, as libsndfile + numpy do). */
export async function* wavChunks(blob: Blob, info: WavInfo, seconds = 10): AsyncGenerator<Float32Array> {
  const bytes = info.bitsPerSample / 8;
  const frameBytes = bytes * info.channels;
  const chunkFrames = Math.max(1024, Math.floor(seconds * info.sampleRate));
  const end = info.dataOffset + info.dataBytes - (info.dataBytes % frameBytes);
  for (let off = info.dataOffset; off < end; off += chunkFrames * frameBytes) {
    const view = new DataView(await blob.slice(off, Math.min(end, off + chunkFrames * frameBytes)).arrayBuffer());
    const n = Math.floor(view.byteLength / frameBytes);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let c = 0; c < info.channels; c++) acc = Math.fround(acc + sample(view, (i * info.channels + c) * bytes, info));
      out[i] = acc / info.channels;
    }
    yield out;
  }
}

function sample(v: DataView, o: number, info: WavInfo): number {
  if (info.float) return info.bitsPerSample === 64 ? v.getFloat64(o, true) : v.getFloat32(o, true);
  switch (info.bitsPerSample) {
    case 8: return (v.getUint8(o) - 128) / 128;
    case 16: return v.getInt16(o, true) / 32768;
    case 24: return ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16))) / 8388608;
    case 32: return v.getInt32(o, true) / 2147483648;
    default: throw new Error(`unsupported WAV: ${info.bitsPerSample}-bit`);
  }
}
