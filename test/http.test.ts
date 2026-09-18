import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, ReadContext } from '../src/http.js';
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

test('normal reads started during refresh never repopulate cache after refresh success or failure', async () => {
  for (const failed of [false, true]) {
    let calls = 0, releaseRefresh!: () => void, refreshStarted!: () => void, releaseNormal!: () => void, normalStarted!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const refreshReady = new Promise<void>(resolve => { refreshStarted = resolve; });
    const normalGate = new Promise<void>(resolve => { releaseNormal = resolve; });
    const normalReady = new Promise<void>(resolve => { normalStarted = resolve; });
    const http = new HttpClient(async (_url, init) => {
      const call = ++calls;
      if (call === 1) {
        assert.equal(new Headers(init?.headers).get('cache-control'), 'no-cache');
        refreshStarted(); await refreshGate;
        return failed ? new Response('refresh failed', { status: 503 }) : new Response('fresh refresh');
      }
      normalStarted(); await normalGate;
      return new Response('overlapping normal read');
    }, 1000);

    const refresh = http.get(origin + '/overlap-' + failed, 120000, true);
    await refreshReady;
    const normal = http.get(origin + '/overlap-' + failed);
    await normalReady;
    releaseRefresh();
    if (failed) await assert.rejects(refresh, e => e instanceof DataError && e.status === 'error');
    else assert.equal((await refresh).body, 'fresh refresh');
    releaseNormal();
    assert.equal((await normal).body, 'overlapping normal read');

    const after = http.get(origin + '/overlap-' + failed);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 3, 'the overlapping normal response must not be served from cache');
    assert.equal((await after).source.cached, false);
  }
});

test('cold aliases discovered after refresh completion cannot repopulate the canonical cache', async () => {
  const oldAlias = 'https://www.cinex.com.ve/cinex-old.html';
  const canonical = 'https://www.cinex.com.ve/cinex-new.html';
  for (const failed of [false, true]) {
    let calls = 0, releaseRefresh!: () => void, refreshStarted!: () => void, releaseAlias!: () => void, aliasStarted!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const refreshReady = new Promise<void>(resolve => { refreshStarted = resolve; });
    const aliasGate = new Promise<void>(resolve => { releaseAlias = resolve; });
    const aliasReady = new Promise<void>(resolve => { aliasStarted = resolve; });
    const http = new HttpClient(async url => {
      const target = String(url), call = ++calls;
      if (call === 1) {
        assert.equal(target, canonical);
        refreshStarted(); await refreshGate;
        return failed ? new Response('refresh failed', { status: 503 }) : new Response('fresh canonical');
      }
      if (call === 2) {
        assert.equal(target, oldAlias);
        aliasStarted(); await aliasGate;
        return new Response(null, { status: 302, headers: { Location: canonical } });
      }
      assert.equal(target, canonical);
      return call === 3 ? new Response('late alias body') : new Response('post-refresh canonical');
    }, 1000);

    const refresh = http.get(canonical, 120000, true);
    await refreshReady;
    const normal = http.get(oldAlias);
    await aliasReady;
    releaseRefresh();
    if (failed) await assert.rejects(refresh, e => e instanceof DataError && e.status === 'error');
    else assert.equal((await refresh).body, 'fresh canonical');
    releaseAlias();
    assert.equal((await normal).body, 'late alias body');

    const after = await http.get(canonical);
    assert.equal(after.body, 'post-refresh canonical');
    assert.equal(after.source.cached, false, 'the late alias response must be refetched, not served from cache');
    assert.equal(calls, 4, 'refresh completion must invalidate a cold alias read discovered afterward');
  }
});

test('canonical refresh protects cached old aliases from overlapping stale writes', async () => {
  const oldAlias = 'https://www.cinex.com.ve/cinex-sambil.html';
  const canonical = 'https://www.cinex.com.ve/cinex-sambilchacao.html';
  for (const failed of [false, true]) {
    let warming = true, calls = 0, releaseRefresh!: () => void, refreshStarted!: () => void, releaseNormal!: () => void, normalStarted!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const refreshReady = new Promise<void>(resolve => { refreshStarted = resolve; });
    const normalGate = new Promise<void>(resolve => { releaseNormal = resolve; });
    const normalReady = new Promise<void>(resolve => { normalStarted = resolve; });
    const http = new HttpClient(async url => {
      const call = ++calls, target = String(url);
      if (warming) return target === oldAlias
        ? new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } })
        : new Response('warm canonical');
      if (call === 1) {
        assert.equal(target, canonical); refreshStarted(); await refreshGate;
        return failed ? new Response('refresh failed', { status: 503 }) : new Response('fresh canonical');
      }
      if (call === 2) {
        assert.equal(target, oldAlias);
        return new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } });
      }
      if (call === 3) {
        assert.equal(target, canonical); normalStarted(); await normalGate;
        return new Response('stale alias response');
      }
      return new Response('post-refresh response');
    }, 1000);

    await http.get(oldAlias); assert.equal((await http.get(canonical)).source.cached, true);
    warming = false; calls = 0;
    const refresh = http.get(canonical, 120000, true);
    await refreshReady;
    const normal = http.get(oldAlias);
    await normalReady;
    releaseRefresh();
    if (failed) await assert.rejects(refresh, e => e instanceof DataError && e.status === 'error');
    else assert.equal((await refresh).body, 'fresh canonical');
    releaseNormal();
    assert.equal((await normal).body, 'stale alias response');
    const after = await http.get(canonical);
    assert.equal(after.body, 'post-refresh response');
    assert.equal(after.source.cached, false);
    assert.equal(calls, 4, 'the old alias response must not repopulate canonical cache');
  }
});

test('old-alias refresh invalidates a canonical read begun before delayed redirect discovery', async () => {
  const oldAlias = 'https://www.cinex.com.ve/cinex-sambil.html';
  const canonical = 'https://www.cinex.com.ve/cinex-sambilchacao.html';
  for (const failed of [false, true]) {
    let warming = true, calls = 0, releaseRedirect!: () => void, redirectStarted!: () => void, releaseNormal!: () => void, normalStarted!: () => void;
    const redirectGate = new Promise<void>(resolve => { releaseRedirect = resolve; });
    const redirectReady = new Promise<void>(resolve => { redirectStarted = resolve; });
    const normalGate = new Promise<void>(resolve => { releaseNormal = resolve; });
    const normalReady = new Promise<void>(resolve => { normalStarted = resolve; });
    const http = new HttpClient(async url => {
      const call = ++calls, target = String(url);
      if (warming) return target === oldAlias
        ? new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } })
        : new Response('warm canonical');
      if (call === 1) {
        assert.equal(target, oldAlias); redirectStarted(); await redirectGate;
        return new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } });
      }
      if (call === 2) {
        assert.equal(target, canonical); normalStarted(); await normalGate;
        return new Response('canonical overlap');
      }
      return call === 3 && failed ? new Response('refresh failed', { status: 503 }) : call === 3 ? new Response('fresh after discovery') : new Response('post-refresh response');
    }, 1000);

    await http.get(oldAlias); assert.equal((await http.get(canonical)).source.cached, true);
    warming = false; calls = 0;
    const refresh = http.get(oldAlias, 120000, true);
    await redirectReady;
    const normal = http.get(canonical);
    await normalStarted;
    releaseRedirect();
    releaseNormal();
    assert.equal((await normal).body, 'canonical overlap');
    if (failed) await assert.rejects(refresh, e => e instanceof DataError && e.status === 'error');
    else assert.equal((await refresh).body, 'fresh after discovery');
    const after = await http.get(canonical);
    assert.equal(after.source.cached, false);
    assert.equal(calls, 4, 'the canonical overlap must not survive refresh completion');
  }
});

test('refresh bookkeeping is released after repeated success and failure', async () => {
  let fail = false;
  const http = new HttpClient(async () => fail ? new Response('refresh failed', { status: 503 }) : new Response('fresh'));
  for (let i = 0; i < 128; i++) {
    fail = i % 2 === 1;
    if (fail) await assert.rejects(http.get(origin + '/bookkeeping', 120000, true));
    else await http.get(origin + '/bookkeeping', 120000, true);
  }
  const internals = http as unknown as { refreshing: Map<string, number>; pending: Map<string, unknown>; pendingKeys: Map<unknown, unknown> };
  assert.equal(internals.refreshing.size, 0);
  assert.equal(internals.pending.size, 0);
  assert.equal(internals.pendingKeys.size, 0);
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

test('authenticated provenance deduplicates by final canonical URL after migration', async () => {
  const { SessionStore } = await import('../src/auth.js');
  const source = 'https://www.cinex.com.ve/boletos.php?sessionid=23062&cinemaid=SBC';
  const target = 'https://www.cinex.com.ve/boletosdev.php?cinemaid=SBC&sessionid=23062';
  class Store extends SessionStore { override async headers() { return { Cookie: 'SYNTHETIC' }; } }
  const http = new HttpClient(async url => String(url) === source
    ? new Response(null, { status: 302, headers: { Location: target } })
    : new Response('prices'), 1000, new Store());
  const context = new ReadContext(http);
  await context.authenticated('cinex', source);
  await context.authenticated('cinex', source);
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0].url, target);
});

test('configured deadline covers injected request, authorization and response-body stalls', async () => {
  const never = <T>() => new Promise<T>(() => {});
  let requests = 0;
  const stalledRequest = new HttpClient(async () => { requests++; return never<Response>(); }, 20);
  await assert.rejects(stalledRequest.get(origin + '/request-stall'), e => e instanceof DataError && /plazo total/.test(e.message));
  await assert.rejects(stalledRequest.get(origin + '/request-stall-again'), e => e instanceof DataError && /plazo total/.test(e.message));
  assert.equal(requests, 2, 'a timed-out request must release its active slot');

  const { SessionStore } = await import('../src/auth.js');
  class StalledStore extends SessionStore { override async headers() { return never<Record<string, string>>(); } }
  const stalledHeaders = new HttpClient(async () => new Response('must not reach transport'), 20, new StalledStore());
  await assert.rejects(stalledHeaders.getAuthenticated('cinesunidos', 'https://gateway.cinesunidos.com/tickets/www/theaters/1005/sessions/s1/'), e => e instanceof DataError && /plazo total/.test(e.message));

  const stalledBody = new ReadableStream<Uint8Array>({
    start() {}, cancel() { return never<void>(); },
  });
  const stalledResponse = new HttpClient(async () => new Response(stalledBody), 20);
  await assert.rejects(stalledResponse.get(origin + '/body-stall'), e => e instanceof DataError && /plazo total/.test(e.message));
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

test('public Cinex reads follow one same-origin cinema-page rename and preserve canonical provenance', async () => {
  const source = 'https://www.cinex.com.ve/cinex-sambil.html';
  const target = 'https://www.cinex.com.ve/cinex-sambilchacao.html';
  let calls = 0;
  const http = new HttpClient(async url => {
    calls++;
    return String(url) === source
      ? new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } })
      : new Response('canonical cinema page');
  });
  const page = await http.get(source);
  assert.equal(page.body, 'canonical cinema page'); assert.equal(page.source.url, target); assert.equal(calls, 2);
});

test('public Cinex redirect aliases reuse one bounded cache entry and refresh the official old URL', async () => {
  const source = 'https://www.cinex.com.ve/cinex-sambil.html';
  const target = 'https://www.cinex.com.ve/cinex-sambilchacao.html';
  let calls = 0;
  const http = new HttpClient(async url => {
    calls++;
    return String(url) === source
      ? new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } })
      : new Response(`canonical-${calls}`);
  });
  const first = await http.get(source);
  const canonical = await http.get(target);
  assert.equal(calls, 2);
  assert.equal(canonical.source.cached, true);
  assert.equal(canonical.source.url, target);
  assert.equal(canonical.source.fetched_at, first.source.fetched_at);
  assert.equal((await http.get(source)).source.cached, true);

  const refreshed = await http.get(source, 120000, true);
  assert.equal(calls, 4, 'refreshing the old URL must recheck the redirect and canonical page');
  assert.equal(refreshed.source.cached, false);
  assert.equal(refreshed.source.url, target);
  assert.equal((await http.get(target)).source.cached, false, 'refresh completion must not leave either alias cached');
  assert.equal(calls, 5);
});

test('refreshing an unobserved old alias invalidates a warm canonical cache after redirect failure', async () => {
  const source = 'https://www.cinex.com.ve/cinex-sambil.html';
  const target = 'https://www.cinex.com.ve/cinex-sambilchacao.html';
  let calls = 0, fail = false;
  const http = new HttpClient(async url => {
    calls++;
    if (String(url) === source) return new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } });
    if (fail) return new Response('refresh failed', { status: 503 });
    return new Response('canonical body');
  });

  await http.get(target);
  fail = true;
  await assert.rejects(http.get(source, 120000, true));
  assert.equal(calls, 3, 'the refresh must consult both the unknown alias and its canonical target');
  fail = false;
  const after = await http.get(target);
  assert.equal(after.source.cached, false);
  assert.equal(calls, 4, 'the failed alias refresh must evict the previously warm canonical response');
});

test('refresh redirect discovery invalidates an older canonical read already in flight', async () => {
  const source = 'https://www.cinex.com.ve/cinex-sambil.html';
  const target = 'https://www.cinex.com.ve/cinex-sambilchacao.html';
  let calls = 0, fail = false, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const olderStarted = new Promise<void>(resolve => { started = resolve; });
  const http = new HttpClient(async url => {
    calls++;
    if (String(url) === target && calls === 1) {
      started(); await gate;
      return new Response('older canonical body');
    }
    if (String(url) === source) return new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } });
    return fail ? new Response('refresh failed', { status: 503 }) : new Response('canonical after refresh');
  });

  const older = http.get(target);
  await olderStarted;
  fail = true;
  await assert.rejects(http.get(source, 120000, true));
  release();
  const oldResult = await older;
  assert.equal(oldResult.body, 'older canonical body');
  assert.equal(oldResult.source.cached, false);
  fail = false;
  const after = await http.get(target);
  assert.equal(after.source.cached, false);
  assert.equal(calls, 4, 'the older canonical response must not repopulate cache after alias refresh failure');
});

test('refresh failure invalidates both directions of a public cinema alias', async () => {
  const source = 'https://www.cinex.com.ve/cinex-sambil.html';
  const target = 'https://www.cinex.com.ve/cinex-sambilchacao.html';
  let calls = 0, fail = false;
  const http = new HttpClient(async url => {
    calls++;
    if (fail) return new Response('refresh failed', { status: 503 });
    return String(url) === source
      ? new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } })
      : new Response(`canonical-${calls}`);
  });

  await http.get(source);
  assert.equal((await http.get(target)).source.cached, true);
  fail = true;
  await assert.rejects(http.get(target, 120000, true));
  assert.equal(calls, 3);
  fail = false;
  await http.get(source);
  assert.equal(calls, 5, 'a failed canonical refresh must not leave the old alias warm');

  fail = true;
  await assert.rejects(http.get(source, 120000, true));
  assert.equal(calls, 6);
  fail = false;
  const canonical = await http.get(target);
  assert.equal(calls, 7, 'a failed old-URL refresh must not leave the canonical alias warm');
  assert.equal(canonical.source.cached, false);
});

test('an older alias read cannot repopulate cache after an overlapping canonical refresh failure', async () => {
  const source = 'https://www.cinex.com.ve/cinex-sambil.html';
  const target = 'https://www.cinex.com.ve/cinex-sambilchacao.html';
  let calls = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const oldStarted = new Promise<void>(resolve => { started = resolve; });
  const http = new HttpClient(async url => {
    calls++;
    if (String(url) === source) {
      started(); await gate;
      return new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } });
    }
    if (calls === 2) return new Response('refresh failed', { status: 503 });
    return new Response('canonical after refresh');
  });

  const older = http.get(source);
  await oldStarted;
  await assert.rejects(http.get(target, 120000, true));
  release();
  const stale = await older;
  assert.equal(stale.source.cached, false);
  const after = await http.get(target);
  assert.equal(after.body, 'canonical after refresh');
  assert.equal(after.source.cached, false);
  assert.equal(calls, 4, 'the older redirected read must not satisfy the later canonical read from cache');
});

test('ReadContext deduplicates provenance by the final canonical URL, not the requested alias', async () => {
  const source = 'https://www.cinex.com.ve/cinex-sambil.html';
  const target = 'https://www.cinex.com.ve/cinex-sambilchacao.html';
  const http = new HttpClient(async url => String(url) === source
    ? new Response(null, { status: 302, headers: { Location: '/cinex-sambilchacao.html' } })
    : new Response('canonical cinema page'));
  const context = new ReadContext(http);
  await context.get(source); await context.get(target);
  assert.equal(context.sources.length, 1); assert.equal(context.sources[0].url, target);
});

test('public Cinex redirect handling cannot escape or broaden beyond cinema detail pages', async () => {
  for (const location of [
    'https://evil.test/cinex-elsewhere.html', '/cartelera.html',
    '/cinex-other.html?next=https://evil.test', '/cinex-other.html#fragment',
    'https://user:secret@www.cinex.com.ve/cinex-other.html', '//user:secret@www.cinex.com.ve/cinex-other.html',
  ]) {
    let calls = 0;
    const http = new HttpClient(async (_, init) => { calls++; assert.equal(init?.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: location } }); });
    await assert.rejects(http.get('https://www.cinex.com.ve/cinex-sambil.html'), e => e instanceof DataError && e.status === 'unavailable');
    assert.equal(calls, 1);
  }
});
