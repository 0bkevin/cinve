import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http/client.js';
import { inputSchema } from '../src/mcp/server.js';
import { mockFetch, EmptySessionStore } from './helpers/fixtures.js';

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
