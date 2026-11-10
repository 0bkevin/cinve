import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { Result } from '../../src/core.js';
import { BrowserToken, fixture, link, successfulLogin } from '../helpers/hosted.js';
import { AuthStatusResult } from '../../src/mcp/server.js';
import { defined, nth } from '../helpers/assert.js';

test('hosted MCP authenticates every request; account links are one-use and sessions stay per user', async t => {
  const f = await fixture(t, successfulLogin);
  const anonymous = await f.client();
  assert.equal((await anonymous.listTools()).tools.length, 11);
  const publicData = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(Result.parse(publicData.structuredContent).status, 'available');
  const protectedData = await anonymous.callTool({ name: 'get_ticket_prices', arguments: { provider: 'cinesunidos', cinema_id: '1', session_id: '1' } });
  assert.equal(Result.parse(protectedData.structuredContent).status, 'auth_required');
  assert.ok(!JSON.stringify(protectedData).includes('npm run')); 
  assert.equal((await fetch(f.origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer invalid' } })).status, 401);
  const alice = await f.client(f.alice.token), bob = await f.client(f.bob.token);
  assert.equal((await alice.listTools()).tools.length, 11);
  const invitation = await link(alice);
  const page = await fetch(f.origin + '/connect');
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert.match(defined(page.headers.get('content-security-policy')), /frame-ancestors 'none'/);
  assert.ok(!(await page.text()).includes(invitation));
  assert.equal((await f.post('/connect/exchange', invitation, {}, { Origin: 'https://evil.test' })).status, 403);
  const exchanged = await f.post('/connect/exchange', invitation);
  const { browser_token } = BrowserToken.parse(await exchanged.json());
  assert.equal(exchanged.status, 200);
  assert.equal((await f.post('/connect/exchange', invitation)).status, 410);
  const logged = await f.post('/connect/login', browser_token, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' });
  assert.equal(logged.status, 200); assert.ok(!(await logged.text()).includes('SYNTHETIC'));
  assert.equal((await f.post('/connect/login', browser_token)).status, 410);
  const aStatus = JSON.stringify((await alice.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  const bStatus = JSON.stringify((await bob.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  assert.ok(aStatus.includes('configured')); assert.ok(!bStatus.includes('configured')); assert.ok(!aStatus.includes('SYNTHETIC'));
  const anonymousAuth = AuthStatusResult.parse((await anonymous.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  assert.deepEqual(anonymousAuth.connection, { mode: 'hosted', client_authorized: false });
  assert.ok(anonymousAuth.providers.every(p => p.status === 'client_authorization_required'));
  const signedIn = AuthStatusResult.parse((await alice.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  assert.deepEqual(signedIn.connection, { mode: 'hosted', client_authorized: true });
  const anonymousStatus = JSON.stringify(anonymousAuth);
  assert.ok(!anonymousStatus.includes('configured'));
  const stillPrivate = await anonymous.callTool({ name: 'get_ticket_prices', arguments: { provider: 'cinesunidos', cinema_id: '1', session_id: '1' } });
  assert.equal(Result.parse(stillPrivate.structuredContent).status, 'auth_required');
  const encrypted = JSON.stringify((await f.pool.query('SELECT ciphertext FROM cinev_sessions')).rows);
  assert.ok(!/SYNTHETIC|person@example/.test(encrypted));
  await bob.callTool({ name: 'disconnect_account', arguments: { provider: 'cinesunidos' } });
  assert.ok(await f.storeFor(f.alice.id).read('cinesunidos'));
  await alice.callTool({ name: 'disconnect_account', arguments: { provider: 'cinesunidos' } });
  assert.equal(await f.storeFor(f.alice.id).read('cinesunidos'), undefined);
  await f.users.revoke(f.alice.id);
  await assert.rejects(alice.callTool({ name: 'get_auth_status', arguments: {} }));
});

test('hosted app reuses public reads across users and honors explicit refresh', async t => {
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstRead = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, undefined, async (_url, _init) => {
    calls++;
    if (calls === 1) { started(); await gate; }
    if (calls === 3) return new Response('upstream failure', { status: 503 });
    return new Response('["Caracas"]');
  });
  const anonymous = await f.client();
  const alice = await f.client(f.alice.token);

  const concurrent = Promise.all([
    anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } }),
    alice.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } }),
  ]);
  await firstRead;
  assert.equal(calls, 1);
  release();
  const [first, second] = await concurrent;
  assert.equal(calls, 1);
  const concurrentSources = [nth(Result.parse(first.structuredContent).sources, 0), nth(Result.parse(second.structuredContent).sources, 0)];
  assert.ok(concurrentSources.every(source => typeof source.cached === 'boolean'));
  assert.ok(concurrentSources.some(source => source.cached === false), 'one request must receive the shared upstream result');
  assert.equal(nth(concurrentSources, 0).fetched_at, nth(concurrentSources, 1).fetched_at);

  const cached = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(calls, 1);
  assert.equal(nth(Result.parse(cached.structuredContent).sources, 0).cached, true);

  const refreshed = await alice.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } });
  assert.equal(calls, 2);
  assert.equal(nth(Result.parse(refreshed.structuredContent).sources, 0).cached, false);
  const failed = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } });
  assert.equal(calls, 3);
  assert.equal(Result.parse(failed.structuredContent).status, 'error');
  const afterFailure = await alice.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(calls, 4);
  assert.equal(nth(Result.parse(afterFailure.structuredContent).sources, 0).cached, false);
});

test('hosted requests retain verified unlisted Cinex IDs across request-scoped services', async t => {
  const requests: string[] = [];
  const f = await fixture(t, undefined, async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/cines.html') return new Response('<a href="cinex-listed.html" title="Cinex Listed, Caracas"><h3>LISTED</h3><img src="assets/images/cinemas/xlisted.jpg"></a>');
    if (url.pathname === '/cinex-metropolisbarquisimeto.html') return new Response(`<h3 class="title">METROPOLIS BARQUISIMETO</h3><div class="sessionslist"><h5 class="title">KNOWN</h5><button onclick="checkLogin('s1','MTB')" alt="1789751400"></button></div>`);
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="posterMovieClick('M','KNOWN','0','x','A','sinopsis-known.html','CARTELERA')" title="KNOWN"></div>`);
    return new Response('missing', { status: 404 });
  });
  const discover = await f.client();
  const cinemas = await discover.callTool({ name: 'list_cinemas', arguments: { provider: 'cinex', city: 'Barquisimeto' } });
  const item = nth(Result.parse(cinemas.structuredContent).items, 0);
  assert.equal(item.cinema_id, 'MTB'); assert.equal(item.directory_status, 'not_listed');
  const before = requests.length;
  const separateRequest = await f.client();
  const showtimes = await separateRequest.callTool({ name: 'get_showtimes', arguments: { provider: 'cinex', cinema_id: 'MTB', date: '2026-09-18', refresh: true } });
  assert.equal(Result.parse(showtimes.structuredContent).status, 'available');
  assert.equal(Result.parse(showtimes.structuredContent).total, 1);
  assert.deepEqual(requests.slice(before), ['/cartelera.html', '/cinex-metropolisbarquisimeto.html']);
});

test('disconnect during upstream login prevents a late session from being saved', async t => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (...args) => { started(); await gate; return successfulLogin(...args); });
  const client = await f.client(f.alice.token);
  const invitation = await link(client);
  const { browser_token } = BrowserToken.parse(await (await f.post('/connect/exchange', invitation)).json());
  const pending = f.post('/connect/login', browser_token, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' });
  await ready;
  await client.callTool({ name: 'disconnect_account', arguments: { provider: 'cinesunidos' } });
  release(); assert.equal((await pending).status, 410);
  assert.equal(await f.storeFor(f.alice.id).read('cinesunidos'), undefined);
});

test('hosted rejects rebinding, excess bodies, field injection, reused/revoked links and leaks', async t => {
  const f = await fixture(t, async () => { throw new Error('PRIVATE_PASSWORD'); });
  const badHost = await new Promise<number>(resolve => {
    const req = httpRequest(f.origin + '/connect', { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(defined(res.statusCode)); }); req.end();
  });
  assert.equal(badHost, 403);
  const client = await f.client(f.alice.token), invite = await link(client);
  const { browser_token } = BrowserToken.parse(await (await f.post('/connect/exchange', invite)).json());
  assert.equal((await f.post('/connect/login', browser_token, { provider: 'cinex', username: 'x', password: 'x' })).status, 400);
  assert.equal((await f.post('/connect/login', browser_token, { username: 'x', password: 'x'.repeat(17000) })).status, 413);
  const failure = await f.post('/connect/login', browser_token, { username: 'x', password: 'x' });
  assert.equal(failure.status, 401); assert.ok(!(await failure.text()).includes('PRIVATE_PASSWORD'));
  for (let i = 0; i < 4; i++) await f.post('/connect/login', browser_token, { username: 'x', password: 'x' });
  assert.equal((await f.post('/connect/login', browser_token, { username: 'x', password: 'x' })).status, 429);
  const newer = await link(client);
  await f.users.revoke(f.alice.id);
  assert.equal((await f.post('/connect/exchange', newer)).status, 410);
});

test('slow request bodies cannot bypass the per-client MCP concurrency limit', async t => {
  const f = await fixture(t);
  const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_cities', arguments: { provider: 'cinesunidos' } } });
  const { port } = new URL(f.origin);
  const requests = Array.from({ length: 8 }, () => {
    let finish!: () => void;
    const status = new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18',
      } }, res => { res.resume(); resolve(defined(res.statusCode)); });
      req.on('error', reject);
      req.write(message.slice(0, 1));
      finish = () => req.end(message.slice(1));
    });
    return { status, finish: () => finish() };
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  for (const r of requests) r.finish();
  const statuses = await Promise.all(requests.map(r => r.status));
  assert.equal(statuses.filter(s => s === 429).length, 4, `statuses: ${statuses.join(',')}`);
});

test('refresh=true calls have their own small budget so the shared cache cannot be bypassed at volume', async t => {
  const f = await fixture(t);
  const { digest } = await import('../../src/hosted/store.js');
  const anonymous = await f.client();
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',10)", [digest('refresh:anonymous:127.0.0.1')]);
  await assert.rejects(anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } }));
  const cached = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(Result.parse(cached.structuredContent).status, 'available');
});

test('an unfinished MCP body is cut off at its deadline and releases its concurrency slot', async t => {
  const f = await fixture(t, undefined, undefined, { bodyTimeoutMs: 100 });
  const { port } = new URL(f.origin);
  const stalled = Array.from({ length: 4 }, () => new Promise<string>(resolve => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      res => { res.resume(); resolve(String(res.statusCode)); });
    req.on('error', () => resolve('closed'));
    req.write('{');
  }));
  assert.deepEqual(await Promise.all(stalled), ['closed', 'closed', 'closed', 'closed']);
  const anonymous = await f.client();
  const r = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(Result.parse(r.structuredContent).status, 'available', 'slots held by stalled bodies were released');
});
