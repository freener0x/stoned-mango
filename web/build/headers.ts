// The HTTP headers the site is served with (Cloudflare Pages reads them from dist/_headers).
//
// The Content-Security-Policy is what makes "your music never leaves your device" checkable:
// the browser itself refuses to let the page connect anywhere but its own site
// (connect-src 'self'), load scripts from anywhere else, or be framed. Anyone can see it in
// the browser's developer tools. The one inline script (applying the saved skin before the
// first paint) is allowed by its hash, computed from the built page.

import { createHash } from 'node:crypto';

export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    out.push(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return out;
}

const COMMON = ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"];

/** The page's policy. */
export function contentSecurityPolicy(html: string): string {
  return [
    ...COMMON,
    // 'wasm-unsafe-eval' lets WebAssembly compile; it doesn't allow eval() of JavaScript
    `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes(html).join(' ')}`.trim(),
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:", // playing your own file from this device
    "connect-src 'self'", // the page can fetch only the site's own files
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; ');
}

/**
 * The analysis workers' policy (a worker follows the policy its own script is served with).
 * Essentia.js's WebAssembly glue builds functions at run time, which needs 'unsafe-eval';
 * the worker still can't connect anywhere but this site, so nothing can be sent away.
 */
export const WORKER_POLICY = [...COMMON, "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'", "connect-src 'self'"].join('; ');

/** The service worker's policy: it only fetches the site's own files. */
export const SERVICE_WORKER_POLICY = [...COMMON, "script-src 'self'", "connect-src 'self'"].join('; ');

/** dist/_headers in Cloudflare Pages' format. The page's policy is on the page (the app only uses "/"). */
export function headersFile(html: string): string {
  const page = contentSecurityPolicy(html);
  return `# Written by the build (web/build/headers.ts). Served by Cloudflare Pages.
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()
/
  Content-Security-Policy: ${page}
  Cache-Control: no-cache
/index.html
  Content-Security-Policy: ${page}
  Cache-Control: no-cache
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/assets/worker-*
  Content-Security-Policy: ${WORKER_POLICY}
/sw.js
  Content-Security-Policy: ${SERVICE_WORKER_POLICY}
  Cache-Control: no-cache
`;
}

export interface HeaderRule {
  pattern: RegExp;
  headers: [string, string][];
}

/** Parses the _headers format (path patterns with *, indented "Name: value" lines). */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const re = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      rules.push({ pattern: new RegExp(`^${re}$`), headers: [] });
    } else {
      const i = line.indexOf(':');
      rules[rules.length - 1].headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

export function headersFor(path: string, rules: HeaderRule[]): [string, string][] {
  return rules.filter((r) => r.pattern.test(path)).flatMap((r) => r.headers);
}
