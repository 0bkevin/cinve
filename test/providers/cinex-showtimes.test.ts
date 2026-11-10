import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../../src/service.js';
import { CinexCinemaCatalog } from '../../src/providers/cinex/venues.js';
import { HttpClient } from '../../src/http/client.js';
import { inputSchema } from '../../src/mcp/server.js';
import { ReadContext } from '../../src/http/read-context.js';
import { parseCinexMovies, parseCinexCinemaShowtimes } from '../../src/providers/cinex/public-pages.js';
import { page } from '../helpers/fixtures.js';

const base = 'https://www.cinex.com.ve';
const card = (slug: string, name: string, image: string, city = 'Caracas') => `<a href="cinex-${slug}.html" title="Cinex ${name}, ${city}"><img src="${base}/assets/images/cinemas/${image}"><h3>${name}</h3></a>`;
function service(directory: () => string, pages: Record<string, string>, codes: Record<string, unknown> = {}) {
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.href);
    if (url.pathname === '/cines.html') return new Response(directory());
    if (url.pathname === '/assets/php/datasource.php') return Response.json({ data: codes[url.searchParams.get('cinemaid')!] ?? [] });
    const body = pages[url.pathname];
    return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200 });
  });
  return { s: new CinemaService(http), requests };
}

test('Cinex cinema-wide showtimes use one cinema page plus one catalog, paginate, cache, and refresh', async () => {
  const requests: string[] = [];
  const directory = card('sambil', 'Sambil Chacao', '480x189xsbc.jpg.pagespeed.test.jpg');
  const detail = `<h3 class="title">SAMBIL CHACAO</h3>
    <div class="sessionslist"><h5 class="title">COYOTE VS ACME</h5>
      <button onclick="checkLogin('23059','SBC')" alt="1789751400"><img class="icoIdioma" src="assets/images/xes.png.pagespeed.test.png">Sala 1</button>
      <button onclick="checkLogin('23062','SBC')" alt="1789756800">Sala 2</button>
      <button onclick="checkLogin('bad/ID','SBC')" alt="1789755000">Sala 2</button>
    </div>
    <div class="sessionslist"><h5 class="title">NOT IN CATALOG</h5>
      <button onclick="checkLogin('23099','SBC')" alt="1789758600">Sala 3</button>
    </div>`;
  const catalog = `<div class="poster" onclick="posterMovieClick('M-COYOTE', 'COYOTE VS ACME', '0', 'x', 'A', 'sinopsis-coyote.html', 'CARTELERA')" title="COYOTE VS ACME"></div>`;
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response(directory);
    if (url.pathname === '/cinex-sambil.html') return new Response(detail);
    if (url.pathname === '/cartelera.html') return new Response(catalog);
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  const first = await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18', limit: 1 });
  assert.equal(first.status, 'available'); assert.equal(first.total, 2); assert.equal(first.next_offset, 1);
  assert.equal(first.items[0].movie_id, 'coyote'); assert.equal(first.partial, true);
  assert.equal(first.items[0].id, '23059'); assert.equal(first.items[0].screen, '1'); assert.equal(first.items[0].language, 'es');
  assert.ok(first.warnings.some(w => /catálogo|identificador/.test(w)));
  assert.deepEqual(requests, ['/cartelera.html', '/cines.html', '/cinex-sambil.html']);

  const cached = await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18', offset: 0, limit: 1 });
  assert.equal(cached.total, 2); assert.equal(requests.length, 3);
  const fresh = await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18', refresh: true });
  assert.equal(fresh.total, 2); assert.equal(requests.length, 5);
  assert.equal(fresh.sources.find(source => source.url.endsWith('/cinex-sambil.html'))?.cached, false);
});

test('Cinex cinema-wide title mapping is conservative for ambiguous catalog titles', async () => {
  const http = new HttpClient(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/cines.html') return new Response(card('x', 'X Cinema', '480x189xx.jpg'));
    if (path === '/cinex-x.html') return new Response(`<h3 class="title">X CINEMA</h3><div class="sessionslist"><h5 class="title">SAME TITLE</h5><button onclick="checkLogin('s1','X')" alt="1789751400"></button></div>`);
    if (path === '/cartelera.html') return new Response(`<div class="poster" onclick="posterMovieClick('M1','SAME TITLE','0','x','A','sinopsis-one.html','CARTELERA')" title="SAME TITLE"></div><div class="poster" onclick="posterMovieClick('M2','SAME TITLE','0','x','A','sinopsis-two.html','CARTELERA')" title="SAME TITLE"></div>`);
    return new Response('missing', { status: 404 });
  });
  const result = await new CinemaService(http).query('showtimes', { provider: 'cinex', cinema_id: 'X', date: '2026-09-18' });
  assert.equal(result.status, 'empty'); assert.equal(result.total, 0); assert.equal(result.partial, true);
  assert.ok(result.warnings.some(w => /ambiguo/.test(w))); assert.equal(result.items.length, 0);
});

test('Cinex movie-specific showtimes still use the movie page and do not fetch a cinema catalog', async () => {
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const path = new URL(String(input)).pathname; requests.push(path);
    if (path === '/sinopsis-m.html') return new Response(`<h1>Movie</h1><button onclick="checkLogin('s1','SBC')" alt="1789751400"><img class="icoIdioma" src="assets/images/xes.png.pagespeed.test.png">Sala 1</button>`);
    return new Response('missing', { status: 404 });
  });
  const result = await new CinemaService(http).query('showtimes', { provider: 'cinex', movie_id: 'm', date: '2026-09-18' });
  assert.equal(result.status, 'available'); assert.equal(result.total, 1); assert.equal(result.items[0].language, 'es'); assert.deepEqual(requests, ['/sinopsis-m.html']);
});

test('Cinex marks an all-malformed epoch block partial instead of returning a complete empty result', async () => {
  const { s } = service(
    () => card('x', 'X Cinema', '480x189xxx.jpg'),
    { '/cinex-x.html': `<h3 class="title">X CINEMA</h3><div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','XX')" alt="not-an-epoch"></button></div>`,
      '/cartelera.html': `<div class="poster" onclick="posterMovieClick('M','KNOWN','0','x','A','sinopsis-known.html','CARTELERA')" title="KNOWN"></div>` },
  );
  const result = await s.query('showtimes', { provider: 'cinex', cinema_id: 'XX', date: '2026-09-18' });
  assert.equal(result.status, 'empty'); assert.equal(result.total, 0); assert.equal(result.partial, true);
  assert.ok(result.warnings.some(w => /epoch|malformada/.test(w)));
});

test('Cinex rejects a schedule page with no session blocks as a schema error', async () => {
  const { s } = service(
    () => card('x', 'X Cinema', '480x189xxx.jpg'),
    { '/cinex-x.html': '<h3 class="title">X CINEMA</h3><img src="assets/images/cinemas/480x189xxx.jpg">',
      '/cartelera.html': `<div class="poster" onclick="posterMovieClick('M','KNOWN','0','x','A','sinopsis-known.html','CARTELERA')" title="KNOWN"></div>` },
    { XX: [{ siglas: 'XX', name: 'X CINEMA' }] },
  );
  const result = await s.query('showtimes', { provider: 'cinex', cinema_id: 'XX', date: '2026-09-18' });
  assert.equal(result.status, 'error'); assert.match(result.warnings.join(' '), /estructura/);
});

test('Cinex permanently suppresses a session ID after cross-movie conflict, including a third duplicate', async () => {
  const { s } = service(
    () => card('x', 'X Cinema', '480x189xxx.jpg'),
    { '/cinex-x.html': `<h3 class="title">X CINEMA</h3>
      <div class="sessionslist"><h5 class="title">MOVIE A</h5><button onclick="checkLogin('s1','XX')" alt="1789751400"></button></div>
      <div class="sessionslist"><h5 class="title">MOVIE B</h5><button onclick="checkLogin('s1','XX')" alt="1789755000"></button></div>
      <div class="sessionslist"><h5 class="title">MOVIE A</h5><button onclick="checkLogin('s1','XX')" alt="1789751400"></button></div>`,
      '/cartelera.html': `<div class="poster" onclick="posterMovieClick('A','MOVIE A','0','x','A','sinopsis-a.html','CARTELERA')" title="MOVIE A"></div><div class="poster" onclick="posterMovieClick('B','MOVIE B','0','x','A','sinopsis-b.html','CARTELERA')" title="MOVIE B"></div>` },
  );
  const result = await s.query('showtimes', { provider: 'cinex', cinema_id: 'XX', date: '2026-09-18' });
  assert.equal(result.status, 'empty'); assert.equal(result.total, 0); assert.equal(result.partial, true);
  assert.equal(result.items.some(item => item.id === 's1'), false);
  assert.ok(result.warnings.some(w => /contradictorios/.test(w)));
});

test('a Cinex venue plus movie query reads the venue page, not the synopsis page', async () => {
  const epoch = (time: string) => String(Date.parse(`2026-09-18T${time}:00-04:00`) / 1000);
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response(card('sambil', 'Sambil', 'xSBC.jpg'));
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="x('sinopsis-elsilbon.html')" title="EL SILBON"></div><div class="poster" onclick="x('sinopsis-otra.html')" title="OTRA"></div>`);
    if (url.pathname === '/cinex-sambil.html') return new Response(`<h3 class="title">SAMBIL</h3>`
      + `<div class="sessionslist"><h5 class="title">EL SILBON</h5><button onclick="checkLogin('24013','SBC')" alt="${epoch('20:30')}"></button></div>`
      + `<div class="sessionslist"><h5 class="title">OTRA</h5><button onclick="checkLogin('24014','SBC')" alt="${epoch('21:00')}"></button></div>`);
    if (url.pathname === '/sinopsis-elsilbon.html') return new Response('<h1>EL SILBON</h1><div class="carousel"></div>');
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http, new CinexCinemaCatalog());
  const r = await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', movie_id: 'elsilbon', date: '2026-09-18' });
  assert.equal(r.status, 'available');
  assert.deepEqual(r.items.map(i => [i.id, i.movie_id, i.time, i.cinema_name]), [['24013', 'elsilbon', '20:30', 'Sambil']]);
  assert.ok(!requests.includes('/sinopsis-elsilbon.html'));
  // Movie-only queries still read the synopsis page, and an empty one points to the venue path.
  const movieOnly = await s.query('showtimes', { provider: 'cinex', movie_id: 'elsilbon', date: '2026-09-18' });
  assert.equal(movieOnly.status, 'unavailable');
  assert.ok(movieOnly.warnings.some(w => /cinema_id de cada sede/.test(w)), movieOnly.warnings.join(' | '));
});

test('Cinex city showtimes read every verified venue of the city in one call and keep the ones that answer', async () => {
  const epoch = (time: string) => String(Date.parse(`2026-09-18T${time}:00-04:00`) / 1000);
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response(card('sambil', 'Sambil', 'xSBC.jpg') + card('lider', 'Lider', 'xLDR.jpg') + card('tolon', 'Tolon', 'xTLN.jpg', 'Valencia'));
    if (url.pathname === '/assets/php/datasource.php') {
      const id = url.searchParams.get('cinemaid');
      return Response.json({ data: [{ siglas: id, name: id === 'SBC' ? 'Sambil' : id === 'LDR' ? 'Lider' : 'Tolon' }] });
    }
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="x('sinopsis-clayface.html')" title="CLAYFACE"></div>`);
    if (url.pathname === '/cinex-sambil.html') return new Response(`<h3 class="title">SAMBIL</h3><div class="sessionslist"><h5 class="title">CLAYFACE</h5><button onclick="checkLogin('1','SBC')" alt="${epoch('20:30')}"></button></div>`);
    if (url.pathname === '/cinex-lider.html') return new Response('down', { status: 503 });
    return new Response('missing', { status: 404 });
  });
  const r = await new CinemaService(http, new CinexCinemaCatalog()).query('showtimes', { provider: 'cinex', city: 'caracas', date: '2026-09-18' });
  assert.equal(r.status, 'available');
  assert.deepEqual(r.items.map(i => [i.id, i.cinema_id, i.cinema_name, i.movie_id, i.time]), [['1', 'SBC', 'Sambil', 'clayface', '20:30']]);
  assert.equal(r.partial, true);
  assert.ok(r.warnings.some(w => /1 sedes Cinex \(Lider\)/.test(w)), r.warnings.join(' | '));
  assert.ok(!requests.includes('/cinex-tolon.html'), 'venues of other cities are not read');
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'cinex', city: 'Caracas' }).success, true);
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'cinex', city: 'Caracas', cinema_id: 'SBC' }).success, false);
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'cinex' }).success, false);
});

test('Cinex city showtimes keep reads within the per-origin limit, and a city with no readable venue is a failure', async () => {
  const epoch = String(Date.parse('2026-09-18T20:30:00-04:00') / 1000);
  const codes = ['AAA', 'BBB', 'CCC', 'DDD'];
  const directory = codes.map(code => card(code.toLowerCase(), code, `x${code}.jpg`)).join('');
  const venueServer = (venue: (code: string) => Promise<Response>) => new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/cines.html') return new Response(directory);
    if (url.pathname === '/assets/php/datasource.php') return Response.json({ data: [{ siglas: url.searchParams.get('cinemaid'), name: url.searchParams.get('cinemaid') }] });
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="x('sinopsis-film.html')" title="FILM"></div>`);
    const m = url.pathname.match(/^\/cinex-([a-z]+)\.html$/);
    return m ? venue(m[1].toUpperCase()) : new Response('missing', { status: 404 });
  }, 300);
  // Each venue page takes 200 ms against a 300 ms per-read deadline that includes queue time:
  // four reads started together would leave two waiting 200 ms in the queue and time them out.
  const slow = venueServer(async code => { await new Promise(r => setTimeout(r, 200)); return new Response(`<h3 class="title">${code}</h3><div class="sessionslist"><h5 class="title">FILM</h5><button onclick="checkLogin('${code}1','${code}')" alt="${epoch}"></button></div>`); });
  const r = await new CinemaService(slow, new CinexCinemaCatalog()).query('showtimes', { provider: 'cinex', city: 'Caracas', date: '2026-09-18' });
  assert.equal(r.partial, false, r.warnings.join(' | '));
  assert.deepEqual(r.items.map(i => i.cinema_id).sort(), codes);

  const down = venueServer(async () => new Response('down', { status: 503 }));
  const none = await new CinemaService(down, new CinexCinemaCatalog()).query('showtimes', { provider: 'cinex', city: 'Caracas', date: '2026-09-18' });
  assert.notEqual(none.status, 'empty', 'no venue was read, so there is no observed empty schedule');
  assert.equal(none.status, 'error');
  assert.ok(none.warnings.some(w => /4 sedes Cinex/.test(w)), none.warnings.join(' | '));
});

test('Cinex city showtimes fail, rather than report an empty city, when no venue code could be verified', async () => {
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/cines.html') return new Response('<a href="cinex-a.html" title="Cinex A, Caracas"><h3>A</h3></a>');
    return new Response('down', { status: 503 });
  });
  const s = new CinemaService(http, new CinexCinemaCatalog());
  const r = await s.query('showtimes', { provider: 'cinex', city: 'Caracas', date: '2026-11-04' });
  assert.equal(r.status, 'unavailable'); assert.equal(r.total, 0);
  assert.ok(r.warnings.some(w => /ninguna sede Cinex/.test(w)), r.warnings.join(' | '));
  const elsewhere = await s.query('showtimes', { provider: 'cinex', city: 'Maracay', date: '2026-11-04' });
  assert.equal(elsewhere.status, 'empty', 'a city without Cinex venues is a real empty answer');
});

test('one Cinex venue with an invalid item fails alone instead of emptying the city result', async () => {
  const epoch = (time: string) => String(Date.parse(`2026-09-18T${time}:00-04:00`) / 1000);
  const long = 'X'.repeat(513);
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/cines.html') return new Response(card('sambil', 'Sambil', 'xSBC.jpg') + card('lider', 'Lider', 'xLDR.jpg'));
    if (url.pathname === '/assets/php/datasource.php') {
      const id = url.searchParams.get('cinemaid');
      return Response.json({ data: [{ siglas: id, name: id === 'SBC' ? 'Sambil' : 'Lider' }] });
    }
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="x('sinopsis-clayface.html')" title="CLAYFACE"></div><div class="poster" onclick="x('sinopsis-long.html')" title="${long}"></div>`);
    if (url.pathname === '/cinex-sambil.html') return new Response(`<h3 class="title">SAMBIL</h3><div class="sessionslist"><h5 class="title">CLAYFACE</h5><button onclick="checkLogin('1','SBC')" alt="${epoch('20:30')}"></button></div>`);
    if (url.pathname === '/cinex-lider.html') return new Response(`<h3 class="title">LIDER</h3><div class="sessionslist"><h5 class="title">${long}</h5><button onclick="checkLogin('2','LDR')" alt="${epoch('21:00')}"></button></div>`);
    return new Response('missing', { status: 404 });
  });
  const venue = await new CinemaService(http, new CinexCinemaCatalog()).query('showtimes', { provider: 'cinex', cinema_id: 'LDR', date: '2026-09-18' });
  assert.equal(venue.status, 'error', 'the invalid item itself is still rejected');
  const r = await new CinemaService(http, new CinexCinemaCatalog()).query('showtimes', { provider: 'cinex', city: 'Caracas', date: '2026-09-18' });
  assert.equal(r.status, 'available', r.warnings.join(' | '));
  assert.deepEqual(r.items.map(i => [i.id, i.cinema_id]), [['1', 'SBC']]);
  assert.equal(r.partial, true);
  assert.ok(r.warnings.some(w => /1 sedes Cinex \(Lider\)/.test(w)), r.warnings.join(' | '));
});

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

test('a Cinex movie_id without a synopsis page is reported as a wrong ID, not as a film without functions', async () => {
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/sinopsis-clayface.html') return new Response('<h1>CLAYFACE</h1>');
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  const missing = await s.query('showtimes', { provider: 'cinex', movie_id: 'noexiste', date: '2026-09-18' });
  assert.equal(missing.status, 'unavailable');
  assert.ok(missing.warnings.some(w => /no tiene una ficha para ese movie_id; obtén un ID vigente con list_movies/.test(w)), missing.warnings.join(' | '));
  const empty = await s.query('showtimes', { provider: 'cinex', movie_id: 'clayface', date: '2026-09-18' });
  assert.equal(empty.status, 'unavailable');
  assert.ok(empty.warnings.some(w => /no lista funciones/.test(w)), empty.warnings.join(' | '));
});
