import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Result, today } from '../src/core.js';
import type { QueryResult } from '../src/core.js';
import * as z from 'zod';

// Live reads, deliberately separate from deterministic tests. No snapshots count as live data.
const client = new Client({ name: 'cinev-live-smoke', version: '1.0.0' });
const urlIndex = process.argv.indexOf('--url');
const remoteUrl = urlIndex < 0 ? undefined : new URL(process.argv[urlIndex + 1]);
if (remoteUrl && (remoteUrl.protocol !== 'https:' || remoteUrl.username || remoteUrl.password)) throw new Error('Use a public HTTPS MCP URL without credentials.');
const transport = remoteUrl ? new StreamableHTTPClientTransport(remoteUrl) : new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], cwd: process.cwd(), stderr: 'inherit' });
let failed = false;
const requireAuth = process.argv.includes('--require-auth');
const day = today();
async function call(name: string, args: Record<string, unknown>, allowed = ['available']): Promise<QueryResult> {
  args = { ...args, refresh: true };
  const started = Date.now();
  const response = await client.callTool({ name, arguments: args });
  const result = Result.parse(response.structuredContent);
  console.log(JSON.stringify({ tool: name, arguments: args, duration_ms: Date.now() - started, status: result.status, total: result.total, partial: result.partial, sources: result.sources, warnings: result.warnings }));
  const expectedError = !['available', 'empty'].includes(result.status);
  if (!allowed.includes(result.status) || response.isError !== expectedError) failed = true;
  if (result.sources.some(s => s.cached)) { failed = true; console.error('Fresh query unexpectedly used cache.'); }
  if (result.status === 'available' && !result.sources.length) failed = true;
  if (name === 'get_showtimes' && result.items.some(s => s.date !== args.date)) failed = true;
  return result;
}
async function authenticatedTickets(provider: 'cinex' | 'cinesunidos', movies: QueryResult) {
  for (const movie of movies.items.slice(0, 8)) {
    const sessions = await call('get_showtimes', { provider, ...(provider === 'cinesunidos' ? { city: 'Caracas' } : {}), movie_id: movie.id, date: day, limit: 100 }, ['available', 'empty', 'unavailable']);
    const s = sessions.items.find(r => r.starts_at && Date.parse(r.starts_at) > Date.now());
    if (!s) continue;
    const prices = await call('get_ticket_prices', { provider, cinema_id: s.cinema_id, session_id: s.id }, requireAuth ? ['available'] : ['available', 'auth_required']);
    if (requireAuth && prices.status !== 'available') failed = true;
    return;
  }
  console.log(JSON.stringify({ skipped: 'Authenticated ticket check', provider, reason: 'No future function found in the sampled movies.', required: requireAuth }));
  failed = true;
}
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const expectedTools = remoteUrl ? 10 : 8;
  if (tools.tools.length !== expectedTools) throw new Error(`Expected ${expectedTools} tools.`);
  const auth = z.object({ providers: z.array(z.object({ provider: z.string(), status: z.string() })) }).parse((await client.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  console.log(JSON.stringify(auth));
  if (requireAuth && !auth.providers.every(p => p.status === 'configured')) throw new Error('Authenticated smoke requires both local accounts to be connected.');
  const providers = await client.callTool({ name: 'list_providers', arguments: {} });
  if (!providers.structuredContent) throw new Error('Missing structured provider catalog.');
  for (const provider of ['cinex', 'cinesunidos', 'cinepic']) await call('list_cities', { provider });
  // Repeat in the same MCP process to prove refresh bypasses warm local state.
  await call('list_cities', { provider: 'cinesunidos' });
  await call('list_cinemas', { provider: 'cinepic' });
  await call('list_cinemas', { provider: 'cinesunidos', city: 'Caracas' });
  await call('list_cinemas', { provider: 'cinex', city: 'Caracas' });
  for (const cinema_id of ['123300', '123301']) {
    await call('list_movies', { provider: 'cinepic', cinema_id, date: today(), limit: 2 });
    const sessions = await call('get_showtimes', { provider: 'cinepic', cinema_id, date: today(), limit: 100 });
    const session = sessions.items.find(r => r.starts_at && Date.parse(r.starts_at) > Date.now());
    if (session) {
      const args = { provider: 'cinepic', cinema_id, session_id: session.id, movie_id: session.movie_id };
      await call('get_ticket_prices', args);
    } else { failed = true; console.log(JSON.stringify({ skipped: 'Cinepic price live check', cinema_id, reason: 'No upcoming function returned today; price retrieval is unverified.' })); }
    await call('get_concessions', { provider: 'cinepic', cinema_id }, ['available', 'empty']);
  }
  const cu = await call('list_movies', { provider: 'cinesunidos', city: 'Caracas', date: day, limit: 8 });
  await authenticatedTickets('cinesunidos', cu);
  await call('get_concessions', { provider: 'cinesunidos', cinema_id: '1005', limit: 2 });
  const cx = await call('list_movies', { provider: 'cinex', limit: 8 });
  await authenticatedTickets('cinex', cx);
  const candy = await call('get_concessions', { provider: 'cinex', cinema_id: 'TLN', limit: 2 }, requireAuth ? ['available'] : ['available', 'auth_required']);
  if (requireAuth && candy.status !== 'available') failed = true;
  console.log(JSON.stringify({ verification: failed ? 'failed' : 'passed', scope: requireAuth ? 'public_and_authenticated' : 'public_with_auth_limitations', date: day }));
} finally { await client.close(); }
if (failed) process.exitCode = 1;
