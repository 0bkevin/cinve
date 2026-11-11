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
import { ConnectionLinks } from '../src/hosted-links.js';
import { createRemoteServer } from '../src/remote.js';
import type { login } from '../src/auth.js';
import type { ClientMetadataFetcher } from '../src/client-metadata.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, authenticate?: typeof login,
  request: typeof fetch = async () => new Response('["Caracas"]'), extra: { bodyTimeoutMs?: number; clientMetadata?: ClientMetadataFetcher } = {}) {
  const schema = 'test_' + randomBytes(12).toString('hex');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });

  await pool.query(await migrationSql());
  const key = randomBytes(32);
  const app = await createHostedApp({ publicUrl: 'http://127.0.0.1:0', allowLocal: true, pool, key, authenticate, request, ...extra });
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
  assert.ok(!(await page.text()).includes(invitation));
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
  assert.match(client.getInstructions() ?? '', /Servidor alojado/);
  assert.deepEqual(client.getServerVersion(), { name: 'cinve', version: '0.1.0' });
  const result = await client.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(Result.parse(result.structuredContent).status, 'available');
  assert.ok(!JSON.stringify(result).includes(f.alice.token));
});

test('independent server instances consume a link only once and share saved sessions', async t => {
  const f = await fixture(t), other = new ConnectionLinks(f.pool, hostedKeys(f.key).budgetKey);
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
  const f = await fixture(t), other = new ConnectionLinks(f.pool, hostedKeys(f.key).budgetKey);
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
  const f = await fixture(t), other = new ConnectionLinks(f.pool, hostedKeys(f.key).budgetKey), hash = (await f.users.hash(f.alice.id))!;
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
  assert.equal((await fetch(f.origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 429);
  await f.pool.query(await migrationSql());
  assert.ok(await f.users.authenticate(f.alice.token), 'migrations can be rerun without invalidating existing access');
});

test('the install guide is served with safe HTTP methods and no downloadable helper exists', async t => {
  const f = await fixture(t);
  const guide = await fetch(f.origin + '/install');
  assert.equal(guide.status, 200); assert.equal(guide.headers.get('cache-control'), 'no-store');
  const text = await guide.text();
  assert.match(text, /available=0 con unknown>0 NO significa agotado/);
  assert.match(text, /bloque de texto monoespaciado/);
  assert.equal((await fetch(f.origin + '/install', { method: 'POST' })).status, 405);
  assert.equal((await fetch(f.origin + '/codex-client.mjs')).status, 404);
});

test('consent warns when Cinve cannot vouch for the destination', async t => {
  const f = await fixture(t, undefined, undefined, { clientMetadata });
  const page = async (client_id: string, redirect?: string) => {
    const r = await authorizationRequest(f.origin, client_id);
    if (redirect) r.url.searchParams.set('redirect_uri', redirect);
    const response = await fetch(r.url); assert.equal(response.status, 200); return response.text();
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
  const script = await (await fetch(f.origin + '/app.js')).text();
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
  return { html, submit, exchange };
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

test('waiting duplicate submits do not use up the per-address sign-in budget', async t => {
  let calls = 0;
  const slowLogin: typeof login = async (...args) => { calls++; await new Promise(r => setTimeout(r, 300)); return successfulLogin(...args); };
  const f = await fixture(t, slowLogin);
  const consent = await consentForm(f.origin, await register(f.origin));
  const many = await Promise.all(Array.from({ length: 25 }, () => consent.submit({ ...cinema, password: 'SYNTHETIC_PASSWORD' })));
  assert.ok(many.every(r => r.status === 303), `25 duplicate submits: ${many.map(r => r.status).join(',')}`);
  assert.equal(calls, 1);
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
  const { createHash } = await import('node:crypto');
  const client_id = await register(f.origin);
  const pages = [f.origin + '/', f.origin + '/connect', (await authorizationRequest(f.origin, client_id)).url.href, f.origin + '/oauth/authorize?client_id=unknown'];
  const install = await fetch(f.origin + '/install', { headers: { Accept: 'text/html' } });
  for (const r of [...await Promise.all(pages.map(u => fetch(u))), install]) {
    const csp = r.headers.get('content-security-policy')!, html = await r.text();
    assert.match(r.headers.get('content-type')!, /text\/html/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
    assert.equal(styles.length, 1); assert.doesNotMatch(html, /\sstyle=/);
    assert.ok(csp.includes(`style-src 'sha256-${createHash('sha256').update(styles[0]).digest('base64')}'`), r.url);
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
});

test('public pages use the configured origin and serve local fonts under the authorization policy', async t => {
  const f = await fixture(t);
  const home = await fetch(f.origin + '/?from=portfolio');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes(`Instala Cinve siguiendo ${f.origin}/install`));
  assert.ok(html.includes('lang="es"'));
  assert.ok(html.includes(`property="og:image" content="${f.origin}/og.png?v=2"`));
  assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
  const social = await fetch(f.origin + '/og.png?v=2');
  assert.equal(social.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await social.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(home.headers.get('content-security-policy')?.includes("font-src 'self'"));
  const font = await fetch(f.origin + '/assets/inter-latin.woff2');
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
  for (let i = 0; i < 20; i++) assert.equal((await form(f.origin, '/oauth/token', { grant_type: 'refresh_token' })).status, 429);
  const global = await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=$1', [f.links.keyHash('oauth:global')]);
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

test('rate limits group an IPv6 subscriber by /64 and keep IPv4 per address', async () => {
  const { rateLimitNetwork } = await import('../src/hosted.js');
  assert.equal(rateLimitNetwork('203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitNetwork('::ffff:203.0.113.7'), '203.0.113.7');
  const network = rateLimitNetwork('2001:db8:1:2::1');
  assert.equal(network, '2001:0db8:0001:0002::/64');
  assert.equal(rateLimitNetwork('2001:0db8:0001:0002:ffff:eeee:dddd:cccc'), network);
  assert.notEqual(rateLimitNetwork('2001:db8:1:3::1'), network);
  assert.equal(rateLimitNetwork('unknown'), 'unknown');
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
  assert.equal(await count('signin:account:cinesunidos:person@example.test'), 0, 'a success clears that account');
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
  await f.links.signInSucceeded(account('VICTIM@example.test', 0));
  assert.equal(await f.links.admitSignIn(account('victim@example.test', 10)), undefined);
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
  assert.equal(await f.links.admitSignIn(subject('203.0.113.5', 'a@example.test')), 'network');
  await fill('signin-fail:day:2001:0db8:0001::/48', 300);
  assert.equal(await f.links.admitSignIn(subject('2001:db8:1:7::1', 'b@example.test')), 'network', 'a fresh /64 in a failing /48');
  assert.equal(await f.links.admitSignIn(subject('2001:db8:2:7::1', 'c@example.test')), undefined);
  await fill('signin:block:2001:0db8:0003::/48', 60, '1 minute');
  assert.equal(await f.links.admitSignIn(subject('2001:db8:3:9::1', 'd@example.test')), 'network', 'per-minute /48 attempts');
  // Failures from a /64 are counted for its /48 too.
  await f.links.signInFailed(subject('2001:db8:4:1::1', 'e@example.test'));
  const rows = await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=ANY($1)', [['signin-fail:day:2001:0db8:0004:0001::/64', 'signin-fail:day:2001:0db8:0004::/48'].map(k => f.links.keyHash(k))]);
  assert.deepEqual(rows.rows.map(r => r.count), [1, 1]);
});

test('refresh=true also has a service-wide budget across addresses', async t => {
  const f = await fixture(t);
  const { digest } = await import('../src/hosted-store.js');
  const anonymous = await f.client();
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',120)", [f.links.keyHash('refresh:global')]);
  await assert.rejects(anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos', refresh: true } }));
  const cached = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal((cached.structuredContent as { status: string }).status, 'available');
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
  const { accessTokenFormat, legacyAccessTokensUntil } = await import('../src/oauth.js');
  const { createHmac } = await import('node:crypto');
  const key = randomBytes(32), id = randomBytes(32).toString('base64url');
  const signed = `cva_${id}.${createHmac('sha256', key).update('cva_' + id).digest('base64url')}`;
  assert.equal(accessTokenFormat(signed, key), 'signed');
  assert.equal(accessTokenFormat(signed, randomBytes(32)), undefined, 'another key');
  assert.equal(accessTokenFormat(`cva_${randomBytes(32).toString('base64url')}.${signed.split('.')[1]}`, key), undefined, 'a signature moved to another id');
  const legacy = 'cva_' + id;
  assert.equal(accessTokenFormat(legacy, key, legacyAccessTokensUntil - 1), 'legacy');
  assert.equal(accessTokenFormat(legacy, key, legacyAccessTokensUntil), undefined);
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
  assert.ok(texts.every(sql => sql.includes('cinev_budgets')), `only rate-limit writes: ${texts.join(' | ')}`);
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
  const { refreshTokenFormat, accessTokenFormat, legacyRefreshTokensUntil } = await import('../src/oauth.js');
  const { createHmac } = await import('node:crypto');
  const key = randomBytes(32), id = randomBytes(32).toString('base64url');
  const mac = (prefix: string) => createHmac('sha256', key).update(prefix + id).digest('base64url');
  assert.equal(refreshTokenFormat(`cvr_${id}.${mac('cvr_')}`, key), 'signed');
  assert.equal(refreshTokenFormat(`cvr_${id}.${mac('cva_')}`, key), undefined, 'an access signature on a refresh id');
  assert.equal(accessTokenFormat(`cva_${id}.${mac('cvr_')}`, key), undefined, 'a refresh signature on an access id');
  assert.equal(refreshTokenFormat(`cva_${id}.${mac('cva_')}`, key), undefined, 'an access token is not a refresh token');
  assert.equal(refreshTokenFormat('cvr_' + id, key, legacyRefreshTokensUntil - 1), 'legacy');
  assert.equal(refreshTokenFormat('cvr_' + id, key, legacyRefreshTokensUntil), undefined);
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
  // Another key sees none of these counts; without a key rate limits refuse to run, while links still work.
  const other = new ConnectionLinks(f.pool, randomBytes(32));
  assert.notEqual(other.keyHash('signin-fail:global'), f.links.keyHash('signin-fail:global'));
  const unkeyed = new ConnectionLinks(f.pool);
  await assert.rejects(unkeyed.budget('x', 1), /clave/);
  const invite = await unkeyed.issue(f.alice.id, (await f.users.hash(f.alice.id))!, 'cinex');
  assert.ok(await unkeyed.exchange(invite.token));
  await unkeyed.cleanup();
});
