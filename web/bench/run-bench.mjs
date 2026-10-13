// Phase 0 benchmark runner: drives the spike page in headless Chromium and
// samples the browser's memory (PSS, summed over all Chromium processes).
//
//   npx vite build --mode spike && node bench/run-bench.mjs --fixtures DIR [--out results.json] [--only name,name]
//
// DIR is the output of `python -m stoned_mango.synth DIR --mp3 --stereo --long 4 10 20`.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: args } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    out: { type: 'string', default: 'bench-results.json' },
    only: { type: 'string' },
    port: { type: 'string', default: '4173' },
  },
});
if (!args.fixtures) throw new Error('--fixtures DIR is required');
const FX = resolve(args.fixtures);
const only = args.only?.split(',');
const URL_ = `http://127.0.0.1:${args.port}/spike.html`;

// ---- memory sampling -------------------------------------------------------

function chromiumPids() {
  const pids = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (/chrom(e|ium)/.test(cmd) && !cmd.includes('node')) pids.push(d);
    } catch {}
  }
  return pids;
}

function chromiumPssMB() {
  let kb = 0;
  for (const pid of chromiumPids()) {
    try {
      const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m);
      if (m) kb += Number(m[1]);
    } catch {}
  }
  return kb / 1024;
}

function sampler() {
  let peak = 0;
  const id = setInterval(() => (peak = Math.max(peak, chromiumPssMB())), 100);
  return { stop: () => (clearInterval(id), Math.max(peak, chromiumPssMB())) };
}

// ---- helpers ---------------------------------------------------------------

async function withServer(fn) {
  // Run vite's entry point directly (not via npx) so kill() stops the actual server.
  const vite = join(import.meta.dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');
  const server = spawn(process.execPath, [vite, 'preview', '--port', args.port, '--strictPort', '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => {
    server.stdout.on('data', (d) => d.toString().includes(args.port) && res());
    server.on('exit', (c) => rej(new Error(`vite preview exited ${c}`)));
  });
  try {
    return await fn();
  } finally {
    server.kill();
  }
}

async function freshPage(browser, cpuThrottle = 1) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (cpuThrottle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  }
  await page.goto(URL_);
  await page.waitForFunction(() => window.stonedMangoBench);
  return { page, context, errors };
}

async function runFiles(browser, name, paths, opts, cpuThrottle = 1) {
  const { page, context, errors } = await freshPage(browser, cpuThrottle);
  const baseline = chromiumPssMB();
  await page.setInputFiles('#files', paths);
  const mem = sampler();
  const summary = await page.evaluate(
    (o) => window.stonedMangoBench.run([...document.getElementById('files').files], o),
    opts,
  );
  const peak = mem.stop();
  await context.close();
  summary.errors.push(...errors);
  const res = { name, cpuThrottle, opts, baselinePssMB: baseline, peakPssMB: peak, summary };
  const perFile = summary.files.map((f) => f.decodeMs + f.totalWorkerMs);
  console.log(
    `${name.padEnd(34)} files=${summary.files.length} audio=${(summary.audioSeconds / 60).toFixed(1)}min ` +
      `wall=${(summary.totalMs / 1000).toFixed(1)}s x${summary.realtimeFactor.toFixed(0)} realtime ` +
      `perFile(avg)=${(perFile.reduce((a, b) => a + b, 0) / perFile.length / 1000).toFixed(2)}s ` +
      `peakPSS=${peak.toFixed(0)}MB (idle ${baseline.toFixed(0)}MB) errors=${summary.errors.length}`,
  );
  return res;
}

function fx(name) {
  return join(FX, name);
}

/** N distinct paths pointing at the same file (browsers dedupe identical picks). */
function copies(file, n) {
  const dir = join(FX, `copies_${file}`);
  mkdirSync(dir, { recursive: true });
  return Array.from({ length: n }, (_, i) => {
    const p = join(dir, `${String(i).padStart(3, '0')}_${file}`);
    if (!existsSync(p)) symlinkSync(fx(file), p);
    return p;
  });
}

const FULL = { profiles: ['edma', 'bgate', 'temperley', 'krumhansl'], frameLoop: true, cnn: true, model: 'int8' };

// ---- scenarios -------------------------------------------------------------

const manifest = JSON.parse(readFileSync(fx('manifest.json'), 'utf8'));
const suite = manifest.filter((m) => !m.name.startsWith('long_'));

const scenarios = {
  golden: async (browser) => {
    const { page, context } = await freshPage(browser);
    const r = await page.evaluate(() => Promise.all([window.stonedMangoBench.golden('fp32'), window.stonedMangoBench.golden('int8')]));
    await context.close();
    r.forEach((g) => console.log(`golden ${g.model}: shape ${g.shape} maxAbsDiff=${g.maxAbsDiff.toExponential(2)} ${g.ms.toFixed(1)}ms`));
    return r;
  },
  parity_wav: (b) => runFiles(b, 'parity_wav', suite.map((m) => fx(`${m.name}.wav`)), { ...FULL, workers: 2 }),
  parity_mp3: (b) => runFiles(b, 'parity_mp3', suite.map((m) => fx(`${m.name}.mp3`)), { ...FULL, workers: 2 }),
  single_4min_int8: (b) => runFiles(b, 'single_4min_int8', [fx('long_4min_c_ionian.mp3')], { ...FULL, workers: 1 }),
  single_4min_fp32: (b) => runFiles(b, 'single_4min_fp32', [fx('long_4min_c_ionian.mp3')], { ...FULL, model: 'fp32', workers: 1 }),
  single_4min_1profile: (b) =>
    runFiles(b, 'single_4min_1profile', [fx('long_4min_c_ionian.mp3')], { ...FULL, profiles: ['edma'], workers: 1 }),
  long_10min_mp3: (b) => runFiles(b, 'long_10min_mp3', [fx('long_10min_c_ionian.mp3')], { ...FULL, workers: 1 }),
  long_20min_mp3: (b) => runFiles(b, 'long_20min_mp3', [fx('long_20min_c_ionian.mp3')], { ...FULL, workers: 1 }),
  long_20min_wav: (b) => runFiles(b, 'long_20min_wav', [fx('long_20min_c_ionian.wav')], { ...FULL, workers: 1 }),
  bulk_24x4min_w1: (b) => runFiles(b, 'bulk_24x4min_w1', copies('long_4min_c_ionian.mp3', 24), { ...FULL, workers: 1 }),
  bulk_24x4min_w2: (b) => runFiles(b, 'bulk_24x4min_w2', copies('long_4min_c_ionian.mp3', 24), { ...FULL, workers: 2 }),
  bulk_24x4min_w3: (b) => runFiles(b, 'bulk_24x4min_w3', copies('long_4min_c_ionian.mp3', 24), { ...FULL, workers: 3 }),
  bulk_24x4min_w4: (b) => runFiles(b, 'bulk_24x4min_w4', copies('long_4min_c_ionian.mp3', 24), { ...FULL, workers: 4 }),
  throttle4_4min: (b) => runFiles(b, 'throttle4_4min', [fx('long_4min_c_ionian.mp3')], { ...FULL, workers: 1 }, 4),
  throttle6_4min: (b) => runFiles(b, 'throttle6_4min', [fx('long_4min_c_ionian.mp3')], { ...FULL, workers: 1 }, 6),
};

const results = {};
await withServer(async () => {
  // Prefer a pre-installed Chromium (CHROMIUM_PATH, or the one in /opt/pw-browsers) over
  // Playwright's pinned download, which may not be installed.
  const preinstalled = '/opt/pw-browsers/chromium';
  const executablePath = process.env.CHROMIUM_PATH || (existsSync(preinstalled) ? preinstalled : undefined);
  const browser = await chromium.launch({ executablePath });
  console.log(`Chromium ${browser.version()}, ${(await import('node:os')).cpus().length} CPUs`);
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    try {
      results[name] = await fn(browser);
    } catch (err) {
      console.log(`${name}: FAILED ${err.stack ?? err}`);
      results[name] = { error: String(err) };
    }
  }
  await browser.close();
});
writeFileSync(args.out, JSON.stringify(results, null, 2));
console.log(`wrote ${args.out}`);
