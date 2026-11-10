import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, ReadContext } from '../src/http.js';
import { CinemaService } from '../src/service.js';
import { DataError } from '../src/core.js';

const cities = 'https://gateway.cinesunidos.com/search/cities';

test('a 200 body that is empty or not the expected JSON is reported but never cached', async () => {
  let calls = 0;
  const bodies = ['', '<html>Mantenimiento</html>', '["Caracas"]'];
  const http = new HttpClient(async () => new Response(bodies[calls++]));
  for (const expected of [/JSON válido/, /JSON válido/]) {
    await assert.rejects(new ReadContext(http).json(cities), e => e instanceof DataError && expected.test(e.message));
  }
  assert.deepEqual(await new ReadContext(http).json(cities), ['Caracas']);
  // Only the valid body was kept.
  assert.deepEqual(await new ReadContext(http).json(cities), ['Caracas']);
  assert.equal(calls, 3);
});

test('long-lived pages without their expected markup are not cached for an hour', async () => {
  let calls = 0;
  const http = new HttpClient(async () => { calls++; return new Response(calls === 1 ? '<html>Sitio en mantenimiento</html>' : '<a href="cinex-sambil.html" title="Cinex Sambil, Caracas"><h3>SAMBIL</h3></a>'); });
  const s = new CinemaService(http);
  const down = await s.query('cinemas', { provider: 'cinex' });
  assert.equal(down.status, 'error');
  const up = await s.query('cinemas', { provider: 'cinex' });
  assert.equal(up.status, 'available', up.warnings.join(' '));
  assert.ok(calls >= 2, 'the maintenance page was asked for again');
});
