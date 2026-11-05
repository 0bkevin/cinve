import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { CinexCinemaCatalog } from '../src/cinex-cinemas.js';
import { HttpClient } from '../src/http.js';
import { outputSchema } from '../src/core.js';
import { inputSchema } from '../src/server.js';

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

test('all eight numeric image codes are verified against official cinema metadata', async () => {
  const names: Record<string, string> = { '39': 'Costa Mall', '38': 'Galerías Mall', '35': 'Marina Plaza', '30': 'Plaza Mayor', '32': 'Cima Plaza', '31': 'Alto Prado', '36': 'Virtudes', '34': 'Valera' };
  const { s, requests } = service(() => Object.entries(names).map(([code, name]) => card(code, name, `480x189x${code}.jpg.pagespeed.ic.test.jpg`)).join(''), {},
    Object.fromEntries(Object.entries(names).map(([code, name]) => [code, [{ siglas: code, name }]])));
  const result = await s.query('cinemas', { provider: 'cinex', city: 'Caracas' });
  assert.equal(result.total, 8); assert.equal(result.partial, false);
  for (const item of result.items) {
    assert.equal(item.cinema_id, item.id); assert.equal(item.code_status, 'verified'); assert.equal(item.directory_status, 'listed');
  }
  assert.equal(requests.some(url => /\/cinex-/.test(url)), false);
  assert.deepEqual(outputSchema('cinemas').parse(result).items, result.items);
});

test('missing, conflicting, and mismatched codes keep directory venues and cannot be sent upstream', async () => {
  const { s, requests } = service(() => card('missing', 'Missing', '39.jpg') + card('conflict', 'Conflict', '40.jpg'), {
    '/cinex-conflict.html': `<button onclick="checkLogin('s1','AAA')"></button><button onclick="checkLogin('s2','BBB')"></button>`,
  }, { '39': [{ siglas: '39', name: 'Another venue' }] });
  const result = await s.query('cinemas', { provider: 'cinex', city: 'Caracas' });
  assert.equal(result.status, 'available'); assert.equal(result.total, 2); assert.equal(result.partial, true);
  for (const item of result.items) {
    assert.equal(item.code_status, 'unverified'); assert.equal(item.cinema_id, undefined); assert.match(item.id, /^directory-/);
    const before = requests.length;
    for (const op of ['prices', 'concessions', 'showtimes'] as const) {
      const blocked = await s.query(op, { provider: 'cinex', cinema_id: item.id, movie_id: 'movie', session_id: 'session' });
      assert.equal(blocked.status, 'unavailable'); assert.match(blocked.warnings[0], /enlace oficial/);
    }
    assert.equal(requests.length, before);
  }
});

test('showtime fallback tolerates whitespace and double quotes while retaining existing codes', async () => {
  const { s } = service(() => card('lagomall', 'Lago Mall', 'xlagomall.webp'), {
    '/cinex-lagomall.html': `<h3 class="title">LAGO MALL</h3><button onclick='checkLogin( "123", "LGM" )'></button>`,
  });
  const result = await s.query('cinemas', { provider: 'cinex', city: 'Caracas' });
  assert.equal(result.items[0].id, 'LGM'); assert.equal(result.partial, false);
});

test('Metropolis is recovered from its official detail without inventing a code from its image', async () => {
  const { s } = service(() => card('tolon', 'Tolón', 'xtln.jpg'), {
    '/cinex-metropolisbarquisimeto.html': '<h3 class="title">METROPOLIS BARQUISIMETO</h3><img src="assets/images/cinemas/xmtb.jpg">',
  }, { TLN: [{ siglas: 'TLN', name: 'TOLON' }] });
  const result = await s.query('cinemas', { provider: 'cinex', city: 'Barquisimeto' });
  assert.equal(result.total, 1); assert.equal(result.items[0].directory_status, 'not_listed');
  assert.equal(result.items[0].code_status, 'unverified'); assert.equal(result.items[0].cinema_id, undefined);
  assert.equal(result.items[0].url, `${base}/cinex-metropolisbarquisimeto.html`);
});

test('discovery seed requires matching current page evidence and is deduplicated when listed', async () => {
  const { s } = service(() => card('tolon', 'Tolón', 'xtln.jpg'), {
    '/cinex-metropolisbarquisimeto.html': '<h3 class="title">OTHER CINEMA</h3>',
  });
  assert.equal((await s.query('cinemas', { provider: 'cinex', city: 'Barquisimeto' })).total, 0);
  const listed = service(() => card('metropolisbarquisimeto', 'METROPOLIS BARQUISIMETO', 'xmtb.jpg', 'Barquisimeto'), {});
  const result = await listed.s.query('cinemas', { provider: 'cinex' });
  assert.equal(result.total, 1); assert.equal(result.items[0].directory_status, 'listed');
});

test('refresh retains previously observed venues with explicit status, filters and pagination', async () => {
  let directory = card('first', 'Primera', '1.jpg') + card('second', 'Segunda', '2.jpg');
  const { s } = service(() => directory, {});
  await s.query('cinemas', { provider: 'cinex', city: 'Caracas' });
  directory = card('second', 'Segunda', '2.jpg');
  const result = await s.query('cinemas', { provider: 'cinex', city: 'Caracas', refresh: true, limit: 1 });
  assert.equal(result.total, 2); assert.equal(result.next_offset, 1);
  assert.equal(result.items[0].name, 'Primera'); assert.equal(result.items[0].directory_status, 'not_listed');
  assert.equal(result.sources.find(s => s.url.endsWith('/cines.html'))?.cached, false);
  const filtered = await s.query('cinemas', { provider: 'cinex', city: 'Caracas', query: 'segunda' });
  assert.equal(filtered.total, 1); assert.equal(filtered.items[0].directory_status, 'listed');
});

test('Cinex cinema query filters before detail and metadata resolution', async () => {
  const { s, requests } = service(
    () => card('sambil', 'Sambil Chacao', 'xsambil.jpg') + card('other', 'Otra Sede', 'xother.jpg'),
    { '/cinex-sambil.html': '<h3 class="title">SAMBIL CHACAO</h3><button onclick="checkLogin(\'s\',\'SAMBIL\')"></button>' },
  );
  const result = await s.query('cinemas', { provider: 'cinex', query: 'sambil' });
  assert.equal(result.total, 1); assert.equal(result.items[0].name, 'Sambil Chacao');
  assert.equal(requests.filter(url => /cinex-other/.test(url)).length, 0);
});

test('a detail for a different cinema cannot assign its showtime code to a listed venue', async () => {
  const { s } = service(() => card('expected', 'Expected', 'unknown.jpg'), {
    '/cinex-expected.html': `<h3 class="title">OTHER CINEMA</h3><button onclick="checkLogin('session','BAD')"></button>`,
  });
  const result = await s.query('cinemas', { provider: 'cinex', city: 'Caracas' });
  assert.equal(result.total, 1); assert.equal(result.items[0].code_status, 'unverified');
  assert.equal(result.items[0].cinema_id, undefined);
});

test('a detail code without a matching identity title remains unverified', async () => {
  const { s } = service(() => card('expected', 'Expected', 'unknown.jpg'), {
    '/cinex-expected.html': `<button onclick="checkLogin('session','BAD')"></button>`,
  });
  const result = await s.query('cinemas', { provider: 'cinex', city: 'Caracas' });
  assert.equal(result.total, 1); assert.equal(result.partial, true);
  assert.equal(result.items[0].code_status, 'unverified'); assert.equal(result.items[0].cinema_id, undefined);
});

test('refresh never reuses a remembered code when current metadata fails and detail identity conflicts', async () => {
  let phase = 0;
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response(card('expected', 'Expected', 'xSBC.jpg'));
    if (url.pathname === '/assets/php/datasource.php') return phase === 0
      ? Response.json({ data: [{ siglas: 'SBC', name: 'Expected' }] })
      : Response.json({ data: [] });
    if (url.pathname === '/cinex-expected.html') return phase === 0
      ? new Response('<h3 class="title">EXPECTED</h3><button onclick="checkLogin(\'s\',\'SBC\')"></button>')
      : new Response('<button onclick="checkLogin(\'s\',\'BAD\')"></button>');
    return new Response('missing', { status: 404 });
  });
  const catalog = new CinexCinemaCatalog();
  const make = () => new CinemaService(http, catalog);
  const first = await make().query('cinemas', { provider: 'cinex', city: 'Caracas', refresh: true });
  assert.equal(first.items[0].cinema_id, 'SBC');
  phase = 1;
  const before = requests.length;
  const second = await make().query('cinemas', { provider: 'cinex', city: 'Caracas', refresh: true });
  assert.equal(second.items[0].code_status, 'unverified');
  assert.equal(second.items[0].cinema_id, undefined);
  assert.ok(requests.slice(before).includes('/cinex-expected.html'));
});

test('a seed without a matching title is not retained as a known venue', async () => {
  let detailReads = 0;
  const http = new HttpClient(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/cines.html') return new Response(card('tolon', 'Tolón', 'xtln.jpg'));
    if (path === '/cinex-metropolisbarquisimeto.html') {
      detailReads++;
      return new Response('<button onclick="checkLogin(\'s\',\'BAD\')"></button>');
    }
    return new Response('missing', { status: 404 });
  });
  const catalog = new CinexCinemaCatalog();
  const make = () => new CinemaService(http, catalog);
  assert.equal((await make().query('cinemas', { provider: 'cinex', city: 'Barquisimeto', refresh: true })).total, 0);
  assert.equal((await make().query('cinemas', { provider: 'cinex', city: 'Barquisimeto', refresh: true })).total, 0);
  assert.equal(detailReads, 2);
});

test('remembered metadata proof cannot authorize an empty schedule after refresh', async () => {
  let phase = 0;
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/cines.html') return new Response(card('expected', 'Expected', 'xSBC.jpg'));
    if (url.pathname === '/assets/php/datasource.php') return phase === 0
      ? Response.json({ data: [{ siglas: 'SBC', name: 'Expected' }] })
      : Response.json({ data: [] });
    if (url.pathname === '/cinex-expected.html') return phase === 0
      ? new Response('<h3 class="title">EXPECTED</h3>')
      : new Response('<div class="sessionslist"></div>');
    return new Response('missing', { status: 404 });
  });
  const catalog = new CinexCinemaCatalog();
  const make = () => new CinemaService(http, catalog);
  const first = await make().query('cinemas', { provider: 'cinex', city: 'Caracas', refresh: true });
  assert.equal(first.items[0].cinema_id, 'SBC');
  phase = 1;
  const result = await make().query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18', refresh: true });
  assert.equal(result.status, 'unavailable');
});

test('refresh adopts a new current URL and targeted rediscovery recovers a stale remembered URL', async () => {
  let directory = card('old', 'Expected', 'xSBC.jpg');
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response(directory);
    if (url.pathname === '/assets/php/datasource.php') return Response.json({ data: [{ siglas: 'SBC', name: 'Expected' }] });
    if (url.pathname === '/cinex-recovery.html') return new Response(`<h3 class="title">EXPECTED</h3><div class="sessionslist"><h5 class="title">MOVIE</h5><button onclick="checkLogin('s1','SBC')" alt="1789751400"></button></div>`);
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="posterMovieClick('M','MOVIE','0','x','A','sinopsis-m.html','CARTELERA')" title="MOVIE"></div>`);
    return new Response('gone', { status: 404 });
  });
  const catalog = new CinexCinemaCatalog();
  const make = () => new CinemaService(http, catalog);
  const first = await make().query('cinemas', { provider: 'cinex', city: 'Caracas', refresh: true });
  assert.equal(first.items[0].cinema_id, 'SBC');

  directory = card('new', 'Expected', 'xSBC.jpg');
  const beforeRefresh = requests.length;
  const refreshed = await make().query('cinemas', { provider: 'cinex', city: 'Caracas', refresh: true });
  assert.equal(refreshed.items.find(item => item.directory_status === 'listed')?.cinema_id, 'SBC');
  assert.equal(refreshed.items.find(item => item.directory_status === 'not_listed')?.code_status, 'unverified');
  assert.deepEqual(requests.slice(beforeRefresh), ['/cines.html', '/assets/php/datasource.php']);

  directory = card('recovery', 'Expected', 'xSBC.jpg');
  const recovered = await make().query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18', refresh: true });
  assert.equal(recovered.status, 'available'); assert.equal(recovered.total, 1);
  assert.deepEqual(requests.slice(-4), ['/cinex-new.html', '/cines.html', '/cinex-recovery.html', '/cartelera.html']);
});

test('large Cinex directories have bounded discovery work while name filtering remains effective', async () => {
  const count = 125, requests: string[] = [];
  const directory = Array.from({ length: count }, (_, i) => card(`venue-${i}`, `Venue ${i}`, 'unknown.jpg')).join('');
  const http = new HttpClient(async input => {
    const path = new URL(String(input)).pathname; requests.push(path);
    if (path === '/cines.html') return new Response(directory);
    const match = path.match(/^\/cinex-venue-(\d+)\.html$/);
    if (match) return new Response(`<h3 class="title">VENUE ${match[1]}</h3><button onclick="checkLogin('s','C${match[1]}')"></button>`);
    return new Response('missing', { status: 404 });
  });
  const serviceForTest = new CinemaService(http);
  const bounded = await serviceForTest.query('cinemas', { provider: 'cinex', city: 'Caracas', limit: 1 });
  assert.equal(bounded.total, 100); assert.equal(bounded.next_offset, 1); assert.equal(bounded.partial, true);
  assert.equal(requests.filter(path => path.startsWith('/cinex-')).length, 100);
  assert.ok(bounded.warnings.some(w => /limitaron|parcial/.test(w)));

  requests.length = 0;
  const searched = await serviceForTest.query('cinemas', { provider: 'cinex', city: 'Caracas', query: 'Venue 124', refresh: true });
  assert.equal(searched.total, 1); assert.equal(searched.items[0].name, 'Venue 124'); assert.equal(searched.partial, false);
  assert.deepEqual(requests.filter(path => path.startsWith('/cinex-')), ['/cinex-venue-124.html']);
});

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
  assert.deepEqual(requests, ['/cines.html', '/cinex-sambil.html', '/cartelera.html']);

  const cached = await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18', offset: 0, limit: 1 });
  assert.equal(cached.total, 2); assert.equal(requests.length, 3);
  const fresh = await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18', refresh: true });
  assert.equal(fresh.total, 2); assert.equal(requests.length, 5);
  assert.equal(fresh.sources.find(source => source.url.endsWith('/cinex-sambil.html'))?.cached, false);
});

test('Cinex remembers the canonical cinema URL after a redirect without fetching it twice in one call', async () => {
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const path = new URL(String(input)).pathname; requests.push(path);
    if (path === '/cines.html') return new Response(card('sambil', 'Sambil Chacao', '480x189xsbc.jpg'));
    if (path === '/cinex-sambil.html') return new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } });
    if (path === '/cinex-sambilchacao.html') return new Response(`<h3 class="title">SAMBIL CHACAO</h3><div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','SBC')" alt="1789751400"></button></div>`);
    if (path === '/cartelera.html') return new Response(`<div class="poster" onclick="posterMovieClick('M','KNOWN','0','x','A','sinopsis-known.html','CARTELERA')" title="KNOWN"></div>`);
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  const first = await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18' });
  assert.equal(first.status, 'available'); assert.equal(first.total, 1);
  assert.deepEqual(requests, ['/cines.html', '/cinex-sambil.html', '/cinex-sambilchacao.html', '/cartelera.html']);
  assert.equal(first.sources.filter(source => source.url.endsWith('/cinex-sambilchacao.html')).length, 1);
  const beforeWarm = requests.length;
  await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18' });
  assert.deepEqual(requests.slice(beforeWarm), []);
  const beforeRefresh = requests.length;
  await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18', refresh: true });
  assert.deepEqual(requests.slice(beforeRefresh), ['/cinex-sambilchacao.html', '/cartelera.html']);
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

test('Cinex verified unlisted/detail codes survive a separate service through a shared bounded catalog', async () => {
  const catalog = new CinexCinemaCatalog();
  const detail = `<h3 class="title">METROPOLIS BARQUISIMETO</h3><div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','MTB')" alt="1789751400"></button></div>`;
  const directory = card('listed', 'Listed', 'xlisted.jpg', 'Caracas');
  const catalogHtml = `<div class="poster" onclick="posterMovieClick('M','KNOWN','0','x','A','sinopsis-known.html','CARTELERA')" title="KNOWN"></div>`;
  const requests: string[] = [];
  const make = () => new CinemaService(new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response(directory);
    if (url.pathname === '/cinex-metropolisbarquisimeto.html') return new Response(detail);
    if (url.pathname === '/cartelera.html') return new Response(catalogHtml);
    return new Response('missing', { status: 404 });
  }), catalog);
  const discovered = await make().query('cinemas', { provider: 'cinex', city: 'Barquisimeto' });
  assert.equal(discovered.total, 1); assert.equal(discovered.items[0].cinema_id, 'MTB');
  assert.equal(discovered.items[0].directory_status, 'not_listed');
  const before = requests.length;
  const showtimes = await make().query('showtimes', { provider: 'cinex', cinema_id: 'MTB', date: '2026-09-18' });
  assert.equal(showtimes.status, 'available'); assert.equal(showtimes.total, 1);
  assert.deepEqual(requests.slice(before), ['/cinex-metropolisbarquisimeto.html', '/cartelera.html']);
  assert.equal(requests.slice(before).includes('/cines.html'), false);
});

test('Cinex cold resolution uses one requested metadata name when the image code differs', async () => {
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response(card('real', 'Real Cinema', '480x189xwrong.jpg'));
    if (url.pathname === '/assets/php/datasource.php') return Response.json({ data: [{ siglas: 'ACTUAL', name: 'Real Cinema' }] });
    if (url.pathname === '/cinex-real.html') return new Response(`<h3 class="title">REAL CINEMA</h3><div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','ACTUAL')" alt="1789751400"></button></div>`);
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="posterMovieClick('M','KNOWN','0','x','A','sinopsis-known.html','CARTELERA')" title="KNOWN"></div>`);
    return new Response('missing', { status: 404 });
  });
  const result = await new CinemaService(http).query('showtimes', { provider: 'cinex', cinema_id: 'ACTUAL', date: '2026-09-18' });
  assert.equal(result.status, 'available'); assert.equal(result.total, 1);
  assert.deepEqual(requests, ['/cines.html', '/assets/php/datasource.php', '/cinex-real.html', '/cartelera.html']);
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

test('Cinex does not accept an image-only code when an empty schedule lacks metadata confirmation', async () => {
  const { s } = service(
    () => card('x', 'X Cinema', '480x189xxx.jpg'),
    { '/cinex-x.html': '<h3 class="title">X CINEMA</h3><img src="assets/images/cinemas/480x189xxx.jpg">',
      '/cartelera.html': `<div class="poster" onclick="posterMovieClick('M','KNOWN','0','x','A','sinopsis-known.html','CARTELERA')" title="KNOWN"></div>` },
  );
  const result = await s.query('showtimes', { provider: 'cinex', cinema_id: 'XX', date: '2026-09-18' });
  assert.equal(result.status, 'unavailable'); assert.match(result.warnings.join(' '), /confirmó el código/);
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
