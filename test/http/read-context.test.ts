import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../../src/http/client.js';
import { ReadContext } from '../../src/http/read-context.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/auth/sessions.js';
import { CinemaService } from '../../src/service.js';
import { EmptySessionStore, page } from '../helpers/fixtures.js';
import { DataError } from '../../src/core.js';

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

const cinexJar = JSON.stringify({ version: 'tough-cookie@4.1.4', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, cookies: [{ key: 'PHPSESSID', value: 'x', domain: 'www.cinex.com.ve', path: '/', hostOnly: true, creation: new Date().toISOString(), lastAccessed: new Date().toISOString() }] });
async function store(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new SessionStore(join(dir, 'sessions'));
}

test('an unexpected Cinex login-check answer is not reported or recorded as an expired session', async t => {
  const sessions = await store(t);
  await sessions.save({ version: 1, provider: 'cinex', expires_at: Date.now() + 3600000, saved_at: Date.now() - 1000, cookie_jar: cinexJar });
  const service = new CinemaService(new HttpClient(async () => new Response('<html>Error interno</html>'), 15000, sessions));
  const r = await service.query('prices', { provider: 'cinex', cinema_id: 'SBC', session_id: 's1' });
  assert.equal(r.status, 'error'); assert.match(r.warnings.join(' '), /de forma inesperada/);
  assert.equal((await sessions.status('cinex')).status, 'configured');
});

test('a passed Cinex login check is reused for a minute, and dropped after a failed read', async () => {
  const requests: string[] = [];
  const sessions = new class extends EmptySessionStore { override async headers() { return { Cookie: 'synthetic' }; } };
  const http = new HttpClient(async input => {
    const path = new URL(String(input)).pathname; requests.push(path);
    if (path === '/checklogin.php') return new Response('on');
    if (path === '/concesiones.php') return new Response('', { status: 500 });
    return new Response('<form id="frmboletos"></form>');
  }, 15000, sessions);
  const s = new CinemaService(http);
  await s.query('prices', { provider: 'cinex', cinema_id: 'SBC', session_id: 's1' });
  await s.query('prices', { provider: 'cinex', cinema_id: 'SBC', session_id: 's2' });
  assert.deepEqual(requests, ['/checklogin.php', '/boletos.php', '/boletos.php']);
  await s.query('concessions', { provider: 'cinex', cinema_id: 'SBC' });
  await s.query('prices', { provider: 'cinex', cinema_id: 'SBC', session_id: 's3' });
  assert.deepEqual(requests.slice(3), ['/concesiones.php', '/checklogin.php', '/boletos.php']);
});

test('a provider refusing the saved session (HTTP 401) marks it expired with a clear message', async t => {
  const sessions = await store(t);
  await sessions.save({ version: 1, provider: 'cinesunidos', expires_at: Date.now() + 3600000, saved_at: Date.now() - 1000, access_token: 'SYNTHETIC_TOKEN' });
  const service = new CinemaService(new HttpClient(async () => new Response('', { status: 401 }), 15000, sessions));
  const r = await service.query('prices', { provider: 'cinesunidos', cinema_id: '1002', session_id: 's1' });
  assert.equal(r.status, 'auth_required'); assert.match(r.warnings.join(' '), /rechazó la sesión guardada/);
  assert.equal((await sessions.status('cinesunidos')).status, 'expired');
});

test('a cancelled call starts no further provider reads', async () => {
  const controller = new AbortController();
  let sessionReads = 0;
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.hostname === 'www.cinesunidos.com') return new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    if (url.pathname === '/search/cities') return Response.json(['Caracas']);
    if (url.pathname.endsWith('/films')) return Response.json(Array.from({ length: 20 }, (_, i) => `Film ${i}`));
    if (url.pathname.endsWith('/sessions')) { sessionReads++; controller.abort(); return Response.json([]); }
    return new Response('missing', { status: 404 });
  });
  const r = await new CinemaService(http).query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-11-04' }, { signal: controller.signal });
  assert.ok(sessionReads <= 4, `only the batch already in flight is read (${sessionReads})`);
  assert.equal(r.partial, true, 'the titles that were never read make the result partial');
  const before = sessionReads;
  const cancelled = await new CinemaService(http).query('showtimes', { provider: 'cinesunidos', city: 'Valencia' }, { signal: controller.signal });
  assert.equal(cancelled.status, 'error'); assert.equal(sessionReads, before);
  assert.ok(cancelled.warnings.some(w => /cancelada/.test(w)), cancelled.warnings.join(' | '));
});

test('a call starts no provider read past its own deadline, whatever chain of reads it is in', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let reads = 0;
  const c = new ReadContext(new HttpClient(async () => { reads++; return new Response('ok'); }), false, {}, 1000);
  assert.equal(c.budget(5000), 1000, 'a fan-out budget never extends past the call deadline');
  assert.equal(c.budget(500), 500);
  await c.get('https://www.cinex.com.ve/cines.html');
  t.mock.timers.tick(1000);
  await assert.rejects(c.get('https://www.cinex.com.ve/cartelera.html'), (e: DataError) => e.status === 'error' && /Se agotó el tiempo de esta consulta/.test(e.message));
  assert.equal(reads, 1);
});

test('a call budget counts from when the hosted server received the request', async () => {
  let calls = 0;
  const http = new HttpClient(async () => { calls++; return new Response('["Caracas"]'); });
  const late = new ReadContext(http, false, { startedAt: Date.now() - 61000 });
  await assert.rejects(late.json('https://gateway.cinesunidos.com/search/cities'), /Se agotó el tiempo de esta consulta/);
  assert.equal(calls, 0);
  const fresh = new ReadContext(http, false, { startedAt: Date.now() - 1000 });
  assert.ok(fresh.deadline <= Date.now() + 59000);
  assert.deepEqual(await fresh.json('https://gateway.cinesunidos.com/search/cities'), ['Caracas']);
});
