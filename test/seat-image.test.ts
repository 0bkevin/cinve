import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { parseCinepicSeats, renderSeats, seatLayout } from '../src/seats.js';
import { renderSeatMapPng, renderSeatMapSvg, seatNumber } from '../src/seat-image.js';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http.js';
import { createServer } from '../src/server.js';
import { SeatResult } from '../src/seats.js';
import { cpBuy, EmptySessionStore, page } from './fixtures.js';

// Cinepic Candelaria's room on 2026-11-05: invertida "1", so its website draws
// column 15 (seat A:5) left of column 23 (seat A:1).
const cp = (columna: string, name: string, libre = '1') => ({ butaca: `A-${columna}-1`, nombre_butaca: name, fila: '1', columna, libre, seleccionada: '1', tipo_butaca_id: '8', invertida: '1' });
const map = { butacas: [cp('15', 'A:5'), cp('17', 'A:4', '0'), cp('23', 'A:1')] };
const header = { provider: 'cinepic', cinema: 'Cinepic Candelaria', session: '24939', queriedAt: '2026-11-05T16:52:00.000Z' };
const xOf = (svg: string, title: string) => Number(svg.match(new RegExp(`<title>${title}[^<]*</title><rect x="([\\d.]+)"`))![1]);

test('seat maps follow each provider website: Cinepic screen on top, numbered right to left when invertida', () => {
  const seats = parseCinepicSeats(map), layout = seatLayout('cinepic', map);
  assert.deepEqual(layout, { screen: 'top', column_order: 'descending' });
  const svg = renderSeatMapSvg(seats, layout, header);
  assert.ok(xOf(svg, 'A:1') < xOf(svg, 'A:4') && xOf(svg, 'A:4') < xOf(svg, 'A:5'), 'A:1 (column 23) is drawn leftmost, as cinepiccandelaria.com shows');
  assert.ok(svg.indexOf('PANTALLA') < svg.indexOf('<title>A:'), 'the screen is drawn above the seats');
  assert.match(svg, /Cinepic Candelaria · Función 24939/); assert.doesNotMatch(svg, /Cinepic · Cinepic/);
  assert.match(svg, /Libre \(2\)/); assert.match(svg, /Ocupado \(1\)/); assert.match(svg, /2 libres de 3/);
  assert.match(svg, /Consultado 05\/11\/2026, 12:52/);
  // The ASCII map uses the same orientation.
  const ascii = renderSeats(seats, layout).split('\n');
  assert.equal(ascii[2], '[ PANTALLA ]');
  assert.ok(ascii[4].indexOf('A:1O') < ascii[4].indexOf('A:5O'), ascii[4]);
  assert.deepEqual(seatLayout('cinepic', { butacas: [{ ...cp('1', 'A:1'), invertida: '0' }] }).column_order, 'ascending');
});

test('Cines Unidos maps put the screen below; Cinex maps never claim a screen side', () => {
  const seats = [{ id: '1:A:1', label: 'A:1', row: 'A', area: '1', row_index: 0, column_index: 0, status: 'available' as const, provider_status: '0' },
    { id: '1:B:1', label: 'B:1', row: 'B', area: '1', row_index: 1, column_index: 0, status: 'unknown' as const, provider_status: '9' }];
  const cu = renderSeatMapSvg(seats, seatLayout('cinesunidos'), { ...header, provider: 'cinesunidos', cinema: 'Sede 1005' });
  assert.ok(cu.indexOf('PANTALLA') > cu.indexOf('<title>B:1'), 'the screen is drawn below the last row');
  assert.match(cu, /Cines Unidos · Sede 1005/);
  assert.match(cu, /Desconocido \(1\)/); assert.match(cu, /no significa libre ni agotado/);
  assert.equal(renderSeats(seats, seatLayout('cinesunidos')).split('\n').at(-1), '[ PANTALLA ]');
  const cinex = renderSeatMapSvg(seats, seatLayout('cinex'), { ...header, provider: 'cinex', cinema: 'Sede SBC' });
  assert.doesNotMatch(cinex, /PANTALLA/); assert.match(cinex, /Posición de la pantalla no verificada/);
  assert.match(renderSeats(seats, seatLayout('cinex')), /orientacion de pantalla no verificada/);
  // Seat numbers come from the label, and provider text is escaped.
  assert.equal(seatNumber({ label: 'B12', row: 'B' }), '12'); assert.equal(seatNumber({ label: 'A:5', row: 'A' }), '5');
  assert.doesNotMatch(renderSeatMapSvg(seats, seatLayout('cinex'), { ...header, cinema: '<script>' }), /<script>/);
});

test('the PNG is a real image of the SVG, bounded in width', async () => {
  const svg = renderSeatMapSvg(parseCinepicSeats(map), seatLayout('cinepic', map), header);
  const png = Buffer.from(await renderSeatMapPng(svg));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.ok(width > 500 && width <= 1200 && height > 200, `${width}x${height}`);
});

test('get_seats returns the map as a PNG by default, as SVG on request, and only data with image=none', async t => {
  const server = createServer(new CinemaService(new HttpClient(async () => new Response(page(cpBuy)), 15000, new EmptySessionStore())));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'seat-image-test', version: '1.0.0' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const args = { provider: 'cinepic', cinema_id: '123300', session_id: 'f1', movie_id: 'p1' };
  const png = await client.callTool({ name: 'get_seats', arguments: args });
  assert.equal(png.isError, false);
  const image = (png.content as { type: string; mimeType?: string; data?: string }[]).find(c => c.type === 'image');
  assert.equal(image?.mimeType, 'image/png'); assert.ok(Buffer.from(image!.data!, 'base64').subarray(1, 4).toString() === 'PNG');
  assert.equal(SeatResult.parse(png.structuredContent).layout.screen, 'top');
  const svg = await client.callTool({ name: 'get_seats', arguments: { ...args, image: 'svg' } });
  const resource = (svg.content as { type: string; resource?: { mimeType: string; text: string; uri: string } }[]).find(c => c.type === 'resource')?.resource;
  assert.equal(resource?.mimeType, 'image/svg+xml'); assert.match(resource!.text, /^<svg /); assert.equal(resource!.uri, 'cinve://seats/cinepic/123300/f1.svg');
  const none = await client.callTool({ name: 'get_seats', arguments: { ...args, image: 'none' } });
  assert.deepEqual((none.content as { type: string }[]).map(c => c.type), ['text']);
  const failed = await client.callTool({ name: 'get_seats', arguments: { ...args, provider: 'cinex', cinema_id: 'SBC' } });
  assert.deepEqual((failed.content as { type: string }[]).map(c => c.type), ['text'], 'no image without a verified map');
});
