import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http.js';
import { page, cpSessions } from './fixtures.js';

const cu = (html: string) => new CinemaService(new HttpClient(async () => new Response(html)));
const cq = { provider: 'cinesunidos' as const, city: 'Caracas' };

test('CU preserves good venues and named venues without usable codes despite malformed siblings', async () => {
  const r = await cu(page({ theaters: [null, { id: '1002', name: 'Good' }, { name: 'Missing ID' }, { id: '../bad', name: 'Unsafe ID' }] })).query('cinemas', cq);
  assert.equal(r.status, 'available'); assert.equal(r.total, 3); assert.equal(r.partial, true);
  assert.equal(r.items.find(i => i.name === 'Good')?.id, '1002');
  for (const name of ['Missing ID', 'Unsafe ID']) {
    const item = r.items.find(i => i.name === name)!;
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
  assert.equal(r.status, 'available'); assert.equal(r.items[0].city, 'Maturín');
  assert.ok(requests.some(u => u.includes('Matur%C3%ADn')));
  const missing = await s.query('cinemas', { ...cq, city: 'Atlantis' });
  assert.equal(missing.status, 'unavailable'); assert.match(missing.warnings.join(' '), /ciudad/i);
});
test('Cinepic retains both known venues when one site fails or changes its configuration ID', async () => {
  for (const broken of ['network', 'wrong-id']) {
    const s = new CinemaService(new HttpClient(async input => {
      if (String(input).includes('cinepiccandelaria')) return broken === 'network' ? new Response('offline', { status: 503 }) : new Response(page({ config: { idUltracine: '123301', nombre: 'Wrong venue' } }));
      return new Response(page({ config: { idUltracine: '123301', nombre: 'Cinepic VVIP' } }));
    }));
    const r = await s.query('cinemas', { provider: 'cinepic' });
    assert.equal(r.status, 'available'); assert.equal(r.total, 2); assert.equal(r.partial, true);
    assert.equal(r.items.find(i => i.id === '123301')?.code_status, 'verified');
    assert.equal(r.items.find(i => i.name === 'Cinepic Candelaria')?.code_status, 'unverified');
    const cities = await s.query('cities', { provider: 'cinepic' });
    assert.equal(cities.items[0].name, 'Caracas'); assert.equal(cities.partial, false);
  }
});

test('Cinepic configured cities return without probing either cinema website', async () => {
  let requests = 0;
  const s = new CinemaService(new HttpClient(async () => { requests++; return new Response('unexpected'); }));
  const result = await s.query('cities', { provider: 'cinepic' });
  assert.equal(result.status, 'available'); assert.deepEqual(result.items.map(item => item.name), ['Caracas']);
  assert.equal(requests, 0); assert.ok(result.warnings.some(w => /configurada/.test(w)));
});
test('Cinepic retains movie references when scheduled sessions lack movie metadata', async () => {
  const payload = structuredClone(cpSessions); payload.data.datos = [];
  const s = new CinemaService(new HttpClient(async () => Response.json(payload)));
  const q = { provider: 'cinepic' as const, cinema_id: '123300', date: '2026-09-18' };
  const r = await s.query('movies', q);
  assert.equal(r.total, 1); assert.equal(r.items[0].id, 'p1'); assert.equal(r.partial, true);
  assert.equal((await s.query('showtimes', q)).partial, true);
});
test('all providers block nonqueryable directory identifiers before network or authentication', async () => {
  let calls = 0;
  const s = new CinemaService(new HttpClient(async () => { calls++; throw new Error('Must not fetch'); }));
  for (const provider of ['cinesunidos', 'cinepic', 'cinex'] as const) {
    for (const op of ['prices', 'concessions', 'showtimes'] as const) {
      const r = await s.query(op, { provider, cinema_id: 'directory-unknown', city: 'Caracas', movie_id: 'm', session_id: 's' });
      assert.equal(r.status, 'unavailable'); assert.match(r.warnings.join(' '), /código/);
    }
  }
  assert.equal(calls, 0);
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
  assert.equal(first.items[0].id, again.items[0].id); assert.notEqual(first.items[0].id, next.items[0].id);
});
test('Cinepic keeps explicitly unverified known sites if both sites fail, without fabricating live sources', async () => {
  const s = new CinemaService(new HttpClient(async () => new Response('offline', { status: 503 })));
  const r = await s.query('cinemas', { provider: 'cinepic' });
  assert.equal(r.total, 2); assert.equal(r.partial, true); assert.equal(r.sources.length, 0);
  assert.ok(r.items.every(i => i.code_status === 'unverified' && i.cinema_id === undefined));
  assert.ok(r.warnings.some(w => w.includes('no hay descubrimiento automático')));
});
test('CU movie catalogs also combine component blocks rather than accepting the first empty list', async () => {
  const html = page({ movies: [] }) + page({ movies: [{ vistaId: 'M', title: 'Movie', theaters: [{ id: '1002', showTimes: [{ id: 'S', date: '2026-09-18T18:00:00' }] }] }] });
  const r = await cu(html).query('movies', { ...cq, date: '2026-09-18' });
  assert.equal(r.total, 1); assert.equal(r.items[0].id, 'M');
});
