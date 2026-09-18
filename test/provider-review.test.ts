import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { HttpClient, ReadContext } from '../src/http.js';
import { parseCinexCinemaShowtimes, parseCinexShowtimes } from '../src/providers.js';

const epoch = (date: string, time = '20:00') => Math.floor((Date.parse(`${date}T${time}:00Z`) + 4 * 3600000) / 1000);
const movie = { kind: 'movie' as const, id: 'm', name: 'KNOWN' };
const context = () => new ReadContext(new HttpClient(async () => new Response('unexpected')));

test('Cinex movie-specific malformed epochs are partial instead of clean empty', () => {
  const c = context();
  const items = parseCinexShowtimes(
    `<h1>Known</h1><button onclick="checkLogin('s1','C')" alt="not-an-epoch"></button>`,
    'm', '2026-09-18', c,
  );
  assert.deepEqual(items, []);
  assert.equal(c.partial, true);
  assert.ok(c.warnings.some(w => /malformado|epoch/.test(w)));
});

test('Cinex valid sessions for another date remain a normal clean empty result', () => {
  const c = context();
  const items = parseCinexCinemaShowtimes(
    `<div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','C')" alt="${epoch('2026-09-19')}"></button></div>`,
    [movie], 'C', '2026-09-18', c, 'https://www.cinex.com.ve/cinex-c.html',
  );
  assert.deepEqual(items, []);
  assert.equal(c.partial, false);
  assert.equal(c.warnings.length, 0);
});

test('Cinex mixed valid and malformed cinema epochs preserve valid sessions and mark partial', () => {
  const c = context();
  const items = parseCinexCinemaShowtimes(
    `<div class="sessionslist"><h5 class="title">KNOWN</h5>
      <button onclick="checkLogin('s1','C')" alt="${epoch('2026-09-18')}"></button>
      <button onclick="checkLogin('s2','C')" alt="not-an-epoch"></button>
    </div>`,
    [movie], 'C', '2026-09-18', c, 'https://www.cinex.com.ve/cinex-c.html',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 's1');
  assert.equal(c.partial, true);
  assert.ok(c.warnings.some(w => /epoch|malformada/.test(w)));
});

test('Cinex parser diagnostics stay bounded for large malformed pages and long labels', () => {
  const malformed = Array.from({ length: 2000 }, () =>
    `<div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','C')" alt="bad"></button></div>`).join('');
  const malformedContext = context();
  parseCinexCinemaShowtimes(malformed, [movie], 'C', '2026-09-18', malformedContext, 'https://www.cinex.com.ve/cinex-c.html');
  assert.equal(malformedContext.partial, true);
  assert.ok(malformedContext.warnings.length <= 32);
  assert.ok(malformedContext.warnings.join('').length < 8192);
  assert.ok(malformedContext.warnings.some(w => /repetido 2000 veces/.test(w)));

  const longTitle = 'T'.repeat(10000);
  const longContext = context();
  parseCinexCinemaShowtimes(
    `<div class="sessionslist"><h5 class="title">${longTitle}</h5><button onclick="checkLogin('s1','C')" alt="${epoch('2026-09-18')}"></button></div>`,
    [movie], 'C', '2026-09-18', longContext, 'https://www.cinex.com.ve/cinex-c.html',
  );
  assert.ok(longContext.warnings.every(w => w.length <= 512));
  assert.ok(longContext.warnings.join('').length < 8192);
});

test('Cinepic omits unknown subtitle and overnight flags and marks the result partial', async () => {
  const payload = { success: true, data: {
    datos: [{ peliculas_codigo: 'p1', peliculas_nombre: 'Movie' }],
    funciones: [{ _id: 'f1', codPelicula: 'p1', hora: '20:00', subtitulada: 'unknown', trasnoche: 'unknown' }],
  } };
  const service = new CinemaService(new HttpClient(async () => Response.json(payload)));
  const result = await service.query('showtimes', { provider: 'cinepic', cinema_id: '123300', date: '2026-09-18' });
  assert.equal(result.status, 'available');
  assert.equal(result.partial, true);
  assert.equal(result.items[0].language, undefined);
  assert.equal(result.items[0].starts_at, undefined);
  assert.ok(result.warnings.some(w => /subtítulos/.test(w)));
  assert.ok(result.warnings.some(w => /trasnoche/.test(w)));
});

test('service caps distinct and repeated provider warnings with an explicit aggregate', async () => {
  const data = Array.from({ length: 200 }, (_, i) => ({ itemId: `item-${i}`, itemDescription: `Product ${i}` }));
  const service = new CinemaService(new HttpClient(async input => {
    if (new URL(String(input)).pathname.includes('/concessions/')) return Response.json(data);
    return new Response('unexpected', { status: 404 });
  }));
  const result = await service.query('concessions', { provider: 'cinesunidos', cinema_id: '1002' });
  assert.equal(result.status, 'available');
  assert.equal(result.total, 200);
  assert.ok(result.warnings.length <= 64);
  assert.ok(result.warnings.join('').length <= 8192);
  assert.ok(result.warnings.some(w => /Se omitieron/.test(w)));
});
