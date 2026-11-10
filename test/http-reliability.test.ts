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

test('directory, city and metadata reads stay cached past the two-minute page lifetime', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const u = new URL(String(input)); requests.push(u.pathname + u.search);
    if (u.pathname === '/search/cities') return new Response('["Caracas"]');
    if (u.pathname === '/cines.html') return new Response('<a href="cinex-sambil.html" title="Cinex Sambil, Caracas"><h3>SAMBIL</h3><img src="assets/images/cinemas/xsbc.jpg"></a>');
    if (u.pathname === '/assets/php/datasource.php') return new Response(JSON.stringify({ data: [{ name: 'Sambil', siglas: 'SBC' }] }));
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  assert.equal((await s.query('cities', { provider: 'cinesunidos' })).status, 'available');
  const listed = await s.query('cinemas', { provider: 'cinex', city: 'Caracas' });
  assert.equal(listed.items[0]?.cinema_id, 'SBC', listed.warnings.join(' '));
  const cold = requests.length;
  t.mock.timers.tick(30 * 60000);
  assert.equal((await s.query('cities', { provider: 'cinesunidos' })).status, 'available');
  assert.equal((await s.query('cinemas', { provider: 'cinex', city: 'Caracas' })).items[0]?.cinema_id, 'SBC');
  assert.equal(requests.length, cold, 'no venue metadata read is repeated within the hour');
  t.mock.timers.tick(31 * 60000);
  await s.query('cities', { provider: 'cinesunidos' });
  assert.equal(requests.length, cold + 1);
});
