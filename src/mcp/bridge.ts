import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { McpServer, SERVER_INFO_META_KEY, fromJsonSchema } from '@modelcontextprotocol/server';
import type { JsonSchemaType, RegisteredTool, StandardSchemaWithJSON, ToolCallback } from '@modelcontextprotocol/server';

/**
 * Publishes an upstream JSON Schema unchanged but leaves validation to the
 * hosted server. Re-validating here would replace its guidance messages
 * ("Se requiere cinema_id; obtenlo con list_cinemas") with generic ones and
 * reject arguments it deliberately accepts, such as null for "not given".
 */
function upstreamSchema(schema: JsonSchemaType): StandardSchemaWithJSON {
  const published = fromJsonSchema(schema)['~standard'];
  return { '~standard': { ...published, validate: (value: unknown) => ({ value }) } };
}
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
/** Longer than the hosted function's 90 s limit, so the server's own deadline answers first. */
export const upstreamCallTimeoutMs = 95_000;
export async function createRemoteServer(config: { url: string; token: string }, callTimeoutMs = upstreamCallTimeoutMs) {
  const client = new Client({ name: 'cinev-stdio-bridge', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error' } }));
  // Preserve the upstream usage guidance so a stdio client receives the same
  // account and data handling instructions as a direct hosted client.
  const instructions = client.getInstructions();
  // The high-level McpServer (the low-level Server class is deprecated for
  // this use) re-publishes each upstream tool with its own JSON Schemas.
  const server = new McpServer({ name: 'cinve', version: '0.1.0' }, instructions ? { instructions } : undefined);
  const stripServerIdentity = (meta: Record<string, unknown> | undefined) => {
    if (!meta) return undefined;
    const forwarded = { ...meta };
    // The bridge must identify itself. Forwarding the upstream reserved key
    // would make clients attribute the bridge response to the hosted server.
    delete forwarded[SERVER_INFO_META_KEY];
    return Object.keys(forwarded).length ? forwarded : undefined;
  };
  type UpstreamTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
  const callUpstream = (name: string): ToolCallback<StandardSchemaWithJSON> => async (args, ctx) => {
    // Forward tool metadata as well as ordinary results, and the caller's
    // cancellation. This bridge does not implement elicitation, so it
    // intentionally does not advertise it.
    // Forward the caller's application _meta. Its progress token is the
    // caller's: the upstream call gets its own, and each upstream progress
    // update is re-sent to the caller under the caller's token.
    const { progressToken, ...meta } = ctx.mcpReq._meta ?? {};
    const result = await client.callTool(
      { name, arguments: args as Record<string, unknown>, ...(Object.keys(meta).length ? { _meta: meta } : {}) },
      {
        signal: ctx.mcpReq.signal,
        // The SDK's default 60 s would cut off a city-wide fan-out that the
        // hosted server finishes in up to about 75 s (its own limit is 90 s).
        timeout: callTimeoutMs,
        ...(progressToken === undefined ? {} : {
          onprogress: progress => {
            void ctx.mcpReq.notify({ method: 'notifications/progress', params: { ...progress, progressToken } }).catch(() => {});
          },
        }),
      });
    const { _meta, ...body } = result;
    const forwarded = stripServerIdentity(_meta);
    return { ...body, ...(forwarded ? { _meta: forwarded } : {}) } as typeof result;
  };
  const register = (tool: UpstreamTool) => server.registerTool(tool.name, {
    title: tool.title, description: tool.description, annotations: tool.annotations,
    ...(tool.icons ? { icons: tool.icons } : {}), ...(tool._meta ? { _meta: tool._meta } : {}),
    inputSchema: upstreamSchema(tool.inputSchema as JsonSchemaType),
    ...(tool.outputSchema ? { outputSchema: upstreamSchema(tool.outputSchema as JsonSchemaType) } : {}),
  }, callUpstream(tool.name));
  // Registrations mirror the upstream list. A deployment can add, change or
  // remove tools while this bridge keeps running, so every tools/list request
  // re-reads the upstream list (which also refreshes the client's cached
  // output schemas) and reconciles the registrations before answering.
  const registered = new Map<string, { tool: RegisteredTool; definition: string }>();
  let upstreamTools: UpstreamTool[] = [];
  const reconcile = async () => {
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools); cursor = page.nextCursor;
    } while (cursor);
    const listed = new Set(tools.map(tool => tool.name));
    for (const [name, entry] of registered) if (!listed.has(name)) { entry.tool.remove(); registered.delete(name); }
    for (const tool of tools) {
      const definition = JSON.stringify(tool), entry = registered.get(tool.name);
      if (entry?.definition === definition) continue;
      // Re-register a changed tool: update() keeps fields an upstream change
      // removed (such as a dropped outputSchema).
      entry?.tool.remove();
      registered.set(tool.name, { tool: register(tool), definition });
    }
    upstreamTools = tools;
  };
  // One reconciliation at a time: concurrent lists would register a name twice.
  let reconciling: Promise<void> | undefined;
  const sync = () => reconciling ??= reconcile().finally(() => { reconciling = undefined; });
  await sync();
  // McpServer installs its tools handlers on the first registration; this
  // list handler must replace that one, not be replaced by it.
  if (!registered.size) throw new Error('El servidor remoto no publicó herramientas.');
  server.server.setRequestHandler('tools/list', async () => { await sync(); return { tools: upstreamTools }; });
  server.server.onclose = () => { void client.close(); };
  return server;
}
