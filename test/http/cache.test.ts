import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../../src/http/client.js';
import { ReadContext } from '../../src/http/read-context.js';
import { DataError } from '../../src/core.js';
import { CinemaService } from '../../src/service.js';
import { defined } from '../helpers/assert.js';

const origin = 'https://gateway.cinesunidos.com';
test('cache deduplicates concurrent requests and preserves original fetch time', async () => {
  let count = 0;
  const http = new HttpClient(async () => { count++; return new Response('[]'); });
  const [one, two] = await Promise.all([http.get(origin + '/search/cities'), http.get(origin + '/search/cities')]);
  const cached = await http.get(origin + '/search/cities');
  assert.equal(count, 1); assert.equal(cached.source.cached, true);
  assert.equal(one.source.fetched_at, cached.source.fetched_at); assert.equal(one.body, two.body);
});

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

test('cache eviction has a byte budget in addition to an entry count', async () => {
  // 3.5 MB bodies count 7 MB each against the 64 MB budget: ten do not fit.
  let count = 0; const http = new HttpClient(async () => { count++; return new Response('x'.repeat(3.5 * 1024 * 1024)); });
  for (let i = 0; i < 10; i++) await http.get(`https://gateway.cinesunidos.com/big/${i}`);
  await http.get('https://gateway.cinesunidos.com/big/0'); assert.equal(count, 11);
});
test('cache eviction removes the least recently used entry, not the oldest one', async () => {
  let count = 0; const http = new HttpClient(async () => { count++; return new Response('x'.repeat(3.5 * 1024 * 1024)); });
  for (let i = 0; i < 9; i++) await http.get(`https://gateway.cinesunidos.com/big/${i}`);
  await http.get('https://gateway.cinesunidos.com/big/0'); // a hit: big/0 is now the most recent
  await http.get('https://gateway.cinesunidos.com/big/9'); // evicts big/1
  assert.equal(count, 10);
  await http.get('https://gateway.cinesunidos.com/big/0'); assert.equal(count, 10, 'the frequently read entry survives');
  await http.get('https://gateway.cinesunidos.com/big/1'); assert.equal(count, 11);
});
test('public Cinex HTML is cached with whitespace collapsed; JSON pages are left intact', async () => {
  const http = new HttpClient(async input => new Response(String(input).endsWith('.html') ? '<div>\n    <h5 class="title">A</h5>\n\n  </div>' : '{"a": "x  y"}'));
  assert.equal((await http.get('https://www.cinex.com.ve/cartelera.html')).body, '<div> <h5 class="title">A</h5> </div>');
  assert.equal((await http.get('https://gateway.cinesunidos.com/search/cities')).body, '{"a": "x  y"}');
});

test('one city read through the search API fits in the cache alongside another city', async () => {
  let reads = 0;
  const http = new HttpClient(async input => {
    reads++;
    const url = new URL(String(input));
    if (url.hostname === 'www.cinesunidos.com') return new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    if (url.pathname === '/search/cities') return Response.json(['Caracas', 'Valencia']);
    if (url.pathname.endsWith('/films')) return Response.json(Array.from({ length: 60 }, (_, i) => `Film ${i}`));
    if (url.pathname.endsWith('/sessions')) return Response.json([{ showtime: '2026-11-04T18:15:00', sessionId: `s${reads}`, screenNumber: 1, format: '2D', ho: `HO${defined(url.searchParams.get('Title')).slice(5)}`, title: url.searchParams.get('Title'), cinemaId: '1005' }]);
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  await s.query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-04' });
  await s.query('showtimes', { provider: 'cinesunidos', city: 'Valencia', date: '2026-11-04' });
  const before = reads;
  const again = await s.query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-04' });
  assert.equal(again.total, 60); assert.equal(reads, before, 'a second city must not evict the first city from the cache');
  // 62 cited URLs would cost more tokens than the schedule; the result lists 10, oldest included.
  assert.equal(again.sources.length, 10);
  const oldest = again.sources.reduce((a, b) => (b.fetched_at < a.fetched_at ? b : a)).fetched_at;
  assert.ok(again.warnings.some(w => w.includes('Se consultaron 62 fuentes') && w.includes(oldest)), again.warnings.join(' | '));
});
