import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCinesUnidosPrices } from '../../src/providers/cinesunidos/prices.js';
import { CinemaService } from '../../src/service.js';
import { HttpClient } from '../../src/http/client.js';
import { mockFetch, page, EmptySessionStore } from '../helpers/fixtures.js';

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
