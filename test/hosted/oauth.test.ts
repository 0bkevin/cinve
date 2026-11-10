import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationSql } from '../../src/hosted/migrations.js';
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ClientMetadataFetcher } from '../../src/hosted/client-metadata.js';
import { fixture, link, successfulLogin } from '../helpers/hosted.js';

const metadataUrl = 'https://assistant.example/oauth/client.json';
const metadataDocuments: Record<string, unknown> = {
  [metadataUrl]: { client_id: metadataUrl, client_name: 'Metadata assistant', redirect_uris: ['https://assistant.example/callback'], token_endpoint_auth_method: 'none' },
  'https://assistant.example/oauth/wrong-id.json': { client_id: 'https://other.example/client.json', redirect_uris: ['https://assistant.example/callback'] },
  'https://assistant.example/oauth/secret.json': { client_id: 'https://assistant.example/oauth/secret.json', client_secret: 'x', redirect_uris: ['https://assistant.example/callback'] },
  'https://assistant.example/oauth/confidential.json': { client_id: 'https://assistant.example/oauth/confidential.json', token_endpoint_auth_methods_supported: ['private_key_jwt'], redirect_uris: ['https://assistant.example/callback'] },
};
const clientMetadata: ClientMetadataFetcher = async url => {
  if (!(url in metadataDocuments)) throw new Error('404');
  return { document: metadataDocuments[url] };
};

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
  for (const origin of ['javascript:alert(1)', 'https://assistant.example/path', 'https://a.example?x', 'https://user@a.example', 'not an origin'])
    assert.equal((await fetch(f.origin + '/mcp', { method: 'OPTIONS', headers: { Origin: origin } })).status, 403, origin);
  // Extension and app-shell clients send origins of their own schemes.
  for (const origin of ['chrome-extension://abcdefghijklmnop', 'moz-extension://0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 'tauri://localhost', 'capacitor://localhost', 'http://[::1]:5173', 'null'])
    assert.equal((await fetch(f.origin + '/mcp', { method: 'OPTIONS', headers: { Origin: origin } })).status, 204, origin);
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

test('one address exhausting its OAuth quota cannot consume the shared OAuth quota', async t => {
  const f = await fixture(t);
  const { digest } = await import('../../src/hosted/store.js');
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES($1,now()+interval '1 minute',61)", [digest('oauth:127.0.0.1')]);
  for (let i = 0; i < 20; i++) assert.equal((await form(f.origin, '/oauth/token', { grant_type: 'refresh_token' })).status, 429);
  const global = await f.pool.query('SELECT count FROM cinev_budgets WHERE key_hash=$1', [digest('oauth:global')]);
  assert.equal(global.rows.length, 0, 'rejected requests must not charge the global budget');
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

test('clients can identify with a Client ID Metadata Document instead of registering', async t => {
  const f = await fixture(t, undefined, undefined, { clientMetadata });
  const metadata = await (await fetch(f.origin + '/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
  assert.equal(metadata.client_id_metadata_document_supported, true);
  const request = await authorizationRequest(f.origin, metadataUrl);
  const page = await (await fetch(request.url)).text();
  assert.match(page, /Metadata assistant/); assert.match(page, /documento publicado en <strong>assistant\.example<\/strong>/);
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
