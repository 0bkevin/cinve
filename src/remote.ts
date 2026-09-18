import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { SERVER_INFO_META_KEY, Server } from '@modelcontextprotocol/server';
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
  // Preserve the upstream usage guidance so a stdio client receives the same
  // account and data handling instructions as a direct hosted client.
  const instructions = client.getInstructions();
  const server = new Server({ name: 'cinve', version: '0.1.0' }, {
    capabilities: { tools: {} },
    ...(instructions ? { instructions } : {}),
  });
  const stripServerIdentity = (meta: Record<string, unknown> | undefined) => {
    if (!meta) return undefined;
    const forwarded = { ...meta };
    // The bridge must identify itself. Forwarding the upstream reserved key
    // would make clients attribute the bridge response to the hosted server.
    delete forwarded[SERVER_INFO_META_KEY];
    return Object.keys(forwarded).length ? forwarded : undefined;
  };
  server.setRequestHandler('tools/list', async request => {
    const result = await client.listTools(request.params);
    const { _meta, ...body } = result;
    const forwarded = stripServerIdentity(_meta);
    return { ...body, ...(forwarded ? { _meta: forwarded } : {}) };
  });
  server.setRequestHandler('tools/call', async request => {
    // Forward tool metadata as well as ordinary results. This bridge does not
    // implement elicitation, so it intentionally does not advertise it.
    const result = await client.callTool(request.params);
    const { _meta, ...body } = result;
    const forwarded = stripServerIdentity(_meta);
    return {
      ...body,
      ...(forwarded ? { _meta: forwarded } : {}),
    };
  });
  server.onclose = () => { void client.close(); };
  return server;
}
