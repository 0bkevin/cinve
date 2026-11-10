import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../../src/service.js';
import { CinexCinemaCatalog } from '../../src/providers/cinex/venues.js';
import { HttpClient } from '../../src/http/client.js';
import { outputSchema } from '../../src/core.js';
import { concessions, page } from '../helpers/fixtures.js';

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
  // The catalog read starts beside the venue's own chain.
  assert.deepEqual(requests.slice(-4), ['/cartelera.html', '/cinex-new.html', '/cines.html', '/cinex-recovery.html']);
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
  assert.deepEqual(requests, ['/cartelera.html', '/cines.html', '/cinex-sambil.html', '/cinex-sambilchacao.html']);
  assert.equal(first.sources.filter(source => source.url.endsWith('/cinex-sambilchacao.html')).length, 1);
  const beforeWarm = requests.length;
  await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18' });
  assert.deepEqual(requests.slice(beforeWarm), []);
  const beforeRefresh = requests.length;
  await s.query('showtimes', { provider: 'cinex', cinema_id: 'SBC', date: '2026-09-18', refresh: true });
  assert.deepEqual(requests.slice(beforeRefresh), ['/cartelera.html', '/cinex-sambilchacao.html']);
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
  assert.deepEqual(requests.slice(before), ['/cartelera.html', '/cinex-metropolisbarquisimeto.html']);
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
  assert.deepEqual(requests, ['/cartelera.html', '/cines.html', '/assets/php/datasource.php', '/cinex-real.html']);
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

test('a cancelled call does not make the shared Cinex catalog forget verified venues', async () => {
  const requests: string[] = [];
  let abortOnVenuePage: AbortController | undefined;
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response(card('sambil', 'Sambil', 'xSBC.jpg'));
    if (url.pathname === '/assets/php/datasource.php') return Response.json({ data: [{ siglas: 'SBC', name: 'Sambil' }] });
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="x('sinopsis-clayface.html')" title="CLAYFACE"></div>`);
    // No sessions on the page, so its code is confirmed by a metadata read.
    if (url.pathname === '/cinex-sambil.html') { abortOnVenuePage?.abort(); return new Response('<h3 class="title">SAMBIL</h3><div class="sessionslist"><h5 class="title">CLAYFACE</h5></div>'); }
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http, new CinexCinemaCatalog());
  const q = { provider: 'cinex' as const, cinema_id: 'SBC', date: '2026-09-18', refresh: true };
  assert.equal((await s.query('showtimes', q)).status, 'empty');
  abortOnVenuePage = new AbortController();
  const cancelled = await s.query('showtimes', q, { signal: abortOnVenuePage.signal });
  assert.ok(cancelled.warnings.some(w => /cancelada/.test(w)), cancelled.warnings.join(' | '));
  abortOnVenuePage = undefined; requests.length = 0;
  assert.equal((await s.query('showtimes', q)).status, 'empty');
  assert.ok(!requests.includes('/cines.html'), `the remembered venue URL must survive the cancellation; read: ${requests.join(', ')}`);
});

test('Cinex areas from list_cities include the venues the directory labels with their town', async () => {
  const directory = () => card('sotaventolaguaira', 'SOTAVENTO LA GUAIRA', 'xSTV.jpg', 'Maiquetía') + card('sambilparaguana', 'SAMBIL PARAGUANA', 'xSBP.jpg', 'Punto Fijo')
    + card('plazamayor', 'PLAZA MAYOR', 'x30.jpg', 'Lechería') + card('costamall', 'COSTA MALL', 'x39.jpg', 'Cabimas') + card('lagomall', 'LAGO MALL', 'xLMM.jpg', 'Maracaibo');
  const codes = { STV: [{ siglas: 'STV', name: 'SOTAVENTO LA GUAIRA' }], SBP: [{ siglas: 'SBP', name: 'SAMBIL PARAGUANA' }], '30': [{ siglas: '30', name: 'PLAZA MAYOR' }],
    '39': [{ siglas: '39', name: 'COSTA MALL' }], LMM: [{ siglas: 'LMM', name: 'LAGO MALL' }] };
  const { s } = service(directory, {}, codes);
  const names = async (city: string) => (await s.query('cinemas', { provider: 'cinex', city })).items.map(i => [i.name, i.city]);
  assert.deepEqual(await names('LA GUAIRA'), [['SOTAVENTO LA GUAIRA', 'Maiquetía']]);
  assert.deepEqual(await names('PARAGUANÁ'), [['SAMBIL PARAGUANA', 'Punto Fijo']]);
  assert.deepEqual(await names('LECHERÍAS'), [['PLAZA MAYOR', 'Lechería']]);
  assert.deepEqual((await names('MARACAIBO')).sort(), [['COSTA MALL', 'Cabimas'], ['LAGO MALL', 'Maracaibo']]);
  assert.deepEqual(await names('Punto Fijo'), [['SAMBIL PARAGUANA', 'Punto Fijo']], 'the town itself still works');
  const none = await s.query('cinemas', { provider: 'cinex', city: 'Atlantis' });
  assert.equal(none.total, 0); assert.ok(none.warnings.some(w => /Ninguna sede del directorio Cinex corresponde/.test(w)), none.warnings.join(' | '));
});

test('untrusted cinema detail href cannot change the requested route', async () => {
  let calls = 0;
  const service = new CinemaService(new HttpClient(async () => { calls++; return new Response('<a href="cinex-x/../../assets/php/action.php" title="Sede, Caracas"><h3>Sede</h3></a>'); }));
  const r = await service.query('cinemas', { provider: 'cinex' });
  assert.equal(calls, 1); assert.equal(r.partial, true); assert.equal(r.items.length, 0);
});

const epoch = (date: string, time = '18:00') => String(Date.parse(`${date}T${time}:00-04:00`) / 1000);

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

test('Cinex venue discovery checks its budget before each follow-up read of an admitted venue', async () => {
  const card = `<a href="cinex-a.html" title="Cinex A, Caracas"><img src="https://www.cinex.com.ve/assets/images/cinemas/xA.jpg"><h3>A</h3></a>`;
  const reads: string[] = [];
  const http = new HttpClient(async input => {
    const url = new URL(String(input)); reads.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response(card);
    await new Promise(r => setTimeout(r, 30));
    if (url.pathname === '/assets/php/datasource.php') return Response.json({ data: [] });
    return new Response('<h3 class="title">A</h3>');
  });
  const r = await new CinemaService(http, new CinexCinemaCatalog(10)).query('cinemas', { provider: 'cinex', city: 'Caracas' });
  assert.deepEqual(reads, ['/cines.html', '/assets/php/datasource.php'], 'no detail read after the budget is spent');
  assert.equal(r.partial, true); assert.equal(r.items[0].code_status, 'unverified');
  assert.ok(r.warnings.some(w => /tiempo de comprobación de A/.test(w)), r.warnings.join(' | '));
});
