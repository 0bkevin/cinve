import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export async function remoteConfig(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077)) throw new Error('El archivo de conexión debe ser privado (0600).');
    const data = JSON.parse(await file.readFile('utf8'));
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/mcp' || typeof data.token !== 'string' || !/^cv_[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(data.token)) throw new Error('Configuración remota no válida.');
    return { url: url.href, token: data.token as string };
  } finally { await file.close(); }
}
export async function createRemoteServer(config: { url: string; token: string }) {
  const client = new Client({ name: 'cinev-stdio-bridge', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error' } }));
  const server = new Server({ name: 'cinev-hosted-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', request => client.listTools(request.params));
  server.setRequestHandler('tools/call', async request => {
    // Forward only ordinary tool results; this bridge does not implement elicitation.
    const result = await client.callTool(request.params);
    return { content: result.content, structuredContent: result.structuredContent, isError: result.isError };
  });
  server.onclose = () => { void client.close(); };
  return server;
}
