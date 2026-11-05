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
    const seatTool = list.tools.find(t => t.name === 'get_seats');
    assert.match(seatTool?.description ?? '', /available=0 con unknown>0 NO significa agotado/);
    assert.match(JSON.stringify(seatTool?.outputSchema), /availability_complete/);
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
    assert.equal(SeatResult.parse(seats.structuredContent).seats, undefined, 'the ASCII map is the default representation');
    const detailed = await client.callTool({ name: 'get_seats', arguments: { provider: 'cinepic', cinema_id: '123300', session_id: 'f1', movie_id: 'p1', include_seats: true } });
    const detail = SeatResult.parse(detailed.structuredContent);
    assert.equal(detail.seats?.length, detail.total); assert.ok(detail.seats?.some(s => s.label === 'A:1' && s.status === 'available'));
    const privateSeats = await client.callTool({ name: 'get_seats', arguments: { provider: 'cinesunidos', cinema_id: '1005', session_id: 's1' } });
    assert.equal(SeatResult.parse(privateSeats.structuredContent).status, 'auth_required');
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
  upstream.registerTool('echo_fixture', {
    description: 'Echo', inputSchema: z.object({ city: z.string().min(1).describe('Ciudad') }).strict(), annotations: { readOnlyHint: true },
    _meta: { 'fixture/tool': 'kept' },
  }, async ({ city }, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    if (token !== undefined) for (const progress of [1, 2]) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress, message: `paso ${progress}` } });
    return { content: [{ type: 'text', text: `${city}|${String(ctx.mcpReq._meta?.['fixture/request'] ?? '')}` }] };
  });
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
  // Tools are re-published with their upstream schemas, annotations and descriptions.
  const echo = (await client.listTools()).tools.find(tool => tool.name === 'echo_fixture');
  assert.equal(echo?.description, 'Echo'); assert.equal(echo?.annotations?.readOnlyHint, true);
  assert.deepEqual((echo?.inputSchema as { required?: string[] }).required, ['city']);
  assert.equal(echo?._meta?.['fixture/tool'], 'kept', 'tool-definition metadata is kept');
  assert.equal(((await client.callTool({ name: 'echo_fixture', arguments: { city: 'Caracas' } })).content[0] as { text: string }).text, 'Caracas|');
  // Request metadata reaches upstream, and upstream progress returns to the caller.
  const updates: { progress: number; message?: string }[] = [];
  const withMeta = await client.callTool({ name: 'echo_fixture', arguments: { city: 'Caracas' }, _meta: { 'fixture/request': 'forwarded' } }, { onprogress: p => updates.push(p) });
  assert.equal((withMeta.content[0] as { text: string }).text, 'Caracas|forwarded');
  assert.deepEqual(updates.map(u => [u.progress, u.message]), [[1, 'paso 1'], [2, 'paso 2']]);
  // Validation stays upstream, with its own messages.
  const invalid = await client.callTool({ name: 'echo_fixture', arguments: {} });
  assert.equal(invalid.isError, true); assert.match(JSON.stringify(invalid.content), /city/);
});

test('stdio bridge follows upstream tool changes made while it runs', async t => {
  let deployed = 1;
  const upstreamFor = () => {
    const s = new McpServer({ name: 'upstream-fixture', version: String(deployed) });
    if (deployed === 1) {
      s.registerTool('changed', { inputSchema: z.object({}), outputSchema: z.object({ before: z.literal(true) }) },
        async () => ({ content: [{ type: 'text', text: '{"before":true}' }], structuredContent: { before: true } }));
      s.registerTool('retired', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'old' }] }));
    } else {
      s.registerTool('changed', { inputSchema: z.object({}), outputSchema: z.object({ after: z.literal(true) }) },
        async () => ({ content: [{ type: 'text', text: '{"after":true}' }], structuredContent: { after: true } }));
      s.registerTool('added', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'new' }] }));
    }
    return s;
  };
  const handler = createMcpHandler(upstreamFor, { maxSubscriptions: 0, keepAliveMs: 0 });
  const http = nodeServer((req, res) => { void toNodeHandler(handler)(req, res); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const bridge = await createRemoteServer({ url: `http://127.0.0.1:${address.port}/mcp`, token: 'unused' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bridge-sync-test', version: '1.0.0' });
  await bridge.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => {
    await client.close(); await bridge.close(); await handler.close();
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['changed', 'retired']);
  deployed = 2;
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map(tool => tool.name).sort(), ['added', 'changed']);
  assert.match(JSON.stringify(listed.find(tool => tool.name === 'changed')?.outputSchema), /after/);
  const changed = await client.callTool({ name: 'changed', arguments: {} });
  assert.notEqual(changed.isError, true, JSON.stringify(changed.content));
  assert.deepEqual(changed.structuredContent, { after: true });
  assert.equal(((await client.callTool({ name: 'added', arguments: {} })).content[0] as { text: string }).text, 'new');
  const retired = await client.callTool({ name: 'retired', arguments: {} }).catch((error: Error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
  assert.equal(retired.isError, true);
  // Concurrent lists reconcile once each without registering a name twice.
  const lists = await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
  assert.ok(lists.every(l => l.tools.length === 2));
});
