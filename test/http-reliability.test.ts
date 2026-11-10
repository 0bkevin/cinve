import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient, decodeBody } from '../src/http/client.js';
import { ReadContext } from '../src/http/read-context.js';
import { SessionStore } from '../src/auth.js';
import { CinemaService } from '../src/service.js';
import { DataError } from '../src/core.js';
import { EmptySessionStore } from './fixtures.js';

const cities = 'https://gateway.cinesunidos.com/search/cities';

test('a 200 body that is empty or not the expected JSON is reported but never cached', async () => {
  let calls = 0;
  const bodies = ['', '<html>Mantenimiento</html>', '["Caracas"]'];
  const http = new HttpClient(async () => new Response(bodies[calls++]));
  for (const expected of [/JSON válido/, /JSON válido/]) {
    await assert.rejects(new ReadContext(http).json(cities), e => e instanceof DataError && expected.test(e.message));
  }
  assert.deepEqual(await new ReadContext(http).json(cities), ['Caracas']);
  // Only the valid body was kept.
  assert.deepEqual(await new ReadContext(http).json(cities), ['Caracas']);
  assert.equal(calls, 3);
});

test('long-lived pages without their expected markup are not cached for an hour', async () => {
  let calls = 0;
  const http = new HttpClient(async () => { calls++; return new Response(calls === 1 ? '<html>Sitio en mantenimiento</html>' : '<a href="cinex-sambil.html" title="Cinex Sambil, Caracas"><h3>SAMBIL</h3></a>'); });
  const s = new CinemaService(http);
  const down = await s.query('cinemas', { provider: 'cinex' });
  assert.equal(down.status, 'error');
  const up = await s.query('cinemas', { provider: 'cinex' });
  assert.equal(up.status, 'available', up.warnings.join(' '));
  assert.ok(calls >= 2, 'the maintenance page was asked for again');
});

test('directory, city and metadata reads stay cached past the two-minute page lifetime', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const requests: string[] = [];
  const http = new HttpClient(async input => {
    const u = new URL(String(input)); requests.push(u.pathname + u.search);
    if (u.pathname === '/search/cities') return new Response('["Caracas"]');
    if (u.pathname === '/cines.html') return new Response('<a href="cinex-sambil.html" title="Cinex Sambil, Caracas"><h3>SAMBIL</h3><img src="assets/images/cinemas/xsbc.jpg"></a>');
    if (u.pathname === '/assets/php/datasource.php') return new Response(JSON.stringify({ data: [{ name: 'Sambil', siglas: 'SBC' }] }));
    return new Response('missing', { status: 404 });
  });
  const s = new CinemaService(http);
  assert.equal((await s.query('cities', { provider: 'cinesunidos' })).status, 'available');
  const listed = await s.query('cinemas', { provider: 'cinex', city: 'Caracas' });
  assert.equal(listed.items[0]?.cinema_id, 'SBC', listed.warnings.join(' '));
  const cold = requests.length;
  t.mock.timers.tick(30 * 60000);
  assert.equal((await s.query('cities', { provider: 'cinesunidos' })).status, 'available');
  assert.equal((await s.query('cinemas', { provider: 'cinex', city: 'Caracas' })).items[0]?.cinema_id, 'SBC');
  assert.equal(requests.length, cold, 'no venue metadata read is repeated within the hour');
  t.mock.timers.tick(31 * 60000);
  await s.query('cities', { provider: 'cinesunidos' });
  assert.equal(requests.length, cold + 1);
});

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

test('a Cines Unidos seat answer that is not JSON names the provider response', async () => {
  const sessions = new class extends EmptySessionStore { override async headers() { return { Authorization: 'Bearer synthetic' }; } };
  const r = await new CinemaService(new HttpClient(async () => new Response('<html></html>'), 15000, sessions)).seats({ provider: 'cinesunidos', cinema_id: '1002', session_id: 's1' });
  assert.equal(r.status, 'error'); assert.match(r.warnings.join(' '), /Cines Unidos no devolvió un mapa de asientos en JSON válido/);
});
