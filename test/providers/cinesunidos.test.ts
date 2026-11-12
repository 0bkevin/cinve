import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCinesUnidosPrices } from '../../src/providers/cinesunidos/prices.js';
import { CinemaService } from '../../src/service.js';
import { HttpClient } from '../../src/http/client.js';
import { mockFetch, page, EmptySessionStore, cuMovies } from '../helpers/fixtures.js';
import { inputSchema } from '../../src/mcp/server.js';
import { cuLanguage, cuSiteTitle } from '../../src/providers/cinesunidos/adapter.js';
import type { DataItem } from '../../src/core.js';
import { defined, nth } from '../helpers/assert.js';

const url = 'https://www.cinex.com.ve/boletos.php?cinemaid=TLN&sessionid=s1';

test('CU uses UI price fields, preserves restrictions and checks cinema/session/movie identity', () => {
  const value = [{ cinemaId: '1002', sessionId: 's1', scheduledFilmId: 'm1', allowTicketSales: false, user: 'PRIVATE_PROFILE', tickets: [{ ticketTypeCode: 't1', areaCategoryCode: 'a1', description: 'Mayor', redemptionOnly: true, isChildOnlyTicket: false, priceInCents: 99999, price: { refPrice: 2, total: 1664.97, exchangeRate: 832.49, grossPrice: { total: 1664.98 } } }] }];
  const query = { provider: 'cinesunidos' as const, cinema_id: '1002', session_id: 's1', movie_id: 'm1' };
  const items = parseCinesUnidosPrices(value, query, 'https://gateway.cinesunidos.com/');
  assert.deepEqual(nth(items, 0).prices?.map(p => p.amount), [2, 1664.97]);
  assert.equal(nth(items, 0).redemption_only, true); assert.equal(nth(items, 0).sales_allowed, false);
  assert.ok(!JSON.stringify(items).includes('PRIVATE_PROFILE'));
  for (const change of [{ cinema_id: '1005' }, { session_id: 'other' }, { movie_id: 'other' }]) assert.throws(() => parseCinesUnidosPrices(value, { ...query, ...change }, url));
});

const service = () => new CinemaService(new HttpClient(mockFetch, 15000, new EmptySessionStore()));

test('Cines Unidos filters by day, cinema and movie; timezone has one offset', async () => {
  const result = await service().query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-09-11', cinema_id: '1005', movie_id: 'HO1' });
  assert.equal(result.total, 1); assert.equal(nth(result.items, 0).id, 's3');
  assert.equal(nth(result.items, 0).starts_at, '2026-09-11T21:00:00-04:00');
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
  assert.equal(nth(result.items, 0).code_status, 'unverified');
  assert.equal(nth(result.items, 0).cinema_id, undefined);
  assert.match(nth(result.items, 0).id, /^directory-/);
  assert.equal(result.total, 1);
  assert.match(nth(result.warnings, 0), /venue kept/);
});

const cu = (html: string) => new CinemaService(new HttpClient(async () => new Response(html)));
const cq = { provider: 'cinesunidos' as const, city: 'Caracas' };

test('CU preserves good venues and named venues without usable codes despite malformed siblings', async () => {
  const r = await cu(page({ theaters: [null, { id: '1002', name: 'Good' }, { name: 'Missing ID' }, { id: '../bad', name: 'Unsafe ID' }] })).query('cinemas', cq);
  assert.equal(r.status, 'available'); assert.equal(r.total, 3); assert.equal(r.partial, true);
  assert.equal(r.items.find(i => i.name === 'Good')?.id, '1002');
  for (const name of ['Missing ID', 'Unsafe ID']) {
    const item = defined(r.items.find(i => i.name === name));
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
  assert.equal(r.status, 'available'); assert.equal(nth(r.items, 0).city, 'Maturín');
  assert.ok(requests.some(u => u.includes('Matur%C3%ADn')));
  const missing = await s.query('cinemas', { ...cq, city: 'Atlantis' });
  assert.equal(missing.status, 'unavailable'); assert.match(missing.warnings.join(' '), /city/i);
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
  assert.equal(nth(first.items, 0).id, nth(again.items, 0).id); assert.notEqual(nth(first.items, 0).id, nth(next.items, 0).id);
});

test('CU movie catalogs also combine component blocks rather than accepting the first empty list', async () => {
  const html = page({ movies: [] }) + page({ movies: [{ vistaId: 'M', title: 'Movie', theaters: [{ id: '1002', showTimes: [{ id: 'S', date: '2026-09-18T18:00:00' }] }] }] });
  const r = await cu(html).query('movies', { ...cq, date: '2026-09-18' });
  assert.equal(r.total, 1); assert.equal(nth(r.items, 0).id, 'M');
});

test('invalid dates and unusable upstream IDs fail visibly instead of returning bad showtimes', async () => {
  for (const patch of [{ date: '2026-09-11T29:99:99' }, { id: '../../unsafe' }]) {
    const data = structuredClone(cuMovies); Object.assign(nth(nth(nth(data.movies, 0).theaters, 0).showTimes, 0), patch);
    const service = new CinemaService(new HttpClient(async () => new Response(page(data))));
    const r = await service.query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-09-11' });
    assert.equal(r.status, 'error'); assert.deepEqual(r.items, []);
  }
  assert.equal(inputSchema('prices').safeParse({ provider: 'cinex', cinema_id: 'TLN', session_id: 's1', movie_id: 'ignored' }).success, false);
});

test('Cines Unidos falls back to its public search API when the website challenges the client', async () => {
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.hostname + url.pathname + url.search);
    if (url.hostname === 'www.cinesunidos.com') return new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    if (url.pathname === '/search/cities') return Response.json(['Caracas', 'Mérida']);
    if (url.pathname === '/search/cities/M%C3%A9rida/theaters') return Response.json([{ id: '1012', name: 'Alto Prado', address: 'Av. Los Próceres' }]);
    if (url.pathname === '/search/cities/M%C3%A9rida/films') return Response.json(['Duna Parte 3', 'Otra']);
    if (url.pathname === '/search/cities/M%C3%A9rida/sessions') {
      const title = url.searchParams.get('Title');
      return Response.json(title === 'Duna Parte 3' ? [
        { showtime: '2026-11-04T18:15:00', sessionId: '44788', screenNumber: 2, format: 'Digital', ho: 'HO00006098', title, cinemaId: '1012', language: 'Español' },
        { showtime: '2026-11-05T18:15:00', sessionId: '44790', screenNumber: 2, format: 'Digital', ho: 'HO00006098', title, cinemaId: '1012', language: 'Español' },
      ] : [{ showtime: '2026-11-04T20:00:00', sessionId: '5', screenNumber: 1, format: '3D', ho: 'HO1', title, cinemaId: '9999' }]);
    }
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  const cinemas = await s.query('cinemas', { provider: 'cinesunidos', city: 'merida' });
  assert.equal(cinemas.status, 'available'); assert.equal(nth(cinemas.items, 0).cinema_id, '1012'); assert.equal(nth(cinemas.items, 0).city, 'Mérida');
  assert.ok(cinemas.warnings.some(w => /public search API/.test(w)));
  const showtimes = await s.query('showtimes', { provider: 'cinesunidos', city: 'Mérida', cinema_id: '1012', date: '2026-11-04' });
  assert.deepEqual(showtimes.items.map(i => [i.id, i.movie_id, i.time, i.screen, i.starts_at]), [['44788', 'HO00006098', '18:15', '2', '2026-11-04T18:15:00-04:00']]);
  const movies = await s.query('movies', { provider: 'cinesunidos', city: 'Mérida', date: '2026-11-04' });
  assert.deepEqual(movies.items.map(i => i.id).sort(), ['HO00006098', 'HO1']);
  assert.ok(requests.every(r => !r.includes('/tickets/')), 'the fallback never touches ticketing routes');
  // A non-challenge failure is not masked by the fallback.
  const down = await new CinemaService(new HttpClient(async () => new Response('down', { status: 503 }))).query('cinemas', { provider: 'cinesunidos', city: 'Caracas' });
  assert.equal(down.status, 'error');
});

test('the Cines Unidos search fallback searches only matching titles and keeps titles that succeed', async () => {
  const searched: string[] = [];
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.hostname === 'www.cinesunidos.com') return new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    if (url.pathname === '/search/cities') return Response.json(['Caracas']);
    if (url.pathname.endsWith('/films')) return Response.json(['Good Film', 'Bad Film', 'El Silbón', 'Otra', 'Broken', 'Bad Id']);
    if (url.pathname.endsWith('/sessions')) {
      const title = defined(url.searchParams.get('Title')); searched.push(title);
      if (title === 'Bad Film') return new Response('down', { status: 500 });
      if (title === 'Broken') return Response.json([{ showtime: 'not-a-date', sessionId: 'x', ho: 'HOX', title, cinemaId: '1005' }]);
      if (title === 'Bad Id') return Response.json([{ showtime: '2026-11-04T19:00:00', sessionId: 'y', ho: 'bad/id', title, cinemaId: '1005' }]);
      return Response.json([{ showtime: '2026-11-04T18:15:00', sessionId: `s-${searched.length}`, screenNumber: 1, format: '2D', ho: `HO${searched.length}`, title, cinemaId: '1005' }]);
    }
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  const one = await s.query('movies', { provider: 'cinesunidos', city: 'Caracas', query: 'silbon', date: '2026-11-04' });
  assert.deepEqual(one.items.map(i => i.name), ['El Silbón']);
  assert.deepEqual(searched, ['El Silbón'], 'a one-title question searches one title');
  const all = await s.query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-04' });
  assert.equal(all.status, 'available'); assert.equal(all.partial, true);
  assert.deepEqual(all.items.map(i => i.name).sort(), ['El Silbón', 'Good Film', 'Otra']);
  // A malformed title fails alone, like a failed request.
  // An ID the service would reject fails its title too, instead of the whole response.
  assert.ok(all.warnings.some(w => /Showtimes could not be queried for 3 of 6 Cines Unidos titles/.test(w)), all.warnings.join(' | '));
});

test('the Cines Unidos search fallback stops at its total deadline and keeps the titles it read', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T12:00:00Z') });
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.hostname === 'www.cinesunidos.com') return new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    if (url.pathname === '/search/cities') return Response.json(['Caracas']);
    if (url.pathname.endsWith('/films')) return Response.json(Array.from({ length: 40 }, (_, i) => `Film ${i}`));
    if (url.pathname.endsWith('/sessions')) {
      const title = defined(url.searchParams.get('Title'));
      t.mock.timers.tick(10000); // every title search takes 10 s
      return Response.json([{ showtime: '2026-11-04T19:00:00', sessionId: title.replace(' ', '-'), ho: `HO${title.slice(5)}`, title, cinemaId: '1005' }]);
    }
    return new Response('missing', { status: 404 });
  });
  const r = await new CinemaService(http).query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-04' });
  assert.equal(r.status, 'available'); assert.equal(r.partial, true);
  assert.ok(r.total > 0 && r.total < 10, `${r.total} titles read before the 45 s budget`);
  assert.ok(r.warnings.some(w => /query timed out before reading \d+ of 40 Cines Unidos titles/.test(w)), r.warnings.join(' | '));
});

test('the Cines Unidos search fallback counts its setup reads against the hosted time limit', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T12:00:00Z') });
  const started = Date.now();
  // Every read takes 14 s, just under the per-read deadline: the challenged
  // page, the city registry and the film list use 42 s before any title search.
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    t.mock.timers.tick(14000);
    if (url.hostname === 'www.cinesunidos.com') return new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    if (url.pathname === '/search/cities') return Response.json(['Caracas']);
    if (url.pathname.endsWith('/films')) return Response.json(Array.from({ length: 8 }, (_, i) => `Film ${i}`));
    if (url.pathname.endsWith('/sessions')) {
      const title = defined(url.searchParams.get('Title'));
      return Response.json([{ showtime: '2026-11-04T19:00:00', sessionId: title.replace(' ', '-'), ho: `HO${title.slice(5)}`, title, cinemaId: '1005' }]);
    }
    return new Response('missing', { status: 404 });
  }, 15000);
  const r = await new CinemaService(http).query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-04' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= 75000, `finished after ${elapsed} ms; reads must stop starting at 60 s`);
  assert.equal(r.status, 'available'); assert.equal(r.partial, true);
  assert.ok(r.total > 0 && r.total < 8, String(r.total));
});

test('Cines Unidos shows the website title, version and rating on both of its read paths', async () => {
  // Shapes observed on 2026-11-05: the page puts the version in the title and
  // features.Language; the search API drops it from the title (leaving a double
  // space inside "Clayface  Atmos") and sends it as language.
  const movie = (vistaId: string, title: string, language: string, sessions: [string, string][]) => ({ vistaId, title, features: { Language: language },
    theaters: [{ id: '1027', name: 'Líder', rating: 'B+12', showTimes: sessions.map(([id, time]) => ({ id, date: `2026-11-05T${time}:00`, screen: 8, format: 'Digital' })) }] });
  const movies = [movie('HO6136', 'Clayface (Esp)', 'Español', [['1', '15:00']]), movie('HO6338', 'Clayface (Sub) Atmos', 'Subtitulada', [['2', '17:40']])];
  const api = [{ showtime: '2026-11-05T15:00:00', sessionId: '1', screenNumber: 8, format: 'Digital', ho: 'HO6136', title: 'Clayface', cinemaId: '1027', rating: 'B+12', language: 'Español' },
    { showtime: '2026-11-05T17:40:00', sessionId: '2', screenNumber: 8, format: 'Digital', ho: 'HO6338', title: 'Clayface  Atmos', cinemaId: '1027', rating: 'B+12', language: 'Subtitulada' }];
  const reader = (blocked: boolean) => new CinemaService(new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.hostname === 'www.cinesunidos.com') return blocked ? new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) : new Response(page({ movies }));
    if (url.pathname === '/search/cities') return Response.json(['Caracas']);
    if (url.pathname.endsWith('/films')) return Response.json(['Clayface']);
    if (url.pathname.endsWith('/sessions')) return Response.json(api);
    return new Response('missing', { status: 404 });
  }));
  const view = (r: { items: DataItem[] }) => r.items.map(i => [i.id, i.name, i.language, i.rating]);
  const expected = [['1', 'Clayface (Esp)', 'es', 'B+12'], ['2', 'Clayface (Sub) Atmos', 'subtitulada', 'B+12']];
  for (const blocked of [false, true]) {
    const r = await reader(blocked).query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-05' });
    assert.deepEqual(view(r), expected, blocked ? 'search API path' : 'page path');
  }
  assert.equal(cuSiteTitle('Godzilla Minus Zero', 'Subtitulada'), 'Godzilla Minus Zero (Sub)');
  assert.equal(cuSiteTitle('Clayface (Sub)', 'Subtitulada'), 'Clayface (Sub)', 'a title that keeps its marker is not marked twice');
  assert.equal(cuSiteTitle('Un  Evento', 'Original'), 'Un Evento', 'an unknown version adds nothing');
  assert.equal(cuLanguage('Inglés'), 'Inglés');
});
