import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../../src/http/client.js';
import { ReadContext } from '../../src/http/read-context.js';
import { DataError } from '../../src/core.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBody } from '../../src/http/response.js';
import { SessionStore } from '../../src/auth/sessions.js';
import { EmptySessionStore } from '../helpers/fixtures.js';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import { CinemaService } from '../../src/service.js';

const origin = 'https://gateway.cinesunidos.com';

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

test('configured deadline covers injected request, authorization and response-body stalls', async () => {
  const never = <T>() => new Promise<T>(() => {});
  let requests = 0;
  const stalledRequest = new HttpClient(async () => { requests++; return never<Response>(); }, 20);
  await assert.rejects(stalledRequest.get(origin + '/request-stall'), e => e instanceof DataError && /plazo total/.test(e.message));
  await assert.rejects(stalledRequest.get(origin + '/request-stall-again'), e => e instanceof DataError && /plazo total/.test(e.message));
  assert.equal(requests, 2, 'a timed-out request must release its active slot');

  const { SessionStore } = await import('../../src/auth/sessions.js');
  class StalledStore extends SessionStore { override async headers() { return never<Record<string, string>>(); } }
  const stalledHeaders = new HttpClient(async () => new Response('must not reach transport'), 20, new StalledStore());
  await assert.rejects(stalledHeaders.getAuthenticated('cinesunidos', 'https://gateway.cinesunidos.com/tickets/www/theaters/1005/sessions/s1/'), e => e instanceof DataError && /plazo total/.test(e.message));

  const stalledBody = new ReadableStream<Uint8Array>({
    start() {}, cancel() { return never<void>(); },
  });
  const stalledResponse = new HttpClient(async () => new Response(stalledBody), 20);
  await assert.rejects(stalledResponse.get(origin + '/body-stall'), e => e instanceof DataError && /plazo total/.test(e.message));
});

const cities = 'https://gateway.cinesunidos.com/search/cities';

test('bodies are decoded with their declared charset, and a UTF-8 byte-order mark does not break JSON', async () => {
  const latin1 = Buffer.from('LECHERÍAS', 'latin1');
  assert.equal(decodeBody(latin1, 'text/html; charset=ISO-8859-1'), 'LECHERÍAS');
  assert.equal(decodeBody(Buffer.from('MÉRIDA'), 'text/html'), 'MÉRIDA');
  assert.equal(decodeBody(Buffer.from('MÉRIDA'), 'text/html; charset=x-unknown'), 'MÉRIDA');
  const http = new HttpClient(async () => new Response(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('["Mérida"]')]), { headers: { 'content-type': 'application/json; charset=utf-8' } }));
  assert.deepEqual(await new ReadContext(http).json(cities), ['Mérida']);
});

test('a public read retries once after a dropped connection or a 502/504, never after 4xx, 429 or 503', async () => {
  for (const [first, retried] of [['reset', true], [502, true], [504, true], [503, false], [500, false], [429, false], [404, false], [403, false]] as const) {
    let calls = 0;
    const http = new HttpClient(async () => {
      calls++;
      if (calls === 1) { if (first === 'reset') throw new TypeError('fetch failed'); return new Response('', { status: first }); }
      return new Response('["Caracas"]');
    });
    const read = http.get(cities);
    if (retried) assert.equal((await read).body, '["Caracas"]', String(first));
    else await assert.rejects(read, DataError);
    assert.equal(calls, retried ? 2 : 1, String(first));
  }
  // A second failure is reported, not retried again.
  let calls = 0;
  const failing = new HttpClient(async () => { calls++; throw new TypeError('fetch failed'); });
  await assert.rejects(failing.get(cities), e => e instanceof DataError && /No se pudo conectar con el proveedor/.test(e.message));
  assert.equal(calls, 2);
});

test('a read retries at most once, even when the retry itself hits a 502', async () => {
  let calls = 0;
  const http = new HttpClient(async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return calls === 2 ? new Response('', { status: 502 }) : new Response('["Caracas"]');
  });
  await assert.rejects(http.get('https://gateway.cinesunidos.com/search/cities'), DataError);
  assert.equal(calls, 2);
});

test('authenticated reads are never retried', async () => {
  let calls = 0;
  const sessions = new class extends EmptySessionStore { override async headers() { return { Authorization: 'Bearer synthetic' }; } };
  const http = new HttpClient(async () => { calls++; return new Response('', { status: 502 }); }, 15000, sessions);
  await assert.rejects(http.getAuthenticated('cinesunidos', 'https://gateway.cinesunidos.com/tickets/www/theaters/1002/sessions/s1/'), DataError);
  assert.equal(calls, 1);
});

test('Cinepic origins get a longer read deadline than the others', async () => {
  const slow = async () => { await new Promise(r => setTimeout(r, 60)); return new Response('{"success":true}'); };
  const http = new HttpClient(slow, 45);
  // 45 ms scales to 75 ms for Cinepic's slow backend.
  await http.get('https://api.cinexo.com.ar/api/complejo/123300/configuration');
  await assert.rejects(http.get(cities), e => e instanceof DataError && /el proveedor no terminó de responder/.test(e.message));
});

test('a failing session store is reported as Cinve failing, not the provider', async () => {
  let calls = 0;
  const sessions = new class extends EmptySessionStore { override async headers(): Promise<never> { throw new Error('connection terminated'); } };
  const http = new HttpClient(async () => { calls++; return new Response('on'); }, 15000, sessions);
  await assert.rejects(http.getAuthenticated('cinex', 'https://www.cinex.com.ve/checklogin.php'),
    e => e instanceof DataError && /Cinve no pudo leer la sesión guardada/.test(e.message) && !/conectar con el proveedor/.test(e.message));
  assert.equal(calls, 0);
});

async function store(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new SessionStore(join(dir, 'sessions'));
}

test('queues reject overload instead of growing without a limit', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let count = 0;
  const http = new HttpClient(async () => { count++; await gate; return new Response('[]'); });
  const pending = Array.from({ length: 40 }, (_, i) => http.get(`https://gateway.cinesunidos.com/load/${i}`).then(() => 'ok', e => e.status));
  await tick(); release(); const results = await Promise.all(pending);
  assert.equal(results.filter(r => r === 'rate_limited').length, 6); assert.equal(count, 34);
});
test('queue wait consumes the deadline and expired queued work never reaches fetch', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let count = 0;
  const http = new HttpClient(async () => { count++; await gate; return new Response('[]'); }, 25);
  const active = [http.get('https://gateway.cinesunidos.com/hold/1'), http.get('https://gateway.cinesunidos.com/hold/2')].map(p => p.catch(() => null));
  const queued = http.get('https://gateway.cinesunidos.com/hold/3');
  await Promise.all([assert.rejects(queued, /cola/), delay(50)]);
  release(); await Promise.all(active); assert.equal(count, 2);
});

test('queued authenticated work rechecks logout before sending credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-queued-auth-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'sessions'));
  await store.save({ version: 1, provider: 'cinesunidos', expires_at: Date.now() + 60000, access_token: 'SYNTHETIC_TOKEN' });
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let count = 0;
  const http = new HttpClient(async () => { count++; await gate; return new Response('[]'); }, 1000, store);
  const active = [http.get('https://gateway.cinesunidos.com/hold/1'), http.get('https://gateway.cinesunidos.com/hold/2')];
  const queued = http.getAuthenticated('cinesunidos', 'https://gateway.cinesunidos.com/tickets/www/theaters/1002/sessions/s1/');
  const rejected = assert.rejects(queued, e => e instanceof DataError && e.status === 'auth_required');
  await tick(); await store.remove('cinesunidos'); release(); await Promise.all([...active, rejected]); assert.equal(count, 2);
});

test('a Cloudflare challenge is reported as an explicit block without evasion', async () => {
  let calls = 0;
  const s = new CinemaService(new HttpClient(async () => { calls++; return new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } }); }));
  const r = await s.query('movies', { provider: 'cinex' });
  assert.equal(r.status, 'blocked'); assert.equal(calls, 1); assert.equal(r.sources.length, 0);
  assert.ok(r.warnings.some(w => /desafío anti-bots/.test(w) && /no evade/.test(w)), r.warnings.join(' | '));
});

test('a challenged origin is remembered so later public reads skip straight to the fallback', async () => {
  const www: string[] = [];
  let challenge = true;
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.hostname === 'www.cinesunidos.com') {
      www.push(url.pathname);
      return challenge ? new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) : new Response('<html></html>');
    }
    if (url.pathname === '/search/cities') return Response.json(['Caracas']);
    if (url.pathname === '/search/cities/Caracas/theaters') return Response.json([{ id: '1005', name: 'Sambil Caracas', address: 'Chacao' }]);
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  for (let i = 0; i < 3; i++) {
    const r = await s.query('cinemas', { provider: 'cinesunidos', city: 'Caracas' });
    assert.equal(r.status, 'available'); assert.ok(r.warnings.some(w => /API pública de búsqueda/.test(w)));
  }
  assert.equal(www.length, 1, 'the challenged website is asked once, not on every call');
  // refresh=true still asks the website again, and a success clears the memory.
  challenge = false;
  await http.get('https://www.cinesunidos.com/cines?city=Caracas', 120000, true);
  await http.get('https://www.cinesunidos.com/cartelera?city=Caracas');
  assert.equal(www.length, 3);
});
