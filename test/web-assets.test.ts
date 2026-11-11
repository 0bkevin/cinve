import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vendored, vendoredSource } from '../scripts/vendor-assets.js';
import { authorizationPage, installationPage, instructionsPage, landingPage, authorizationErrorPage, escapeHtml } from '../src/public-web.js';
import { serverInstructions } from '../src/agent-instructions.js';
import { loginPage } from '../src/auth-web.js';

test('vendored stylesheet and fonts are the pinned package files, unmodified', () => {
  for (const [name, file, destination] of vendored) {
    const copy = readFileSync(new URL(`../src/assets/${destination}`, import.meta.url));
    assert.ok(copy.equals(readFileSync(vendoredSource(name, file))), `${destination} differs; run: npx tsx scripts/vendor-assets.ts`);
  }
});

test('pages carry no inline styles or scripts, so they render under the CSP without unsafe-inline', () => {
  const pages = [landingPage('https://cinve.example'), installationPage('https://cinve.example'), instructionsPage('https://cinve.example'), authorizationErrorPage(), loginPage(),
    authorizationPage({ app: 'App', destination: 'https://app.example', id: 'id', csrf: 'csrf', recognized: false, cinemaLogin: true, error: 'x' })];
  for (const html of pages) {
    assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/);
    // Every script loads a file, except JSON-LD, which is data and never runs.
    for (const tag of html.match(/<script[^>]*>/g) ?? []) assert.match(tag, /\ssrc=|type="application\/ld\+json"/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/basecoat\.css\?v=[0-9a-f]+">/);
  }
});

test('the instructions page shows the exact text the MCP server sends', () => {
  const html = instructionsPage('https://cinve.example');
  for (const mode of [{ publicHosted: true }, { accounts: true }]) assert.ok(html.includes(escapeHtml(serverInstructions(mode))));
});

test('public pages are indexable with their own canonical and description; private ones are not', () => {
  const origin = 'https://cinve.example';
  for (const [html, path] of [[landingPage(origin), '/'], [installationPage(origin), '/install'], [instructionsPage(origin), '/instrucciones']] as const) {
    assert.match(html, /<meta name="robots" content="index,follow/);
    assert.ok(html.includes(`<link rel="canonical" href="${origin}${path}"`), path);
  }
  assert.notEqual(installationPage(origin).match(/name="description" content="([^"]+)"/)![1], landingPage(origin).match(/name="description" content="([^"]+)"/)![1]);
  for (const html of [loginPage(), authorizationErrorPage()]) assert.match(html, /<meta name="robots" content="noindex,nofollow"/);
});

test('the landing page describes Cinve with valid schema.org JSON-LD and no invented ratings', () => {
  const json = landingPage('https://cinve.example').match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1];
  const data = JSON.parse(json);
  const app = data['@graph'].find((node: { '@type': string }) => node['@type'] === 'SoftwareApplication');
  assert.equal(app.isAccessibleForFree, true); assert.equal(app.url, 'https://cinve.example/');
  assert.doesNotMatch(json, /aggregateRating|review|offers/);
});
