import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../../src/service.js';
import { HttpClient } from '../../src/http/client.js';
import { cpBuy, cpSessions, mockFetch, page, EmptySessionStore } from '../helpers/fixtures.js';

const service = () => new CinemaService(new HttpClient(mockFetch, 15000, new EmptySessionStore()));

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
