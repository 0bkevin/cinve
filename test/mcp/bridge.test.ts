import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createRemoteServer, upstreamCallTimeoutMs } from '../../src/mcp/bridge.js';
import { createServer as nodeServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import * as z from 'zod';
import { firstText } from '../helpers/assert.js';

// The SDK declares method?: string, which Node's method?: string | undefined fails under exactOptionalPropertyTypes.
const serve = (handler: Parameters<typeof toNodeHandler>[0]) => (req: IncomingMessage, res: ServerResponse) => { void toNodeHandler(handler)(req as NodeIncomingMessageLike, res); };

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
  const http = nodeServer(serve(upstreamHandler));
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
  assert.equal(result._meta?.['fixture-key'], 'preserved');
  assert.equal(client.getServerVersion()?.name, 'cinve');
  // Tools are re-published with their upstream schemas, annotations and descriptions.
  const echo = (await client.listTools()).tools.find(tool => tool.name === 'echo_fixture');
  assert.equal(echo?.description, 'Echo'); assert.equal(echo?.annotations?.readOnlyHint, true);
  assert.deepEqual(echo?.inputSchema.required, ['city']);
  assert.equal(echo?._meta?.['fixture/tool'], 'kept', 'tool-definition metadata is kept');
  assert.equal(firstText((await client.callTool({ name: 'echo_fixture', arguments: { city: 'Caracas' } })).content), 'Caracas|');
  // Request metadata reaches upstream, and upstream progress returns to the caller.
  const updates: { progress: number; message?: string | undefined }[] = [];
  const withMeta = await client.callTool({ name: 'echo_fixture', arguments: { city: 'Caracas' }, _meta: { 'fixture/request': 'forwarded' } }, { onprogress: p => updates.push(p) });
  assert.equal(firstText(withMeta.content), 'Caracas|forwarded');
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
  const http = nodeServer(serve(handler));
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
  assert.equal(firstText((await client.callTool({ name: 'added', arguments: {} })).content), 'new');
  const retired = await client.callTool({ name: 'retired', arguments: {} }).catch((error: Error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
  assert.equal(retired.isError, true);
  // Concurrent lists reconcile once each without registering a name twice.
  const lists = await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
  assert.ok(lists.every(l => l.tools.length === 2));
});

test('stdio bridge waits for upstream calls longer than the SDK default and the hosted limit', async t => {
  assert.ok(upstreamCallTimeoutMs > 90_000, 'the hosted deadline, not the bridge, ends a slow call');
  const upstream = () => {
    const s = new McpServer({ name: 'upstream-fixture', version: '1.0.0' });
    s.registerTool('slow', { inputSchema: z.object({}) }, async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return { content: [{ type: 'text', text: 'done' }] };
    });
    return s;
  };
  const handler = createMcpHandler(upstream, { maxSubscriptions: 0, keepAliveMs: 0 });
  const http = nodeServer(serve(handler));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const clients: Client[] = [], bridges: McpServer[] = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    for (const b of bridges) await b.close();
    await handler.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const call = async (timeout?: number) => {
    const bridge = await createRemoteServer({ url, token: 'unused' }, timeout); bridges.push(bridge);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'bridge-timeout-test', version: '1.0.0' }); clients.push(client);
    await bridge.connect(serverTransport); await client.connect(clientTransport);
    return client.callTool({ name: 'slow', arguments: {} });
  };
  assert.equal(firstText((await call()).content), 'done');
  const cut = await call(100);
  assert.equal(cut.isError, true, 'the configured timeout is what bounds the upstream call');
  assert.match(JSON.stringify(cut.content), /timed out/i);
});
