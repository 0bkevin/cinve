import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http/client.js';
import { inputSchema } from '../src/mcp/server.js';
import { mockFetch, EmptySessionStore, cpBuy, concessions, page } from './helpers/fixtures.js';

const service = () => new CinemaService(new HttpClient(mockFetch, 15000, new EmptySessionStore()));

test('empty candy is distinct from auth-required providers', async () => {
  const s = service();
  const empty = await s.query('concessions', { provider: 'cinepic', cinema_id: '123300' });
  const auth = await s.query('prices', { provider: 'cinesunidos', cinema_id: '1002', session_id: 's1' });
  assert.equal(empty.status, 'empty'); assert.equal(auth.status, 'auth_required');
  assert.equal(empty.sources.length, 1);
  assert.equal(empty.sources[0].url, 'https://api.cinexo.com.ar/api/complejo/123300/candy');
});

test('pagination is stable with total, offset and accent-insensitive filtering', async () => {
  const s = service(), q = { provider: 'cinesunidos' as const, limit: 1 };
  const one = await s.query('cities', q), two = await s.query('cities', { ...q, offset: 1 });
  assert.equal(one.total, 2); assert.equal(one.next_offset, 1); assert.equal(two.next_offset, null);
  assert.notEqual(one.items[0].id, two.items[0].id);
  assert.equal((await s.query('cities', { ...q, query: 'merida' })).items[0].name, 'Mérida');
});

test('refresh survives tool validation and reaches every public source read', async () => {
  let calls = 0;
  const s = new CinemaService(new HttpClient(async () => new Response(JSON.stringify([`City ${++calls}`]))));
  const q = inputSchema('cities').parse({ provider: 'cinesunidos', refresh: true });
  const first = await s.query('cities', q), second = await s.query('cities', q);
  assert.equal(first.items[0].name, 'City 1'); assert.equal(second.items[0].name, 'City 2');
  assert.equal(second.sources[0].cached, false);
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

test('malformed conversion cannot escape the structured result handler, even off the requested page', async () => {
  const data = structuredClone(cpBuy); data.configData.tasaConversion = '1e-320';
  const service = new CinemaService(new HttpClient(async () => new Response(page(data))));
  const r = await service.query('prices', { provider: 'cinepic', cinema_id: '123300', movie_id: 'p1', session_id: 'f1', offset: 100 });
  assert.equal(r.status, 'error'); assert.deepEqual(r.items, []); assert.equal(r.total, 0);
});

test('unsafe upstream links are omitted without losing useful product data', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'https://secret@example.test/image', 'file:///etc/passwd']) {
    const data = structuredClone(concessions).map(r => ({ ...r, itemImageUrl: url }));
    const service = new CinemaService(new HttpClient(async () => new Response(JSON.stringify(data))));
    const r = await service.query('concessions', { provider: 'cinesunidos', cinema_id: '1002' });
    assert.equal(r.status, 'available'); assert.ok(r.items.every(i => i.image_url === undefined));
    assert.equal(JSON.stringify(r).includes(url), false); assert.ok(r.warnings.some(w => w.includes('HTTPS')));
  }
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
