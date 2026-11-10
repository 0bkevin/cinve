import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCinesUnidosPrices } from '../../src/providers/cinesunidos/prices.js';
import { CinemaService } from '../../src/service.js';
import { HttpClient } from '../../src/http/client.js';
import { mockFetch, page, EmptySessionStore, cuMovies, concessions } from '../helpers/fixtures.js';
import { inputSchema } from '../../src/mcp/server.js';

const url = 'https://www.cinex.com.ve/boletos.php?cinemaid=TLN&sessionid=s1';

test('CU uses UI price fields, preserves restrictions and checks cinema/session/movie identity', () => {
  const value = [{ cinemaId: '1002', sessionId: 's1', scheduledFilmId: 'm1', allowTicketSales: false, user: 'PRIVATE_PROFILE', tickets: [{ ticketTypeCode: 't1', areaCategoryCode: 'a1', description: 'Mayor', redemptionOnly: true, isChildOnlyTicket: false, priceInCents: 99999, price: { refPrice: 2, total: 1664.97, exchangeRate: 832.49, grossPrice: { total: 1664.98 } } }] }];
  const query = { provider: 'cinesunidos' as const, cinema_id: '1002', session_id: 's1', movie_id: 'm1' };
  const items = parseCinesUnidosPrices(value, query, 'https://gateway.cinesunidos.com/');
  assert.deepEqual(items[0].prices?.map(p => p.amount), [2, 1664.97]);
  assert.equal(items[0].redemption_only, true); assert.equal(items[0].sales_allowed, false);
  assert.ok(!JSON.stringify(items).includes('PRIVATE_PROFILE'));
  for (const change of [{ cinema_id: '1005' }, { session_id: 'other' }, { movie_id: 'other' }]) assert.throws(() => parseCinesUnidosPrices(value, { ...query, ...change }, url));
});

const service = () => new CinemaService(new HttpClient(mockFetch, 15000, new EmptySessionStore()));

test('Cines Unidos filters by day, cinema and movie; timezone has one offset', async () => {
  const result = await service().query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-09-11', cinema_id: '1005', movie_id: 'HO1' });
  assert.equal(result.total, 1); assert.equal(result.items[0].id, 's3');
  assert.equal(result.items[0].starts_at, '2026-09-11T21:00:00-04:00');
});

test('missing product prices never become free, and stock zero remains zero', async () => {
  const result = await service().query('concessions', { provider: 'cinesunidos', cinema_id: '1002' });
  assert.deepEqual(result.items.find(r => r.id === '2')?.prices, []);
  assert.equal(result.items.find(r => r.id === '1')?.stock, 0);
});

test('service preserves a named cinema with malformed code as a nonqueryable directory entry', async () => {
  const http = new HttpClient(async () => new Response(page({ theaters: [{ id: '../secret', name: 'Cinema' }] })), 15000, new EmptySessionStore());
  const result = await new CinemaService(http).query('cinemas', { provider: 'cinesunidos', city: 'Caracas' });
  assert.equal(result.status, 'available');
  assert.equal(result.partial, true);
  assert.equal(result.items[0].code_status, 'unverified');
  assert.equal(result.items[0].cinema_id, undefined);
  assert.match(result.items[0].id, /^directory-/);
  assert.equal(result.total, 1);
  assert.match(result.warnings[0], /sede conservada/);
});

const cu = (html: string) => new CinemaService(new HttpClient(async () => new Response(html)));
const cq = { provider: 'cinesunidos' as const, city: 'Caracas' };

test('CU preserves good venues and named venues without usable codes despite malformed siblings', async () => {
  const r = await cu(page({ theaters: [null, { id: '1002', name: 'Good' }, { name: 'Missing ID' }, { id: '../bad', name: 'Unsafe ID' }] })).query('cinemas', cq);
  assert.equal(r.status, 'available'); assert.equal(r.total, 3); assert.equal(r.partial, true);
  assert.equal(r.items.find(i => i.name === 'Good')?.id, '1002');
  for (const name of ['Missing ID', 'Unsafe ID']) {
    const item = r.items.find(i => i.name === name)!;
    assert.equal(item.code_status, 'unverified'); assert.equal(item.cinema_id, undefined); assert.match(item.id, /^directory-/);
  }
});
test('CU reads all page catalog blocks, ignoring movie-nested theaters and empty earlier blocks', async () => {
  const html = page({ movies: [{ vistaId: 'M', theaters: [{ id: 'decoy', name: 'Only one movie' }] }] })
    + page({ theaters: [] }) + page({ theaters: [{ id: '1002', name: 'First' }] }) + page({ theaters: [{ id: '1005', name: 'Second' }] });
  const r = await cu(html).query('cinemas', cq);
  assert.deepEqual(r.items.map(i => i.id), ['1002', '1005']); assert.equal(r.partial, false);
});
test('CU duplicate codes assigned to different cinemas do not silently overwrite either venue', async () => {
  const r = await cu(page({ theaters: [{ id: '1002', name: 'First' }, { id: '1002', name: 'Second' }] })).query('cinemas', cq);
  assert.equal(r.total, 2); assert.equal(r.partial, true);
  assert.ok(r.items.every(i => i.code_status === 'unverified'));
});
test('CU retries unrecognized city spellings with the official canonical city and rejects unknown cities', async () => {
  const requests: string[] = [];
  const s = new CinemaService(new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.href);
    if (url.pathname === '/search/cities') return Response.json(['Caracas', 'Maturín']);
    return new Response(url.searchParams.get('city') === 'Maturín' ? page({ theaters: [{ id: '1007', name: 'Petroriente' }] }) : page({ error: 'Unknown city' }));
  }));
  const r = await s.query('cinemas', { ...cq, city: 'Maturin' });
  assert.equal(r.status, 'available'); assert.equal(r.items[0].city, 'Maturín');
  assert.ok(requests.some(u => u.includes('Matur%C3%ADn')));
  const missing = await s.query('cinemas', { ...cq, city: 'Atlantis' });
  assert.equal(missing.status, 'unavailable'); assert.match(missing.warnings.join(' '), /ciudad/i);
});

test('CU distinguishes a genuinely empty directory from wholly unreadable data', async () => {
  const empty = await cu(page({ theaters: [] })).query('cinemas', cq);
  assert.equal(empty.status, 'empty'); assert.equal(empty.partial, false);
  for (const theaters of [[null, {}], 'not-an-array']) {
    const broken = await cu(page({ theaters })).query('cinemas', cq);
    assert.equal(broken.status, 'error'); assert.equal(broken.partial, true);
  }
});
test('CU directory identity and pagination remain stable when unknown-code rows are reordered', async () => {
  const rows = [{ name: 'Primera' }, { name: 'Segunda' }];
  const first = await cu(page({ theaters: rows })).query('cinemas', { ...cq, limit: 1 });
  const next = await cu(page({ theaters: [...rows].reverse() })).query('cinemas', { ...cq, offset: 1, limit: 1 });
  const again = await cu(page({ theaters: [...rows].reverse() })).query('cinemas', { ...cq, limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.next_offset, 1); assert.equal(next.next_offset, null);
  assert.equal(first.items[0].id, again.items[0].id); assert.notEqual(first.items[0].id, next.items[0].id);
});

test('CU movie catalogs also combine component blocks rather than accepting the first empty list', async () => {
  const html = page({ movies: [] }) + page({ movies: [{ vistaId: 'M', title: 'Movie', theaters: [{ id: '1002', showTimes: [{ id: 'S', date: '2026-09-18T18:00:00' }] }] }] });
  const r = await cu(html).query('movies', { ...cq, date: '2026-09-18' });
  assert.equal(r.total, 1); assert.equal(r.items[0].id, 'M');
});

test('invalid dates and unusable upstream IDs fail visibly instead of returning bad showtimes', async () => {
  for (const patch of [{ date: '2026-09-11T29:99:99' }, { id: '../../unsafe' }]) {
    const data = structuredClone(cuMovies); Object.assign(data.movies[0].theaters[0].showTimes[0], patch);
    const service = new CinemaService(new HttpClient(async () => new Response(page(data))));
    const r = await service.query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-09-11' });
    assert.equal(r.status, 'error'); assert.deepEqual(r.items, []);
  }
  assert.equal(inputSchema('prices').safeParse({ provider: 'cinex', cinema_id: 'TLN', session_id: 's1', movie_id: 'ignored' }).success, false);
});
