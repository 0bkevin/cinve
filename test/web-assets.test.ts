import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vendored, vendoredSource } from '../scripts/vendor-assets.js';
import { authorizationPage, installationPage, landingPage, authorizationErrorPage } from '../src/public-web.js';
import { loginPage } from '../src/auth-web.js';

test('vendored stylesheet and fonts are the pinned package files, unmodified', () => {
  for (const [name, file, destination] of vendored) {
    const copy = readFileSync(new URL(`../src/assets/${destination}`, import.meta.url));
    assert.ok(copy.equals(readFileSync(vendoredSource(name, file))), `${destination} differs; run: npx tsx scripts/vendor-assets.ts`);
  }
});

test('pages carry no inline styles or scripts, so they render under the CSP without unsafe-inline', () => {
  const pages = [landingPage('https://cinve.example'), installationPage('https://cinve.example'), authorizationErrorPage(), loginPage(),
    authorizationPage('App', 'https://app.example', 'id', 'csrf')];
  for (const html of pages) {
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=|<script>/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/basecoat\.css\?v=[0-9a-f]+">/);
  }
});
