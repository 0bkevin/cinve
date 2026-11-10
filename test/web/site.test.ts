import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers/hosted.js';
import { defined } from '../helpers/assert.js';
import { fakeElements, runScript } from '../helpers/browser.js';
import { installationPage, landingPage } from '../../src/web/site.js';

test('the install guide carries the seat rules and no code download', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/codex-client.mjs')).status, 404, 'the Codex companion is no longer served');
  const guide = await (await fetch(f.origin + '/install')).text();
  assert.ok(!guide.includes('/codex-client.mjs'), 'the guide never sends agents to download code');
  assert.match(guide, /available=0 con unknown>0 NO significa agotado/);
  assert.match(guide, /bloque de texto monoespaciado/);
});

test('public pages use the configured origin and serve local fonts under the authorization policy', async t => {
  const f = await fixture(t);
  const home = await fetch(f.origin + '/?from=portfolio');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes(`Instala Cinve siguiendo ${f.origin}/install`));
  assert.ok(html.includes('lang="es"'));
  assert.ok(html.includes(`property="og:image" content="${f.origin}/og.png?v=2"`));
  assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
  const social = await fetch(f.origin + '/og.png?v=2');
  assert.equal(social.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await social.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(home.headers.get('content-security-policy')?.includes("font-src 'self'"));
  const font = await fetch(f.origin + '/assets/inter-latin.woff2');
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
  const browser = await fetch(f.origin + '/install', { headers: { Accept: 'text/html' } });
  assert.match(defined(browser.headers.get('content-type')), /text\/html/);
  assert.ok((await browser.text()).includes(`${f.origin}/mcp`));
  const agent = await fetch(f.origin + '/install');
  assert.match(defined(agent.headers.get('content-type')), /text\/plain/);
  assert.ok((await agent.text()).includes('Cinve MCP installation'));
  const raw = await fetch(f.origin + '/install?format=text', { headers: { Accept: 'text/html' } });
  assert.match(defined(raw.headers.get('content-type')), /text\/plain/);
  const error = await fetch(f.origin + '/oauth/authorize');
  assert.equal(error.status, 400);
  assert.ok((await error.text()).includes('No se pudo autorizar la conexión.'));
});

test('the served /site.js parses and copies the install message on the landing and install pages', async t => {
  const f = await fixture(t), served = await fetch(f.origin + '/site.js');
  assert.equal(served.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const script = await served.text();
  for (const html of [landingPage('https://cinve.example'), installationPage('https://cinve.example')]) {
    for (const fails of [false, true]) {
      const elements = fakeElements(html), copied: string[] = [];
      const clipboard = { writeText: async (text: string) => { if (fails) throw new Error('denied'); copied.push(text); } };
      runScript(script, elements, { navigator: { clipboard } });
      const button = defined(elements.get('copy-install'));
      assert.equal(button.hidden, false, 'the copy button appears once the script runs');
      await defined(button.onclick)();
      assert.deepEqual(copied, fails ? [] : ['Instala Cinve siguiendo https://cinve.example/install']);
      assert.equal(defined(elements.get('copy-feedback')).textContent, fails
        ? 'Selecciona el mensaje y cópialo para enviarlo a tu asistente.' : 'Mensaje copiado. Pégalo en tu asistente.');
    }
  }
});
