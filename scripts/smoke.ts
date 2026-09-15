import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Result, today } from '../src/core.js';
import type { QueryResult } from '../src/core.js';
import * as z from 'zod';

// Live reads, deliberately separate from deterministic tests. No snapshots count as live data.
const client = new Client({ name: 'cinev-live-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], cwd: process.cwd(), stderr: 'inherit' });
let failed = false;
const requireAuth = process.argv.includes('--require-auth');
const day = today();
async function call(name: string, args: Record<string, unknown>): Promise<QueryResult> {
  const response = await client.callTool({ name, arguments: args });
  const result = Result.parse(response.structuredContent);
  console.log(JSON.stringify({ tool: name, arguments: args, status: result.status, total: result.total, partial: result.partial, sources: result.sources, warnings: result.warnings }));
  if (response.isError || result.status === 'error') failed = true;
  return result;
}
async function authenticatedTickets(provider: 'cinex' | 'cinesunidos', movies: QueryResult) {
  for (const movie of movies.items.slice(0, 8)) {
    const sessions = await call('get_showtimes', { provider, ...(provider === 'cinesunidos' ? { city: 'Caracas' } : {}), movie_id: movie.id, date: day, limit: 100 });
    const s = sessions.items.find(r => r.starts_at && Date.parse(r.starts_at) > Date.now());
    if (!s) continue;
    const prices = await call('get_ticket_prices', { provider, cinema_id: s.cinema_id, session_id: s.id });
    if (requireAuth && prices.status !== 'available') failed = true;
    return;
  }
  console.log(JSON.stringify({ skipped: 'Authenticated ticket check', provider, reason: 'No future function found in the sampled movies.', required: requireAuth }));
  if (requireAuth) failed = true;
}
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 8) throw new Error('Expected 8 tools.');
  const auth = z.object({ providers: z.array(z.object({ provider: z.string(), status: z.string() })) }).parse((await client.callTool({ name: 'get_auth_status', arguments: {} })).structuredContent);
  console.log(JSON.stringify(auth));
  if (requireAuth && !auth.providers.every(p => p.status === 'configured')) throw new Error('Authenticated smoke requires both local accounts to be connected.');
  const providers = await client.callTool({ name: 'list_providers', arguments: {} });
  if (!providers.structuredContent) throw new Error('Missing structured provider catalog.');
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
    } else console.log(JSON.stringify({ skipped: 'Cinepic price live check', cinema_id, reason: 'No upcoming function returned today.' }));
    await call('get_concessions', { provider: 'cinepic', cinema_id });
  }
  const cu = await call('list_movies', { provider: 'cinesunidos', city: 'Caracas', date: day, limit: 8 });
  await authenticatedTickets('cinesunidos', cu);
  await call('get_concessions', { provider: 'cinesunidos', cinema_id: '1005', limit: 2 });
  const cx = await call('list_movies', { provider: 'cinex', limit: 8 });
  await authenticatedTickets('cinex', cx);
  const candy = await call('get_concessions', { provider: 'cinex', cinema_id: 'TLN', limit: 2 });
  if (requireAuth && candy.status !== 'available') failed = true;
  await call('get_ticket_prices', { provider: 'cinex', cinema_id: 'TLN' });
  await call('list_movies', { provider: 'trasnocho' });
} finally { await client.close(); }
if (failed) process.exitCode = 1;
