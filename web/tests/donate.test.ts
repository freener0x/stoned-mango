// The Donate page's build-time data (build/donate.ts): only filled-in methods appear, QR codes are static images.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { donateData } from '../build/donate.ts';

test('empty config: nothing shown', async () => {
  assert.deepEqual(await donateData({}), { links: [], coins: [] });
});

test('the real donate.json builds: Cash App and four coins, each with a QR code', async () => {
  const d = await donateData(JSON.parse(readFileSync(new URL('../donate.json', import.meta.url), 'utf8')));
  assert.deepEqual(d.links.map((l) => l.id), ['cashapp']);
  assert.match(d.links[0].url, /^https:\/\/cash\.app\/\$\w+$/);
  assert.deepEqual(d.coins.map((c) => c.id), ['BTC', 'ETH', 'SOL', 'XMR']);
  for (const c of d.coins) assert.ok(c.qr.startsWith('data:image/svg+xml;base64,'), c.id);
  assert.match(d.coins.find((c) => c.id === 'ETH')!.note ?? '', /Ethereum mainnet/);
});

test('links and QR codes', async () => {
  const d = await donateData({
    cashApp: '$mangotag', paypal: 'mango', checkout: 'https://ko-fi.com/mango',
    crypto: { XMR: '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge', BTC: '' },
  });
  assert.deepEqual(d.links.map((l) => l.url), ['https://cash.app/$mangotag', 'https://paypal.me/mango', 'https://ko-fi.com/mango']);
  assert.equal(d.coins.length, 1);
  assert.ok(d.coins[0].qr.startsWith('data:image/svg+xml;base64,'));
  assert.match(Buffer.from(d.coins[0].qr.split(',')[1], 'base64').toString(), /^<svg /);
  assert.match(d.coins[0].note ?? '', /private/);
});

test('bad values are refused at build time', async () => {
  await assert.rejects(donateData({ checkout: 'http://example.com' }));
  await assert.rejects(donateData({ crypto: { BTC: 'not an address!' } }));
});
