import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http/client.js';
import { DateInput } from '../src/core.js';
import { findField, flight } from '../src/providers/parsing.js';
import { inputSchema } from '../src/mcp/server.js';
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
test('empty candy is distinct from auth-required providers', async () => {
  const s = service();
  const empty = await s.query('concessions', { provider: 'cinepic', cinema_id: '123300' });
  const auth = await s.query('prices', { provider: 'cinesunidos', cinema_id: '1002', session_id: 's1' });
  assert.equal(empty.status, 'empty'); assert.equal(auth.status, 'auth_required');
  assert.equal(empty.sources.length, 1);
  assert.equal(empty.sources[0].url, 'https://api.cinexo.com.ar/api/complejo/123300/candy');
});
// Shaped as the Cinepic purchase JS reads candyData (2026-11-05): units hold
// categorias[].items[] with nombre, descripcion ("contenido"), imagen and precio
// in Bs.; "dinamico" items and items with productos ask for options.
test('a Cinepic snack catalog is read the way its checkout shows it', async () => {
  const item = (id: string, nombre: string, precio: unknown, extra = {}) => ({ id, nombre, descripcion: ' ', imagen: `https://api.cinexo.com.ar/img/${id}.png`, precio, ...extra });
  const candy = { tiene_unidades_negocios: true, unidades_negocios: [{ id: 'u1', nombre_empresa: 'Cinepic', categorias: [
    { id: 'c0', nombre: 'TODOS', items: [item('1', 'Cotufa grande', '3579.52')] },
    { id: 'c1', nombre: 'COMBOS', items: [item('1', 'Cotufa grande', '3579.52'), item('2', 'Combo pareja', '8948.8', { descripcion: '2 cotufas + 2 refrescos', formato: 'dinamico' }), item('3', 'Nachos', '', { imagen: 'http://x/n.png', productos: [{ id: 'p1' }] })] },
  ] }] };
  let rate = '894.88', urls: string[] = [];
  const s = new CinemaService(new HttpClient(async url => {
    urls.push(String(url));
    return Response.json(String(url).endsWith('/configuration') ? { datos: { tasaConversion: rate, ip_privada: 'not read' } } : candy);
  }));
  const r = await s.query('concessions', { provider: 'cinepic', cinema_id: '123300' });
  assert.equal(r.status, 'available');
  assert.deepEqual(r.items.map(i => [i.id, i.name, i.category, i.prices, i.options_required, i.image_url]), [
    ['2', 'Combo pareja (2 cotufas + 2 refrescos)', 'COMBOS', [{ currency: 'VES', amount: 8948.8, basis: 'provider' }, { currency: 'USD', amount: 10, basis: 'provider_conversion' }], true, 'https://api.cinexo.com.ar/img/2.png'],
    ['1', 'Cotufa grande', 'COMBOS', [{ currency: 'VES', amount: 3579.52, basis: 'provider' }, { currency: 'USD', amount: 4, basis: 'provider_conversion' }], false, 'https://api.cinexo.com.ar/img/1.png'],
    ['3', 'Nachos', 'COMBOS', [], true, undefined],
  ]);
  assert.match(r.warnings.join(' '), /Producto 3 sin precio verificable/);
  assert.deepEqual(urls, ['https://api.cinexo.com.ar/api/complejo/123300/candy', 'https://api.cinexo.com.ar/api/complejo/123300/configuration']);
  rate = '0';
  const noRate = await new CinemaService(new HttpClient(async url => Response.json(String(url).endsWith('/configuration') ? { datos: { tasaConversion: rate } } : candy))).query('concessions', { provider: 'cinepic', cinema_id: '123301' });
  assert.deepEqual(noRate.items.find(i => i.id === '1')?.prices, [{ currency: 'VES', amount: 3579.52, basis: 'provider' }]);
  assert.match(noRate.warnings.join(' '), /se omite la equivalencia USD/);
});
test('one odd Cinepic snack item or group is skipped, not the whole catalog', async () => {
  const catalog = (categorias: unknown) => ({ tiene_unidades_negocios: true, unidades_negocios: [{ id: 'u1', nombre_empresa: 'Cinepic', categorias }] });
  const run = async (candy: unknown, rate: unknown = '0') => new CinemaService(new HttpClient(async url => Response.json(String(url).endsWith('/configuration') ? { datos: { tasaConversion: rate } } : candy))).query('concessions', { provider: 'cinepic', cinema_id: '123300' });
  const r = await run(catalog([
    { nombre: 'BEBIDAS', items: [{ id: '1', nombre: '$Refresco', precio: '100' }, { nombre: 'Sin id', precio: '5' }, { id: 'x'.repeat(300), nombre: 'Id largo', precio: '5' }, { id: '2', nombre: 'N'.repeat(400), descripcion: 'D'.repeat(400), precio: '7' }] },
    { nombre: 'ROTA' },
  ]));
  assert.equal(r.status, 'available'); assert.equal(r.partial, true);
  assert.deepEqual(r.items.map(i => i.id).sort(), ['1', '2']);
  assert.equal(r.items.find(i => i.id === '1')?.name, '$Refresco', 'a leading $ is part of the name');
  assert.ok(r.items.find(i => i.id === '2')!.name.length <= 512);
  assert.match(r.warnings.join(' '), /3 productos o grupos del catálogo .* se omitieron/);
  assert.equal(r.warnings.filter(w => /USD/.test(w)).length, 1, 'one consistent USD note when the rate is missing');
  assert.match(r.warnings.join(' '), /se omite la equivalencia USD/);
  // A server-sent TODOS category is shown by the site, so its items are kept.
  const todos = await run(catalog([{ nombre: 'TODOS', items: [{ id: '9', nombre: 'Cotufa', precio: '10' }] }]), '10');
  assert.deepEqual(todos.items.map(i => [i.id, i.category, i.prices?.map(p => p.amount)]), [['9', undefined, [10, 1]]]);
  const units = await run({ tiene_unidades_negocios: true, unidades_negocios: [{ id: 'u1' }] });
  assert.equal(units.partial, true); assert.deepEqual(units.items, []);
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
