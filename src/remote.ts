import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { McpServer, SERVER_INFO_META_KEY, fromJsonSchema } from '@modelcontextprotocol/server';
import type { JsonSchemaType, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

/**
 * Publishes an upstream JSON Schema unchanged but leaves validation to the
 * hosted server. Re-validating here would replace its guidance messages
 * ("cinema_id is required; get it with list_cinemas") with generic ones and
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
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077)) throw new Error('The connection file must be private (0600).');
    const data = JSON.parse(await file.readFile('utf8'));
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/mcp' || typeof data.token !== 'string' || !/^cv_[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(data.token)) throw new Error('Invalid remote configuration.');
    return { url: url.href, token: data.token as string };
  } finally { await file.close(); }
}
export async function createRemoteServer(config: { url: string; token: string }) {
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
  const tools = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools); cursor = page.nextCursor;
  } while (cursor);
  for (const tool of tools) {
    server.registerTool(tool.name, {
      title: tool.title, description: tool.description, annotations: tool.annotations,
      ...(tool.icons ? { icons: tool.icons } : {}), ...(tool._meta ? { _meta: tool._meta } : {}),
      inputSchema: upstreamSchema(tool.inputSchema as JsonSchemaType),
      ...(tool.outputSchema ? { outputSchema: upstreamSchema(tool.outputSchema as JsonSchemaType) } : {}),
    }, async (args, ctx) => {
      // Forward tool metadata as well as ordinary results, and the caller's
      // cancellation. This bridge does not implement elicitation, so it
      // intentionally does not advertise it.
      // Forward the caller's application _meta. Its progress token is the
      // caller's: the upstream call gets its own, and each upstream progress
      // update is re-sent to the caller under the caller's token.
      const { progressToken, ...meta } = ctx.mcpReq._meta ?? {};
      const result = await client.callTool(
        { name: tool.name, arguments: args as Record<string, unknown>, ...(Object.keys(meta).length ? { _meta: meta } : {}) },
        {
          signal: ctx.mcpReq.signal,
          ...(progressToken === undefined ? {} : {
            onprogress: progress => {
              void ctx.mcpReq.notify({ method: 'notifications/progress', params: { ...progress, progressToken } }).catch(() => {});
            },
          }),
        });
      const { _meta, ...body } = result;
      const forwarded = stripServerIdentity(_meta);
      return { ...body, ...(forwarded ? { _meta: forwarded } : {}) } as typeof result;
    });
  }
  server.server.onclose = () => { void client.close(); };
  return server;
}
