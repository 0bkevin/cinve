import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../../src/http/client.js';
import { ReadContext } from '../../src/http/read-context.js';
import { DataError } from '../../src/core.js';
import { SessionStore } from '../../src/auth/sessions.js';

test('Cinex ticket migration preserves IDs, credentials, deadline and final source without caching', async () => {
  const { SessionStore } = await import('../../src/auth/sessions.js');
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
  const { SessionStore } = await import('../../src/auth/sessions.js');
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

test('Cinex ticket redirects cannot change identity, escape the route or loop', async () => {
  const { SessionStore } = await import('../../src/auth/sessions.js');
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

test('Cinex expiry redirect becomes auth_required and redirects are never followed', async () => {
  let calls = 0; class Store extends SessionStore { override async headers() { return { Cookie: 'PHPSESSID=SYNTHETIC' }; } }
  const http = new HttpClient(async () => { calls++; return new Response(null, { status: 302, headers: { Location: '/clearsession.html' } }); }, 1000, new Store());
  await assert.rejects(http.getAuthenticated('cinex', 'https://www.cinex.com.ve/concesiones.php?cinemaid=TLN'), e => e instanceof DataError && e.status === 'auth_required');
  assert.equal(calls, 1);
});
