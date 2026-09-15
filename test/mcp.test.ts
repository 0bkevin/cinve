import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Result } from '../src/core.js';

test('official MCP client discovers tools, validates arguments and reads structured results over stdio', async () => {
  const client = new Client({ name: 'cinev-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'test/fixture-server.ts'], cwd: process.cwd(), stderr: 'pipe' });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools.length, 8);
    assert.ok(list.tools.every(t => t.annotations?.readOnlyHint && t.outputSchema));
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
    const blocked = await client.callTool({ name: 'list_movies', arguments: { provider: 'trasnocho' } });
    assert.equal(Result.parse(blocked.structuredContent).status, 'blocked');
  } finally { await client.close(); }
});
