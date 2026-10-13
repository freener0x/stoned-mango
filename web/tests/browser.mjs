// End to end in a real browser (headless Chromium), on the built app:
//
//  1. engine: WAV (streamed in the worker), MP3 (WebCodecs, frame by frame) and FLAC
//     (main-thread decodeAudioData fallback) give Python's labels and sections
//  2. privacy: once the app has loaded (and saved itself for offline use), analysing
//     files makes no network request at all
//  3. interface: the results table, the song view and its timeline, settings (notation,
//     skin), CSV export
//  4. key tags: tagged copies downloaded as a zip; a file changed in place through the
//     File System Access API (on the browser's private file system, which needs no picker)
//  5. offline: with the network off, the app reloads from its service worker and still
//     analyses a file
//
//   npm run build && npm run test:browser          (CHROMIUM_PATH=... to use a specific Chromium;
//   CORES=n to simulate n CPU cores; INIT_SCRIPT=file.js to run a script in the page first)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readKeyTags } from '../src/ui/tagging/files.ts';

const PORT = 4174;
const URL_ = `http://127.0.0.1:${PORT}/`;
const GOLDEN = fileURLToPath(new URL('../../shared/golden/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${GOLDEN}manifest.json`, 'utf8'));

const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const server = spawn(process.execPath, [vite, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore',
});
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const step = (s) => console.log(`\n== ${s}`);
const finished = (n) => {
  const jobs = window.stonedMango.pool.jobs;
  return jobs.length >= n && jobs.every((j) => ['done', 'error', 'cancelled'].includes(j.status));
};

/** The entries of a stored (uncompressed) zip. */
function unzip(buf) {
  const out = {};
  let pos = 0;
  while (buf.readUInt32LE(pos) === 0x04034b50) {
    const size = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extra = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    const start = pos + 30 + nameLen + extra;
    out[name] = buf.subarray(start, start + size);
    pos = start + size;
  }
  return out;
}

let failed = false;
const errors = [];
let page = null;
/** Clicks a top-bar link and waits for its view. */
async function nav(label, hash) {
  await page.click(`nav >> text=${label}`);
  await page.waitForFunction((h) => location.hash === h, hash, { timeout: 10000 });
}
try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 900 } });
  // Every Content-Security-Policy violation is collected: the app itself must cause none.
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  if (process.env.INIT_SCRIPT) await context.addInitScript({ path: process.env.INIT_SCRIPT });
  if (process.env.CORES) await context.addInitScript((n) => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => n }), Number(process.env.CORES));
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  let response;
  for (let i = 0; ; i++) {
    try { response = await page.goto(URL_); break; } catch (e) { if (i > 50) throw e; await new Promise((r) => setTimeout(r, 200)); }
  }
  const policy = response.headers()['content-security-policy'] ?? '';
  assert.match(policy, /connect-src 'self'/, 'the page is served with its security policy');
  assert.match(policy, /default-src 'none'/);
  page.on('requestfailed', (r) => r.url().startsWith('blob:') || errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  const t0 = Date.now();
  await page.evaluate(() => window.stonedMango.ready);
  console.log(`engine ready in ${Date.now() - t0} ms (${await page.evaluate(() => window.stonedMango.pool.size)} workers)`);
  await page.evaluate(() => window.stonedMango.offline());
  console.log(`saved for offline use in ${Date.now() - t0} ms`);
  // The preview server redirects /index.html to / like Cloudflare Pages. Browsers refuse a page served
  // from a redirected response (Safari: "Response served by service worker has redirections").
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const req of await cache.keys()) out.push([new URL(req.url).pathname, (await cache.match(req)).redirected]);
    }
    return out;
  });
  assert.ok(cached.some(([path]) => path === '/'), 'the page is kept for offline use');
  assert.deepEqual(cached.filter(([, redirected]) => redirected), [], 'no redirected responses kept for offline use');

  // Maqam, makam and raga scales are off by default ("Western scales only"); the golden files expect
  // the experimental Automatic setting, so switch it on, as a user would.
  assert.equal(await page.evaluate(() => window.stonedMango.pool.options.traditions), 'western', 'Western only by default');
  await nav('Settings', '#/settings');
  await page.selectOption('#traditions', 'auto');
  await nav('Analyse', '#/');
  assert.equal(await page.evaluate(() => window.stonedMango.pool.options.traditions), 'auto');

  step('engine and privacy');
  // From here on nothing may touch the network: the files never leave the device.
  const requests = [];
  context.on('request', (r) => { if (!/^(blob|data):/.test(r.url())) requests.push(r.url()); });

  const names = [...Object.keys(manifest.clips).map((n) => manifest.clips[n].wav), ...Object.keys(manifest.compressed)];
  const t1 = Date.now();
  await page.setInputFiles('#files', names.map((n) => `${GOLDEN}${n}`));
  await page.waitForFunction(finished, names.length, { timeout: 120000 });
  const jobs = await page.evaluate(() => window.stonedMango.pool.jobs.map((j) => ({
    id: j.id, name: j.file.name, status: j.status, error: j.error, method: j.method, label: j.result?.label,
    segments: j.result?.segments.map((s) => s.label), ms: j.ms, envelope: j.envelope?.values.length,
  })));
  console.log(`analysed ${jobs.length} files in ${Date.now() - t1} ms`);
  for (const j of jobs) console.log(`  ${j.name}: ${j.label ?? j.error} [${j.method}] ${j.segments?.join(' → ')} (${Math.round(j.ms ?? 0)} ms)`);
  const expect = {};
  for (const c of Object.values(manifest.clips)) expect[c.wav] = { ...c, method: 'wav' };
  expect['modulating-22k.mp3'] = { ...manifest.compressed['modulating-22k.mp3'], method: 'mp3-webcodecs' };
  expect['dorian-22k.flac'] = { ...manifest.compressed['dorian-22k.flac'], method: 'decodeAudioData' };
  for (const j of jobs) {
    const e = expect[j.name];
    assert.equal(j.status, 'done', `${j.name}: ${j.error}`);
    assert.equal(j.method, e.method, `${j.name} decoded with ${j.method}`);
    assert.equal(j.label, e.label, `${j.name} label`);
    assert.deepEqual(j.segments, e.segments, `${j.name} sections`);
    assert.ok(j.envelope > 10, `${j.name} loudness envelope`);
  }
  assert.deepEqual(requests, [], `network requests while analysing: ${requests.join(', ')}`);
  console.log('results match Python; no network requests');

  step('interface');
  const rows = page.locator('table.table tbody tr');
  assert.equal(await rows.count(), names.length);
  const dorianRow = rows.filter({ hasText: 'dorian-44k-stereo.wav' });
  assert.match(await dorianRow.innerText(), /D Dorian\s*8B\s*\(C major\)/);
  assert.match(await rows.filter({ hasText: 'noise-22k.wav' }).innerText(), /No clear key/);
  await rows.filter({ hasText: 'modulating-22k.wav' }).click();
  const song = page.locator('aside.song');
  await song.waitFor();
  assert.match(await song.locator('h2').innerText(), /modulating-22k\.wav/);
  assert.match(await song.innerText(), /key changes[\s\S]*C major\s*8B[\s\S]*G major\s*9B/i);
  assert.match(await song.locator('.scale-notes').innerText(), /G\s+A\s+B\s+C\s+D\s+E\s+F♯[\s\S]*root G, major/, 'scale notes');
  const box = await song.locator('canvas.timeline-canvas').boundingBox();
  assert.ok(box && box.width > 200 && box.height > 100, 'timeline drawn');
  await song.locator('canvas.timeline-canvas').click({ position: { x: box.width * 0.75, y: 60 } });
  assert.match(await song.locator('canvas.timeline-canvas').getAttribute('aria-valuetext'), /G major/);
  // filter: songs that mix with this one
  await song.getByRole('button', { name: /Show songs that mix with/ }).click();
  assert.match(await page.locator('.filter-chip').innerText(), /Mixes with/);
  await page.getByRole('button', { name: 'Show all', exact: true }).click();
  // maqam and raga-family scales: the nearest key's code with ≈, notes between the keys, ragas
  assert.match(await rows.filter({ hasText: 'sikah-22k.wav' }).innerText(), /Maqam Sikah on E half-flat\s*≈8B\s*\(≈ C major\)/);
  await rows.filter({ hasText: 'kalyan-22k.wav' }).click();
  await song.locator('h2', { hasText: 'kalyan-22k.wav' }).waitFor();
  const world = await song.innerText();
  assert.match(world, /Kalyan thaat, Sa = D\s*≈11B\s*\(≈ A major\)/, 'tier 3 label');
  assert.match(world, /Mechakalyani, the 65th melakarta/);
  assert.match(world, /Ragas with these notes: (Yaman|Kalyani)/);
  assert.match(world, /In Western terms: D Lydian/);
  assert.match(await song.locator('.scale-notes').innerText(), /D\s+E\s+F♯−14¢/, 'notes with cents');
  await page.keyboard.press('Escape');

  // settings: notation and skin, stored as preferences only
  await nav('Settings', '#/settings');
  await page.selectOption('#notation', 'name+openkey');
  await page.click('[data-skin-preview=mango]');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), 'mango');
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('stoned-mango.settings')));
  assert.deepEqual(stored, { skin: 'mango', notation: 'name+openkey', traditions: 'auto' });
  await nav('Analyse', '#/');
  assert.match(await dorianRow.innerText(), /D Dorian\s*1d/);
  await nav('Settings', '#/settings');
  await page.selectOption('#notation', 'name+camelot');

  // CSV export, made on the device
  await nav('Analyse', '#/');
  const [csvDownload] = await Promise.all([page.waitForEvent('download'), page.click('text=Export CSV')]);
  const csv = readFileSync(await csvDownload.path(), 'utf8');
  assert.ok(csv.startsWith('﻿file,key,camelot,open_key,mix_key'), csv.slice(0, 80));
  assert.match(csv, /"dorian-44k-stereo.wav","D Dorian",8B,1d,"C major"/);
  console.log('table, song view, timeline, settings and CSV export work');

  step('key tags');
  await nav('Settings', '#/settings');
  await page.check('text=Write keys into the files’ tags');
  await nav('Analyse', '#/');
  await page.click('text=Write key tags…');
  const dialog = page.locator('dialog[open]');
  assert.match(await dialog.innerText(), /5 tagged copies will be downloaded[\s\S]*2 files will be skipped: no clear key; only MP3 and WAV/);
  const [zipDownload] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download tagged copies' }).click()]);
  assert.equal(zipDownload.suggestedFilename(), 'stoned-mango-tagged.zip');
  const entries = unzip(readFileSync(await zipDownload.path()));
  assert.deepEqual(Object.keys(entries).sort(),
    ['dorian-44k-stereo.wav', 'kalyan-22k.wav', 'modulating-22k.mp3', 'modulating-22k.wav', 'sikah-22k.wav']);
  assert.deepEqual(await readKeyTags(new Blob([entries['kalyan-22k.wav']])), { tkey: 'A', keyMode: 'Kalyan thaat, Sa = D' });
  assert.deepEqual(await readKeyTags(new Blob([entries['dorian-44k-stereo.wav']])), { tkey: 'C', keyMode: 'D Dorian' });
  assert.deepEqual(await readKeyTags(new Blob([entries['modulating-22k.mp3']])), { tkey: 'G', keyMode: 'G major' });
  await page.locator('dialog[open]').getByRole('button', { name: 'Done' }).click();

  // In place: a file with a File System Access handle (here on the private origin file system).
  const id = await page.evaluate(async () => {
    const { store } = window.stonedMango;
    const src = store.pool.jobs.find((j) => j.file.name === 'modulating-22k.mp3').file;
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('in-place.mp3', { create: true });
    const w = await handle.createWritable();
    await w.write(src);
    await w.close();
    const [job] = store.add([{ file: await handle.getFile(), path: 'in-place.mp3', handle }]);
    return job.id;
  });
  await page.waitForFunction(finished, names.length + 1, { timeout: 60000 });
  await page.evaluate((id) => { location.hash = `#/song/${id}`; }, id);
  await page.locator('aside.song').getByRole('button', { name: 'Write key tag' }).click();
  assert.match(await page.locator('dialog[open]').innerText(), /1 file will be updated in place/);
  await page.locator('dialog[open]').getByRole('button', { name: 'Write tags' }).click();
  await page.locator('dialog[open]').getByText('1 file updated in place.').waitFor();
  await page.locator('dialog[open]').getByRole('button', { name: 'Done' }).click();
  const written = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle('in-place.mp3')).getFile();
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  });
  assert.deepEqual(await readKeyTags(new Blob([Uint8Array.from(written)])), { tkey: 'G', keyMode: 'G major' });
  assert.match(await page.locator('aside.song').innerText(), /Key tag written: G/);
  assert.deepEqual(requests, [], `network requests: ${requests.join(', ')}`);
  console.log('tagged copies (zip) and in-place writing work; still no network requests');

  step('pages');
  for (const [view, text] of [['privacy', /connect-src 'self'/], ['accuracy', /0\.703/], ['donate', /Support stoned-mango/]]) {
    await page.click(`footer >> text=${view[0].toUpperCase()}${view.slice(1)}`);
    await page.locator('main.page', { hasText: text }).waitFor({ timeout: 10000 }); // waits for the view to render
  }
  console.log('privacy, accuracy and donate pages open');

  step('security policy');
  assert.deepEqual(await page.evaluate(() => window.__csp), [], 'the app broke its own security policy');
  // The browser itself must refuse to send anything to another site.
  const outside = await page.evaluate(() => fetch('https://example.com/upload', { method: 'POST', body: 'x' }).then(() => 'sent', () => 'blocked'));
  assert.equal(outside, 'blocked');
  assert.deepEqual(await page.evaluate(() => window.__csp), ['connect-src https://example.com/upload']);
  assert.deepEqual(requests, [], `network requests: ${requests.join(', ')}`);
  errors.splice(0); // the blocked request's console message
  console.log('no violations by the app; a request to another site is blocked by the browser');

  step('offline');
  console.log('controller before reload:', await page.evaluate(() => navigator.serviceWorker.controller?.state));
  await context.setOffline(true);
  const reloaded = await page.reload();
  assert.match(reloaded.headers()['content-security-policy'] ?? '', /connect-src 'self'/, 'offline, the page keeps its security policy');
  await page.waitForFunction(() => window.stonedMango, null, { timeout: 30000 }).catch(async (e) => {
    console.log('page after the offline reload:', page.url(), errors);
    console.log('caches:', await page.evaluate(async () => Promise.all((await caches.keys()).map(async (k) => [k, (await (await caches.open(k)).keys()).map((r) => r.url)]))));
    console.log('controller:', await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL));
    throw e;
  });
  await page.evaluate(() => window.stonedMango.ready);
  await page.setInputFiles('#files', `${GOLDEN}dorian-44k-stereo.wav`);
  await page.waitForFunction(finished, 1, { timeout: 60000 });
  const offline = await page.evaluate(() => window.stonedMango.pool.jobs.map((j) => j.result?.label));
  assert.deepEqual(offline, [manifest.clips['dorian-44k-stereo'].label]);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), 'mango', 'preferences kept');
  // the traditions setting reaches the workers: "Western scales only" keeps the Kalyan clip Western
  await nav('Settings', '#/settings');
  await page.selectOption('#traditions', 'western');
  await nav('Analyse', '#/');
  await page.setInputFiles('#files', `${GOLDEN}kalyan-22k.wav`);
  await page.waitForFunction(finished, 2, { timeout: 60000 });
  const western = await page.evaluate(() => window.stonedMango.pool.jobs[1].result);
  assert.ok(!western.tradition && western.engine !== 'tier3', `Western only: ${western.label}`);
  console.log('the app reloads and analyses with the network off');

  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  console.log('\nbrowser tests passed');
} catch (e) {
  failed = true;
  console.error(e);
  if (page) {
    console.error('page errors:', errors);
    console.error('at', page.url(), '\n', (await page.locator('body').innerText().catch(() => '')).slice(0, 1500));
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
