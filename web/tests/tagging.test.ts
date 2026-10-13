// The key-tag writer (src/ui/tagging). Inputs in shared/golden/tags/in were tagged by
// mutagen (python -m stoned_mango.tag_fixtures); our outputs are kept in
// shared/golden/tags/out, and research/tests/test_tag_fixtures.py reads them back with
// mutagen. Set UPDATE_TAG_FIXTURES=1 to rewrite the outputs after an intended change.

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileKind, readKeyTags, tagFile, toBlob, type KeyTags } from '../src/ui/tagging/files.ts';
import { buildTag, deunsync, parseTag, readKeys, TagError, tagLength, withKeys } from '../src/ui/tagging/id3.ts';
import { keyTags } from '../src/ui/tagging/keys.ts';
import { crc32, zip } from '../src/ui/tagging/zip.ts';
import type { Result } from '../src/engine/analysis.ts';

const DIR = new URL('../../shared/golden/tags/', import.meta.url);
const IN = new URL('in/', DIR);
const OUT = new URL('out/', DIR);
const UPDATE = process.env.UPDATE_TAG_FIXTURES === '1';
const KEYS: KeyTags = { tkey: '8A', keyMode: 'D Dorian ♯4' };

const read = (u: URL) => new Uint8Array(readFileSync(u));
const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];

/** The audio payload: MP3 after the ID3v2 tag; WAV's data chunk. */
function audio(b: Uint8Array): Uint8Array {
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF') {
    let pos = 12;
    for (;;) {
      const id = String.fromCharCode(...b.subarray(pos, pos + 4));
      const size = b[pos + 4] | (b[pos + 5] << 8) | (b[pos + 6] << 16) | (b[pos + 7] << 24);
      if (id === 'data') return b.subarray(pos + 8, pos + 8 + size);
      pos += 8 + size + (size & 1);
    }
  }
  return b.subarray(tagLength(b));
}

if (UPDATE) mkdirSync(OUT, { recursive: true });
const outputs: { name: string; bytes: Uint8Array }[] = [];

for (const name of readdirSync(IN).sort()) {
  test(`${name}: key tags written, audio and other tags untouched`, async () => {
    const original = read(new URL(name, IN));
    const tagged = await tagFile(new Blob([original]), KEYS);
    const bytes = await blobBytes(toBlob(tagged));
    assert.equal(bytes.length, tagged.size);
    assert.deepEqual(await readKeyTags(new Blob([bytes])), { tkey: '8A', keyMode: 'D Dorian ♯4' });
    assert.deepEqual(audio(bytes), audio(original), 'audio bytes changed');
    if (name.endsWith('.mp3')) {
      const before = parseTag(original.subarray(0, tagLength(original)));
      const after = parseTag(bytes.subarray(0, tagLength(bytes)));
      assert.equal(after.version, before.size ? before.version : 3);
      const kept = (t: typeof before) => t.frames.filter((f) => f.id !== 'TKEY' && !(f.id === 'TXXX' && readKeys({ ...t, frames: [f] }).keyMode !== null));
      assert.deepEqual(kept(after), kept(before), 'other frames changed');
      if (before.size) assert.deepEqual(bytes.subarray(after.size), original.subarray(before.size));
      if (name === 'v24-padding.mp3') assert.equal(after.size, before.size, 'the tag should fit in the old one’s padding');
    }
    // Tagging again changes nothing (the new tag fits where the old one was).
    const again = await blobBytes(toBlob(await tagFile(new Blob([bytes]), KEYS)));
    assert.deepEqual(again, bytes);
    outputs.push({ name, bytes });
    const out = new URL(name, OUT);
    if (UPDATE) writeFileSync(out, bytes);
    else assert.deepEqual(bytes, read(out), `differs from shared/golden/tags/out/${name} (UPDATE_TAG_FIXTURES=1 to rewrite)`);
  });
}

test('tagged copies in a zip', async () => {
  const entries = await Promise.all(['untagged.mp3', 'info-id3.wav'].map(async (n) => ({
    name: `Music/Sub folder/${n}`, parts: (await tagFile(new Blob([read(new URL(n, IN))]), KEYS)).parts,
  })));
  const bytes = await blobBytes(await zip(entries, new Date(2026, 0, 2, 3, 4, 6)));
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'PK\x03\x04');
  if (UPDATE) writeFileSync(new URL('copies.zip', OUT), bytes);
  else assert.deepEqual(bytes, read(new URL('copies.zip', OUT)));
});

test('crc32', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new TextEncoder().encode('6789'), crc32(new TextEncoder().encode('12345'))), 0xcbf43926);
});

const frame = (id: string, data: number[], v4 = false, flags = [0, 0]) =>
  [...id].map((c) => c.charCodeAt(0)).concat(v4 ? syncsafe(data.length) : [0, 0, 0, data.length], flags, data);
const tag = (major: number, flags: number, body: number[]) => Uint8Array.from([0x49, 0x44, 0x33, major, 0, flags, ...syncsafe(body.length), ...body]);
const text = (s: string) => [0, ...[...s].map((c) => c.charCodeAt(0))];

test('ID3: unsynchronised v2.3 tags are read and written back plain', () => {
  const pic = frame('APIC', [0, 0x69, 0, 3, 0, 0xff, 0xe0, 0xff, 0xfb]);
  const raw = [...frame('TIT2', text('Hi')), ...pic];
  const unsynced = raw.flatMap((b, i) => (b === 0xff && (raw[i + 1] ?? 0) >= 0xe0 ? [b, 0] : [b])).concat([0, 0]);
  const t = parseTag(tag(3, 0x80, unsynced));
  assert.deepEqual(t.frames.map((f) => f.id), ['TIT2', 'APIC']);
  assert.deepEqual([...t.frames[1].data], [0, 0x69, 0, 3, 0, 0xff, 0xe0, 0xff, 0xfb]);
  const out = buildTag(withKeys(t, 'Am', null));
  assert.equal(out[5], 0, 'flags cleared');
  assert.deepEqual(readKeys(parseTag(out)), { tkey: 'Am', keyMode: null });
  assert.deepEqual([...deunsync(Uint8Array.of(1, 0xff, 0, 0xe0, 0xff, 0, 0))], [1, 0xff, 0xe0, 0xff, 0]);
});

test('ID3: v2.4 tag-level unsync moves to the frames; plain-integer v2.4 sizes are tolerated', () => {
  const t = parseTag(tag(4, 0x80, [...frame('TIT2', text('Hi'), true), 0, 0]));
  assert.equal(t.frames[0].flags[1] & 0x02, 0x02);
  const big = text('x'.repeat(200)); // 201 bytes: as a plain integer, not a valid syncsafe one
  const t2 = parseTag(tag(4, 0, [...frame('TIT2', big, false), ...frame('TKEY', text('C'), false)]));
  assert.deepEqual(t2.frames.map((f) => f.id), ['TIT2', 'TKEY']);
  assert.equal(readKeys(t2).tkey, 'C');
});

test('ID3: refuses what it can’t handle safely', async () => {
  assert.throws(() => parseTag(tag(2, 0, [0x54, 0x54, 0x32, 0, 0, 3, 0, 0x48, 0x69])), TagError);
  assert.throws(() => parseTag(tag(3, 0, [...frame('TIT2', text('Hi')), 0x41, 0x42])), TagError); // junk after the frames
  assert.throws(() => parseTag(tag(3, 0, [0x74, 0x69, 0x74, 0x32, 0, 0, 0, 1, 0, 0, 0])), TagError); // bad frame id
  assert.throws(() => withKeys(parseTag(new Uint8Array(0)), 'A minor', null), TagError);
  await assert.rejects(tagFile(new Blob([new TextEncoder().encode('fLaC....')]), KEYS), TagError);
  assert.equal(await fileKind(new Blob([Uint8Array.of(0xff, 0xfb, 0x90, 0x64)])), 'mp3');
});

test('WAV: an odd-sized last chunk without its pad byte', async () => {
  const data = [1, 2, 3];
  const fmt = [0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0, 0x22, 0x56, 0, 0, 0x22, 0x56, 0, 0, 1, 0, 8, 0];
  const body = [0x57, 0x41, 0x56, 0x45, ...fmt, 0x64, 0x61, 0x74, 0x61, 3, 0, 0, 0, ...data];
  const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, body.length, 0, 0, 0, ...body]);
  const out = await blobBytes(toBlob(await tagFile(new Blob([wav]), KEYS)));
  assert.equal(out.length % 2, 0);
  const riffSize = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
  assert.equal(riffSize, out.length - 8);
  assert.deepEqual([...audio(out)], data);
  assert.equal((await readKeyTags(new Blob([out]))).tkey, '8A');
  await assert.rejects(tagFile(new Blob([wav.subarray(0, wav.length - 2)]), KEYS), TagError); // cut short
});

test('what is written for a result', () => {
  const r = { key: { tonic: 2, scale: 'dorian', third: 'minor' }, label: 'D Dorian' } as Result;
  const s = { codeRule: 'notes', spelling: 'key', tagFormat: 'standard', tagModeFrame: true } as const;
  assert.deepEqual(keyTags(r, s), { tkey: 'C', keyMode: 'D Dorian' });
  assert.deepEqual(keyTags(r, { ...s, codeRule: 'home', tagFormat: 'camelot' }), { tkey: '7A', keyMode: 'D Dorian' });
  assert.deepEqual(keyTags(r, { ...s, tagFormat: 'openkey', tagModeFrame: false }), { tkey: '1d', keyMode: null });
  assert.equal(keyTags({ ...r, key: null } as Result, s), null);
});
