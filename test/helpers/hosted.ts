// A hosted app on a throwaway Postgres schema, with two issued users and MCP
// and browser helpers, shared by the hosted, web and bridge tests.
import assert from 'node:assert/strict';
import { migrationSql } from '../../src/hosted/migrations.js';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHostedApp } from '../../src/hosted/app.js';
import type { login } from '../../src/auth/login.js';
import type { ClientMetadataFetcher } from '../../src/hosted/client-metadata.js';

export async function fixture(t: { after(fn: () => Promise<void>): void }, authenticate?: typeof login | undefined,
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
export const successfulLogin: typeof login = async (provider, username, password, store) => {
  assert.equal(username, 'person@example.test'); assert.equal(password, 'SYNTHETIC_PASSWORD');
  await store!.save({ version: 1, provider, expires_at: Date.now() + 60000, access_token: 'SYNTHETIC_UPSTREAM_TOKEN' });
  return { provider, authenticated: true, profile_update_requested: false };
};
export async function link(client: Client) {
  const response = await client.callTool({ name: 'connect_account', arguments: { provider: 'cinesunidos' } });
  return new URL((response.structuredContent as { url: string }).url).hash.slice(1);
}
