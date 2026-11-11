// Synthetic minimal pages shaped like the observed grancine.net markup; no customer data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { HttpClient, assertPublicRead } from '../src/http.js';
import { inputSchema } from '../src/server.js';
import { granCineTitle } from '../src/grancine.js';
import { EmptySessionStore, shiftDate } from './fixtures.js';

// Dates relative to today: past dates are answered without reading the provider.
const D = today(), D1 = shiftDate(D, 1), DFAR = shiftDate(D, 60);
import { today } from '../src/core.js';

const GC = 'https://www.grancine.net';
const card = (slug: string, name: string) => `<div class="card"><div class="card-body"><h5 class="card-title">${name}</h5><a href="sedes/sede.php?slug=${slug}">VER CARTELERA</a></div></div>`;
const salas = card('paseo-las-mercedes', 'PASEO LAS MERCEDES') + card('lder', 'LÍDER') + card('villaplanchartelcerrito', 'VILLA PLANCHART (EL CERRITO)') +
  card('nuevasala', 'NUEVA SALA (MARACAIBO)') + card('otra', 'OTRA SALA') + card('BAD/../x', 'MALA');
const strip = (slug: string, selected: string) => [`${D}`, `${D1}`].map(d => `<a href="?slug=${slug}&fecha=${d}" class="caja-fecha-roja ${d === selected ? 'hoy' : ''}">x</a>`).join('');
const film = (title: string, id: string | undefined, slots: string[]) => `<div class="tarjeta-container-horizontal mb-4"><h3 class="titulo-card-horiz">${title}</h3><span class="badge">B</span>
<div class="grid-funciones">${slots.map(s => `<div class="caja-hora-sala">${s}</div>`).join('')}</div>${id ? `<a href="../detalle_sinopsis.php?id=${id}">VER DETALLE</a>` : ''}</div>`;
function venuePage(slug: string, date: string, selected = date): string {
  const head = `<h1 class="titulo-sede-estilo">Sala</h1><a class="btn-ubicacion-estilo">C. C. Paseo Las Mercedes, Caracas</a>${strip(slug, selected)}`;
  if (date !== `${D}` || slug === 'villaplanchartelcerrito') return head + '<h3>No hay funciones programadas para esta fecha.</h3>';
  if (slug === 'lder') return head + film('El nuevo pez que fuma (4ta. Semana)', '12', ['4:10 p.m.<br><small>Sala 10</small>']);
  return head + film('Caballo salvaje nueve (Estreno)', '45', ['7:00 p.m.<br><small>Paseo 2</small>', '12:15 a.m.<br><small>Paseo 1</small>', 'luego<br><small>Paseo 1</small>']) +
    film('Sin ficha', undefined, ['5:00 p.m.<br><small>Paseo 1</small>']);
}

function provider() {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname === '/salas') return new Response(salas);
    if (url.pathname === '/sedes/sede.php') {
      const slug = url.searchParams.get('slug')!, date = url.searchParams.get('fecha')!;
      if (date === `${DFAR}`) return new Response(`<a href="?slug=${slug}&fecha=${D}" class="caja-fecha-roja ">x</a><h3>No hay funciones</h3>`);
      if (date === `${D1}` && slug === 'lder') return new Response(venuePage(slug, date, `${D}`));
      return new Response(venuePage(slug, date));
    }
    throw new Error(`Unexpected ${url.href}`);
  };
  return { calls, service: new CinemaService(new HttpClient(fetcher, 15000, new EmptySessionStore())) };
}

test('Gran Cine reads only its directory and venue pages by GET', () => {
  assert.doesNotThrow(() => assertPublicRead(`${GC}/salas`));
  assert.doesNotThrow(() => assertPublicRead(`${GC}/sedes/sede.php?slug=lder&fecha=${D}`));
  for (const url of [`${GC}/sedes/sede.php?slug=lder`, `${GC}/sedes/sede.php?slug=../x&fecha=${D}`, `${GC}/sedes/sede.php?slug=lder&fecha=${D}&x=1`, `${GC}/contacto.php`, `${GC}/salas?x=1`])
    assert.throws(() => assertPublicRead(url), /no permitida/);
});

test('Gran Cine directory: slugs as IDs, known or stated cities only, unsafe slugs dropped', async () => {
  const { service } = provider();
  const cinemas = await service.query('cinemas', { provider: 'grancine' });
  assert.deepEqual(cinemas.items.map(c => [c.id, c.name, c.city ?? null]), [
    ['lder', 'Líder', 'Caracas'], ['nuevasala', 'Nueva Sala (Maracaibo)', 'Maracaibo'], ['otra', 'Otra Sala', null],
    ['paseo-las-mercedes', 'Paseo Las Mercedes', 'Caracas'], ['villaplanchartelcerrito', 'Villa Planchart (El Cerrito)', 'Caracas']]);
  assert.ok(cinemas.warnings.some(w => /no indica la ciudad de: Otra Sala/.test(w)));
  const cities = await service.query('cities', { provider: 'grancine' });
  assert.deepEqual(cities.items.map(c => c.name), ['Caracas', 'Maracaibo']);
});

test('Gran Cine functions: cleaned titles, 12-hour clock, rooms, stable synthetic IDs, skipped malformed entries', async () => {
  const { service } = provider();
  const first = await service.query('showtimes', { provider: 'grancine', cinema_id: 'paseo-las-mercedes', date: `${D}` });
  assert.deepEqual(first.items.map(s => [s.name, s.movie_id, s.time, s.starts_at ?? null, s.screen]), [
    ['Caballo salvaje nueve', '45', '19:00', `${D}T19:00:00-04:00`, 'Paseo 2'],
    ['Caballo salvaje nueve', '45', '00:15', null, 'Paseo 1'],
  ]);
  assert.ok(first.items.every(s => /^gc-[0-9a-f]{20}$/.test(s.id)));
  assert.equal(first.partial, true);
  assert.ok(first.warnings.some(w => /no publica identificadores de función/.test(w)));
  // A separate client (no shared cache) computes the same IDs for the same listing.
  const again = await provider().service.query('showtimes', { provider: 'grancine', cinema_id: 'paseo-las-mercedes', date: `${D}` });
  assert.deepEqual(again.items.map(s => s.id), first.items.map(s => s.id));
});

test('Gran Cine city fan-out, partner-venue warning, and unpublished or mismatched dates', async () => {
  const { service, calls } = provider();
  const city = await service.query('showtimes', { provider: 'grancine', city: 'Caracas', date: `${D}` });
  assert.deepEqual([...new Set(city.items.map(s => s.cinema_id))].sort(), ['lder', 'paseo-las-mercedes']);
  assert.ok(city.warnings.some(w => /En salas de Cines Unidos/.test(w)));
  assert.equal(calls.filter(c => c.startsWith('GET /sedes/')).length, 3);
  const far = await service.query('showtimes', { provider: 'grancine', cinema_id: 'lder', date: `${DFAR}` });
  assert.equal(far.status, 'empty');
  assert.ok(far.warnings.some(w => /aún no publica la programación/.test(w)));
  // A page showing another date than requested is a failure, not an empty schedule.
  const mismatch = await service.query('showtimes', { provider: 'grancine', cinema_id: 'lder', date: `${D1}` });
  assert.equal(mismatch.status, 'error');
  const movies = await service.query('movies', { provider: 'grancine', cinema_id: 'lder', date: `${D}` });
  assert.deepEqual(movies.items.map(m => [m.id, m.name, m.rating]), [['12', 'El nuevo pez que fuma', 'B']]);
  assert.ok(!movies.warnings.some(w => /no publica identificadores/.test(w)));
});

test('Gran Cine fares and concessions are reported as not published, without reading the provider', async () => {
  const { service, calls } = provider();
  for (const op of ['prices', 'concessions'] as const) {
    const result = await service.query(op, { provider: 'grancine', cinema_id: 'lder', session_id: 'gc-1' });
    assert.equal(result.status, 'unavailable');
  }
  assert.equal(calls.length, 0);
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'grancine', city: 'Caracas', cinema_id: 'lder' }).success, false);
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'grancine' }).success, true);
});

test('Gran Cine title cleaning keeps titles whose parenthetical is part of the name', () => {
  assert.equal(granCineTitle('Tierra de mi padre (Extreno Exclusivo)'), 'Tierra de mi padre');
  assert.equal(granCineTitle('Sentido y sensibilidad (2da. Semana)'), 'Sentido y sensibilidad');
  assert.equal(granCineTitle('Cosas de casa (Estreno Nacional)'), 'Cosas de casa');
  assert.equal(granCineTitle('1936 (Versión restaurada)'), '1936 (Versión restaurada)');
});

test('Gran Cine past dates are answered without reading the provider', async () => {
  const { service, calls } = provider();
  const result = await service.query('showtimes', { provider: 'grancine', cinema_id: 'lder', date: shiftDate(D, -3) });
  assert.equal(result.status, 'empty');
  assert.ok(result.warnings.some(w => /ya pasó/.test(w)));
  assert.ok(!result.warnings.some(w => /aún no publica/.test(w)));
  assert.equal(calls.length, 0);
});
