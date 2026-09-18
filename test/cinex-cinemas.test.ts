import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http.js';
import { outputSchema } from '../src/core.js';

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
    '/cinex-lagomall.html': `<button onclick='checkLogin( "123", "LGM" )'></button>`,
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

test('a detail for a different cinema cannot assign its showtime code to a listed venue', async () => {
  const { s } = service(() => card('expected', 'Expected', 'unknown.jpg'), {
    '/cinex-expected.html': `<h3 class="title">OTHER CINEMA</h3><button onclick="checkLogin('session','BAD')"></button>`,
  });
  const result = await s.query('cinemas', { provider: 'cinex', city: 'Caracas' });
  assert.equal(result.total, 1); assert.equal(result.items[0].code_status, 'unverified');
  assert.equal(result.items[0].cinema_id, undefined);
});
