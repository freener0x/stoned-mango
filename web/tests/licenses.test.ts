// The third-party licence file (build/licenses.ts): which package each bundled module comes from, and its notice.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageOf, thirdPartyLicenses } from '../build/licenses.ts';

const web = fileURLToPath(new URL('..', import.meta.url));

test("packageOf: plain, scoped, nested, Windows paths and the app's own code", () => {
  assert.deepEqual(packageOf('/w/node_modules/react/index.js'), { name: 'react', dir: '/w/node_modules/react' });
  assert.deepEqual(packageOf('\0/w/node_modules/@protobufjs/base64/index.js?commonjs-module'),
    { name: '@protobufjs/base64', dir: '/w/node_modules/@protobufjs/base64' });
  assert.deepEqual(packageOf('/w/node_modules/a/node_modules/b/x.js'), { name: 'b', dir: '/w/node_modules/a/node_modules/b' });
  assert.deepEqual(packageOf('C:\\w\\node_modules\\react\\index.js'), { name: 'react', dir: 'C:/w/node_modules/react' });
  assert.equal(packageOf('/w/src/ui/App.tsx'), undefined);
});

test('each package once, with its own licence file, or the standard text when it ships none', () => {
  const text = thirdPartyLicenses([
    `${web}src/ui/App.tsx`,
    `${web}node_modules/react/index.js`,
    `${web}node_modules/react/cjs/react.production.js`,
    `${web}node_modules/onnxruntime-web/dist/ort.bundle.min.mjs`,
  ]);
  assert.match(text, /^- onnxruntime-web [\d.]+ \(MIT\)\n- react [\d.]+ \(MIT\)\n\n/m);
  assert.equal(text.match(/^react [\d.]+ · MIT/gm)?.length, 1);
  assert.match(text, /Copyright \(c\) Meta Platforms/); // React's LICENSE file
  assert.match(text, /Copyright \(c\) Microsoft Corporation\n\nPermission is hereby granted/); // onnxruntime-web has none
  assert.match(text, /ThirdPartyNotices/);
});
