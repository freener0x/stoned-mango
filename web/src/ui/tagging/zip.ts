// A plain (uncompressed) .zip of tagged copies, for browsers that can't write files in
// place. Built from parts, so the audio isn't copied into memory; only the CRC check
// reads it once. No ZIP64: a zip is kept under 4 GB (the caller splits bigger batches).

import { partsSize, type Part } from './files.ts';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

async function partsCrc(parts: Part[]): Promise<number> {
  let crc = 0;
  for (const p of parts) {
    if (p instanceof Uint8Array) crc = crc32(p, crc);
    else for (let o = 0; o < p.size; o += 8 << 20) crc = crc32(new Uint8Array(await p.slice(o, o + (8 << 20)).arrayBuffer()), crc);
  }
  return crc;
}

export const ZIP_LIMIT = 0xffffffff - (64 << 20); // room for the headers

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

export interface ZipEntry {
  name: string;
  parts: Part[];
}

export async function zip(entries: ZipEntry[], now = new Date()): Promise<Blob> {
  const out: Part[] = [];
  const central: number[] = [];
  const [time, date] = dosTime(now);
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name.replace(/^\/+/, ''));
    const size = partsSize(e.parts);
    const crc = await partsCrc(e.parts);
    // version 2.0, flag 0x0800 (UTF-8 names), method 0 (stored)
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length)];
    const local = Uint8Array.from([...u32(0x04034b50), ...common, ...u16(0), ...name]);
    out.push(local, ...e.parts);
    central.push(...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
    offset += local.length + size;
    if (offset > 0xffffffff) throw new Error('zip too large');
  }
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length),
    ...u32(offset), ...u16(0)];
  out.push(Uint8Array.from(central), Uint8Array.from(end));
  return new Blob(out as BlobPart[], { type: 'application/zip' });
}
