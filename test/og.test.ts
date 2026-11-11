import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { generate } from '../scripts/build-og.js';

function sharedArtwork(svg: string): string {
  return svg
    .replace(/  <title>[\s\S]*?<\/title>\n/, '')
    .replace(/  <desc>[\s\S]*?<\/desc>\n/, '')
    .replace(/  <g id="copy">[\s\S]*?<!-- \/copy -->\n/, '');
}

test('Spanish and English OG artwork share all nontext SVG elements', async () => {
  const [es, en] = await Promise.all([generate('es'), generate('en')]);
  assert.equal(sharedArtwork(es.svg), sharedArtwork(en.svg));
  assert.equal((es.svg.match(/<image href="data:/g) ?? []).length, 6);
  const seatmap = es.svg.match(/<g id="seatmap">([\s\S]*?)<\/g>/)?.[1] ?? '';
  assert.equal((seatmap.match(/<path d="[^"]+" fill="#[a-f0-9]+"\/>/g) ?? []).length, 48);
  for (const { png } of [es, en]) {
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  }
});

test('OG generation is deterministic', async () => {
  const first = await generate('es');
  const second = await generate('es');
  assert.equal(first.svg, second.svg);
  assert.deepEqual(first.png, second.png);
});


test('checked-in social images match the shared generator in both languages', async () => {
  for (const locale of ['es', 'en'] as const) {
    const generated = await generate(locale);
    const name = locale === 'es' ? 'og' : 'og-en';
    const base = new URL(`../src/assets/${name}`, import.meta.url);
    assert.equal(await readFile(`${base.pathname}.svg`, 'utf8'), `${generated.svg}\n`);
    assert.deepEqual(await readFile(`${base.pathname}.png`), generated.png);
  }
});
