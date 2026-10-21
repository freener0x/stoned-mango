// The security headers (build/headers.ts) written to dist/_headers for Cloudflare Pages.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { contentSecurityPolicy, headersFile, headersFor, inlineScriptHashes, parseHeaders } from '../build/headers.ts';

const html = '<html><head><script>var a = 1;</script><script type="module" src="/x.js"></script></head></html>';
const hash = `'sha256-${createHash('sha256').update('var a = 1;').digest('base64')}'`;

test('the inline script is allowed by its hash, and only it', () => {
  assert.deepEqual(inlineScriptHashes(html), [hash]);
  const csp = contentSecurityPolicy(html);
  assert.ok(csp.includes(`script-src 'self' 'wasm-unsafe-eval' ${hash}`), csp);
  assert.ok(!/unsafe-inline|'unsafe-eval'|\*|https?:/.test(csp), csp);
  for (const d of ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'"]) assert.ok(csp.includes(d), d);
});

test('each path gets the right policy', () => {
  const rules = parseHeaders(headersFile(html));
  const csp = (path: string) => headersFor(path, rules).filter(([n]) => n === 'Content-Security-Policy').map(([, v]) => v);
  assert.equal(csp('/').length, 1);
  assert.equal(csp('/')[0], contentSecurityPolicy(html));
  assert.equal(csp('/index.html')[0], contentSecurityPolicy(html));
  assert.equal(csp('/assets/worker-AbC12.js').length, 1);
  assert.match(csp('/assets/worker-AbC12.js')[0], /'unsafe-eval'.*connect-src 'self'/);
  assert.deepEqual(csp('/assets/main-AbC12.js'), []);
  assert.match(csp('/sw.js')[0], /connect-src 'self'/);
  const all = headersFor('/assets/main-AbC12.js', rules);
  assert.ok(all.some(([n, v]) => n === 'X-Content-Type-Options' && v === 'nosniff'));
  assert.ok(all.some(([n, v]) => n === 'Cache-Control' && v.includes('immutable')));
  assert.ok(headersFor('/sw.js', rules).some(([n, v]) => n === 'Cache-Control' && v === 'no-cache'));
  for (const path of ['/', '/assets/main-AbC12.js', '/sw.js', '/does-not-exist']) {
    assert.ok(headersFor(path, rules).some(([n, v]) => n === 'Strict-Transport-Security' && /max-age=\d{8}/.test(v)), path);
  }
});
