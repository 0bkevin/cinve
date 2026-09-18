import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createHostedApp } from '../src/hosted.js';
import { EncryptedSessionStore, HostedUsers } from '../src/hosted-store.js';
import { Result } from '../src/core.js';
import { ConnectionLinks } from '../src/hosted-links.js';
import { createRemoteServer } from '../src/remote.js';
import type { login } from '../src/auth.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, authenticate?: typeof login) {
  const schema = 'test_' + randomBytes(12).toString('hex');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });

  await pool.query(await readFile(new URL('../migrations/001_hosted.sql', import.meta.url), 'utf8'));
  const key = randomBytes(32);
  const app = await createHostedApp({ publicUrl: 'http://127.0.0.1:0', allowLocal: true, pool, key, authenticate,
    request: async () => new Response('["Caracas"]') });
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
const successfulLogin: typeof login = async (provider, username, password, store) => {
  assert.equal(username, 'person@example.test'); assert.equal(password, 'SYNTHETIC_PASSWORD');
  await store!.save({ version: 1, provider, expires_at: Date.now() + 60000, access_token: 'SYNTHETIC_UPSTREAM_TOKEN' });
  return { provider, authenticated: true, profile_update_requested: false };
};
async function link(client: Client) {
  const response = await client.callTool({ name: 'connect_account', arguments: { provider: 'cinesunidos' } });
  return new URL((response.structuredContent as { url: string }).url).hash.slice(1);
}

test('hosted MCP authenticates every request; account links are one-use and sessions stay per user', async t => {
  const f = await fixture(t, successfulLogin);
  const anonymous = await f.client();
  assert.equal((await anonymous.listTools()).tools.length, 8);
  const publicData = await anonymous.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal((publicData.structuredContent as { status: string }).status, 'available');
  const protectedData = await anonymous.callTool({ name: 'get_ticket_prices', arguments: { provider: 'cinesunidos', cinema_id: '1', session_id: '1' } });
  assert.equal((protectedData.structuredContent as { status: string }).status, 'auth_required');
  assert.ok(!JSON.stringify(protectedData).includes('npm run')); 
  assert.equal((await fetch(f.origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer invalid' } })).status, 401);
  const alice = await f.client(f.alice.token), bob = await f.client(f.bob.token);
  assert.equal((await alice.listTools()).tools.length, 10);
  const invitation = await link(alice);
  const page = await fetch(f.origin + '/connect');
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.ok(!(await page.text()).includes(invitation));
  assert.equal((await f.post('/connect/exchange', invitation, {}, { Origin: 'https://evil.test' })).status, 403);
  const exchanged = await f.post('/connect/exchange', invitation);
  const { browser_token } = await exchanged.json() as { browser_token: string };
  assert.equal(exchanged.status, 200);
  assert.equal((await f.post('/connect/exchange', invitation)).status, 410);
  const logged = await f.post('/connect/login', browser_token, { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' });
  assert.equal(logged.status, 200); assert.ok(!(await logged.text()).includes('SYNTHETIC'));
  assert.equal((await f.post('/connect/login', browser_token)).status, 410);
  const aStatus = JSON.stringify((await alice.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  const bStatus = JSON.stringify((await bob.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  assert.ok(aStatus.includes('configured')); assert.ok(!bStatus.includes('configured')); assert.ok(!aStatus.includes('SYNTHETIC'));
  const anonymousStatus = JSON.stringify((await anonymous.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
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
  assert.equal(hostedTools.tools.length, 10);
  assert.ok(hostedTools.tools.every(tool => tool.title));
  assert.match(client.getInstructions() ?? '', /Servidor alojado/);
  assert.deepEqual(client.getServerVersion(), { name: 'cinev-hosted-bridge', version: '0.1.0' });
  const result = await client.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
  assert.equal(Result.parse(result.structuredContent).status, 'available');
  assert.ok(!JSON.stringify(result).includes(f.alice.token));
});

test('independent server instances consume a link only once and share saved sessions', async t => {
  const f = await fixture(t), other = new ConnectionLinks(f.pool);
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
  const f = await fixture(t), other = new ConnectionLinks(f.pool);
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
  const f = await fixture(t), other = new ConnectionLinks(f.pool), hash = (await f.users.hash(f.alice.id))!;
  const invite = await f.links.issue(f.alice.id, hash, 'cinex');
  const token = (await other.exchange(invite.token))!.browserToken;
  for (let i = 0; i < 5; i++) { assert.ok(await other.claim(token)); await f.links.release(token); }
  assert.equal(await f.links.claim(token), undefined);
  const requests = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? f.links : other).budget('same-client', 4)));
  assert.equal(requests.filter(Boolean).length, 4);
  await f.pool.query("UPDATE cinev_budgets SET expires_at=now()-interval '1 second'");
  assert.equal(await other.budget('same-client', 4), true);
});
