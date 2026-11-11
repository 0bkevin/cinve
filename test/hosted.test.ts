import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationSql } from '../src/migrations.js';
import { Pool } from 'pg';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createHostedApp, hostedKeys } from '../src/hosted.js';
import { EncryptedSessionStore, HostedUsers } from '../src/hosted-store.js';
import { Result } from '../src/core.js';
import { accountName, ConnectionLinks } from '../src/hosted-links.js';
import { createRemoteServer } from '../src/remote.js';
import type { login } from '../src/auth.js';
import type { ClientMetadataFetcher } from '../src/client-metadata.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, authenticate?: typeof login,
  request: typeof fetch = async () => new Response('["Caracas"]'), extra: { bodyTimeoutMs?: number; clientMetadata?: ClientMetadataFetcher; trustedVercelProxy?: boolean; signInFloorMs?: number } = {}) {
  const schema = 'test_' + randomBytes(12).toString('hex');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });

  await pool.query(await migrationSql());
  const key = randomBytes(32);
  // No response floor by default: tests fail sign-ins on purpose and should stay fast.
  const app = await createHostedApp({ publicUrl: 'http://127.0.0.1:0', allowLocal: true, pool, key, authenticate, request, signInFloorMs: 0, ...extra });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const alice = await app.users.issue(), bob = await app.users.issue();
  const clients: Client[] = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); });
  async function client(token?: string) {
    const c = new Client({ name: 'hosted-test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }));
    clients.push(c); return c;
  }
  const post = (path: string, token: string, data: unknown = {}, custom: Record<string, string> = {}) => fetch(origin + path, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Cinev-Connection': token, ...custom }, body: JSON.stringify(data),
  });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  return { ...app, pool, key, origin, alice, bob, client, post };
}
const metadataUrl = 'https://assistant.example/oauth/client.json';
const metadataDocuments: Record<string, unknown> = {
  [metadataUrl]: { client_id: metadataUrl, client_name: 'Metadata assistant', redirect_uris: ['https://assistant.example/callback'], token_endpoint_auth_method: 'none' },
  'https://assistant.example/oauth/elsewhere.json': { client_id: 'https://assistant.example/oauth/elsewhere.json', client_name: 'Claude', redirect_uris: ['https://elsewhere.example/callback'], token_endpoint_auth_method: 'none' },
  'https://assistant.example/oauth/wrong-id.json': { client_id: 'https://other.example/client.json', redirect_uris: ['https://assistant.example/callback'] },
  'https://assistant.example/oauth/secret.json': { client_id: 'https://assistant.example/oauth/secret.json', client_secret: 'x', redirect_uris: ['https://assistant.example/callback'] },
  'https://assistant.example/oauth/confidential.json': { client_id: 'https://assistant.example/oauth/confidential.json', token_endpoint_auth_methods_supported: ['private_key_jwt'], redirect_uris: ['https://assistant.example/callback'] },
};
const clientMetadata: ClientMetadataFetcher = async url => {
  if (!(url in metadataDocuments)) throw new Error('404');
  return { document: metadataDocuments[url] };
};
const successfulLogin: typeof login = async (provider, username, password, store) => {
  assert.equal(username, 'person@example.test'); assert.equal(password, 'SYNTHETIC_PASSWORD');
  await store!.save({ version: 1, provider, expires_at: Date.now() + 60000, access_token: 'SYNTHETIC_UPSTREAM_TOKEN' });
  return { provider, authenticated: true, profile_update_requested: false };
};
async function link(client: Client) {
  const response = await client.callTool({ name: 'connect_account', arguments: { provider: 'cinesunidos' } });
  assert.equal((response.structuredContent as { connected: boolean }).connected, false);
  return new URL((response.structuredContent as { url: string }).url).hash.slice(1);
}

test('hosted MCP authenticates every request; account links are one-use and sessions stay per user', async t => {
  const f = await fixture(t, successfulLogin);
  const anonymous = await f.client();
  assert.equal((await anonymous.listTools()).tools.length, 11);
  const publicData = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal((publicData.structuredContent as { status: string }).status, 'available');
  const protectedData = await anonymous.callTool({ name: 'get_ticket_prices', arguments: { provider: 'cinesunidos', cinema_id: '1', session_id: '1' } });
  assert.equal((protectedData.structuredContent as { status: string }).status, 'auth_required');
  assert.ok(!JSON.stringify(protectedData).includes('npm run')); 
  assert.equal((await fetch(f.origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer invalid' } })).status, 401);
  const alice = await f.client(f.alice.token), bob = await f.client(f.bob.token);
  assert.equal((await alice.listTools()).tools.length, 11);
  const invitation = await link(alice);
  const page = await fetch(f.origin + '/connect');
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const connectHtml = await page.text();
  assert.ok(!connectHtml.includes(invitation));
  const scriptUrl = connectHtml.match(/<script type="module" src="(\/assets\/js\/connect\.js\?v=[0-9a-f]{10})">/)![1];
  const script = await fetch(f.origin + scriptUrl);
  assert.match(script.headers.get('content-type')!, /text\/javascript/); assert.match(await script.text(), /\/connect\/exchange/);
  assert.equal((await f.post('/connect/exchange', invitation, {}, { Origin: 'https://evil.test' })).status, 403);
  const exchanged = await f.post('/connect/exchange', invitation);
  const { browser_token, app } = await exchanged.json() as { browser_token: string; app: unknown };
  assert.equal(exchanged.status, 200); assert.equal(app, null, 'operator-issued access has no assistant app');
  assert.equal((await f.post('/connect/exchange', invitation)).status, 410);
  const logged = await f.post('/connect/login', browser_token, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' });
  assert.equal(logged.status, 200); assert.ok(!(await logged.text()).includes('SYNTHETIC'));
  assert.equal((await f.post('/connect/login', browser_token)).status, 410);
  const aStatus = JSON.stringify((await alice.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  const bStatus = JSON.stringify((await bob.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  assert.ok(aStatus.includes('configured')); assert.ok(!bStatus.includes('configured')); assert.ok(!aStatus.includes('SYNTHETIC'));
  // A connected account needs no new link; the assistant just retries its query.
  assert.deepEqual((await alice.callTool({ name: 'connect_account', arguments: { provider: 'cinesunidos' } })).structuredContent, { connected: true });
  assert.equal(((await bob.callTool({ name: 'connect_account', arguments: { provider: 'cinesunidos' } })).structuredContent as { connected: boolean }).connected, false);
  const anonymousAuth = (await anonymous.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent as { connection: { mode: string; client_authorized: boolean }; providers: Array<{ status: string }> };
  assert.deepEqual(anonymousAuth.connection, { mode: 'hosted', client_authorized: false });
  assert.ok(anonymousAuth.providers.every(p => p.status === 'client_authorization_required'));
  const signedIn = (await alice.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent as { connection: { mode: string; client_authorized: boolean } };
  assert.deepEqual(signedIn.connection, { mode: 'hosted', client_authorized: true });
  const anonymousStatus = JSON.stringify(anonymousAuth);
  assert.ok(!anonymousStatus.includes('configured'));
  const stillPrivate = await anonymous.callTool({ name: 'get_ticket_prices', arguments: { provider: 'cinesunidos', cinema_id: '1', session_id: '1' } });
  assert.equal((stillPrivate.structuredContent as { status: string }).status, 'auth_required');
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
  const concurrentSources = [Result.parse(first.structuredContent).sources[0], Result.parse(second.structuredContent).sources[0]];
  assert.ok(concurrentSources.every(source => typeof source.cached === 'boolean'));
  assert.ok(concurrentSources.some(source => source.cached === false), 'one request must receive the shared upstream result');
  assert.equal(concurrentSources[0].fetched_at, concurrentSources[1].fetched_at);

  const cached = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(calls, 1);
  assert.equal(Result.parse(cached.structuredContent).sources[0].cached, true);

  const refreshed = await alice.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } });
  assert.equal(calls, 2);
  assert.equal(Result.parse(refreshed.structuredContent).sources[0].cached, false);
  const failed = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } });
  assert.equal(calls, 3);
  assert.equal(Result.parse(failed.structuredContent).status, 'error');
  const afterFailure = await alice.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(calls, 4);
  assert.equal(Result.parse(afterFailure.structuredContent).sources[0].cached, false);
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
  const item = (cinemas.structuredContent as { items: Array<{ cinema_id?: string; directory_status?: string }> }).items[0];
  assert.equal(item.cinema_id, 'MTB'); assert.equal(item.directory_status, 'not_listed');
  const before = requests.length;
  const separateRequest = await f.client();
  const showtimes = await separateRequest.callTool({ name: 'get_showtimes', arguments: { provider: 'cinex', cinema_id: 'MTB', date: '2026-09-18', refresh: true } });
  assert.equal((showtimes.structuredContent as { status: string; total: number }).status, 'available');
  assert.equal((showtimes.structuredContent as { total: number }).total, 1);
  assert.deepEqual(requests.slice(before), ['/cinex-metropolisbarquisimeto.html', '/cartelera.html']);
});

test('disconnect during upstream login prevents a late session from being saved', async t => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (...args) => { started(); await gate; return successfulLogin(...args); });
  const client = await f.client(f.alice.token);
  const invitation = await link(client);
  const { browser_token } = await (await f.post('/connect/exchange', invitation)).json() as { browser_token: string };
  const pending = f.post('/connect/login', browser_token, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' });
  await ready;
  await client.callTool({ name: 'disconnect_account', arguments: { provider: 'cinesunidos' } });
  release(); assert.equal((await pending).status, 410);
  assert.equal(await f.storeFor(f.alice.id).read('cinesunidos'), undefined);
});

test('encrypted sessions reject tampering and ciphertext moved to a different user', async t => {
  const f = await fixture(t);
  const session = { version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: 'SYNTHETIC_TOKEN' };
  await f.storeFor(f.alice.id).save(session);
  const { rows } = await f.pool.query('SELECT ciphertext FROM cinev_sessions WHERE user_id=$1', [f.alice.id]);
  await f.pool.query('INSERT INTO cinev_sessions(user_id,provider,ciphertext,expires_at) VALUES($1,$2,$3,now())', [f.bob.id, 'cinesunidos', rows[0].ciphertext]);
  await assert.rejects(f.storeFor(f.bob.id).read('cinesunidos'));
  const tampered = JSON.parse(rows[0].ciphertext); tampered.tag = randomBytes(16).toString('base64');
  await f.pool.query('UPDATE cinev_sessions SET ciphertext=$1 WHERE user_id=$2', [JSON.stringify(tampered), f.alice.id]);
  await assert.rejects(f.storeFor(f.alice.id).read('cinesunidos'));
  assert.equal((await new HostedUsers(f.pool).authenticate(f.alice.token))?.id, f.alice.id);
  assert.equal(await f.users.authenticate(f.alice.token + 'bad'), undefined);
});

test('hosted rejects rebinding, excess bodies, field injection, reused/revoked links and leaks', async t => {
  const f = await fixture(t, async () => { throw new Error('PRIVATE_PASSWORD'); });
  const badHost = await new Promise<number>(resolve => {
    const req = httpRequest(f.origin + '/connect', { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
  });
  assert.equal(badHost, 403);
  const client = await f.client(f.alice.token), invite = await link(client);
  const { browser_token } = await (await f.post('/connect/exchange', invite)).json() as { browser_token: string };
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

test('database links expire and cancellation invalidates browser stages', async t => {
  const f = await fixture(t), hash = (await f.users.hash(f.alice.id))!;
  const first = await f.links.issue(f.alice.id, hash, 'cinex');
  await f.pool.query("UPDATE cinev_links SET expires_at=now()-interval '1 second'");
  assert.equal(await f.links.exchange(first.token), undefined);
  const next = await f.links.issue(f.alice.id, hash, 'cinex');
  const browser = (await f.links.exchange(next.token))!;
  await f.links.cancel(f.alice.id, 'cinex'); assert.equal(await f.links.get(browser.browserToken), undefined);
});

test('stdio bridge forwards tools to authenticated hosted MCP with fresh retrieval', async t => {
  const f = await fixture(t);
  const server = await createRemoteServer({ url: f.origin + '/mcp', token: f.alice.token });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'bridge-test', version: '1' }); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const hostedTools = await client.listTools();
  assert.equal(hostedTools.tools.length, 11);
  assert.ok(hostedTools.tools.every(tool => tool.title));
  assert.match(client.getInstructions() ?? '', /Hosted server/);
  assert.deepEqual(client.getServerVersion(), { name: 'cinve', version: '0.1.0' });
  const result = await client.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(Result.parse(result.structuredContent).status, 'available');
  assert.ok(!JSON.stringify(result).includes(f.alice.token));
});

test('independent server instances consume a link only once and share saved sessions', async t => {
  const f = await fixture(t), other = new ConnectionLinks(f.pool, hostedKeys(f.key));
  const hash = (await f.users.hash(f.alice.id))!;
  const invite = await f.links.issue(f.alice.id, hash, 'cinesunidos');
  const results = await Promise.all([f.links.exchange(invite.token), other.exchange(invite.token)]);
  assert.equal(results.filter(Boolean).length, 1);
  const token = results.find(Boolean)!.browserToken;
  const claims = await Promise.all([f.links.claim(token), other.claim(token)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const session = { version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: 'SECRET_SESSION' };
  assert.equal(await other.complete(token, session, f.key), true);
  assert.equal((await new EncryptedSessionStore(f.pool, f.alice.id, f.key).read('cinesunidos'))?.access_token, 'SECRET_SESSION');
  assert.equal(await f.links.complete(token, session, f.key), undefined);
  const dump = JSON.stringify((await f.pool.query('SELECT * FROM cinev_clients')).rows) + JSON.stringify((await f.pool.query('SELECT * FROM cinev_sessions')).rows);
  assert.ok(!dump.includes('SECRET_SESSION')); assert.ok(!dump.includes(f.alice.token));
});

test('revocation and newer invitations prevent another instance from saving a late login', async t => {
  const f = await fixture(t), other = new ConnectionLinks(f.pool, hostedKeys(f.key));
  const hash = (await f.users.hash(f.alice.id))!;
  const session = { version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: 'SECRET_SESSION' };
  const invite = await f.links.issue(f.alice.id, hash, 'cinesunidos');
  const token = (await other.exchange(invite.token))!.browserToken;
  await other.claim(token);
  await f.links.issue(f.alice.id, hash, 'cinesunidos');
  assert.equal(await other.complete(token, session, f.key), undefined);
  const newest = await f.links.issue(f.alice.id, hash, 'cinesunidos');
  const nextToken = (await other.exchange(newest.token))!.browserToken;
  await other.claim(nextToken); await f.users.revoke(f.alice.id);
  assert.equal(await other.complete(nextToken, session, f.key), undefined);
  assert.equal(await f.storeFor(f.alice.id).read('cinesunidos'), undefined);
  await assert.rejects(other.issue(f.alice.id, hash, 'cinesunidos'));
});

test('database attempt limits and rate budgets survive new instances', async t => {
  const f = await fixture(t), other = new ConnectionLinks(f.pool, hostedKeys(f.key)), hash = (await f.users.hash(f.alice.id))!;
  const invite = await f.links.issue(f.alice.id, hash, 'cinex');
  const token = (await other.exchange(invite.token))!.browserToken;
  for (let i = 0; i < 5; i++) { assert.ok(await other.claim(token)); await f.links.release(token); }
  assert.equal(await f.links.claim(token), undefined);
  const requests = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? f.links : other).budget('same-client', 4)));
  assert.equal(requests.filter(Boolean).length, 4);
  await f.pool.query("UPDATE cinev_budgets SET expires_at=now()-interval '1 second'");
  assert.equal(await other.budget('same-client', 4), true);
});

// Exercise the actual SDK's discovery/DCR/PKCE path, not only hand-crafted OAuth requests.
test('anonymous MCP client authorizes in the browser, connects a cinema, refreshes and disconnects', async t => {
  const f = await fixture(t, successfulLogin);
  type Provider = import('@modelcontextprotocol/client').OAuthClientProvider;
  let info: Awaited<ReturnType<Provider['clientInformation']>>;
  let tokens: Awaited<ReturnType<Provider['tokens']>>;
  let verifier = '', authorization: URL | undefined;
  let discovery: Awaited<ReturnType<NonNullable<Provider['discoveryState']>>>;
  const provider: Provider = {
    redirectUrl: 'https://assistant.example/callback',
    clientMetadata: { client_name: 'My assistant', redirect_uris: ['https://assistant.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    clientInformation: () => info, saveClientInformation: value => { info = value; },
    tokens: () => tokens, saveTokens: value => { tokens = value; },
    codeVerifier: () => verifier, saveCodeVerifier: value => { verifier = value; },
    discoveryState: () => discovery, saveDiscoveryState: value => { discovery = value; },
    state: () => 'sdk-test-state', redirectToAuthorization: value => { authorization = value; },
  };
  const transport = new StreamableHTTPClientTransport(new URL(f.origin + '/mcp'), { authProvider: provider });
  const client = new Client({ name: 'oauth-test', version: '1' });
  await client.connect(transport); t.after(() => client.close());
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'connect_account'));
  await assert.rejects(client.callTool({ name: 'connect_account', arguments: { provider: 'cinesunidos' } }));
  assert.ok(authorization, '401 must cause the SDK to discover/register and open approval');
  const callback = await approve(f.origin, authorization);
  assert.equal(callback.searchParams.get('state'), 'sdk-test-state');
  await transport.finishAuth(callback.searchParams);
  assert.ok(tokens?.access_token);
  const invitation = await link(client);
  const { browser_token } = await (await f.post('/connect/exchange', invitation)).json() as { browser_token: string };
  assert.equal((await f.post('/connect/login', browser_token, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' })).status, 200);
  assert.match(JSON.stringify((await client.callTool({ name: 'get_auth_status' })).structuredContent), /configured/);
  const before = tokens.access_token;
  await f.pool.query("UPDATE cinev_oauth_tokens SET expires_at=now()-interval '1 second' WHERE kind='access'");
  assert.match(JSON.stringify((await client.callTool({ name: 'get_auth_status' })).structuredContent), /configured/);
  assert.notEqual(tokens.access_token, before, 'SDK automatically refreshes without losing cinema ownership');
  const dump = JSON.stringify((await f.pool.query('SELECT * FROM cinev_oauth_tokens')).rows);
  assert.ok(!dump.includes(tokens.access_token)); assert.ok(!dump.includes(tokens.refresh_token!));
  await client.callTool({ name: 'disconnect_account', arguments: { provider: 'cinesunidos' } });
  assert.ok(!JSON.stringify((await client.callTool({ name: 'get_auth_status' })).structuredContent).includes('configured'));
});

async function approve(origin: string, authorization: URL, decision = 'approve') {
  const page = await fetch(authorization);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.match(page.headers.get('content-security-policy')!, /form-action 'self'/);
  const html = await page.text();
  assert.ok(page.headers.get('content-security-policy')!.includes(`form-action 'self' ${new URL(authorization.searchParams.get('redirect_uri')!).origin};`));
  const request_id = html.match(/name="request_id" value="([^"]+)"/)![1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const result = await fetch(origin + '/oauth/authorize', { method: 'POST', redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams({ request_id, csrf, decision }) });
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  return new URL(result.headers.get('location')!);
}
async function register(origin: string) {
  const response = await fetch(origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test assistant', redirect_uris: ['https://assistant.example/callback'], token_endpoint_auth_method: 'none' }) });
  assert.equal(response.status, 201);
  return (await response.json() as { client_id: string }).client_id;
}
async function authorizationRequest(origin: string, client_id: string) {
  const { createHash } = await import('node:crypto');
  const verifier = randomBytes(32).toString('base64url');
  const params = { client_id, redirect_uri: 'https://assistant.example/callback', resource: origin + '/mcp',
    response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'state123' };
  return { verifier, params, url: new URL(origin + '/oauth/authorize?' + new URLSearchParams(params)) };
}
function form(origin: string, path: string, data: Record<string, string>) {
  return fetch(origin + path, { method: 'POST', body: new URLSearchParams(data), redirect: 'manual' });
}
async function enrolled(origin: string) {
  const client_id = await register(origin), request = await authorizationRequest(origin, client_id);
  const callback = await approve(origin, request.url);
  const exchange = { grant_type: 'authorization_code', client_id, code: callback.searchParams.get('code')!,
    code_verifier: request.verifier, resource: origin + '/mcp', redirect_uri: request.params.redirect_uri };
  const response = await form(origin, '/oauth/token', exchange); assert.equal(response.status, 200);
  return { client_id, exchange, tokens: await response.json() as { access_token: string; refresh_token: string } };
}

test('OAuth rejects redirect injection, missing PKCE, wrong resource, CSRF, and cancellation', async t => {
  const f = await fixture(t), client_id = await register(f.origin), a = await authorizationRequest(f.origin, client_id);
  for (const change of [{ redirect_uri: 'https://evil.example' }, { code_challenge_method: 'plain' }, { resource: 'https://other.example/mcp' }]) {
    const url = new URL(a.url); for (const [k, v] of Object.entries(change)) url.searchParams.set(k, v);
    const response = await fetch(url, { redirect: 'manual' });
    assert.equal(response.status, 400); assert.equal(response.headers.get('location'), null);
  }
  const page = await fetch(a.url), html = await page.text();
  const request_id = html.match(/name="request_id" value="([^"]+)"/)![1], csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const body = new URLSearchParams({ request_id, csrf, decision: 'approve' });
  assert.equal((await fetch(f.origin + '/oauth/authorize', { method: 'POST', headers: { Origin: f.origin }, body })).status, 403);
  assert.equal((await fetch(f.origin + '/oauth/authorize', { method: 'POST', headers: { Origin: 'https://evil.example', Cookie: page.headers.get('set-cookie')!.split(';')[0] }, body })).status, 403);
  for (const origin of [undefined, 'null']) {
    assert.equal((await fetch(f.origin + '/oauth/authorize', { method: 'POST', headers: {
      Cookie: page.headers.get('set-cookie')!.split(';')[0], ...(origin ? { Origin: origin } : {}),
    }, body })).status, 403);
  }
  const denied = await approve(f.origin, a.url, 'deny');
  assert.equal(denied.searchParams.get('error'), 'access_denied'); assert.equal(denied.searchParams.get('state'), 'state123');
  assert.equal(denied.searchParams.get('code'), null);
  const approval = await approve(f.origin, a.url);
  const data = { grant_type: 'authorization_code', client_id, code: approval.searchParams.get('code')!, code_verifier: a.verifier,
    resource: f.origin + '/mcp', redirect_uri: a.params.redirect_uri };
  for (const change of [{ code_verifier: 'a'.repeat(43) }, { resource: 'https://evil.example/mcp' }, { client_id: 'another-app' }, { redirect_uri: 'https://evil.example' }]) {
    assert.equal((await form(f.origin, '/oauth/token', { ...data, ...change })).status, 400);
  }
  assert.equal((await form(f.origin, '/oauth/token', data)).status, 200);
  assert.equal((await form(f.origin, '/oauth/token', data)).status, 400);
  assert.equal((await f.pool.query('SELECT count(*) FROM cinev_clients WHERE revoked_at IS NOT NULL')).rows[0].count, '1');
});

test('OAuth refresh rotation detects replay, revocation removes sessions, and connections remain isolated', async t => {
  const f = await fixture(t), a = await enrolled(f.origin), b = await enrolled(f.origin);
  const alice = await f.client(a.tokens.access_token), bob = await f.client(b.tokens.access_token);
  const rows = (await f.pool.query('SELECT user_id FROM cinev_oauth_grants WHERE app_id=$1', [a.client_id])).rows;
  const user = rows[0].user_id;
  await f.storeFor(user).save({ version: 1, provider: 'cinesunidos', access_token: 'PRIVATE_SESSION', expires_at: Date.now() + 60000 });
  assert.match(JSON.stringify((await alice.callTool({ name: 'get_auth_status' })).structuredContent), /configured/);
  assert.ok(!JSON.stringify((await bob.callTool({ name: 'get_auth_status' })).structuredContent).includes('configured'));
  const data = { grant_type: 'refresh_token', client_id: a.client_id, refresh_token: a.tokens.refresh_token, resource: f.origin + '/mcp' };
  assert.equal((await form(f.origin, '/oauth/token', { ...data, client_id: b.client_id })).status, 400);
  const rotated = await form(f.origin, '/oauth/token', data); assert.equal(rotated.status, 200);
  const next = await rotated.json() as { access_token: string; refresh_token: string };
  assert.equal((await form(f.origin, '/oauth/token', data)).status, 400);
  assert.equal((await fetch(f.origin + '/mcp', { headers: { Authorization: `Bearer ${next.access_token}` } })).status, 401);
  assert.equal(await f.storeFor(user).read('cinesunidos'), undefined);
  assert.equal((await form(f.origin, '/oauth/revoke', { token: b.tokens.refresh_token, client_id: a.client_id })).status, 200);
  assert.ok((await bob.listTools()).tools.length);
  assert.equal((await form(f.origin, '/oauth/revoke', { token: b.tokens.refresh_token, client_id: b.client_id })).status, 200);
  await assert.rejects(bob.listTools());
});

test('OAuth expiry, concurrent redemption, malformed registration and cleanup', async t => {
  const f = await fixture(t), client_id = await register(f.origin), a = await authorizationRequest(f.origin, client_id);
  for (const uri of ['https://example.test/#fragment', 'http://remote.example/callback', 'https://user:pass@example.test/callback', 'javascript:alert(1)']) {
    assert.equal((await fetch(f.origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [uri] }) })).status, 400);
  }
  const code = (await approve(f.origin, a.url)).searchParams.get('code')!;
  const data = { grant_type: 'authorization_code', client_id, code, code_verifier: a.verifier, resource: f.origin + '/mcp', redirect_uri: a.params.redirect_uri };
  const results = await Promise.all([form(f.origin, '/oauth/token', data), form(f.origin, '/oauth/token', data)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  const expired = await authorizationRequest(f.origin, client_id);
  const expiredCode = (await approve(f.origin, expired.url)).searchParams.get('code')!;
  await f.pool.query("UPDATE cinev_oauth_requests SET expires_at=now()-interval '1 second'");
  assert.equal((await form(f.origin, '/oauth/token', { ...data, code: expiredCode, code_verifier: expired.verifier })).status, 400);
  const active = await enrolled(f.origin);
  await f.pool.query("UPDATE cinev_oauth_grants SET expires_at=now()-interval '1 second'");
  assert.equal((await form(f.origin, '/oauth/token', { grant_type: 'refresh_token', client_id: active.client_id, refresh_token: active.tokens.refresh_token, resource: f.origin + '/mcp' })).status, 400);
  await f.links.cleanup();
  assert.equal((await f.pool.query('SELECT count(*) FROM cinev_oauth_grants')).rows[0].count, '0');
  assert.equal((await f.pool.query('SELECT count(*) FROM cinev_oauth_tokens')).rows[0].count, '0');
  assert.ok(await f.users.authenticate(f.alice.token), 'legacy operator access is preserved');
});

test('browser MCP clients discover OAuth without cookies; approval names are escaped and enrollment is rate limited', async t => {
  const f = await fixture(t);
  const headers = { Origin: 'https://assistant.example' };
  const preflight = await fetch(f.origin + '/mcp', { method: 'OPTIONS', headers });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  // Required request headers of protocol 2026-07-28 must pass a browser preflight.
  for (const header of ['mcp-method', 'mcp-name', 'mcp-protocol-version', 'authorization'])
    assert.ok(preflight.headers.get('access-control-allow-headers')!.toLowerCase().split(/,\s*/).includes(header), header);
  // No session or resumption headers: the stateless endpoint never uses them.
  assert.doesNotMatch(preflight.headers.get('access-control-allow-headers')!, /session-id|last-event-id/i);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  for (const origin of ['javascript:alert(1)', 'https://assistant.example/path', 'not an origin'])
    assert.equal((await fetch(f.origin + '/mcp', { method: 'OPTIONS', headers: { Origin: origin } })).status, 403, origin);
  const challenge = await fetch(f.origin + '/mcp', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Cookie: 'cinve=untrusted' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect_account', arguments: { provider: 'cinex' } } }) });
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get('www-authenticate')!, /resource_metadata=/);
  assert.match(challenge.headers.get('access-control-expose-headers')!, /WWW-Authenticate/);
  const metadata = await (await fetch(f.origin + '/.well-known/oauth-protected-resource/mcp', { headers })).json() as { resource: string };
  assert.equal(metadata.resource, f.origin + '/mcp');
  const registered = await fetch(f.origin + '/oauth/register', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: '<script>alert(1)</script>', redirect_uris: ['http://127.0.0.1:8080/callback'] }) });
  assert.equal(registered.status, 201);
  const { client_id } = await registered.json() as { client_id: string };
  const a = await authorizationRequest(f.origin, client_id);
  a.url.searchParams.set('redirect_uri', 'http://127.0.0.1:8080/callback');
  const html = await (await fetch(a.url)).text();
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  await f.pool.query('UPDATE cinev_budgets SET count=10000');
  // An invalid body is refused for free; a valid registration meets the spent quota.
  assert.equal((await fetch(f.origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal((await fetch(f.origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'T', redirect_uris: ['https://assistant.example/callback'] }) })).status, 429);
  await f.pool.query(await migrationSql());
  assert.ok(await f.users.authenticate(f.alice.token), 'migrations can be rerun without invalidating existing access');
});

test('the install guide is served with safe HTTP methods and no downloadable helper exists', async t => {
  const f = await fixture(t);
  const guide = await fetch(f.origin + '/install');
  assert.equal(guide.status, 200); assert.equal(guide.headers.get('cache-control'), 'no-store');
  const text = await guide.text();
  assert.match(text, /available=0 with unknown>0 does NOT mean sold out/);
  assert.match(text, /monospaced text block/);
  assert.equal((await fetch(f.origin + '/install', { method: 'POST' })).status, 405);
  assert.equal((await fetch(f.origin + '/codex-client.mjs')).status, 404);
});

test('consent warns when Cinve cannot vouch for the destination', async t => {
  const f = await fixture(t, undefined, undefined, { clientMetadata });
  const page = async (client_id: string, redirect?: string) => {
    const r = await authorizationRequest(f.origin, client_id);
    if (redirect) r.url.searchParams.set('redirect_uri', redirect);
    const response = await fetch(r.url); assert.equal(response.status, 200);
    // Popup-based OAuth reads the callback through window.opener; same-origin COOP would sever it.
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'unsafe-none');
    return response.text();
  };
  // A registered client with a web redirect can claim any name and destination.
  assert.match(await page(await register(f.origin)), /class="warning" role="alert"><strong>Cinve no puede verificar esta aplicación/);
  // A metadata document whose redirect lives on another site.
  const html = await page('https://assistant.example/oauth/elsewhere.json', 'https://elsewhere.example/callback');
  assert.match(html, /no puede verificar/); assert.match(html, /https:\/\/elsewhere\.example/);
  // Loopback keeps the code on the user's own machine.
  const local = await fetch(f.origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Local CLI', redirect_uris: ['http://127.0.0.1:8080/callback'] }) });
  assert.doesNotMatch(await page((await local.json() as { client_id: string }).client_id, 'http://127.0.0.1:8080/callback'), /no puede verificar/);
});

test('only loopback or the publishing site and its subdomains are recognized destinations', async () => {
  const { recognizedDestination } = await import('../src/oauth.js');
  for (const r of ['http://127.0.0.1:9/cb', 'http://localhost/cb', 'http://[::1]:9/cb']) assert.ok(recognizedDestination(r), r);
  assert.ok(recognizedDestination('https://claude.ai/cb', 'claude.ai'));
  assert.ok(recognizedDestination('https://app.claude.ai/cb', 'claude.ai'));
  for (const r of ['https://evilclaude.ai/cb', 'https://claude.ai.evil.example/cb', 'https://other.example/cb']) assert.ok(!recognizedDestination(r, 'claude.ai'), r);
  assert.ok(!recognizedDestination('https://claude.ai/cb'), 'registered clients have no publisher to match');
});

test('the cinema-login link names the assistant app the account will be attached to', async t => {
  const f = await fixture(t, undefined, undefined, { clientMetadata });
  const registered = await enrolled(f.origin);
  const request = await authorizationRequest(f.origin, metadataUrl), callback = await approve(f.origin, request.url);
  const metadataTokens = await (await form(f.origin, '/oauth/token', { grant_type: 'authorization_code', client_id: metadataUrl,
    code: callback.searchParams.get('code')!, code_verifier: request.verifier, resource: f.origin + '/mcp', redirect_uri: request.params.redirect_uri })).json() as { access_token: string };
  for (const [token, expected] of [[registered.tokens.access_token, { name: 'Test assistant', publisher: null, verified: false }],
    [metadataTokens.access_token, { name: 'Metadata assistant', publisher: 'assistant.example', verified: true }]] as const) {
    const exchanged = await f.post('/connect/exchange', await link(await f.client(token)));
    assert.equal(exchanged.status, 200);
    const body = await exchanged.json() as Record<string, unknown>;
    assert.deepEqual(body.app, expected); assert.ok(!('user_label' in body));
  }
  // A registered local client (loopback only): fine on its own consent page, but not vouched for on a link.
  const local = await fetch(f.origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Local CLI', redirect_uris: ['http://127.0.0.1:8080/callback'] }) });
  const { client_id } = await local.json() as { client_id: string };
  const localRequest = await authorizationRequest(f.origin, client_id);
  localRequest.url.searchParams.set('redirect_uri', 'http://127.0.0.1:8080/callback');
  const localCallback = await approve(f.origin, localRequest.url);
  const localTokens = await (await form(f.origin, '/oauth/token', { grant_type: 'authorization_code', client_id, code: localCallback.searchParams.get('code')!,
    code_verifier: localRequest.verifier, resource: f.origin + '/mcp', redirect_uri: 'http://127.0.0.1:8080/callback' })).json() as { access_token: string };
  const localLink = await f.post('/connect/exchange', await link(await f.client(localTokens.access_token)));
  // A forwarded link must not inherit trust from a loopback redirect anyone can register.
  assert.deepEqual((await localLink.json() as { app: unknown }).app, { name: 'Local CLI', publisher: null, verified: false });
  const script = readFileSync(new URL('../src/client/connect.ts', import.meta.url), 'utf8');
  assert.match(script, /const app = data\.app;/); assert.doesNotMatch(script, /innerHTML/);
});

async function consentForm(origin: string, client_id: string) {
  const request = await authorizationRequest(origin, client_id);
  const page = await fetch(request.url), html = await page.text();
  const fields = { request_id: html.match(/name="request_id" value="([^"]+)"/)![1], csrf: html.match(/name="csrf" value="([^"]+)"/)![1] };
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const submit = (data: Record<string, string>, headers: Record<string, string> = { Origin: origin, Cookie: cookie }) =>
    fetch(origin + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams({ ...fields, ...data }) });
  const exchange = async (location: string) => {
    const code = new URL(location).searchParams.get('code')!;
    const response = await form(origin, '/oauth/token', { grant_type: 'authorization_code', client_id, code, code_verifier: request.verifier,
      resource: origin + '/mcp', redirect_uri: request.params.redirect_uri });
    return { code, response };
  };
  return { html, submit, exchange, cookie };
}
const cinema = { decision: 'connect', provider: 'cinesunidos', username: 'person@example.test' };

test('the consent page signs in to the cinema in the same step, so the assistant is ready on return', async t => {
  let calls = 0;
  const f = await fixture(t, async (...args) => { calls++; return successfulLogin(...args); });
  const consent = await consentForm(f.origin, await register(f.origin));
  assert.match(consent.html, /name="username"[^>]*autocomplete="username"/); assert.match(consent.html, /value="connect">Conectar</);
  // A wrong password re-renders the page with the error and the email, never the password, and issues no code.
  const failed = await consent.submit({ ...cinema, password: 'WRONG_PASSWORD' });
  assert.equal(failed.status, 401); assert.equal(failed.headers.get('location'), null);
  const retry = await failed.text();
  assert.match(retry, /No se pudo iniciar sesión/); assert.match(retry, /value="person@example\.test"/);
  assert.match(retry, /<option value="cinesunidos" selected>/); assert.doesNotMatch(retry, /WRONG_PASSWORD/);
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_sessions')).rowCount, 0);
  const done = await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' });
  assert.equal(done.status, 303); assert.equal(calls, 2);
  const { response } = await consent.exchange(done.headers.get('location')!);
  const tokens = await response.json() as { access_token: string };
  const assistant = await f.client(tokens.access_token);
  const status = (await assistant.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent as { providers: Array<{ provider: string; status: string }> };
  assert.equal(status.providers.find(p => p.provider === 'cinesunidos')!.status, 'configured');
  // The client's automatic retry of connect_account needs no second page.
  assert.deepEqual((await assistant.callTool({ name: 'connect_account', arguments: { provider: 'cinesunidos' } })).structuredContent, { connected: true });
  assert.ok(!/SYNTHETIC|person@example/.test(JSON.stringify((await f.pool.query('SELECT ciphertext FROM cinev_sessions')).rows)));
});

test('consent sign-in is refused without CSRF, rate-limited, and skippable', async t => {
  let calls = 0;
  const f = await fixture(t, async (...args) => { calls++; return successfulLogin(...args); });
  const consent = await consentForm(f.origin, await register(f.origin));
  for (const headers of [{ Origin: f.origin }, { Origin: 'https://evil.example', Cookie: 'x' }] as Record<string, string>[]) {
    assert.equal((await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' }, headers)).status, 403);
  }
  assert.equal((await consent.submit({ ...cinema, provider: 'cinepic', password: 'x' })).status, 400);
  assert.equal(calls, 0, 'nothing reaches the cinema before CSRF and input checks pass');
  for (let i = 0; i < 5; i++) assert.equal((await consent.submit({ ...cinema, password: 'WRONG' })).status, 401);
  const limited = await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' });
  assert.equal(limited.status, 429); assert.equal(calls, 5); assert.match(await limited.text(), /Demasiados intentos/);
  // Skipping the cinema still authorizes the assistant, with no account attached.
  const skipped = await consent.submit({ decision: 'approve' });
  assert.equal(skipped.status, 303);
  const { response } = await consent.exchange(skipped.headers.get('location')!);
  assert.equal(response.status, 200);
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_sessions')).rowCount, 0);
});

test('a cinema connected on consent is dropped if the code is never exchanged, and revoked on code replay', async t => {
  const f = await fixture(t, successfulLogin);
  const abandoned = await consentForm(f.origin, await register(f.origin));
  assert.equal((await abandoned.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })).status, 303);
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_sessions')).rowCount, 1);
  await f.pool.query("UPDATE cinev_oauth_requests SET expires_at=now()-interval '1 second'");
  await f.links.cleanup();
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_sessions')).rowCount, 0);
  const users = (await f.pool.query('SELECT count(*)::int AS n FROM cinev_clients')).rows[0].n;
  assert.equal(users, 2, 'only the two operator-issued fixture users remain');
  const replayed = await consentForm(f.origin, await register(f.origin));
  const done = await replayed.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' });
  const location = done.headers.get('location')!;
  assert.equal((await replayed.exchange(location)).response.status, 200);
  assert.equal((await replayed.exchange(location)).response.status, 400);
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_sessions')).rowCount, 0, 'replay revokes the connection and its session');
});

test('a session the cinema rejects early is dropped, so connect_account offers a new link instead of looping', async t => {
  let upstream = 200;
  const f = await fixture(t, successfulLogin, async () => new Response(upstream === 200 ? '["Caracas"]' : 'denied', { status: upstream }));
  const alice = await f.client(f.alice.token);
  const exchanged = await f.post('/connect/exchange', await link(alice));
  const { browser_token } = await exchanged.json() as { browser_token: string };
  assert.equal((await f.post('/connect/login', browser_token, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' })).status, 200);
  assert.deepEqual((await alice.callTool({ name: 'connect_account', arguments: { provider: 'cinesunidos' } })).structuredContent, { connected: true });
  upstream = 401; // The cinema ended the session long before its stored expiry.
  const prices = await alice.callTool({ name: 'get_ticket_prices', arguments: { provider: 'cinesunidos', cinema_id: '1', session_id: '1' } });
  assert.equal((prices.structuredContent as { status: string }).status, 'auth_required');
  const again = (await alice.callTool({ name: 'connect_account', arguments: { provider: 'cinesunidos' } })).structuredContent as { connected: boolean; url?: string };
  assert.equal(again.connected, false); assert.ok(again.url);
});

test('discarding a rejected session never removes one saved by a reconnection meanwhile', async t => {
  const f = await fixture(t);
  const session = (token: string) => ({ version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: token });
  await f.storeFor(f.alice.id).save(session('OLD'));
  const inFlight = f.storeFor(f.alice.id);
  assert.equal((await inFlight.read('cinesunidos'))!.access_token, 'OLD');
  await f.storeFor(f.alice.id).save(session('NEW'));
  await inFlight.discardRejected('cinesunidos');
  assert.equal((await f.storeFor(f.alice.id).read('cinesunidos'))!.access_token, 'NEW');
  await inFlight.read('cinesunidos'); await inFlight.discardRejected('cinesunidos');
  assert.equal(await f.storeFor(f.alice.id).read('cinesunidos'), undefined);
});

test('a double submit signs in once and still sends the browser back to the assistant', async t => {
  let calls = 0;
  const slowLogin: typeof login = async (...args) => { calls++; await new Promise(r => setTimeout(r, 400)); return successfulLogin(...args); };
  const f = await fixture(t, slowLogin);
  const consent = await consentForm(f.origin, await register(f.origin));
  const [first, second] = await Promise.all([1, 2].map(() => consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })));
  assert.deepEqual([first.status, second.status], [303, 303]);
  assert.equal(calls, 1, 'the second submit waits for the first sign-in instead of running another');
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_sessions')).rowCount, 1);
  // Whichever response the browser kept, exactly one code is current and it carries the connection.
  const results = [];
  for (const r of [first, second]) results.push((await consent.exchange(r.headers.get('location')!)).response.status);
  assert.deepEqual(results.sort(), [200, 400]);
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_oauth_grants g JOIN cinev_sessions s ON s.user_id=g.user_id')).rowCount, 1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM cinev_clients')).rows[0].n, 3, 'no orphaned connection');
});

test('waiting duplicate submits do not use up the per-address sign-in budget, and a flood of them is bounded', async t => {
  let calls = 0;
  const slowLogin: typeof login = async (...args) => { calls++; await new Promise(r => setTimeout(r, 300)); return successfulLogin(...args); };
  const f = await fixture(t, slowLogin);
  const consent = await consentForm(f.origin, await register(f.origin));
  // Repeated clicks: every response sends the browser on, whichever one it keeps.
  const clicks = await Promise.all(Array.from({ length: 8 }, () => consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })));
  assert.ok(clicks.every(r => r.status === 303), `8 duplicate submits: ${clicks.map(r => r.status).join(',')}`);
  assert.equal(calls, 1);
  // A flood: at most 8 submits of one approval wait (each polls the database).
  const flood = await consentForm(f.origin, await register(f.origin));
  const many = await Promise.all(Array.from({ length: 25 }, () => flood.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })));
  const statuses = many.map(r => r.status);
  assert.equal(statuses.filter(s => s === 303).length, 9, `the sign-in and 8 waiters: ${statuses.join(',')}`);
  assert.equal(statuses.filter(s => s === 429).length, 16);
  assert.equal(calls, 2);
});

test('approving while a cinema sign-in is running wins cleanly, and the attempt cap spans the whole request', async t => {
  const slowLogin: typeof login = async (...args) => { await new Promise(r => setTimeout(r, 300)); return successfulLogin(...args); };
  const f = await fixture(t, slowLogin);
  const consent = await consentForm(f.origin, await register(f.origin));
  const connecting = consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' });
  await new Promise(r => setTimeout(r, 50));
  const approved = await consent.submit({ decision: 'approve' });
  assert.equal(approved.status, 303);
  assert.equal((await connecting).status, 400, 'the slower sign-in is discarded, not attached');
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_sessions')).rowCount, 0);
  assert.equal((await consent.exchange(approved.headers.get('location')!)).response.status, 200);
  // Five failed sign-ins per request in total, even when the per-minute budgets reset.
  const capped = await consentForm(f.origin, await register(f.origin));
  for (let i = 0; i < 5; i++) {
    assert.equal((await capped.submit({ ...cinema, password: 'WRONG' })).status, 401);
    await f.pool.query('DELETE FROM cinev_budgets');
  }
  assert.equal((await capped.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })).status, 429);
});

test('cleanup keeps exchanged connections and apps with a pending request', async t => {
  const f = await fixture(t, successfulLogin);
  const consent = await consentForm(f.origin, await register(f.origin));
  const done = await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' });
  assert.equal((await consent.exchange(done.headers.get('location')!)).response.status, 200);
  const pending = await consentForm(f.origin, await register(f.origin));
  await f.pool.query("UPDATE cinev_oauth_apps SET created_at=now()-interval '200 days', last_used_at=NULL");
  await f.pool.query("UPDATE cinev_oauth_requests SET expires_at=now()-interval '1 second' WHERE consumed_at IS NOT NULL");
  await f.links.cleanup();
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_sessions')).rowCount, 1, 'an exchanged connection survives its request');
  const ok = await pending.submit({ decision: 'approve' });
  assert.equal(ok.status, 303, 'an old app with a pending request is not deleted under it');
  assert.equal((await pending.exchange(ok.headers.get('location')!)).response.status, 200);
});

test('only a refusal of the session own credentials marks it rejected', async () => {
  const { HttpClient } = await import('../src/http.js');
  const { SessionStore } = await import('../src/auth.js');
  const sessions = new class extends SessionStore {
    override async read() { return { version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: 'T' }; }
  }();
  const make = (status: number, body = '{}') => new HttpClient(async () => new Response(body, { status }), 5000, sessions);
  const seats = 'https://www.cinesunidos.com/api/seats?theaterId=1&showTimeId=2';
  const publicUrl = 'https://www.cinesunidos.com/api/cities';
  const ok = make(200); await ok.getAuthenticated('cinesunidos', seats);
  assert.equal(ok.rejectedSessions.size, 0);
  const publicDenied = make(401); await publicDenied.get(publicUrl).catch(() => {});
  assert.equal(publicDenied.rejectedSessions.size, 0, 'a public 401 says nothing about the session');
  const denied = make(401); await denied.getAuthenticated('cinesunidos', seats).catch(() => {});
  assert.ok(denied.rejectedSessions.has('cinesunidos'));
  const cinex = new HttpClient(async () => new Response('off'), 5000, new class extends SessionStore {
    override async headers() { return { Cookie: 'PHPSESSID=x' }; }
  }());
  await cinex.getAuthenticated('cinex', 'https://www.cinex.com.ve/checklogin.php');
  assert.ok(cinex.rejectedSessions.has('cinex'), 'Cinex reports an ended session with 200 and a body other than "on"');
});

test('cleanup never orphans a connection whose request row is locked while it runs', async t => {
  const f = await fixture(t, successfulLogin);
  const consent = await consentForm(f.origin, await register(f.origin));
  assert.equal((await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })).status, 303);
  await f.pool.query("UPDATE cinev_oauth_requests SET expires_at=now()-interval '1 second'");
  const holder = await f.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM cinev_oauth_requests FOR UPDATE'); // e.g. a late /oauth/token retry
    await f.links.cleanup(); // must not block, and must not drop the request while keeping its connection
    await holder.query('ROLLBACK');
  } finally { holder.release(); }
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_oauth_requests')).rowCount, 1, 'kept for the next cleanup');
  await f.links.cleanup();
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_sessions')).rowCount, 0);
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_oauth_requests')).rowCount, 0);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM cinev_clients')).rows[0].n, 2);
});

test('every HTML page allows only its own stylesheet, never inline styles', async t => {
  const f = await fixture(t);
  const client_id = await register(f.origin);
  const pages = [f.origin + '/', f.origin + '/connect', f.origin + '/instrucciones', f.origin + '/privacidad', (await authorizationRequest(f.origin, client_id)).url.href, f.origin + '/oauth/authorize?client_id=unknown'];
  const install = await fetch(f.origin + '/install', { headers: { Accept: 'text/html' } });
  for (const r of [...await Promise.all(pages.map(u => fetch(u))), install]) {
    const csp = r.headers.get('content-security-policy')!, html = await r.text();
    assert.match(r.headers.get('content-type')!, /text\/html/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(csp, /style-src 'self'/, r.url);
    assert.doesNotMatch(html, /<style[\s>]/); assert.doesNotMatch(html, /\sstyle=/);
    assert.match(csp, /frame-ancestors 'none'/);
  }
});

test('the install page carries security headers even when served before the hosted app', async () => {
  const { serveInstall } = await import('../src/install.js');
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; }, writeHead() {}, end() {} };
  assert.ok(serveInstall({ url: '/install', method: 'GET', headers: { accept: 'text/html' } } as never, res as never, 'https://cinve.example'));
  assert.match(headers['content-security-policy'], /default-src 'none'.*frame-ancestors 'none'/);
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.match(headers['permissions-policy'], /camera=\(\).*geolocation=\(\).*microphone=\(\)/);
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(headers['cross-origin-embedder-policy'], 'require-corp');
});

test('public pages use the configured origin and serve local fonts under the authorization policy', async t => {
  const f = await fixture(t);
  const home = await fetch(f.origin + '/?from=portfolio');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes(`Instala Cinve siguiendo ${f.origin}/install`));
  assert.ok(html.includes('lang="es"'));
  const ogImage = html.match(/property="og:image" content="([^"]+)"/)![1];
  assert.match(ogImage, new RegExp(`^${f.origin}/og\\.png\\?v=[0-9a-f]{10}$`));
  assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
  const social = await fetch(ogImage);
  assert.equal(social.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await social.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(home.headers.get('content-security-policy')?.includes("font-src 'self'"));
  const policy = home.headers.get('content-security-policy')!;
  assert.match(policy, /style-src 'self'/); assert.doesNotMatch(policy, /unsafe-inline/);
  const stylesheet = html.match(/<link rel="stylesheet" href="(\/assets\/basecoat\.css\?v=[0-9a-f]{10})">/)![1];
  const compressed = await fetch(f.origin + stylesheet, { headers: { 'Accept-Encoding': 'br' } });
  assert.match(compressed.headers.get('content-type')!, /text\/css/); assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
  assert.ok((await compressed.text()).includes('.btn'));
  const font = await fetch(f.origin + '/assets/instrument-sans.woff2');
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
  const browser = await fetch(f.origin + '/install', { headers: { Accept: 'text/html' } });
  assert.match(browser.headers.get('content-type')!, /text\/html/);
  assert.ok((await browser.text()).includes(`${f.origin}/mcp`));
  const agent = await fetch(f.origin + '/install');
  assert.match(agent.headers.get('content-type')!, /text\/plain/);
  assert.ok((await agent.text()).includes('Cinve MCP installation'));
  const raw = await fetch(f.origin + '/install?format=text', { headers: { Accept: 'text/html' } });
  assert.match(raw.headers.get('content-type')!, /text\/plain/);
  const error = await fetch(f.origin + '/oauth/authorize');
  assert.equal(error.status, 400);
  assert.ok((await error.text()).includes('No se pudo autorizar la conexión.'));
});

test('one address exhausting its OAuth quota cannot consume the shared OAuth quota', async t => {
  const f = await fixture(t);
  const { digest } = await import('../src/hosted-store.js');
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',61)", [f.links.keyHash('oauth:127.0.0.1')]);
  const registration = () => fetch(f.origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'T', redirect_uris: ['https://assistant.example/callback'] }) });
  for (let i = 0; i < 20; i++) assert.equal((await registration()).status, 429);
  const global = await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=ANY($1)', [['oauth:global', 'oauth:register:global'].map(k => f.links.keyHash(k))]);
  assert.equal(global.rows.length, 0, 'rejected requests must not charge the global budget');
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
      } }, res => { res.resume(); resolve(res.statusCode!); });
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
  const { digest } = await import('../src/hosted-store.js');
  const anonymous = await f.client();
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',10)", [f.links.keyHash('refresh:anonymous:127.0.0.1')]);
  await assert.rejects(anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } }));
  const cached = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal((cached.structuredContent as { status: string }).status, 'available');
});

test('cleanup removes stale anonymous OAuth registrations but keeps used or recent ones', async t => {
  const f = await fixture(t);
  const stale = await register(f.origin), recent = await register(f.origin), used = await enrolled(f.origin);
  await f.pool.query("UPDATE cinev_oauth_apps SET created_at=now()-interval '100 days' WHERE id=ANY($1)", [[stale, used.client_id]]);
  assert.ok((await f.pool.query('SELECT last_used_at FROM cinev_oauth_apps WHERE id=$1', [used.client_id])).rows[0].last_used_at, 'token issuance records use');
  await f.links.cleanup();
  const left = (await f.pool.query('SELECT id FROM cinev_oauth_apps')).rows.map(r => r.id).sort();
  assert.deepEqual(left, [recent, used.client_id].sort());
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
  assert.equal((r.structuredContent as { status: string }).status, 'available', 'slots held by stalled bodies were released');
});

test('daily cleanup still completes on a deployment that precedes migration 003', async t => {
  const f = await fixture(t);
  await f.pool.query('ALTER TABLE cinev_oauth_apps DROP COLUMN last_used_at');
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES('stale',now()-interval '1 minute',1)");
  await f.links.cleanup();
  assert.equal((await f.pool.query("SELECT count(*) FROM cinev_budgets WHERE key_hash='stale'")).rows[0].count, '0');
  await f.pool.query(await migrationSql());
});

test('clients can identify with a Client ID Metadata Document instead of registering', async t => {
  const f = await fixture(t, undefined, undefined, { clientMetadata });
  const metadata = await (await fetch(f.origin + '/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
  assert.equal(metadata.client_id_metadata_document_supported, true);
  const request = await authorizationRequest(f.origin, metadataUrl);
  const page = await (await fetch(request.url)).text();
  assert.match(page, /Metadata assistant/); assert.match(page, /publicada por <strong>assistant\.example<\/strong>\. Continúa solo si reconoces ese sitio/);
  assert.doesNotMatch(page, /no puede verificar/, 'a redirect on the publishing site is recognized');
  const callback = await approve(f.origin, request.url);
  const exchange = { grant_type: 'authorization_code', client_id: metadataUrl, code: callback.searchParams.get('code')!,
    code_verifier: request.verifier, resource: f.origin + '/mcp', redirect_uri: request.params.redirect_uri };
  const tokens = await (await form(f.origin, '/oauth/token', exchange)).json() as { access_token: string; refresh_token: string };
  assert.match(tokens.access_token, /^cva_/);
  const status = await (await f.client(tokens.access_token)).callTool({ name: 'get_auth_status', arguments: {} });
  assert.equal((status.structuredContent as { connection: { client_authorized: boolean } }).connection.client_authorized, true);
  const refreshed = await form(f.origin, '/oauth/token', { grant_type: 'refresh_token', client_id: metadataUrl, refresh_token: tokens.refresh_token, resource: f.origin + '/mcp' });
  assert.equal(refreshed.status, 200);
  // Documents that do not match their URL, carry a secret, or cannot be fetched are refused
  // without redirecting, and so is a redirect URI the document does not list.
  for (const client_id of ['https://assistant.example/oauth/wrong-id.json', 'https://assistant.example/oauth/secret.json',
    'https://assistant.example/oauth/confidential.json', 'https://assistant.example/oauth/missing.json']) {
    const response = await fetch((await authorizationRequest(f.origin, client_id)).url, { redirect: 'manual' });
    assert.equal(response.status, 400, client_id); assert.equal(response.headers.get('location'), null);
  }
  const unlisted = new URL(request.url); unlisted.searchParams.set('redirect_uri', 'https://evil.example/callback');
  const response = await fetch(unlisted, { redirect: 'manual' });
  assert.equal(response.status, 400); assert.equal(response.headers.get('location'), null);
});

test('crawlers get robots.txt, a sitemap of the public pages and llms.txt; browsers get an HTML 404', async t => {
  const f = await fixture(t);
  const robots = await fetch(f.origin + '/robots.txt');
  assert.equal(robots.status, 200); const rules = await robots.text();
  assert.match(rules, /Disallow: \/connect\//); assert.doesNotMatch(rules, /Disallow: \/connect\n/);
  assert.match(rules, new RegExp(`Sitemap: ${f.origin}/sitemap.xml`));
  const map = await (await fetch(f.origin + '/sitemap.xml')).text();
  for (const path of ['/', '/install', '/instrucciones', '/privacidad']) assert.ok(map.includes(`<loc>${f.origin}${path}</loc>`), path);
  assert.doesNotMatch(map, /connect|oauth/);
  const llms = await (await fetch(f.origin + '/llms.txt')).text();
  assert.match(llms, /^# Cinve/); assert.ok(llms.includes(`${f.origin}/privacidad`));
  const security = await (await fetch(f.origin + '/.well-known/security.txt')).text();
  assert.match(security, /^Contact: https:\/\/github\.com\/0bkevin\/cinve\/security\/advisories\/new$/m);
  assert.match(security, new RegExp(`^Canonical: ${f.origin}/\\.well-known/security\\.txt$`, 'm'));
  const expires = Date.parse(security.match(/^Expires: (\S+)$/m)![1]);
  assert.ok(expires > Date.now() && expires < Date.now() + 365 * 86400000);
  const page = await fetch(f.origin + '/nope', { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 404); assert.match(await page.text(), /noindex/);
  const api = await fetch(f.origin + '/nope');
  assert.equal(api.status, 404); assert.match(api.headers.get('content-type')!, /json/);
});

test('public pages may be cached briefly by the CDN; the agent guide and private pages may not', async t => {
  const f = await fixture(t);
  const html = { headers: { Accept: 'text/html' } };
  for (const path of ['/', '/instrucciones', '/privacidad', '/install']) assert.match((await fetch(f.origin + path, html)).headers.get('cache-control')!, /s-maxage=300/, path);
  assert.equal((await fetch(f.origin + '/install')).headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(f.origin + '/connect', html)).headers.get('cache-control'), 'no-store');
});

test('rate limits group an IPv6 subscriber by /64 and keep IPv4 per address', async () => {
  const { rateLimitNetwork } = await import('../src/hosted.js');
  assert.equal(rateLimitNetwork('203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitNetwork('::ffff:203.0.113.7'), '203.0.113.7');
  const network = rateLimitNetwork('2001:db8:1:2::1');
  assert.equal(network, '2001:0db8:0001:0002::/64');
  assert.equal(rateLimitNetwork('2001:0db8:0001:0002:ffff:eeee:dddd:cccc'), network);
  assert.notEqual(rateLimitNetwork('2001:db8:1:3::1'), network);
  assert.equal(rateLimitNetwork('unknown'), 'unknown');
  assert.equal(rateLimitNetwork('attacker-chosen text'), 'unknown');
});

test('connection-link sign-ins are charged to the network, and failures and successes are recorded', async t => {
  let calls = 0, accept = false;
  const f = await fixture(t, async (...args) => { calls++; if (!accept) throw new Error('rejected'); return successfulLogin(...args); });
  const { digest } = await import('../src/hosted-store.js');
  const client = await f.client(f.alice.token);
  const browser = async () => ((await (await f.post('/connect/exchange', await link(client))).json()) as { browser_token: string }).browser_token;
  const count = async (key: string) => (await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=$1', [f.links.keyHash(key)])).rows[0]?.count ?? 0;
  // Each self-service connection has its own link budget; the network quota still applies.
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',20)", [f.links.keyHash('oauth:login-ip:127.0.0.1')]);
  const limited = await f.post('/connect/login', await browser(), { username: 'x', password: 'x' });
  assert.equal(limited.status, 429); assert.equal(calls, 0); assert.match(await limited.text(), /desde tu red/);
  await f.pool.query('DELETE FROM cinev_budgets');
  // Malformed requests never reach admission.
  assert.equal((await f.post('/connect/login', await browser(), { username: 'x' })).status, 400);
  assert.equal(await count('oauth:login-ip:127.0.0.1'), 0);
  assert.equal((await f.post('/connect/login', await browser(), { username: 'Person@Example.test', password: 'WRONG' })).status, 401);
  assert.equal(await count('signin-fail:day:127.0.0.1'), 1);
  assert.equal(await count('signin-fail:global'), 1);
  assert.equal(await count('signin:account:cinesunidos:person@example.test'), 1);
  accept = true;
  assert.equal((await f.post('/connect/login', await browser(), { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' })).status, 200);
  assert.equal(await count('signin:account:cinesunidos:person@example.test'), 2, 'a success clears nothing, so it cannot be observed');
  assert.equal(await count(`signin:known:cinesunidos:person@example.test:principal:${f.alice.id}`), 1, 'it marks the connection as the account\'s owner');
  assert.equal(await count('signin-fail:day:127.0.0.1'), 1, 'a success never clears network failures');
});

test('one cinema account gets five attempts per 15 minutes, from any network and in any letter case', async t => {
  const f = await fixture(t);
  const account = (username: string, n: number) => ({ network: `198.51.100.${n}`, provider: 'cinex' as const, username });
  const admitted = await Promise.all(Array.from({ length: 8 }, (_, i) => f.links.admitSignIn(account(i % 2 ? 'Victim@Example.test' : 'victim@example.test ', i))));
  assert.equal(admitted.filter(r => r === undefined).length, 5, 'parallel guesses cannot overshoot');
  assert.ok(admitted.filter(Boolean).every(r => r === 'account'));
  assert.equal(await f.links.admitSignIn(account('other@example.test', 9)), undefined);
  assert.equal(await f.links.admitSignIn({ ...account('victim@example.test', 9), provider: 'cinesunidos' }), undefined, 'accounts are per cinema');
  await f.links.signInSucceeded({ ...account('VICTIM@example.test', 0), proofs: ['principal:owner'] });
  assert.equal(await f.links.admitSignIn({ ...account('victim@example.test', 10), proofs: ['principal:owner'] }), undefined, 'the owner is not locked out, from any network');
  assert.equal(await f.links.admitSignIn(account('victim@example.test', 0)), 'account', 'a success does not reopen the account to others, even on its network');
  assert.equal(await f.links.admitSignIn({ ...account('victim@example.test', 0), proofs: ['principal:someone-else'] }), 'account');
});

test('under a broad failing attack only networks without recent failures may sign in', async t => {
  const f = await fixture(t);
  const { digest } = await import('../src/hosted-store.js');
  const subject = (network: string, username: string) => ({ network, provider: 'cinex' as const, username });
  await f.links.signInFailed(subject('203.0.113.1', 'a@example.test'));
  await f.pool.query("UPDATE cinev_budgets SET count=300 WHERE key_hash=$1", [f.links.keyHash('signin-fail:global')]);
  assert.equal(await f.links.admitSignIn(subject('203.0.113.1', 'b@example.test')), 'strained');
  assert.equal(await f.links.admitSignIn(subject('203.0.113.2', 'c@example.test')), undefined, 'a clean network still signs in');
  // Below the threshold a single failure blocks nobody.
  await f.pool.query("UPDATE cinev_budgets SET count=299 WHERE key_hash=$1", [f.links.keyHash('signin-fail:global')]);
  assert.equal(await f.links.admitSignIn(subject('203.0.113.1', 'd@example.test')), undefined);
});

test('networks have daily failure limits, and IPv6 /64s also share their /48', async t => {
  const f = await fixture(t);
  const { digest } = await import('../src/hosted-store.js');
  const { rateLimitNetwork } = await import('../src/hosted.js');
  const subject = (address: string, username: string) => ({ network: rateLimitNetwork(address), provider: 'cinex' as const, username });
  const fill = (key: string, count: number, interval = '1 day') =>
    f.pool.query(`INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '${interval}',$2)`, [f.links.keyHash(key), count]);
  await fill('signin-fail:day:203.0.113.5', 100);
  // Past the daily cap only a slow lane remains: one attempt per minute.
  assert.equal(await f.links.admitSignIn(subject('203.0.113.5', 'a@example.test')), undefined);
  assert.equal(await f.links.admitSignIn(subject('203.0.113.5', 'a2@example.test')), 'network');
  await fill('signin-fail:day:2001:0db8:0001::/48', 300);
  assert.equal(await f.links.admitSignIn(subject('2001:db8:1:7::1', 'b@example.test')), undefined);
  assert.equal(await f.links.admitSignIn(subject('2001:db8:1:8::1', 'b2@example.test')), undefined, 'two per /48');
  assert.equal(await f.links.admitSignIn(subject('2001:db8:1:9::1', 'b3@example.test')), 'network', 'a fresh /64 in a failing /48');
  assert.equal(await f.links.admitSignIn(subject('2001:db8:2:7::1', 'c@example.test')), undefined);
  await fill('signin:block:2001:0db8:0003::/48', 60, '1 minute');
  assert.equal(await f.links.admitSignIn(subject('2001:db8:3:9::1', 'd@example.test')), 'network', 'per-minute /48 attempts');
  // Failures from a /64 are counted for its /48 too.
  await f.links.signInFailed(subject('2001:db8:4:1::1', 'e@example.test'));
  const rows = await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=ANY($1)', [['signin-fail:day:2001:0db8:0004:0001::/64', 'signin-fail:day:2001:0db8:0004::/48'].map(k => f.links.keyHash(k))]);
  assert.deepEqual(rows.rows.map(r => r.count), [1, 1]);
});

test('refresh=true also has separate service-wide budgets across addresses', async t => {
  const f = await fixture(t);
  for (const [client, key] of [[await f.client(), 'refresh:global:anon'], [await f.client(f.alice.token), 'refresh:global']] as const) {
    await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',120)", [f.links.keyHash(key)]);
    await assert.rejects(client.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } }));
    const cached = await client.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
    assert.equal((cached.structuredContent as { status: string }).status, 'available');
  }
});

test('an exhausted anonymous global refresh budget does not block authenticated refreshes', async t => {
  const f = await fixture(t, undefined, undefined, { trustedVercelProxy: true });
  const refresh = (network: string) => fetch(f.origin + '/mcp', from(network, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } } }) }));
  // Twelve anonymous callers spend ten refreshes each, staying within their per-caller caps.
  for (let i = 0; i < 120; i++) {
    const response = await refresh(`203.0.113.${1 + Math.floor(i / 10)}`);
    assert.equal(response.status, 200);
    await response.text();
  }
  const blocked = await refresh('203.0.113.13');
  assert.equal(blocked.status, 429, 'a fresh anonymous caller is held back by the global cap');
  assert.match(await blocked.text(), /Demasiadas consultas con refresh=true/);
  const alice = await f.client(f.alice.token);
  const result = await alice.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } });
  assert.equal((result.structuredContent as { status: string }).status, 'available');
});

test('HTTPS responses send HSTS for the host and its subdomains; plain HTTP sends none', async () => {
  const { setSecurityHeaders } = await import('../src/public-web.js');
  const headers = (https: boolean) => {
    const set = new Map<string, string>();
    setSecurityHeaders({ setHeader: (k: string, v: string) => set.set(k, v) } as never, https);
    return set;
  };
  assert.equal(headers(true).get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
  assert.equal(headers(false).has('Strict-Transport-Security'), false);
});

test('access tokens are signed: forgeries are refused without a database query, valid ones still checked', async t => {
  const f = await fixture(t);
  const { digest } = await import('../src/hosted-store.js');
  const { tokens } = await enrolled(f.origin);
  assert.match(tokens.access_token, /^cva_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  const authorized = async (token: string) => ((await (await f.client(token)).callTool({ name: 'get_auth_status', arguments: {} }))
    .structuredContent as { connection: { client_authorized: boolean } }).connection.client_authorized;
  assert.equal(await authorized(tokens.access_token), true);
  const forged = tokens.access_token.slice(0, -1) + (tokens.access_token.endsWith('A') ? 'B' : 'A');
  // Let the MCP client's background notifications land before measuring.
  await new Promise(resolve => setTimeout(resolve, 100));
  const query = f.pool.query.bind(f.pool); let queries = 0;
  f.pool.query = ((...args: Parameters<typeof query>) => { queries++; return query(...args); }) as typeof f.pool.query;
  const headers = { Authorization: `Bearer ${forged}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const refused = await fetch(f.origin + '/mcp', { method: 'POST', headers, body: '{}' });
  f.pool.query = query;
  assert.equal(refused.status, 401); assert.equal(queries, 0, 'a forged token never reaches Postgres');
  // A token issued before signing keeps working until the cutoff, via the database.
  const { rows } = await f.pool.query('SELECT user_id FROM cinev_oauth_tokens WHERE token_hash=$1', [digest(tokens.access_token)]);
  const legacy = 'cva_' + randomBytes(32).toString('base64url');
  await f.pool.query("INSERT INTO cinev_oauth_tokens(token_hash,user_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')", [digest(legacy), rows[0].user_id]);
  assert.equal(await authorized(legacy), true);
  // Revocation is still enforced for a correctly signed token.
  await f.pool.query('UPDATE cinev_clients SET revoked_at=now() WHERE id=$1', [rows[0].user_id]);
  await assert.rejects(f.client(tokens.access_token));
});

test('the access token format is judged in memory, and unsigned tokens stop at the cutoff', async () => {
  const { accessTokenFormat } = await import('../src/oauth.js');
  const { createHmac } = await import('node:crypto');
  const key = randomBytes(32), id = randomBytes(32).toString('base64url');
  const signed = `cva_${id}.${createHmac('sha256', key).update('cva_' + id).digest('base64url')}`;
  assert.equal(accessTokenFormat(signed, key), 'signed');
  assert.equal(accessTokenFormat(signed, randomBytes(32)), undefined, 'another key');
  assert.equal(accessTokenFormat(`cva_${randomBytes(32).toString('base64url')}.${signed.split('.')[1]}`, key), undefined, 'a signature moved to another id');
  const legacy = 'cva_' + id;
  assert.equal(accessTokenFormat(legacy, key, 1000, 999), 'legacy');
  assert.equal(accessTokenFormat(legacy, key, 1000, 1000), undefined);
  for (const bad of ['', 'cva_', signed + 'x', 'cvr_' + id, `cva_${id}.`]) assert.equal(accessTokenFormat(bad, key), undefined);
});

test('repeated failed credential lookups are refused in memory, without holding back signed tokens', async t => {
  const f = await fixture(t);
  const { tokens } = await enrolled(f.origin);
  const mcp = (token: string) => fetch(f.origin + '/mcp', { method: 'POST', body: '{}',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } });
  // Unsigned (legacy-format) tokens need a database lookup to be judged.
  const fake = () => 'cva_' + randomBytes(32).toString('base64url');
  for (let i = 0; i < 30; i++) assert.equal((await mcp(fake())).status, 401);
  const query = f.pool.query.bind(f.pool); let queries = 0;
  f.pool.query = ((...args: Parameters<typeof query>) => { queries++; return query(...args); }) as typeof f.pool.query;
  const held = await mcp(fake());
  const link = await f.post('/connect/exchange', randomBytes(32).toString('hex'));
  f.pool.query = query;
  assert.equal(held.status, 429); assert.equal(link.status, 429);
  assert.equal(queries, 0, 'refused before any database work');
  // Others' failures on a shared address never block a validly signed token.
  const status = await (await f.client(tokens.access_token)).callTool({ name: 'get_auth_status', arguments: {} });
  assert.equal((status.structuredContent as { connection: { client_authorized: boolean } }).connection.client_authorized, true);
});

test('refresh tokens are signed: forgeries are refused and revocations ignored without touching token tables', async t => {
  const f = await fixture(t);
  const { digest } = await import('../src/hosted-store.js');
  const { client_id, tokens } = await enrolled(f.origin);
  assert.match(tokens.refresh_token, /^cvr_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  const refresh = (refresh_token: string) => form(f.origin, '/oauth/token', { grant_type: 'refresh_token', client_id, refresh_token, resource: f.origin + '/mcp' });
  const forged = tokens.refresh_token.slice(0, -1) + (tokens.refresh_token.endsWith('A') ? 'B' : 'A');
  const query = f.pool.query.bind(f.pool), connect = f.pool.connect.bind(f.pool), texts: string[] = []; let connections = 0;
  f.pool.query = ((...args: Parameters<typeof query>) => { texts.push(String(args[0])); return query(...args); }) as typeof f.pool.query;
  // pool.query connects with a callback; a transaction connects through the promise form.
  f.pool.connect = ((...args: unknown[]) => { if (!args.length) connections++; return (connect as (...a: unknown[]) => unknown)(...args); }) as typeof f.pool.connect;
  const refused = await refresh(forged);
  const revoked = await form(f.origin, '/oauth/revoke', { token: forged, client_id });
  f.pool.query = query; f.pool.connect = connect;
  assert.equal(refused.status, 400); assert.equal((await refused.json() as { error: string }).error, 'invalid_grant');
  assert.equal(revoked.status, 200);
  assert.equal(connections, 0, 'no transaction is opened');
  assert.deepEqual(texts, [], 'not even a rate-limit write');
  // The genuine token was not affected by the forgery, and still rotates.
  const rotated = await refresh(tokens.refresh_token);
  assert.equal(rotated.status, 200);
  const next = await rotated.json() as { access_token: string; refresh_token: string };
  // An unsigned refresh token issued before signing still rotates until the cutoff, into a signed one.
  const { rows } = await f.pool.query('SELECT user_id FROM cinev_oauth_tokens WHERE token_hash=$1', [digest(next.access_token)]);
  const legacy = 'cvr_' + randomBytes(32).toString('base64url');
  await f.pool.query(`INSERT INTO cinev_oauth_tokens(token_hash,user_id,kind,expires_at)
    VALUES($1,$2,'refresh',(SELECT expires_at FROM cinev_oauth_grants WHERE user_id=$2))`, [digest(legacy), rows[0].user_id]);
  const fromLegacy = await refresh(legacy);
  assert.equal(fromLegacy.status, 200);
  assert.match((await fromLegacy.json() as { refresh_token: string }).refresh_token, /^cvr_[A-Za-z0-9_-]{43}\./);
});

test('refresh token formats are judged in memory and never accept an access signature', async () => {
  const { refreshTokenFormat, accessTokenFormat } = await import('../src/oauth.js');
  const { createHmac } = await import('node:crypto');
  const key = randomBytes(32), id = randomBytes(32).toString('base64url');
  const mac = (prefix: string) => createHmac('sha256', key).update(prefix + id).digest('base64url');
  assert.equal(refreshTokenFormat(`cvr_${id}.${mac('cvr_')}`, key), 'signed');
  assert.equal(refreshTokenFormat(`cvr_${id}.${mac('cva_')}`, key), undefined, 'an access signature on a refresh id');
  assert.equal(accessTokenFormat(`cva_${id}.${mac('cvr_')}`, key), undefined, 'a refresh signature on an access id');
  assert.equal(refreshTokenFormat(`cva_${id}.${mac('cva_')}`, key), undefined, 'an access token is not a refresh token');
  assert.equal(refreshTokenFormat('cvr_' + id, key, 1000, 999), 'legacy');
  assert.equal(refreshTokenFormat('cvr_' + id, key, 1000, 1000), undefined);
});

test('rate-limit keys are stored as HMACs under a derived key, never as plain digests', async t => {
  const f = await fixture(t);
  const { digest } = await import('../src/hosted-store.js');
  const subject = { network: '198.51.100.20', provider: 'cinex' as const, username: 'person@example.test' };
  assert.equal(await f.links.admitSignIn(subject), undefined);
  await f.links.signInFailed(subject);
  const stored = (await f.pool.query('SELECT key_hash FROM cinev_budgets')).rows.map(r => r.key_hash as string);
  assert.ok(stored.length >= 4);
  for (const plain of ['oauth:login-ip:198.51.100.20', 'signin:account:cinex:person@example.test', 'signin-fail:day:198.51.100.20', 'signin-fail:global'])
    assert.ok(!stored.includes(digest(plain)) && stored.includes(f.links.keyHash(plain)), plain);
  // Another key sees none of these counts; without keys rate limits and new links refuse to run, while cleanup works.
  const other = new ConnectionLinks(f.pool, { budgetKey: randomBytes(32), linkKey: randomBytes(32) });
  assert.notEqual(other.keyHash('signin-fail:global'), f.links.keyHash('signin-fail:global'));
  const unkeyed = new ConnectionLinks(f.pool);
  await assert.rejects(unkeyed.budget('x', 1), /clave/);
  await assert.rejects(unkeyed.issue(f.alice.id, (await f.users.hash(f.alice.id))!, 'cinex'), /clave/);
  await unkeyed.cleanup();
});

test('only refused credentials count as failures; an unreachable cinema refunds the attempt and says so', async t => {
  const { CredentialsRejected, CinemaUnavailable, LoginError } = await import('../src/auth.js');
  let next: Error = new Error();
  const f = await fixture(t, async () => { throw next; });
  const client = await f.client(f.alice.token);
  const attempt = async (error: Error) => {
    next = error;
    const browser = ((await (await f.post('/connect/exchange', await link(client))).json()) as { browser_token: string }).browser_token;
    const response = await f.post('/connect/login', browser, { username: 'person@example.test', password: 'x' });
    return { status: response.status, error: (await response.json() as { error: string }).error };
  };
  const count = async (key: string) => (await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=$1', [f.links.keyHash(key)])).rows[0]?.count ?? 0;
  const account = 'signin:account:cinesunidos:person@example.test';
  const down = await attempt(new CinemaUnavailable('down'));
  assert.equal(down.status, 503); assert.match(down.error, /no está respondiendo/);
  assert.equal(await count('signin-fail:global'), 0); assert.equal(await count(account), 0, 'the attempt is refunded');
  // After the credentials were sent, an outage is answered exactly like a refusal but not counted.
  const unclear = await attempt(new LoginError('timeout'));
  const refused = await attempt(new CredentialsRejected('no'));
  assert.deepEqual(unclear, refused, 'the response never reveals whether the password was right');
  assert.equal(refused.status, 401);
  assert.equal(await count('signin-fail:global'), 1, 'only the refusal trips strained mode');
  assert.equal(await count('signin-fail:recent:127.0.0.1'), 1);
  assert.equal(await count('signin-fail:day:127.0.0.1'), 2, 'unclear errors still count toward the daily network cap');
  assert.equal(await count(account), 2, 'both used an attempt');
  // A thrown value of unknown kind fails closed: it counts.
  await attempt(new Error('bug'));
  assert.equal(await count('signin-fail:global'), 2);
});

// Requests as if from another client network, through the trusted Vercel proxy header.
const from = (network: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string> ?? {}), 'x-vercel-forwarded-for': network } });

test('a spent service-wide OAuth quota never blocks refreshing, exchanging codes or revoking', async t => {
  const f = await fixture(t, undefined, undefined, { trustedVercelProxy: true });
  const { client_id, tokens } = await enrolled(f.origin);
  const pending = await authorizationRequest(f.origin, client_id), callback = await approve(f.origin, pending.url);
  // Ten networks spending their own quotas on new authorizations exhaust the shared one...
  await f.pool.query(`INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',601)
    ON CONFLICT(key_hash) DO UPDATE SET count=601, expires_at=now()+interval '1 minute'`, [f.links.keyHash('oauth:global')]);
  assert.equal((await fetch(pending.url, from('192.0.2.7'))).status, 429, 'starting an authorization is shared');
  // ...but connected clients keep working, from any network.
  const refreshed = await fetch(f.origin + '/oauth/token', from('198.51.100.70', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id, refresh_token: tokens.refresh_token, resource: f.origin + '/mcp' }) }));
  assert.equal(refreshed.status, 200);
  const exchanged = await fetch(f.origin + '/oauth/token', from('198.51.100.71', { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', client_id, code: callback.searchParams.get('code')!, code_verifier: pending.verifier,
    resource: f.origin + '/mcp', redirect_uri: pending.params.redirect_uri }) }));
  assert.equal(exchanged.status, 200, 'an approval already given completes');
  const next = await refreshed.json() as { access_token: string };
  assert.equal((await fetch(f.origin + '/oauth/revoke', from('198.51.100.72', { method: 'POST', body: new URLSearchParams({ token: next.access_token, client_id }) }))).status, 200);
  assert.equal((await f.pool.query('SELECT revoked_at FROM cinev_clients c JOIN cinev_oauth_tokens t ON t.user_id=c.id WHERE t.token_hash=$1',
    [(await import('../src/hosted-store.js')).digest(next.access_token)])).rows[0].revoked_at !== null, true);
});

test('malformed and forged token-endpoint requests are refused before any database work', async t => {
  const f = await fixture(t);
  const query = f.pool.query.bind(f.pool), texts: string[] = [];
  f.pool.query = ((...args: Parameters<typeof query>) => { texts.push(String(args[0])); return query(...args); }) as typeof f.pool.query;
  const token = (data: Record<string, string>) => form(f.origin, '/oauth/token', { client_id: 'cvapp_x', resource: f.origin + '/mcp', ...data });
  const statuses = [
    (await token({ grant_type: 'refresh_token' })).status,
    (await token({ grant_type: 'refresh_token', refresh_token: 'cvr_' + 'A'.repeat(43) + '.' + 'B'.repeat(43) })).status,
    (await token({ grant_type: 'authorization_code', code: 'short', code_verifier: 'v'.repeat(43), redirect_uri: 'https://assistant.example/callback' })).status,
    (await token({ grant_type: 'password' })).status,
    (await form(f.origin, '/oauth/revoke', { token: 'cva_forged', client_id: 'cvapp_x' })).status,
  ];
  f.pool.query = query;
  assert.deepEqual(statuses, [400, 400, 400, 400, 200]);
  assert.deepEqual(texts, []);
});

test('OAuth quotas also apply per IPv6 /48, so rotating /64s does not multiply them', async t => {
  const f = await fixture(t, undefined, undefined, { trustedVercelProxy: true });
  const statuses = [];
  for (let i = 0; i < 250; i++) statuses.push((await fetch(f.origin + '/oauth/revoke', from(`2001:db8:5:${i.toString(16)}::1`, { method: 'POST',
    body: new URLSearchParams({ token: 'cva_' + randomBytes(32).toString('base64url'), client_id: 'cvapp_x' }) }))).status);
  assert.equal(statuses.filter(s => s === 200).length, 240); assert.equal(statuses.filter(s => s === 429).length, 10);
  assert.equal((await fetch(f.origin + '/oauth/revoke', from('2001:db8:6::1', { method: 'POST',
    body: new URLSearchParams({ token: 'cva_' + randomBytes(32).toString('base64url'), client_id: 'cvapp_x' }) }))).status, 200, 'another /48');
});

test('JSON-RPC batches are refused, so one request is one call for every limit', async t => {
  let upstream = 0;
  const f = await fixture(t, undefined, async () => { upstream++; return new Response('["Caracas"]'); });
  const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } } });
  const post = (body: unknown) => fetch(f.origin + '/mcp', { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' } });
  for (const batch of [Array.from({ length: 50 }, (_, i) => call(i + 1)), [call(1)], []]) {
    const response = await post(batch);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: number } }).error.code, -32600);
  }
  assert.equal(upstream, 0, 'no provider read');
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_budgets WHERE key_hash=$1', [f.links.keyHash('refresh:anonymous:127.0.0.1')])).rowCount, 0);
  // A single refresh call still works and is charged once.
  const anonymous = await f.client();
  assert.equal(((await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } })).structuredContent as { status: string }).status, 'available');
  assert.equal((await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=$1', [f.links.keyHash('refresh:anonymous:127.0.0.1')])).rows[0].count, 1);
});

test('connection links are signed per stage; forged and dead ones are refused from memory', async t => {
  const f = await fixture(t, successfulLogin);
  // Issued directly: an MCP client's background notifications would overlap the measured windows.
  const { token: invite } = await f.links.issue(f.alice.id, (await f.users.hash(f.alice.id))!, 'cinesunidos');
  assert.match(invite, /^[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/);
  assert.match(await link(await f.client(f.bob.token)), /^[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/, 'connect_account links are signed too');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.links.linkFormat(invite, 'invitation'), 'signed');
  assert.equal(f.links.linkFormat(invite, 'browser'), undefined, 'an invitation never works as a browser token');
  const query = f.pool.query.bind(f.pool); let queries: string[] = [];
  const spy = () => { queries = []; f.pool.query = ((...args: Parameters<typeof query>) => { queries.push(String(args[0])); return query(...args); }) as typeof f.pool.query; };
  spy();
  const forged = await f.post('/connect/exchange', invite.slice(0, 64) + '.' + 'A'.repeat(43));
  const asBrowser = await f.post('/connect/login', invite, { username: 'x', password: 'x' });
  f.pool.query = query;
  assert.deepEqual([forged.status, asBrowser.status, queries], [403, 403, []]);
  const exchanged = await (await f.post('/connect/exchange', invite)).json() as { browser_token: string };
  assert.equal(f.links.linkFormat(exchanged.browser_token, 'browser'), 'signed');
  // The used invitation is dead: the first replay looks it up, later ones are answered from memory.
  assert.equal((await f.post('/connect/exchange', invite)).status, 410);
  spy();
  assert.equal((await f.post('/connect/exchange', invite)).status, 410);
  f.pool.query = query;
  assert.deepEqual(queries, []);
  assert.equal((await f.post('/connect/login', exchanged.browser_token, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' })).status, 200);
});

test('attackers on a shared address cannot lock out users of signed tokens or signed links', async t => {
  const f = await fixture(t, successfulLogin, undefined, { trustedVercelProxy: true });
  const shared = '190.202.9.9';
  const { tokens } = await enrolled(f.origin);
  // 600 junk requests and 30 junk credential lookups from the shared address.
  for (let k = 0; k < 12; k++) await Promise.all(Array.from({ length: 50 }, () => fetch(f.origin + '/nothing', from(shared)).then(r => r.text())));
  assert.equal((await fetch(f.origin + '/nothing', from(shared))).status, 429, 'the junk itself is limited');
  assert.equal((await fetch(f.origin + '/connect', from(shared))).status, 200, 'the link page always opens');
  const mcp = (token: string, network: string) => fetch(f.origin + '/mcp', from(network, { method: 'POST', body: '{}',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }));
  const other = '190.202.9.10';
  for (let i = 0; i < 30; i++) {
    await mcp('cva_' + randomBytes(32).toString('base64url'), other);
    await f.post('/connect/exchange', randomBytes(32).toString('hex'), {}, { 'x-vercel-forwarded-for': other });
  }
  assert.equal((await mcp('cva_' + randomBytes(32).toString('base64url'), other)).status, 429, 'unsigned junk is held back');
  // A real user on either address still gets through.
  for (const network of [shared, other]) {
    const status = await mcp(tokens.access_token, network);
    assert.notEqual(status.status, 429, network); assert.notEqual(status.status, 401, network);
    const user = await f.users.issue();
    const invite = await f.links.issue(user.id, (await f.users.hash(user.id))!, 'cinesunidos');
    assert.equal((await f.post('/connect/exchange', invite.token, {}, { 'x-vercel-forwarded-for': network })).status, 200, network);
  }
});

test('a revoked signed token is refused from memory after its first lookup', async t => {
  const f = await fixture(t);
  const { client_id, tokens } = await enrolled(f.origin);
  await form(f.origin, '/oauth/revoke', { token: tokens.access_token, client_id });
  const mcp = () => fetch(f.origin + '/mcp', { method: 'POST', body: '{}',
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } });
  assert.equal((await mcp()).status, 401);
  const query = f.pool.query.bind(f.pool); let queries = 0;
  f.pool.query = ((...args: Parameters<typeof query>) => { queries++; return query(...args); }) as typeof f.pool.query;
  const statuses = [];
  for (let i = 0; i < 40; i++) statuses.push((await mcp()).status);
  f.pool.query = query;
  assert.ok(statuses.every(s => s === 401)); assert.equal(queries, 0);
});

test('an unsigned token that recently worked is not held back by others\' failures', async t => {
  const f = await fixture(t);
  const mcp = (token: string) => fetch(f.origin + '/mcp', { method: 'POST', body: '{}',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } });
  assert.notEqual((await mcp(f.alice.token)).status, 401, 'operator token works');
  for (let i = 0; i < 30; i++) await mcp('cva_' + randomBytes(32).toString('base64url'));
  assert.equal((await mcp('cva_' + randomBytes(32).toString('base64url'))).status, 429);
  const again = await mcp(f.alice.token);
  assert.notEqual(again.status, 429); assert.notEqual(again.status, 401);
});

test('local filters: requests without a signed token are also limited per IPv6 /48', async t => {
  const f = await fixture(t, undefined, undefined, { trustedVercelProxy: true });
  const all: number[] = [];
  for (let k = 0; k < 2401; k += 20) all.push(...await Promise.all(Array.from({ length: Math.min(20, 2401 - k) }, (_, i) =>
    fetch(f.origin + '/nothing', from(`2001:db8:9:${(k + i).toString(16)}::1`)).then(r => r.status))));
  assert.equal(all.filter(s => s === 429).length, 1, 'each /64 is under its own limit; the /48 is not');
  assert.equal((await fetch(f.origin + '/nothing', from('2001:db8:a::1'))).status, 404, 'another /48');
});

test('local sets remember keys for their lifetime within a bounded size', async () => {
  const { LocalSet } = await import('../src/local-limit.js');
  let now = 0;
  const set = new LocalSet(1000, 3, () => now);
  set.add('a'); now = 10; set.add('b'); set.add('c');
  assert.ok(set.has('a') && set.has('c'));
  set.add('d');
  assert.equal(set.has('a'), false, 'oldest evicted at capacity'); assert.equal(set.size, 3);
  now = 1010;
  assert.equal(set.has('b'), false, 'expired');
});

test('strained mode reserves one attempt per network and two per /48, even in parallel', async t => {
  const f = await fixture(t);
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '15 minutes',300)", [f.links.keyHash('signin-fail:global')]);
  const subject = (network: string, i: number) => ({ network, provider: 'cinex' as const, username: `victim${i}@example.test` });
  const parallel = await Promise.all(Array.from({ length: 20 }, (_, i) => f.links.admitSignIn(subject('198.51.100.99', i))));
  assert.equal(parallel.filter(r => r === undefined).length, 1);
  assert.ok(parallel.filter(Boolean).every(r => r === 'strained'));
  let admitted = 0;
  for (let n = 0; n < 40; n++) {
    const s = subject(`2001:0db8:00aa:${n.toString(16).padStart(4, '0')}::/64`, n);
    if (await f.links.admitSignIn(s) === undefined) { admitted++; await f.links.signInError(s, new Error('refused')); }
  }
  assert.equal(admitted, 1, 'rotating /64s: after one failure the whole /48 is held back');
  // Before any failure, parallel attempts from many /64s of one /48 get two slots.
  const fresh = await Promise.all(Array.from({ length: 10 }, (_, n) => f.links.admitSignIn(subject(`2001:0db8:00ab:${n.toString(16).padStart(4, '0')}::/64`, 100 + n))));
  assert.equal(fresh.filter(r => r === undefined).length, 2);
  assert.equal(await f.links.admitSignIn(subject('2001:0db8:00ac:0001::/64', 99)), undefined, 'another /48');
});

test('a proven owner is exempt from network caps and strained mode, but not from their own budget', async t => {
  const f = await fixture(t);
  const shared = '190.202.1.1', owner = { network: shared, provider: 'cinex' as const, username: 'owner@example.test', proofs: ['browser:owner-cookie'] };
  await f.links.signInSucceeded(owner);
  const fill = (key: string, count: number) => f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 day',$2)", [f.links.keyHash(key), count]);
  await fill(`signin-fail:day:${shared}`, 100); await fill(`signin-fail:recent:${shared}`, 5); await fill('signin-fail:global', 300);
  await fill(`oauth:login-ip:${shared}`, 21); await fill('signin:account:cinex:owner@example.test', 5);
  // Without the owner's proof, the same account on the same network is held back: the exemption cannot be used or observed.
  assert.equal(await f.links.admitSignIn({ ...owner, proofs: [] }), 'strained');
  assert.equal(await f.links.admitSignIn({ ...owner, proofs: ['browser:attacker'] }), 'strained');
  assert.equal(await f.links.admitSignIn({ ...owner, username: 'other@example.test' }), 'strained', 'the proof is per account');
  for (let i = 0; i < 5; i++) assert.equal(await f.links.admitSignIn({ ...owner }), undefined, `owner attempt ${i + 1}`);
  assert.equal(await f.links.admitSignIn({ ...owner }), 'account', 'the owner still has their own budget');
});

test('a refused attempt gives back what it charged, so it cannot spend a strained slot', async t => {
  const f = await fixture(t);
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '15 minutes',300),($2,now()+interval '15 minutes',5)",
    [f.links.keyHash('signin-fail:global'), f.links.keyHash('signin:account:cinex:locked@example.test')]);
  const network = '198.51.100.123';
  assert.equal(await f.links.admitSignIn({ network, provider: 'cinex', username: 'locked@example.test' }), 'account');
  assert.equal(await f.links.admitSignIn({ network, provider: 'cinex', username: 'newcomer@example.test' }), undefined, 'the slot is still free');
  const left = await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=$1', [f.links.keyHash(`oauth:login-ip:${network}`)]);
  assert.equal(left.rows[0].count, 1, 'only the admitted attempt was charged to the network');
});

test('every spelling of one email shares its account limit', async t => {
  const f = await fixture(t);
  const { accountName } = await import('../src/hosted-links.js');
  const variants = ['Owner@Example.com', 'ówner@example.com', 'ｏwner@example.com', 'o\u200Bwner@example.com', ' OWNER@EXAMPLE.COM '];
  assert.deepEqual(new Set(variants.map(accountName)), new Set(['owner@example.com']));
  for (const [a, b] of [['carłos@x.com', 'carlos@x.com'], ['mæva@x.com', 'maeva@x.com'], ['jøse@x.com', 'jose@x.com'], ['điana@x.com', 'diana@x.com'],
    ['straße@x.de', 'strasse@x.de'], ['a\u0000b@x.com', 'ab@x.com']]) assert.equal(accountName(a), accountName(b), `${a} ~ ${b}`);
  assert.notEqual(accountName('数@x.com'), accountName('字@x.com'), 'distinct non-ASCII letters retain separate account keys');
  const results = [];
  for (const [i, username] of [...variants, 'owner@example.com'].entries()) results.push(await f.links.admitSignIn({ network: `203.0.113.${i}`, provider: 'cinex', username }));
  assert.deepEqual(results, [undefined, undefined, undefined, undefined, undefined, 'account']);
});

test('distinct non-ASCII accounts keep separate keys while accent and case variants still fold', () => {
  assert.notEqual(accountName('数@gmail.com'), accountName('字@gmail.com'));
  assert.notEqual(accountName('😀@gmail.com'), accountName('😁@gmail.com'));
  assert.equal(accountName('Ówner@GMAIL.com'), accountName('owner@gmail.com'));
});

test('a refused admission or a busy double submit spends no link or consent attempt', async t => {
  let calls = 0;
  const f = await fixture(t, async (...args) => { calls++; return successfulLogin(...args); });
  const client = await f.client(f.alice.token);
  const browser = ((await (await f.post('/connect/exchange', await link(client))).json()) as { browser_token: string }).browser_token;
  const fill = () => f.pool.query(`INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',21)
    ON CONFLICT(key_hash) DO UPDATE SET count=21`, [f.links.keyHash('oauth:login-ip:127.0.0.1')]);
  await fill();
  for (let i = 0; i < 7; i++) assert.equal((await f.post('/connect/login', browser, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' })).status, 429);
  await f.pool.query('DELETE FROM cinev_budgets');
  assert.equal((await f.post('/connect/login', browser, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' })).status, 200, 'the link still has its attempts');
  // The same on the consent page (forgetting that this account just became known on this network).
  await f.pool.query('DELETE FROM cinev_budgets');
  const consent = await consentForm(f.origin, await register(f.origin));
  await fill();
  for (let i = 0; i < 7; i++) assert.equal((await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })).status, 429);
  await f.pool.query('DELETE FROM cinev_budgets');
  assert.equal((await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })).status, 303);
  assert.equal(calls, 2);
});

test('refused and unclear sign-ins take the same minimum time, on links and on consent', async t => {
  const { CredentialsRejected, LoginError } = await import('../src/auth.js');
  let next: Error = new Error();
  const f = await fixture(t, async () => { throw next; }, undefined, { signInFloorMs: 300 });
  const client = await f.client(f.alice.token);
  const timed = async (error: Error) => {
    next = error;
    const browser = ((await (await f.post('/connect/exchange', await link(client))).json()) as { browser_token: string }).browser_token;
    const started = Date.now();
    const response = await f.post('/connect/login', browser, { username: `u${Math.random()}@example.test`, password: 'x' });
    return { status: response.status, elapsed: Date.now() - started };
  };
  for (const error of [new CredentialsRejected('no'), new LoginError('timeout')]) {
    const { status, elapsed } = await timed(error);
    assert.equal(status, 401); assert.ok(elapsed >= 290, `${error.constructor.name}: ${elapsed} ms`);
  }
  next = new CredentialsRejected('no');
  const consent = await consentForm(f.origin, await register(f.origin));
  const started = Date.now();
  assert.equal((await consent.submit({ ...cinema, password: 'WRONG' })).status, 401);
  assert.ok(Date.now() - started >= 290);
});

test('expired rate-limit windows and unbound authorization requests are pruned as they accumulate', async t => {
  const f = await fixture(t);
  await f.pool.query(`INSERT INTO cinev_budgets(key_hash,expires_at,count)
    SELECT md5(i::text) || md5((i+1)::text), now()-interval '1 second', 1 FROM generate_series(1,150) i`);
  for (let i = 0; i < 100; i++) await f.links.budget(`prune:${i}`, 1000);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM cinev_budgets WHERE expires_at<=now()")).rows[0].n, 0);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM cinev_budgets WHERE expires_at>now()")).rows[0].n, 100, 'live windows stay');
  const client_id = await register(f.origin);
  await f.pool.query(`INSERT INTO cinev_oauth_requests(id,app_id,redirect_uri,resource,challenge,csrf_hash,expires_at)
    SELECT 'old' || i, $1, 'https://assistant.example/callback', 'r', 'c', 'h', now()-interval '1 second' FROM generate_series(1,60) i`, [client_id]);
  // An expired request holding a connection is cleanup's to decide, never pruned here.
  await f.pool.query(`INSERT INTO cinev_oauth_requests(id,app_id,redirect_uri,resource,challenge,csrf_hash,expires_at,user_id)
    VALUES('bound',$1,'https://assistant.example/callback','r','c','h',now()-interval '1 second',$2)`, [client_id, f.alice.id]);
  for (let i = 0; i < 50; i++) await fetch((await authorizationRequest(f.origin, client_id)).url);
  const left = (await f.pool.query("SELECT id FROM cinev_oauth_requests WHERE expires_at<=now()")).rows.map(r => r.id);
  assert.deepEqual(left, ['bound']);
});

test('legacy cutoffs follow when signing began, recorded once by the first instance', async t => {
  const f = await fixture(t);
  const { legacyCutoffs, readLegacyCutoffs } = await import('../src/oauth.js');
  const first = await readLegacyCutoffs(f.pool), again = await readLegacyCutoffs(f.pool);
  assert.deepEqual(first, again, 'recorded once');
  const since = (await f.pool.query("SELECT value FROM cinev_meta WHERE key='token_signing_since'")).rows[0].value as Date;
  assert.ok(Math.abs(since.getTime() - Date.now()) < 60000);
  assert.deepEqual(first, { access: since.getTime() + 86400000, refresh: since.getTime() + 31 * 86400000, link: since.getTime() + 86400000 });
  assert.deepEqual(legacyCutoffs(undefined), { access: Infinity, refresh: Infinity, link: Infinity }, 'before migration 006');
  // Once the cutoff has passed, real unsigned tokens and links are refused.
  const late = await fixture(t);
  const { digest } = await import('../src/hosted-store.js');
  const { client_id, tokens } = await enrolled(late.origin);
  const user = (await late.pool.query('SELECT user_id FROM cinev_oauth_tokens WHERE token_hash=$1', [digest(tokens.access_token)])).rows[0].user_id;
  const access = 'cva_' + randomBytes(32).toString('base64url'), refresh = 'cvr_' + randomBytes(32).toString('base64url'), linkToken = randomBytes(32).toString('hex');
  await late.pool.query(`INSERT INTO cinev_oauth_tokens(token_hash,user_id,kind,expires_at) VALUES($1,$3,'access',now()+interval '1 hour'),
    ($2,$3,'refresh',(SELECT expires_at FROM cinev_oauth_grants WHERE user_id=$3))`, [digest(access), digest(refresh), user]);
  await late.pool.query(`INSERT INTO cinev_links(token_hash,user_id,provider,stage,expires_at) VALUES($1,$2,'cinex','invitation',now()+interval '10 minutes')`,
    [digest(linkToken), late.alice.id]);
  const use = async () => ({
    access: (await fetch(late.origin + '/mcp', { method: 'POST', body: '{}', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } })).status,
    refresh: (await form(late.origin, '/oauth/token', { grant_type: 'refresh_token', client_id, resource: late.origin + '/mcp', refresh_token: refresh })).status,
  });
  // Enrolling recorded the epoch (and this instance cached it): move it back and let a fresh read see that.
  await late.pool.query("UPDATE cinev_meta SET value=now()-interval '40 days' WHERE key='token_signing_since'");
  (late.oauth as unknown as { cutoffs?: unknown }).cutoffs = undefined;
  assert.deepEqual(await use(), { access: 401, refresh: 400 });
  assert.equal((await late.post('/connect/exchange', linkToken)).status, 403, 'an unsigned link is no longer accepted');
});

test('one network cannot spend the shared registration quota', async t => {
  const f = await fixture(t, undefined, undefined, { trustedVercelProxy: true });
  const register = (network: string) => fetch(f.origin + '/oauth/register', from(network, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'T', redirect_uris: ['https://assistant.example/callback'] }) })).then(r => r.status);
  const statuses = [];
  for (let i = 0; i < 60; i++) statuses.push(await register('203.0.113.66'));
  assert.equal(statuses.filter(s => s === 201).length, 10);
  assert.equal(await register('198.51.100.66'), 201, 'another network still registers');
});

test('junk from others on a shared address never blocks a signed refresh or code exchange', async t => {
  const f = await fixture(t, undefined, undefined, { trustedVercelProxy: true });
  const shared = '190.202.7.7';
  const { client_id, tokens } = await enrolled(f.origin);
  const pending = await authorizationRequest(f.origin, client_id), callback = await approve(f.origin, pending.url);
  assert.match(callback.searchParams.get('code')!, /^cvc_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/, 'codes are signed');
  // Junk consent posts (no approval cookie), authorization starts and requests spend the address's quotas.
  for (let i = 0; i < 70; i++) {
    await fetch(f.origin + '/oauth/authorize', from(shared, { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: 'a'.repeat(32), csrf: 'b'.repeat(43), decision: 'approve' }) }));
    await fetch(pending.url, from(shared));
  }
  for (let k = 0; k < 12; k++) await Promise.all(Array.from({ length: 50 }, () => fetch(f.origin + '/nothing', from(shared)).then(r => r.text())));
  assert.equal((await fetch(pending.url, from(shared))).status, 429, 'the junk itself is limited');
  // A real user on the address approving a request their browser started still gets through.
  const started = await fetch(pending.url, from('203.0.113.200'));
  const page = await started.text();
  const approval = await fetch(f.origin + '/oauth/authorize', from(shared, { method: 'POST', redirect: 'manual', headers: {
    Origin: f.origin, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: started.headers.get('set-cookie')!.split(';')[0] },
    body: new URLSearchParams({ request_id: page.match(/name="request_id" value="([^"]+)"/)![1], csrf: page.match(/name="csrf" value="([^"]+)"/)![1], decision: 'approve' }) }));
  assert.equal(approval.status, 303);
  const refreshed = await fetch(f.origin + '/oauth/token', from(shared, { method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id, refresh_token: tokens.refresh_token, resource: f.origin + '/mcp' }) }));
  assert.equal(refreshed.status, 200);
  const exchanged = await fetch(f.origin + '/oauth/token', from(shared, { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', client_id, code: callback.searchParams.get('code')!, code_verifier: pending.verifier,
    resource: f.origin + '/mcp', redirect_uri: pending.params.redirect_uri }) }));
  assert.equal(exchanged.status, 200);
  const next = await refreshed.json() as { access_token: string };
  assert.equal((await fetch(f.origin + '/oauth/revoke', from(shared, { method: 'POST', body: new URLSearchParams({ token: next.access_token, client_id }) }))).status, 200);
  // A forged signed code is refused without database work.
  const forged = 'cvc_' + 'A'.repeat(43) + '.' + 'B'.repeat(43);
  const query = f.pool.query.bind(f.pool), connect = f.pool.connect.bind(f.pool); let queries = 0;
  f.pool.query = ((...args: Parameters<typeof query>) => { queries++; return query(...args); }) as typeof f.pool.query;
  // pool.query connects with a callback; a transaction connects through the promise form.
  f.pool.connect = ((...args: unknown[]) => { if (!args.length) queries++; return (connect as (...a: unknown[]) => unknown)(...args); }) as typeof f.pool.connect;
  const refused = await form(f.origin, '/oauth/token', { grant_type: 'authorization_code', client_id, code: forged, code_verifier: pending.verifier, resource: f.origin + '/mcp', redirect_uri: pending.params.redirect_uri });
  f.pool.query = query; f.pool.connect = connect;
  assert.equal(refused.status, 400); assert.equal(queries, 0, 'no query and no transaction');
});

test('dead signed tokens buy no headroom, and signed traffic is also capped per /48', async t => {
  const f = await fixture(t, undefined, undefined, { trustedVercelProxy: true });
  const { client_id, tokens } = await enrolled(f.origin);
  const dead = await enrolled(f.origin);
  await form(f.origin, '/oauth/revoke', { token: dead.tokens.access_token, client_id: dead.client_id });
  const shared = '190.202.8.8';
  const mcp = (token: string, network: string) => fetch(f.origin + '/mcp', from(network, { method: 'POST', body: '{}',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }));
  // A dead token on another route, or on /mcp once known dead, counts like any request from the address.
  await mcp(dead.tokens.access_token, shared);
  for (let k = 0; k < 12; k++) await Promise.all(Array.from({ length: 50 }, () => mcp(dead.tokens.access_token, shared).then(r => r.text())));
  assert.equal((await fetch(f.origin + '/nothing', from(shared, { headers: { Authorization: `Bearer ${dead.tokens.access_token}` } }))).status, 429);
  const live = await mcp(tokens.access_token, shared);
  assert.notEqual(live.status, 429); assert.notEqual(live.status, 401);
  // Live signed traffic from one IPv6 /48 is capped too (6000/min), across tokens and /64s.
  // One registered client, eleven connections (registration itself is limited per network).
  const many: Array<{ tokens: { access_token: string } }> = [];
  for (let i = 0; i < 12; i++) {
    const request = await authorizationRequest(f.origin, client_id), callback = await approve(f.origin, request.url);
    const response = await form(f.origin, '/oauth/token', { grant_type: 'authorization_code', client_id, code: callback.searchParams.get('code')!,
      code_verifier: request.verifier, resource: f.origin + '/mcp', redirect_uri: request.params.redirect_uri });
    many.push({ tokens: await response.json() as { access_token: string } });
  }
  const statuses: number[] = [];
  for (let k = 0; k < 6000; k += 25) statuses.push(...await Promise.all(Array.from({ length: 25 }, (_, i) =>
    mcp(many[(k + i) % 11].tokens.access_token, `2001:db8:77:${((k + i) % 4000).toString(16)}::1`).then(r => r.status))));
  assert.ok(!statuses.includes(401));
  // A twelfth, unused connection (its own database budget untouched) is held back by the /48 cap alone.
  const over = await mcp(many[11].tokens.access_token, '2001:db8:77:ffff::1');
  assert.equal(over.status, 429); assert.match(await over.text(), /Demasiadas consultas/);
  const elsewhere = await mcp(many[11].tokens.access_token, '2001:db8:78::1');
  assert.notEqual(elsewhere.status, 429, 'another /48'); assert.notEqual(elsewhere.status, 401);
});

test('an unreachable cinema spends no link or consent attempt', async t => {
  const { CinemaUnavailable } = await import('../src/auth.js');
  let down = true, calls = 0;
  const f = await fixture(t, async (...args) => { calls++; if (down) throw new CinemaUnavailable('down'); return successfulLogin(...args); });
  const client = await f.client(f.alice.token);
  const browser = ((await (await f.post('/connect/exchange', await link(client))).json()) as { browser_token: string }).browser_token;
  for (let i = 0; i < 7; i++) assert.equal((await f.post('/connect/login', browser, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' })).status, 503);
  down = false;
  assert.equal((await f.post('/connect/login', browser, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' })).status, 200);
  down = true;
  const consent = await consentForm(f.origin, await register(f.origin));
  for (let i = 0; i < 7; i++) assert.equal((await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })).status, 503);
  down = false;
  assert.equal((await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })).status, 303);
  assert.equal(calls, 16);
});

test('refused sign-ins are answered in fixed time steps, also when the cinema is slow', async () => {
  const { signInFloor } = await import('../src/hosted-links.js');
  for (const [took, expected] of [[0, 300], [100, 300], [350, 600], [610, 900]] as const) {
    const started = Date.now() - took;
    await signInFloor(started, 300);
    const total = Date.now() - started;
    assert.ok(total >= expected - 5 && total < expected + 80, `took ${took} ms: answered at ${total} ms, expected ${expected}`);
  }
});

test('a concurrent double submit on a link runs one sign-in and charges the account once', async t => {
  let calls = 0;
  const slow: typeof login = async (...args) => { calls++; await new Promise(r => setTimeout(r, 300)); throw new Error('refused'); };
  const f = await fixture(t, slow);
  const client = await f.client(f.alice.token);
  const browser = ((await (await f.post('/connect/exchange', await link(client))).json()) as { browser_token: string }).browser_token;
  const submit = () => f.post('/connect/login', browser, { username: 'person@example.test', password: 'x' }).then(r => r.status);
  const statuses = await Promise.all([submit(), submit()]);
  assert.deepEqual(statuses.sort(), [401, 429]);
  assert.equal(calls, 1);
  assert.equal((await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=$1', [f.links.keyHash('signin:account:cinesunidos:person@example.test')])).rows[0].count, 1);
});

test('the consent page remembers its owner\'s browser after a successful sign-in', async t => {
  const f = await fixture(t, successfulLogin);
  const first = await consentForm(f.origin, await register(f.origin));
  const done = await first.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' });
  assert.equal(done.status, 303);
  const device = done.headers.getSetCookie().find(c => c.startsWith('cinve_device='));
  assert.match(device ?? '', /^cinve_device=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/oauth\/authorize; Max-Age=2592000/);
  // The network's attempts are spent: a stranger is held back, the returning owner's browser is not.
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',21) ON CONFLICT(key_hash) DO UPDATE SET count=21",
    [f.links.keyHash('oauth:login-ip:127.0.0.1')]);
  const stranger = await consentForm(f.origin, await register(f.origin));
  assert.equal((await stranger.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })).status, 429);
  const again = await consentForm(f.origin, await register(f.origin));
  assert.equal((await again.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' }, { Origin: f.origin, Cookie: `${again.cookie}; ${device!.split(';')[0]}` })).status, 303);
});

test('the signing epoch is recorded once, at the first signed token, even with concurrent first reads', async t => {
  const f = await fixture(t);
  const { readLegacyCutoffs } = await import('../src/oauth.js');
  assert.equal((await f.pool.query('SELECT 1 FROM cinev_meta')).rowCount, 0);
  await enrolled(f.origin);
  assert.equal((await f.pool.query("SELECT 1 FROM cinev_meta WHERE key='token_signing_since'")).rowCount, 1, 'recorded when signing began');
  // A first read racing another instance's first insert: that insert commits
  // after the read's snapshot, so the read must look again, not see "none".
  const fresh = await fixture(t);
  const other = await fresh.pool.connect();
  await other.query('BEGIN');
  await other.query("INSERT INTO cinev_meta VALUES('token_signing_since', now()-interval '2 days')");
  const reading = readLegacyCutoffs(fresh.pool);
  await new Promise(resolve => setTimeout(resolve, 200)); // The read now waits on the conflicting insert.
  await other.query('COMMIT'); other.release();
  const raced = await reading;
  assert.notEqual(raced.access, Infinity, 'the racing read found the value');
  assert.ok(raced.access < Date.now(), 'the other instance\'s value, two days old');
  // Before migration 006 "not recorded" is kept briefly, then read again.
  const early = await fixture(t);
  await early.pool.query('DROP TABLE cinev_meta');
  assert.equal((await early.oauth.legacy()).access, Infinity);
  await early.pool.query('CREATE TABLE cinev_meta (key text PRIMARY KEY, value timestamptz NOT NULL)');
  assert.equal((await early.oauth.legacy()).access, Infinity, 'kept for a minute');
  const until = (early.oauth as unknown as { cutoffsUntil: number }).cutoffsUntil;
  assert.ok(until > Date.now() && until <= Date.now() + 60000, 'only for a minute');
  (early.oauth as unknown as { cutoffsUntil: number }).cutoffsUntil = 0;
  assert.notEqual((await early.oauth.legacy()).access, Infinity, 'then read again');
});

test('an outage gives back every charge of the attempt, including a strained slot', async t => {
  const f = await fixture(t);
  const { CinemaUnavailable } = await import('../src/auth.js');
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '15 minutes',300)", [f.links.keyHash('signin-fail:global')]);
  const network = '198.51.100.140';
  const first = { network, provider: 'cinex' as const, username: 'a@example.test' };
  assert.equal(await f.links.admitSignIn(first), undefined, 'takes the network\'s only strained slot');
  assert.equal(await f.links.signInError(first, new CinemaUnavailable('down')), 'unavailable');
  const counts = await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=ANY($1)', [[`signin:strained:${network}`, `oauth:login-ip:${network}`, 'signin:account:cinex:a@example.test'].map(k => f.links.keyHash(k))]);
  assert.deepEqual(counts.rows.map(r => r.count), [0, 0, 0]);
  assert.equal(await f.links.admitSignIn({ ...first }), undefined, 'the slot is free again');
});

test('a device id planted in a browser never becomes a proof for the account signed in there', async t => {
  const f = await fixture(t, successfulLogin);
  const planted = 'P'.repeat(43);
  const consent = await consentForm(f.origin, await register(f.origin));
  const done = await consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' }, { Origin: f.origin, Cookie: `${consent.cookie}; cinve_device=${planted}` });
  assert.equal(done.status, 303);
  const issued = done.headers.getSetCookie().find(c => c.startsWith('cinve_device='))!.split(';')[0].split('=')[1];
  assert.notEqual(issued, planted, 'a fresh id is issued');
  const subject = (device: string) => ({ network: '203.0.113.150', provider: 'cinesunidos' as const, username: 'person@example.test', proofs: [`browser:${device}`] });
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',21)", [f.links.keyHash('oauth:login-ip:203.0.113.150')]);
  assert.equal(await f.links.admitSignIn(subject(planted)), 'network', 'whoever planted the id gets no exemption');
  assert.equal(await f.links.admitSignIn(subject(issued)), undefined, 'the browser that signed in does');
});
