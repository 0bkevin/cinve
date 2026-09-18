import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import { DataError } from '../src/core.js';

const origin = 'https://gateway.cinesunidos.com';
test('cache deduplicates concurrent requests and preserves original fetch time', async () => {
  let count = 0;
  const http = new HttpClient(async () => { count++; return new Response('[]'); });
  const [one, two] = await Promise.all([http.get(origin + '/search/cities'), http.get(origin + '/search/cities')]);
  const cached = await http.get(origin + '/search/cities');
  assert.equal(count, 1); assert.equal(cached.source.cached, true);
  assert.equal(one.source.fetched_at, cached.source.fetched_at); assert.equal(one.body, two.body);
});
test('bounds upstream concurrency and uses public channel with no cookies', async () => {
  let active = 0, max = 0;
  const http = new HttpClient(async (_, init) => {
    active++; max = Math.max(max, active);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('xChannel'), 'www'); assert.equal(headers.get('cookie'), null);
    assert.equal(init?.redirect, 'manual');
    await new Promise(r => setTimeout(r, 10)); active--; return new Response('[]');
  });
  await Promise.all(Array.from({ length: 8 }, (_, i) => http.get(origin + '/read/' + i)));
  assert.equal(max, 2);
});
test('rejects arbitrary origins before making requests', async () => {
  let called = false;
  const http = new HttpClient(async () => { called = true; return new Response(''); });
  await assert.rejects(http.get('http://127.0.0.1/'), DataError);
  await assert.rejects(http.get('https://www.cinesunidos.com:8443/'), DataError);
  assert.equal(called, false);
});
test('429/auth errors are explicit and never cached as successful empty lists', async () => {
  let count = 0;
  const http = new HttpClient(async () => { count++; return new Response('', { status: 429 }); });
  for (let i = 0; i < 2; i++) await assert.rejects(http.get(origin + '/test'), (e: unknown) => e instanceof DataError && e.status === 'rate_limited');
  assert.equal(count, 2);
});
test('oversize response is cancelled', async () => {
  const http = new HttpClient(async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(http.get(origin + '/large'), /demasiado grande/);
});

test('refresh bypasses warm cache, requests revalidation and never falls back on failure', async () => {
  let count = 0;
  const http = new HttpClient(async (_, init) => {
    count++;
    if (count > 1) assert.equal(new Headers(init?.headers).get('Cache-Control'), 'no-cache');
    if (count === 3) return new Response('', { status: 503 });
    return new Response(String(count));
  });
  await http.get(origin + '/fresh');
  assert.equal((await http.get(origin + '/fresh')).source.cached, true);
  const fresh = await http.get(origin + '/fresh', 120000, true);
  assert.equal(fresh.body, '2'); assert.equal(fresh.source.cached, false);
  await assert.rejects(http.get(origin + '/fresh', 120000, true));
  assert.equal(count, 3);
});

test('Cinex ticket migration preserves IDs, credentials, deadline and final source without caching', async () => {
  const { SessionStore } = await import('../src/auth.js');
  const source = 'https://www.cinex.com.ve/boletos.php?sessionid=23062&cinemaid=SBC';
  const target = 'https://www.cinex.com.ve/boletosdev.php?cinemaid=SBC&sessionid=23062';
  const authorized: string[] = [], signals: Array<AbortSignal | null | undefined> = [];
  class Store extends SessionStore {
    override async headers(_provider: 'cinex' | 'cinesunidos', url: string) {
      authorized.push(url); return { Cookie: `session=${authorized.length}` };
    }
  }
  const http = new HttpClient(async (url, init) => {
    signals.push(init?.signal);
    assert.equal(new Headers(init?.headers).get('Cookie'), `session=${authorized.length}`);
    assert.equal(init?.redirect, 'manual');
    return String(url) === source ? new Response(null, { status: 302, headers: { Location: target } }) : new Response('prices');
  }, 1000, new Store());
  const page = await http.getAuthenticated('cinex', source);
  assert.equal(page.body, 'prices'); assert.equal(page.source.url, target); assert.equal(page.source.cached, false);
  assert.deepEqual(authorized, [source, target]); assert.equal(signals[0], signals[1]);
  await http.getAuthenticated('cinex', source); assert.equal(authorized.length, 4);
});

test('Cinex ticket redirects cannot change identity, escape the route or loop', async () => {
  const { SessionStore } = await import('../src/auth.js');
  class Store extends SessionStore { override async headers() { return { Cookie: 'SYNTHETIC' }; } }
  const source = 'https://www.cinex.com.ve/boletos.php?sessionid=23062&cinemaid=SBC';
  for (const destination of [
    'https://evil.test/boletosdev.php?cinemaid=SBC&sessionid=23062',
    '/boletosdev.php?cinemaid=TLN&sessionid=23062', '/boletosdev.php?cinemaid=SBC&sessionid=other',
    '/boletosdev.php?cinemaid=SBC&sessionid=23062&extra=1', '/boletosdev.php?cinemaid=SBC&sessionid=23062&sessionid=23062',
    '/boletosdev.php?cinemaid=SBC&sessionid=23062#fragment', '/pago.php',
    'https://user:secret@www.cinex.com.ve/boletosdev.php?cinemaid=SBC&sessionid=23062',
  ]) {
    let calls = 0;
    const http = new HttpClient(async () => { calls++; return new Response(null, { status: 302, headers: { Location: destination } }); }, 1000, new Store());
    await assert.rejects(http.getAuthenticated('cinex', source), e => e instanceof DataError && e.status === 'unavailable');
    assert.equal(calls, 1);
  }
  let calls = 0;
  const loop = new HttpClient(async () => { calls++; return new Response(null, { status: 302, headers: { Location: '/boletosdev.php?cinemaid=SBC&sessionid=23062' } }); }, 1000, new Store());
  await assert.rejects(loop.getAuthenticated('cinex', source), e => e instanceof DataError && e.status === 'unavailable');
  assert.equal(calls, 2);
});
