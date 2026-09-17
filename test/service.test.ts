import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http.js';
import { DateInput } from '../src/core.js';
import { findField, flight } from '../src/parsers.js';
import { inputSchema } from '../src/server.js';
import { cpBuy, cpSessions, mockFetch, page, EmptySessionStore } from './fixtures.js';

const service = () => new CinemaService(new HttpClient(mockFetch, 15000, new EmptySessionStore()));
test('calendar validation rejects impossible dates and accepts leap day', () => {
  assert.equal(DateInput.safeParse('2026-02-30').success, false);
  assert.equal(DateInput.safeParse('2024-02-29').success, true);
});
test('tool validation rejects missing provider context and arbitrary IDs', () => {
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'cinepic' }).success, false);
  assert.equal(inputSchema('movies').safeParse({ provider: 'cinesunidos' }).success, false);
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'cinex', movie_id: '../../secret' }).success, false);
  assert.equal(inputSchema('movies').safeParse({ provider: 'cinex', date: '2026-09-11' }).success, false);
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'cinepic', cinema_id: '123300' }).success, true);
});
test('Flight parser handles split records and literal closing brackets in strings without eval', () => {
  const record = 'a:' + JSON.stringify({ movies: [{ name: 'Título ]) y "comillas"' }] }) + '\n';
  const html = [record.slice(0, 20), record.slice(20)].map(s => `<script>self.__next_f.push(${JSON.stringify([1, s])})</script>`).join('');
  assert.deepEqual(findField(flight(html), 'movies'), [{ name: 'Título ]) y "comillas"' }]);
  assert.throws(() => flight('<script>throw new Error("not executed")</script>'));
});
test('Cinepic joins films to scheduled functions, excluding unscheduled releases', async () => {
  const result = await service().query('movies', { provider: 'cinepic', cinema_id: '123300', date: '2026-09-11' });
  assert.equal(result.status, 'available'); assert.equal(result.total, 1);
  assert.equal(result.items[0].name, 'Película Uno');
});
test('movie_id filters Cinepic movies and does not silently return another film', async () => {
  const result = await service().query('movies', { provider: 'cinepic', cinema_id: '123300', movie_id: 'p2', date: '2026-09-11' });
  assert.equal(result.status, 'empty'); assert.equal(result.total, 0);
});
test('overnight times remain commercial dates and do not invent a calendar timestamp', async () => {
  const result = await service().query('showtimes', { provider: 'cinepic', cinema_id: '123300', date: '2026-09-11' });
  assert.equal(result.items.find(r => r.id === 'f1')?.starts_at, '2026-09-11T20:30:00-04:00');
  assert.equal(result.items.find(r => r.id === 'f2')?.starts_at, undefined);
  assert.ok(result.warnings.some(s => s.includes('trasnoche')));
});
test('Cines Unidos filters by day, cinema and movie; timezone has one offset', async () => {
  const result = await service().query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-09-11', cinema_id: '1005', movie_id: 'HO1' });
  assert.equal(result.total, 1); assert.equal(result.items[0].id, 's3');
  assert.equal(result.items[0].starts_at, '2026-09-11T21:00:00-04:00');
});
test('Cinepic tariffs preserve VES and label the provider-derived USD without exposing configuration', async () => {
  const result = await service().query('prices', { provider: 'cinepic', cinema_id: '123300', session_id: 'f1', movie_id: 'p1' });
  assert.equal(result.status, 'available');
  assert.deepEqual(result.items[0].prices, [{ currency: 'VES', amount: 4162.4, basis: 'provider' }, { currency: 'USD', amount: 5, basis: 'provider_conversion' }]);
  assert.equal(result.items[0].final_total_verified, false);
  assert.equal(JSON.stringify(result).includes('SHOULD_NOT_LEAVE_PARSER'), false);
});
test('mismatched function/movie cannot return another ticket price', async () => {
  const result = await service().query('prices', { provider: 'cinepic', cinema_id: '123300', session_id: 'other', movie_id: 'p1' });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.items, []);
});
test('empty candy is distinct from auth-required and blocked providers', async () => {
  const s = service();
  const empty = await s.query('concessions', { provider: 'cinepic', cinema_id: '123300' });
  const auth = await s.query('prices', { provider: 'cinesunidos', cinema_id: '1002', session_id: 's1' });
  const blocked = await s.query('movies', { provider: 'trasnocho' });
  assert.equal(empty.status, 'empty'); assert.equal(auth.status, 'auth_required'); assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.sources.length, 0);
  assert.equal(empty.sources.length, 1);
  assert.equal(empty.sources[0].url, 'https://api.cinexo.com.ar/api/complejo/123300/candy');
});
test('Cinepic does not invent a USD price if the provider rate is zero', async () => {
  const props = structuredClone(cpBuy); props.configData.tasaConversion = '0';
  const s = new CinemaService(new HttpClient(async () => new Response(page(props))));
  const result = await s.query('prices', { provider: 'cinepic', cinema_id: '123300', movie_id: 'p1', session_id: 'f1' });
  assert.equal(result.status, 'available');
  assert.deepEqual(result.items[0].prices, [{ currency: 'VES', amount: 4162.4, basis: 'provider' }]);
});
test('missing product prices never become free, and stock zero remains zero', async () => {
  const result = await service().query('concessions', { provider: 'cinesunidos', cinema_id: '1002' });
  assert.deepEqual(result.items.find(r => r.id === '2')?.prices, []);
  assert.equal(result.items.find(r => r.id === '1')?.stock, 0);
});
test('pagination is stable with total, offset and accent-insensitive filtering', async () => {
  const s = service(), q = { provider: 'cinesunidos' as const, limit: 1 };
  const one = await s.query('cities', q), two = await s.query('cities', { ...q, offset: 1 });
  assert.equal(one.total, 2); assert.equal(one.next_offset, 1); assert.equal(two.next_offset, null);
  assert.notEqual(one.items[0].id, two.items[0].id);
  assert.equal((await s.query('cities', { ...q, query: 'merida' })).items[0].name, 'Mérida');
});
test('Cinex HTML separators do not merge screen number and showtime', async () => {
  const result = await service().query('showtimes', { provider: 'cinex', movie_id: 'pelicula', date: '2026-09-11' });
  assert.equal(result.items[0].screen, '4'); assert.equal(result.items[0].time, '11:20');
});
test('schema drift fails visibly instead of reporting an empty catalog', async () => {
  const s = new CinemaService(new HttpClient(async () => new Response(JSON.stringify({ ...cpSessions, data: { datos: [] } }))));
  const r = await s.query('movies', { provider: 'cinepic', cinema_id: '123300' });
  assert.equal(r.status, 'error'); assert.match(r.warnings[0], /estructura/);
});
test('invalid ticket amount is an error rather than zero', async () => {
  const props = structuredClone(cpBuy); props.functionData.tarifas[0].precio = 'no disponible';
  const s = new CinemaService(new HttpClient(async () => new Response(page(props))));
  const r = await s.query('prices', { provider: 'cinepic', cinema_id: '123300', movie_id: 'p1', session_id: 'f1' });
  assert.equal(r.status, 'error');
});

test('refresh survives tool validation and reaches every public source read', async () => {
  let calls = 0;
  const s = new CinemaService(new HttpClient(async () => new Response(JSON.stringify([`City ${++calls}`]))));
  const q = inputSchema('cities').parse({ provider: 'cinesunidos', refresh: true });
  const first = await s.query('cities', q), second = await s.query('cities', q);
  assert.equal(first.items[0].name, 'City 1'); assert.equal(second.items[0].name, 'City 2');
  assert.equal(second.sources[0].cached, false);
});
