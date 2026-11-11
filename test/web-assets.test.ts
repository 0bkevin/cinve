import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

test('the vendored Basecoat stylesheet is the pinned package build, unmodified', () => {
  const require = createRequire(import.meta.url);
  const packaged = readFileSync(require.resolve('basecoat-css/package.json').replace('package.json', 'dist/basecoat.cdn.min.css'));
  assert.ok(readFileSync(new URL('../src/assets/basecoat.css', import.meta.url)).equals(packaged), 'run: npx tsx scripts/vendor-basecoat.ts');
});

