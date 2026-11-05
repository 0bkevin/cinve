import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { CinexCinemaCatalog } from '../src/cinex-cinemas.js';
import { HttpClient, ReadContext, assertPublicRead } from '../src/http.js';
import { DataError, Id } from '../src/core.js';
import { parseCinexMovies, parseCinexCinemaShowtimes } from '../src/providers.js';
import { page } from './fixtures.js';

const epoch = (date: string, time = '18:00') => String(Date.parse(`${date}T${time}:00-04:00`) / 1000);

test('Cinex movie slugs with interior dots stay in the catalog and match cinema sessions', () => {
  const catalog = parseCinexMovies(`<div class="poster" onclick="javascript: posterMovieClick('HO1', 'SERES. PARTE 1 LA INVASION', '10', 'Ficción', 'B', 'sinopsis-seres.parte1lainvasion.html', 'CARTELERA');" title="SERES. PARTE 1 LA INVASION"></div>`
    + `<div class="poster" onclick="x('sinopsis-..%2Fsecret.html')" title="Bad"></div>`);
  assert.deepEqual(catalog.map(m => m.id), ['seres.parte1lainvasion']);
  const c = new ReadContext(new HttpClient(async () => new Response('unexpected')));
  const sessions = parseCinexCinemaShowtimes(`<div class="sessionslist"><h5 class="title">SERES. PARTE 1 LA INVASION</h5><button onclick="checkLogin('77','TLN')" alt="${epoch('2026-11-04')}"></button></div>`,
    catalog, 'TLN', '2026-11-04', c, 'https://www.cinex.com.ve/cinex-tolon.html');
  assert.equal(sessions.length, 1); assert.equal(sessions[0].movie_id, 'seres.parte1lainvasion'); assert.equal(c.partial, false);
});

test('IDs allow interior dots but never relative path segments', () => {
  for (const ok of ['a', 'TLN', 'seres.parte1lainvasion', 'x'.repeat(100)]) assert.ok(Id.safeParse(ok).success, ok);
  for (const bad of ['', '.', '..', '.a', 'a.', 'a..b', '../x', 'a/b', 'x'.repeat(101)]) assert.equal(Id.safeParse(bad).success, false, bad);
});

test('conflicting duplicate session IDs are suppressed and marked partial instead of overwritten', async () => {
  const show = (id: string, date: string) => ({ id, date });
  const html = page({ movies: [
    { vistaId: 'M', title: 'Movie M', theaters: [{ id: '1002', showTimes: [show('S', '2026-11-04T18:00:00'), show('OK', '2026-11-04T19:00:00')] }] },
    { vistaId: 'N', title: 'Movie N', theaters: [{ id: '1002', showTimes: [show('S', '2026-11-04T20:00:00')] }] },
  ] }) + page({ movies: [
    // Later identical copies of a conflicting ID must not resurrect it.
    { vistaId: 'M', title: 'Movie M', theaters: [{ id: '1002', showTimes: [show('S', '2026-11-04T18:00:00'), show('OK', '2026-11-04T19:00:00')] }] },
  ] });
  const r = await new CinemaService(new HttpClient(async () => new Response(html))).query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-04' });
  assert.equal(r.status, 'available'); assert.equal(r.partial, true);
  assert.deepEqual(r.items.map(i => i.id), ['OK'], 'identical duplicates collapse; conflicting IDs are dropped');
  assert.ok(r.warnings.some(w => /contradictorios para la función S/.test(w)));
});

test('a seeded unlisted Cinex venue resolves on a fresh catalog (cold instance)', async () => {
  const detail = `<h3 class="title">METROPOLIS BARQUISIMETO</h3><div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','MTB')" alt="${epoch('2026-11-04')}"></button></div>`;
  const make = () => new CinemaService(new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/cines.html') return new Response(`<a href="cinex-listed.html" title="Cinex Listed, Caracas"><img src="https://www.cinex.com.ve/assets/images/cinemas/xlisted.jpg"><h3>Listed</h3></a>`);
    if (url.pathname === '/assets/php/datasource.php') return Response.json({ data: [] });
    if (url.pathname === '/cinex-metropolisbarquisimeto.html') return new Response(detail);
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="posterMovieClick('M','KNOWN','0','x','A','sinopsis-known.html','CARTELERA')" title="KNOWN"></div>`);
    return new Response('missing', { status: 404 });
  }), new CinexCinemaCatalog());
  const showtimes = await make().query('showtimes', { provider: 'cinex', cinema_id: 'MTB', date: '2026-11-04' });
  assert.equal(showtimes.status, 'available'); assert.equal(showtimes.total, 1);
  // A different code on the same seed page is still rejected.
  const other = await make().query('showtimes', { provider: 'cinex', cinema_id: 'XYZ', date: '2026-11-04' });
  assert.equal(other.status, 'unavailable');
});

test('public reads are limited to the routes adapters parse, even on allowed hosts', () => {
  for (const ok of [
    'https://www.cinex.com.ve/cines.html', 'https://www.cinex.com.ve/cartelera.html', 'https://www.cinex.com.ve/cinex-tolon.html',
    'https://www.cinex.com.ve/sinopsis-seres.parte1lainvasion.html',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=getcinemacitieslist',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=getcinemadatafromcinemaid&cinemaid=TLN',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=preparepricecinema&cinemaid=TLN',
    'https://www.cinesunidos.com/cines?city=Caracas', 'https://www.cinesunidos.com/cartelera?city=M%C3%A9rida',
    'https://gateway.cinesunidos.com/search/cities', 'https://gateway.cinesunidos.com/concessions/www/cinemas/1005/concessions',
    'https://cinepiccandelaria.com/es-AR', 'https://cinepicvip.com/es-AR/compra?cid=123301&fid=3636&pid=206',
    'https://apifront.cinexo.com.ar/mobile/consultas/peliculas/PeliculasConFuncionesYHorarios?idComplejo=123300&fecha=04%2F11%2F2026',
    'https://api.cinexo.com.ar/api/complejo/123300/candy',
  ]) assert.doesNotThrow(() => assertPublicRead(ok), ok);
  for (const bad of [
    'https://www.cinex.com.ve/assets/php/prepareconcessionprocess.php?action=buy',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=getcinemacitieslist&extra=1',
    'https://www.cinex.com.ve/assets/php/datasource.php?method=somethingelse',
    'https://www.cinex.com.ve/cartelera.html?x=1', 'https://www.cinex.com.ve/sinopsis-..%2Fx.html',
    'https://www.cinex.com.ve/boletos.php?cinemaid=TLN&sessionid=1',
    'https://www.cinesunidos.com/cines?city=Caracas&city=Valencia', 'https://www.cinesunidos.com/api/seats?theaterId=1&showTimeId=2',
    'https://gateway.cinesunidos.com/tickets/www/theaters/1/sessions/2/', 'https://cinepicvip.com/es-AR/compra?cid=1&fid=2',
    'https://evil.test/',
  ]) assert.throws(() => assertPublicRead(bad), DataError, bad);
});

test('a Cloudflare challenge is reported as an explicit block without evasion', async () => {
  let calls = 0;
  const s = new CinemaService(new HttpClient(async () => { calls++; return new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } }); }));
  const r = await s.query('movies', { provider: 'cinex' });
  assert.equal(r.status, 'blocked'); assert.equal(calls, 1); assert.equal(r.sources.length, 0);
  assert.ok(r.warnings.some(w => /desafío anti-bots/.test(w) && /no evade/.test(w)), r.warnings.join(' | '));
});

test('Cinex venue discovery stops at its time budget and keeps remaining venues as unverified', async () => {
  const cards = ['a', 'b', 'c', 'd', 'e'].map(slug => `<a href="cinex-${slug}.html" title="Cinex ${slug.toUpperCase()}, Caracas"><img src="https://www.cinex.com.ve/assets/images/cinemas/x${slug}.jpg"><h3>${slug.toUpperCase()}</h3></a>`).join('');
  let metadata = 0;
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/cines.html') return new Response(cards);
    if (url.pathname === '/assets/php/datasource.php') { metadata++; return Response.json({ data: [] }); }
    return new Response('missing', { status: 404 });
  });
  const r = await new CinemaService(http, new CinexCinemaCatalog(0)).query('cinemas', { provider: 'cinex' });
  assert.equal(r.total, 5); assert.equal(r.partial, true); assert.equal(metadata, 0, 'no provider reads after the budget is spent');
  assert.ok(r.items.every(i => i.code_status === 'unverified' && i.id.startsWith('directory-')));
  assert.ok(r.warnings.some(w => /tiempo de comprobación/.test(w)));
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
  assert.equal(cinemas.status, 'available'); assert.equal(cinemas.items[0].cinema_id, '1012'); assert.equal(cinemas.items[0].city, 'Mérida');
  assert.ok(cinemas.warnings.some(w => /API pública de búsqueda/.test(w)));
  const showtimes = await s.query('showtimes', { provider: 'cinesunidos', city: 'Mérida', cinema_id: '1012', date: '2026-11-04' });
  assert.deepEqual(showtimes.items.map(i => [i.id, i.movie_id, i.time, i.screen, i.starts_at]), [['44788', 'HO00006098', '18:15', '2', '2026-11-04T18:15:00-04:00']]);
  const movies = await s.query('movies', { provider: 'cinesunidos', city: 'Mérida', date: '2026-11-04' });
  assert.deepEqual(movies.items.map(i => i.id).sort(), ['HO00006098', 'HO1']);
  assert.ok(requests.every(r => !r.includes('/tickets/')), 'the fallback never touches ticketing routes');
  // A non-challenge failure is not masked by the fallback.
  const down = await new CinemaService(new HttpClient(async () => new Response('down', { status: 503 }))).query('cinemas', { provider: 'cinesunidos', city: 'Caracas' });
  assert.equal(down.status, 'error');
});

test('gateway search routes are allowed only with a bounded city and exact Title query', () => {
  for (const ok of ['https://gateway.cinesunidos.com/search/cities/Caracas/theaters', 'https://gateway.cinesunidos.com/search/cities/M%C3%A9rida/films',
    'https://gateway.cinesunidos.com/search/cities/Caracas/sessions?Title=Duna+Parte+3']) assert.doesNotThrow(() => assertPublicRead(ok), ok);
  for (const bad of ['https://gateway.cinesunidos.com/search/cities/Caracas/sessions', 'https://gateway.cinesunidos.com/search/cities/Caracas/sessions?Title=a&x=1',
    'https://gateway.cinesunidos.com/search/cities/Caracas/theaters?x=1', 'https://gateway.cinesunidos.com/search/cities/%2F/films',
    'https://gateway.cinesunidos.com/search/cities/%E0%A4%A/films', 'https://gateway.cinesunidos.com/search/cities/Caracas/orders']) assert.throws(() => assertPublicRead(bad), DataError, bad);
});

test('a challenged origin is remembered so later public reads skip straight to the fallback', async () => {
  const www: string[] = [];
  let challenge = true;
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.hostname === 'www.cinesunidos.com') {
      www.push(url.pathname);
      return challenge ? new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) : new Response('<html></html>');
    }
    if (url.pathname === '/search/cities') return Response.json(['Caracas']);
    if (url.pathname === '/search/cities/Caracas/theaters') return Response.json([{ id: '1005', name: 'Sambil Caracas', address: 'Chacao' }]);
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  for (let i = 0; i < 3; i++) {
    const r = await s.query('cinemas', { provider: 'cinesunidos', city: 'Caracas' });
    assert.equal(r.status, 'available'); assert.ok(r.warnings.some(w => /API pública de búsqueda/.test(w)));
  }
  assert.equal(www.length, 1, 'the challenged website is asked once, not on every call');
  // refresh=true still asks the website again, and a success clears the memory.
  challenge = false;
  await http.get('https://www.cinesunidos.com/cines?city=Caracas', 120000, true);
  await http.get('https://www.cinesunidos.com/cartelera?city=Caracas');
  assert.equal(www.length, 3);
});

test('one city read through the search API fits in the cache alongside another city', async () => {
  let reads = 0;
  const http = new HttpClient(async input => {
    reads++;
    const url = new URL(String(input));
    if (url.hostname === 'www.cinesunidos.com') return new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    if (url.pathname === '/search/cities') return Response.json(['Caracas', 'Valencia']);
    if (url.pathname.endsWith('/films')) return Response.json(Array.from({ length: 60 }, (_, i) => `Film ${i}`));
    if (url.pathname.endsWith('/sessions')) return Response.json([{ showtime: '2026-11-04T18:15:00', sessionId: `s${reads}`, screenNumber: 1, format: '2D', ho: `HO${url.searchParams.get('Title')!.slice(5)}`, title: url.searchParams.get('Title'), cinemaId: '1005' }]);
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  await s.query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-04' });
  await s.query('showtimes', { provider: 'cinesunidos', city: 'Valencia', date: '2026-11-04' });
  const before = reads;
  const again = await s.query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-04' });
  assert.equal(again.total, 60); assert.equal(reads, before, 'a second city must not evict the first city from the cache');
});
