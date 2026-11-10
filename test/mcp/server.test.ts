import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Result } from '../../src/core.js';
import { SeatResult } from '../../src/seats/schema.js';
import { createServer } from '../../src/mcp/server.js';
import { CinemaService } from '../../src/service.js';
import { CinexCinemaCatalog } from '../../src/providers/cinex/venues.js';
import { HttpClient } from '../../src/http/client.js';

test('official MCP client discovers tools, validates arguments and reads structured results over stdio', async () => {
  const client = new Client({ name: 'cinev-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'test/helpers/fixture-server.ts'], cwd: process.cwd(), stderr: 'pipe' });
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

const base = 'https://www.cinex.com.ve';
const card = (slug: string, name: string, image: string, city = 'Caracas') => `<a href="cinex-${slug}.html" title="Cinex ${name}, ${city}"><img src="${base}/assets/images/cinemas/${image}"><h3>${name}</h3></a>`;

test('long fan-outs report increasing progress to clients that send a progress token', async () => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { createServer } = await import('../../src/mcp/server.js');
  const epoch = String(Date.parse('2026-09-18T20:30:00-04:00') / 1000);
  const codes = ['AAA', 'BBB', 'CCC'];
  const http = new HttpClient(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/cines.html') return new Response(codes.map(code => card(code.toLowerCase(), code, `x${code}.jpg`)).join(''));
    if (url.pathname === '/assets/php/datasource.php') return Response.json({ data: [{ siglas: url.searchParams.get('cinemaid'), name: url.searchParams.get('cinemaid') }] });
    if (url.pathname === '/cartelera.html') return new Response(`<div class="poster" onclick="x('sinopsis-film.html')" title="FILM"></div>`);
    const m = url.pathname.match(/^\/cinex-([a-z]+)\.html$/);
    if (m) { const code = m[1].toUpperCase(); return new Response(`<h3 class="title">${code}</h3><div class="sessionslist"><h5 class="title">FILM</h5><button onclick="checkLogin('${code}1','${code}')" alt="${epoch}"></button></div>`); }
    return new Response('missing', { status: 404 });
  });
  const server = createServer(new CinemaService(http, new CinexCinemaCatalog()));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'progress', version: '1' });
  await client.connect(clientTransport);
  try {
    const updates: { progress: number; message?: string }[] = [];
    const r = await client.callTool({ name: 'get_showtimes', arguments: { provider: 'cinex', city: 'Caracas', date: '2026-09-18' } }, { onprogress: p => updates.push(p) });
    assert.equal((r.structuredContent as { total: number }).total, 3);
    assert.ok(updates.length >= 4, JSON.stringify(updates)); // discovery batch + three venues
    assert.ok(updates.every((u, i) => i === 0 || u.progress > updates[i - 1].progress), 'progress only increases');
    assert.ok(updates.some(u => u.message === 'Cinex: 3 de 3 sedes leídas.'), JSON.stringify(updates));
  } finally { await client.close(); }
});
