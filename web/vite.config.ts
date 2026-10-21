import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { donateModule } from './build/donate.ts';
import { headersFile, headersFor, parseHeaders } from './build/headers.ts';
import { thirdPartyLicenses } from './build/licenses.ts';

/** virtual:donate: the Donate page's links and QR codes, made from donate.json at build time. */
function donate(): Plugin {
  const file = resolve(__dirname, 'donate.json');
  return {
    name: 'stoned-mango-donate',
    resolveId: (id) => (id === 'virtual:donate' ? '\0virtual:donate' : undefined),
    async load(id) {
      if (id !== '\0virtual:donate') return undefined;
      this.addWatchFile(file);
      return donateModule(JSON.parse(readFileSync(file, 'utf8')));
    },
  };
}

/**
 * Writes dist/_headers (the security policy and caching rules, web/build/headers.ts), and
 * makes `vite preview` serve them too, so the tests run under the same policy as the site.
 */
function securityHeaders(): Plugin {
  let outDir = '';
  return {
    name: 'stoned-mango-headers',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      // public/spike holds the benchmark page's inputs: not part of the site unless that page is built
      if (!existsSync(join(outDir, 'spike.html'))) rmSync(join(outDir, 'spike'), { recursive: true, force: true });
      writeFileSync(join(outDir, '_headers'), headersFile(readFileSync(join(outDir, 'index.html'), 'utf8')));
    },
    configurePreviewServer(server) {
      const file = join(outDir, '_headers');
      const rules = existsSync(file) ? parseHeaders(readFileSync(file, 'utf8')) : [];
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url ?? '/').split('?');
        // Like Cloudflare Pages: /index.html redirects to /, so the tests meet the same redirect
        if (path.endsWith('/index.html')) {
          res.statusCode = 308;
          res.setHeader('Location', path.slice(0, -'index.html'.length) + (query ? `?${query}` : ''));
          res.end();
          return;
        }
        for (const [name, value] of headersFor(path, rules)) res.setHeader(name, value);
        // Like Cloudflare Pages with a 404.html: an address with no file gets that page and a 404 (without
        // one, Pages would serve the app at any address, outside the policy that only "/" carries)
        if (path !== '/' && !isFile(outDir, path)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(readFileSync(join(outDir, '404.html')));
          return;
        }
        next();
      });
    },
  };
}

// The modules bundled into the analysis worker (its build finishes before the page's bundle is written)
const workerModules = new Set<string>();

function collectWorkerModules(): Plugin {
  return {
    name: 'stoned-mango-worker-modules',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') for (const id of chunk.moduleIds) workerModules.add(id);
    },
  };
}

/** Writes dist/third-party-licenses.txt (web/build/licenses.ts) for the packages the page and the worker ship. */
function licenses(): Plugin {
  return {
    name: 'stoned-mango-licenses',
    apply: 'build',
    generateBundle(_, bundle) {
      const ids = new Set(workerModules);
      for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') for (const id of chunk.moduleIds) ids.add(id);
      this.emitFile({ type: 'asset', fileName: 'third-party-licenses.txt', source: thirdPartyLicenses(ids) });
    },
  };
}

/** Whether ``urlPath`` names a file inside ``dir``. */
function isFile(dir: string, urlPath: string): boolean {
  try {
    const file = join(dir, decodeURIComponent(urlPath));
    return file.startsWith(dir) && statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Writes dist/sw.js: the service worker with the list of files to keep offline (everything
 * the app references, starting from index.html, so the phase 0 benchmark page is left out)
 * and a version that changes whenever any of them does.
 */
function precache(): Plugin {
  let outDir = '';
  let base = '/';
  return {
    name: 'stoned-mango-precache',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
      base = c.base;
    },
    closeBundle() {
      const all: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(dir, e.name));
          else all.push(relative(outDir, join(dir, e.name)).split('\\').join('/'));
        }
      };
      walk(outDir);
      const text = /\.(html|js|css|webmanifest)$/;
      const keep = new Set(['index.html', 'manifest.webmanifest']);
      const queue = [...keep];
      while (queue.length) {
        const content = readFileSync(join(outDir, queue.pop()!), 'utf8');
        for (const f of all) {
          if (keep.has(f) || f === 'sw.js' || !content.includes(f.split('/').pop()!)) continue;
          keep.add(f);
          if (text.test(f)) queue.push(f);
        }
      }
      const files = [...keep].sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      // The kept responses carry their headers, so a change to the headers alone needs a new version too
      hash.update(headersFile(readFileSync(join(outDir, 'index.html'), 'utf8')));
      const sw = readFileSync(resolve(__dirname, 'src/pwa/sw.js'), 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__FILES__', JSON.stringify(files.map((f) => (f === 'index.html' ? base : `${base}${f}`))))
        .replace('__BASE__', base);
      writeFileSync(join(outDir, 'sw.js'), sw);
      this.info?.(`sw.js: ${files.length} files kept for offline use`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), donate(), licenses(), precache(), securityHeaders()],
  worker: { format: 'es', plugins: () => [collectWorkerModules()] },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'), // the app
        // the phase 0 benchmark page, only in `vite build --mode spike` (it isn't part of the site)
        ...(mode === 'spike' ? { spike: resolve(__dirname, 'spike.html') } : {}),
      },
    },
  },
}));
