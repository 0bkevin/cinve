import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as nodeServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler, InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod';
import { Result } from '../src/core.js';
import { SeatResult } from '../src/seats.js';
import { createServer } from '../src/server.js';
import { CinemaService } from '../src/service.js';
import { createRemoteServer } from '../src/remote.js';

test('official MCP client discovers tools, validates arguments and reads structured results over stdio', async () => {
  const client = new Client({ name: 'cinev-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'test/fixture-server.ts'], cwd: process.cwd(), stderr: 'pipe' });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools.length, 9);
    assert.ok(list.tools.every(t => t.annotations?.readOnlyHint && t.outputSchema));
    assert.ok(list.tools.every(t => t.title));
    const movies = list.tools.find(t => t.name === 'list_movies');
    assert.match(JSON.stringify(movies?.inputSchema), /ID de película/);
    const showtimes = list.tools.find(t => t.name === 'get_showtimes');
    assert.equal((showtimes?.outputSchema as { properties: { items: { items: { properties: { kind: { const: string } } } } } }).properties.items.items.properties.kind.const, 'showtime');
    assert.equal(JSON.stringify(list.tools).includes('"password"'), false);
    const auth = await client.callTool({ name: 'get_auth_status', arguments: {} });
    assert.ok(auth.structuredContent);
    const r = await client.callTool({ name: 'list_cities', arguments: { provider: 'cinesunidos' } });
    const data = Result.parse(r.structuredContent);
    assert.equal(data.status, 'available'); assert.equal(data.total, 2);
    const parsedText = JSON.parse((r.content[0] as { text: string }).text);
    assert.deepEqual(data, parsedText);
    const bad = await client.callTool({ name: 'get_showtimes', arguments: { provider: 'cinepic' } });
    assert.equal(bad.isError, true);
    const authRequired = await client.callTool({ name: 'get_ticket_prices', arguments: { provider: 'cinesunidos', cinema_id: '1002', session_id: 's1' } });
    assert.equal(authRequired.isError, true);
    assert.equal(Result.parse(authRequired.structuredContent).status, 'auth_required');
    const seats = await client.callTool({ name: 'get_seats', arguments: { provider: 'cinepic', cinema_id: '123300', session_id: 'f1', movie_id: 'p1' } });
    assert.equal(SeatResult.parse(seats.structuredContent).available, 1);
    assert.match(SeatResult.parse(seats.structuredContent).ascii, /A:1O/);
    const privateSeats = await client.callTool({ name: 'get_seats', arguments: { provider: 'cinesunidos', cinema_id: '1005', session_id: 's1' } });
    assert.equal(SeatResult.parse(privateSeats.structuredContent).status, 'auth_required');
    const blocked = await client.callTool({ name: 'list_movies', arguments: { provider: 'trasnocho' } });
    assert.equal(blocked.isError, true);
    assert.equal(Result.parse(blocked.structuredContent).status, 'blocked');
  } finally { await client.close(); }
});

test('account adapter failures are returned without exposing internal exception text', async () => {
  const server = createServer(undefined, {
    connect: async () => { throw new Error('DATABASE_SECRET_INTERNAL'); },
    disconnect: async () => { throw new Error('DATABASE_SECRET_INTERNAL'); },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'error-test', version: '1.0.0' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'connect_account', arguments: { provider: 'cinex' } });
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('DATABASE_SECRET_INTERNAL'), false);
    assert.match((result.content[0] as { text: string }).text, /No se pudo crear el enlace/);
    const disconnected = await client.callTool({ name: 'disconnect_account', arguments: { provider: 'cinex' } });
    assert.equal(disconnected.isError, true);
    assert.equal(JSON.stringify(disconnected).includes('DATABASE_SECRET_INTERNAL'), false);
    assert.match((disconnected.content[0] as { text: string }).text, /No se pudo desconectar la cuenta/);
  } finally { await client.close(); await server.close(); }

  const authServer = createServer(new class extends CinemaService {
    override async authStatus(): Promise<never> { throw new Error('AUTH_STATUS_INTERNAL'); }
  });
  const [authServerTransport, authClientTransport] = InMemoryTransport.createLinkedPair();
  const authClient = new Client({ name: 'auth-error-test', version: '1.0.0' });
  await authServer.connect(authServerTransport); await authClient.connect(authClientTransport);
  try {
    const status = await authClient.callTool({ name: 'get_auth_status', arguments: {} });
    assert.equal(status.isError, true);
    assert.equal(JSON.stringify(status).includes('AUTH_STATUS_INTERNAL'), false);
    assert.match((status.content[0] as { text: string }).text, /No se pudo leer el estado/);
  } finally { await authClient.close(); await authServer.close(); }
});

test('stdio bridge forwards application metadata but keeps its own server identity', async t => {
  const upstream = new McpServer({ name: 'upstream-fixture', version: '1.0.0' }, { instructions: 'Upstream handling guidance.' });
  upstream.registerTool('metadata_fixture', {
    title: 'Metadata fixture', inputSchema: z.object({}), outputSchema: z.object({ ok: z.literal(true) }),
  }, async () => ({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true }, _meta: { 'fixture-key': 'preserved' } }));
  const upstreamHandler = createMcpHandler(() => upstream, { maxSubscriptions: 0, keepAliveMs: 0 });
  const http = nodeServer((req, res) => { void toNodeHandler(upstreamHandler)(req, res); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const bridge = await createRemoteServer({ url: `http://127.0.0.1:${address.port}/mcp`, token: 'unused' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bridge-metadata-test', version: '1.0.0' });
  await bridge.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => {
    await client.close(); await bridge.close(); await upstreamHandler.close();
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const result = await client.callTool({ name: 'metadata_fixture', arguments: {} });
  assert.equal((result._meta as Record<string, unknown>)['fixture-key'], 'preserved');
  assert.equal(client.getServerVersion()?.name, 'cinve');
});
