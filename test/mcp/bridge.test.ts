import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Result } from '../../src/core.js';
import { createRemoteServer } from '../../src/mcp/bridge.js';
import { fixture } from '../helpers/hosted.js';

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
