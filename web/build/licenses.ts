// dist/third-party-licenses.txt: the licences of the npm packages whose code the site ships.
//
// MIT, BSD and Apache licences ask for their notice in every copy, and minifying strips it from
// the code, so the build collects each bundled package's licence file into one text file, which
// the About page links to.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The npm package a bundled module comes from, or undefined for the app's own code. */
export function packageOf(id: string): { name: string; dir: string } | undefined {
  const path = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return undefined;
  const start = at + '/node_modules/'.length;
  const parts = path.slice(start).split('/');
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return { name, dir: path.slice(0, start) + name };
}

// Packages published without a licence file: the standard text of their declared licence
const STANDARD: Record<string, string> = {
  MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  ISC: `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
};

// The copyright holder where the package's "author" field names a maintainer instead
const HOLDER: Record<string, string> = {
  'onnxruntime-common': 'Microsoft Corporation',
  'onnxruntime-web': 'Microsoft Corporation',
};

// Code compiled into a package's WebAssembly, with its own notices upstream
const NOTE: Record<string, string> = {
  'essentia.js': 'Its WebAssembly is built from Essentia (AGPL-3.0): https://github.com/MTG/essentia',
  'onnxruntime-web': 'Its WebAssembly also contains third-party components; their notices: https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt',
};

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i;

function repository(pkg: { repository?: string | { url?: string } }): string {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
}

function author(pkg: { author?: string | { name?: string } }): string {
  return (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? '').replace(/\s*[<(].*$/, '');
}

/** The file's text, from the module ids of every chunk the site ships. */
export function thirdPartyLicenses(moduleIds: Iterable<string>): string {
  const dirs = new Map<string, string>();
  for (const id of moduleIds) {
    const p = packageOf(id);
    if (p && !dirs.has(p.name)) dirs.set(p.name, p.dir);
  }
  const names = [...dirs.keys()].sort();
  const list: string[] = [];
  const sections: string[] = [];
  for (const name of names) {
    const dir = dirs.get(name)!;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort() : [];
    let text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n');
    if (!text) {
      const standard = STANDARD[pkg.license];
      if (!standard) throw new Error(`${name}: no licence file, and no standard text for "${pkg.license}"`);
      text = `Copyright (c) ${HOLDER[name] ?? author(pkg)}\n\n${standard}`;
    }
    list.push(`- ${name} ${pkg.version} (${pkg.license})`);
    sections.push([
      '-'.repeat(72),
      `${name} ${pkg.version} · ${pkg.license}${repository(pkg) ? ` · ${repository(pkg)}` : ''}`,
      ...(NOTE[name] ? [NOTE[name]] : []),
      '',
      text,
    ].join('\n'));
  }
  return [
    'Third-party software in stoned-mango',
    '====================================',
    '',
    'stoned-mango (https://github.com/freener0x/stoned-mango) is licensed under the GNU AGPL 3.0 or later,',
    'and its key model under CC BY-SA 4.0. The site includes these packages, under their own licences:',
    '',
    ...list,
    '',
    ...sections,
    '',
  ].join('\n');
}
