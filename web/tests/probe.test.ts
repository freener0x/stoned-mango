// Lengths read from headers before a whole-file decode (src/engine/probe.ts, decode.ts
// checkWholeDecode), and the WAV header checks (src/engine/wav.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWholeDecode } from '../src/engine/decode.ts';
import { probeLength } from '../src/engine/probe.ts';
import { readWavHeader } from '../src/engine/wav.ts';

const bytes = (...parts: (number[] | Uint8Array | string)[]) =>
  new Blob(parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : Uint8Array.from(p))));
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];

function flac(rate: number, channels: number, total: number) {
  const info = new Array(34).fill(0);
  info[10] = rate >> 12; info[11] = (rate >> 4) & 0xff;
  info[12] = ((rate & 0x0f) << 4) | ((channels - 1) << 1) | 0; // 16-bit: (bps-1)=15 -> high bit 0
  info[13] = (15 << 4) | Math.floor(total / 2 ** 32);
  info.splice(14, 4, ...be32(total >>> 0));
  return bytes('fLaC', [0x80, 0, 0, 34], info, new Array(100).fill(0));
}

function oggPage(serial: number, granule: number, packet: number[]) {
  return [...new TextEncoder().encode('OggS'), 0, 0, ...le32(granule), 0, 0, 0, 0, ...le32(serial), 0, 0, 0, 0, 0, 0, 0, 0, 1, packet.length, ...packet];
}
const vorbisId = (channels: number, rate: number) => [1, ...new TextEncoder().encode('vorbis'), 0, 0, 0, 0, channels, ...le32(rate), 0, 0, 0, 0];

function mvhd(v1: boolean, timescale: number, duration: number) {
  const body = v1 ? [1, 0, 0, 0, ...new Array(16).fill(0), ...be32(timescale), 0, 0, 0, 0, ...be32(duration)] : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...be32(timescale), ...be32(duration)];
  return [...be32(8 + body.length), ...new TextEncoder().encode('mvhd'), ...body];
}
const mp4box = (type: string, body: number[]) => [...be32(8 + body.length), ...new TextEncoder().encode(type), ...body];

function aiff(channels: number, frames: number) {
  const rate44100 = [0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]; // 44100 as an 80-bit extended float
  const comm = [...new TextEncoder().encode('COMM'), ...be32(18), (channels >> 8) & 0xff, channels & 0xff, ...be32(frames), 0, 16, ...rate44100];
  const body = [...new TextEncoder().encode('AIFF'), ...comm];
  return bytes('FORM', be32(body.length), body);
}

test('lengths from FLAC, Ogg Vorbis, Opus, AIFF and MP4 headers', async () => {
  assert.deepEqual(await probeLength(flac(44100, 2, 44100 * 300)), { seconds: 300, channels: 2 });
  assert.deepEqual(await probeLength(flac(44100, 2, 0)), { seconds: null, channels: 2 }); // length unknown
  const vorbis = bytes(oggPage(7, 0, vorbisId(2, 48000)), new Array(1000).fill(0), oggPage(7, 48000 * 120, [0]));
  assert.deepEqual(await probeLength(vorbis), { seconds: 120, channels: 2 });
  const opusHead = [...new TextEncoder().encode('OpusHead'), 1, 2, ...le16(312), ...le32(44100), 0, 0, 0];
  const opus = bytes(oggPage(9, 0, opusHead), new Array(500).fill(0), oggPage(9, 48000 * 60 + 312, [0]));
  assert.deepEqual(await probeLength(opus), { seconds: 60, channels: 2 });
  assert.deepEqual(await probeLength(aiff(2, 44100 * 90)), { seconds: 90, channels: 2 });
  const ftyp = mp4box('ftyp', [...new TextEncoder().encode('M4A '), 0, 0, 0, 0]);
  // moov after the audio data, and both mvhd versions
  for (const v1 of [false, true]) {
    const m4a = bytes(ftyp, mp4box('mdat', new Array(300).fill(0)), mp4box('moov', [...mp4box('trak', [1, 2, 3]), ...mvhd(v1, 1000, 1000 * 600)]));
    assert.deepEqual(await probeLength(m4a), { seconds: 600, channels: null });
  }
  assert.equal(await probeLength(bytes([0x1a, 0x45, 0xdf, 0xa3], new Array(60).fill(0))), null); // WebM: not read
});

test('whole-file decodes: long files are refused before decoding', async () => {
  await assert.doesNotReject(checkWholeDecode(flac(44100, 2, 44100 * 600)));
  await assert.rejects(checkWholeDecode(flac(44100, 2, 44100 * 20 * 60)), /longer than 15 minutes/);
  await assert.rejects(checkWholeDecode(flac(44100, 8, 44100 * 5 * 60)), /number of channels/); // 8 channels x 5 min
  await assert.doesNotReject(checkWholeDecode(flac(44100, 8, 44100 * 3 * 60)));
  const unknown = new Blob([new Uint8Array(41 * 2 ** 20)]);
  await assert.rejects(checkWholeDecode(unknown), /over 40 MB/);
});

function wav(fmt: { format?: number; channels: number; rate: number; bits: number }, data = 0) {
  const f = [...le16(fmt.format ?? 1), ...le16(fmt.channels), ...le32(fmt.rate), ...le32(fmt.rate * fmt.channels * fmt.bits / 8), ...le16(fmt.channels * fmt.bits / 8), ...le16(fmt.bits)];
  const body = [...new TextEncoder().encode('WAVEfmt '), ...le32(16), ...f, ...new TextEncoder().encode('data'), ...le32(data), ...new Array(data).fill(0)];
  return bytes('RIFF', le32(body.length), body);
}

test('WAV: headers no recording has are refused (a 0 Hz rate used to hang the analysis)', async () => {
  assert.equal((await readWavHeader(wav({ channels: 2, rate: 44100, bits: 16 }, 4)))?.sampleRate, 44100);
  for (const bad of [{ channels: 1, rate: 0, bits: 16 }, { channels: 0, rate: 44100, bits: 16 }, { channels: 1, rate: 44100, bits: 13 },
    { channels: 1, rate: 0xffffffff, bits: 8 }, { channels: 40, rate: 44100, bits: 16 }, { format: 3, channels: 1, rate: 44100, bits: 16 }]) {
    await assert.rejects(readWavHeader(wav(bad)), /unsupported WAV header/, JSON.stringify(bad));
  }
});
