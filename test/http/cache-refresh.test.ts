import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../../src/http/client.js';
import { DataError } from '../../src/core.js';

const origin = 'https://gateway.cinesunidos.com';

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
