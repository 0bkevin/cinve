import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { authorizationPage, installationPage, landingPage, authorizationErrorPage } from '../src/public-web.js';
import { loginPage } from '../src/auth-web.js';

test('the vendored Basecoat stylesheet is the pinned package build, unmodified', () => {
  const require = createRequire(import.meta.url);
  const packaged = readFileSync(require.resolve('basecoat-css/package.json').replace('package.json', 'dist/basecoat.cdn.min.css'));
  assert.ok(readFileSync(new URL('../src/assets/basecoat.css', import.meta.url)).equals(packaged), 'run: npx tsx scripts/vendor-basecoat.ts');
});

test('pages carry no inline styles or scripts, so they render under the CSP without unsafe-inline', () => {
  const pages = [landingPage('https://cinve.example'), installationPage('https://cinve.example'), authorizationErrorPage(), loginPage(),
    authorizationPage('App', 'https://app.example', 'id', 'csrf')];
  for (const html of pages) {
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=|<script>/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/basecoat\.css\?v=[0-9a-f]+">/);
  }
});
