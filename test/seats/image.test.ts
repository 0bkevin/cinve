import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { renderSeats } from '../../src/seats/ascii.js';
import { cinepicBookableTypes, parseCinepicSeats, parseCinexShowing } from '../../src/seats/parsers.js';
import { seatLayout } from '../../src/seats/schema.js';
import { cinepicTicketsLeft } from '../../src/providers/cinepic/sites.js';
import { crc32, inflateSync } from 'node:zlib';
import { encodeIndexedPng, MapTooLarge, MAX_PNG_PIXELS, renderSeatMapPng, renderSeatMapSvg, seatNumber, textWidth } from '../../src/seats/image.js';
import { CinemaService } from '../../src/service.js';
import { HttpClient } from '../../src/http/client.js';
import { createServer } from '../../src/mcp/server.js';
import { SeatResult } from '../../src/seats/schema.js';
import { Result } from '../../src/core.js';
import { cpBuy, EmptySessionStore, page } from '../helpers/fixtures.js';
import { capture, instance, nth } from '../helpers/assert.js';

// Cinepic Candelaria's room on 2026-11-05: invertida "1", so its website draws
// column 15 (seat A:5) left of column 23 (seat A:1).
const cp = (columna: string, name: string, libre = '1') => ({ butaca: `A-${columna}-1`, nombre_butaca: name, fila: '1', columna, libre, seleccionada: '1', tipo_butaca_id: '8', invertida: '1' });
const map = { butacas: [cp('15', 'A:5'), cp('17', 'A:4', '0'), cp('23', 'A:1')] };
const header = { provider: 'cinepic', cinema: 'Cinepic Candelaria', session: '24939', queriedAt: '2026-11-05T16:52:00.000Z' };
const xOf = (svg: string, title: string) => Number(capture(svg, new RegExp(`<title>${title}[^<]*</title><rect x="([\\d.]+)"`)));

test('seat maps follow each provider website: Cinepic screen on top, numbered right to left when invertida', () => {
  const seats = parseCinepicSeats(map), layout = seatLayout('cinepic', map);
  assert.deepEqual(layout, { screen: 'top', column_order: 'descending' });
  const svg = renderSeatMapSvg(seats, layout, header);
  assert.ok(xOf(svg, 'A:1') < xOf(svg, 'A:4') && xOf(svg, 'A:4') < xOf(svg, 'A:5'), 'A:1 (column 23) is drawn leftmost, as cinepiccandelaria.com shows');
  assert.ok(svg.indexOf('PANTALLA') < svg.indexOf('<title>A:'), 'the screen is drawn above the seats');
  assert.match(svg, />Cinepic Candelaria<.*>Función 24939</); assert.doesNotMatch(svg, /Cinepic · Cinepic/);
  assert.match(svg, /Libre \(2\)/); assert.match(svg, /Ocupado \(1\)/); assert.match(svg, /fill="#ffbd3f" text-anchor="end">2<\/text><text[^>]*>libres de 3</);
  assert.match(svg, /Consultado 05\/11\/2026, 12:52/);
  // The ASCII map uses the same orientation.
  const ascii = renderSeats(seats, layout).split('\n');
  assert.equal(ascii[2], '[ PANTALLA ]');
  assert.ok(nth(ascii, 4).indexOf('A:1O') < nth(ascii, 4).indexOf('A:5O'), ascii[4]);
  assert.deepEqual(seatLayout('cinepic', { butacas: [{ ...cp('1', 'A:1'), invertida: '0' }] }).column_order, 'ascending');
});

test('Cines Unidos and Cinex maps put the screen below; an unverified side is never drawn', () => {
  const seats = [{ id: '1:A:1', label: 'A:1', row: 'A', area: '1', row_index: 0, column_index: 0, status: 'available' as const, provider_status: '0' },
    { id: '1:B:1', label: 'B:1', row: 'B', area: '1', row_index: 1, column_index: 0, status: 'unknown' as const, provider_status: '9' }];
  const cu = renderSeatMapSvg(seats, seatLayout('cinesunidos'), { ...header, provider: 'cinesunidos', cinema: 'Sede 1005' });
  assert.ok(cu.indexOf('PANTALLA') > cu.indexOf('<title>B:1'), 'the screen is drawn below the last row');
  assert.match(cu, /Cines Unidos · Sede 1005/);
  assert.match(cu, /Desconocido \(1\)/); assert.match(cu, /no significa libre ni agotado/);
  assert.equal(renderSeats(seats, seatLayout('cinesunidos')).split('\n').at(-1), '[ PANTALLA ]');
  // cinex.com.ve draws its screen image right after the grid, below row A.
  const cinex = renderSeatMapSvg(seats, seatLayout('cinex'), { ...header, provider: 'cinex', cinema: 'Sede SBC' });
  assert.ok(cinex.indexOf('PANTALLA') > cinex.indexOf('<title>B:1')); assert.doesNotMatch(cinex, /no indica el lado/);
  const unverified = { screen: 'unverified' as const, column_order: 'ascending' as const };
  assert.doesNotMatch(renderSeatMapSvg(seats, unverified, header), /PANTALLA/); assert.match(renderSeatMapSvg(seats, unverified, header), /La web del cine no indica el lado de la pantalla/);
  assert.match(renderSeats(seats, unverified), /que no indica el lado de la pantalla/);
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
  const image = png.content.find(c => c.type === 'image');
  assert.ok(image?.type === 'image', 'an image block');
  assert.equal(image.mimeType, 'image/png'); assert.ok(Buffer.from(image.data, 'base64').subarray(1, 4).toString() === 'PNG');
  assert.equal(SeatResult.parse(png.structuredContent).layout.screen, 'top');
  const svg = await client.callTool({ name: 'get_seats', arguments: { ...args, image: 'svg' } });
  const embedded = svg.content.find(c => c.type === 'resource');
  assert.ok(embedded?.type === 'resource' && 'text' in embedded.resource, 'an embedded text resource');
  const { resource } = embedded;
  assert.equal(resource.mimeType, 'image/svg+xml'); assert.match(resource.text, /^<svg /); assert.equal(resource.uri, 'cinve://seats/cinepic/123300/f1.svg');
  const none = await client.callTool({ name: 'get_seats', arguments: { ...args, image: 'none' } });
  assert.deepEqual(none.content.map(c => c.type), ['text']);
  const failed = await client.callTool({ name: 'get_seats', arguments: { ...args, provider: 'cinex', cinema_id: 'SBC' } });
  assert.deepEqual(failed.content.map(c => c.type), ['text'], 'no image without a verified map');
});

// The function line as cinex.com.ve's seat page printed it on 2026-11-05.
const cinexInfo = (available: number, hora = '02:45pm') => `<section id="cinexasientodatalistzy"><div class="movie-details"><h3 class="title">LAS ALTAGRACIAS EN NAVIDAD</h3></div><div class="col-md-8"><h3 class="title">Seleccione sus asientos</h3></div>`
  + `<div style="text-align:center">CINEX SAMBIL CHACAO | Sala 3 | <b>Fecha:</b> 05-11-2026 | <b>Hora:</b> ${hora} | <b>Formato:</b> DIG ESP | <b>Asientos disponibles:</b> ${available} asiento(s)</div></section>`;
const cinexMap = `<a id="btnasientosatras" href="boletosdev.php?cinemaid=SBC&sessionid=s1">Atras</a><div id="mapcontent"><div class="row centermap"><div class="rowletter">B</div><div id="B1" class="seatestandar" alt="0" onclick="javascript:decideAsientoNew('B1','0','0','1','0001','0','N','N');"></div><div title="B2" class="seatestandar-occupied" alt="B2"></div></div></div>`;

test('the seat result names the function from the same provider response, and checks Cinex\'s own count', async () => {
  assert.deepEqual(parseCinexShowing(cinexInfo(154)), { showing: { movie: 'LAS ALTAGRACIAS EN NAVIDAD', cinema_name: 'CINEX SAMBIL CHACAO', screen: 'Sala 3', date: '2026-11-05', time: '14:45' }, available: 154 });
  assert.equal(parseCinexShowing(cinexInfo(1, '12:10am')).showing?.time, '00:10');
  assert.equal(parseCinexShowing(cinexInfo(1, '12:10pm')).showing?.time, '12:10');
  assert.equal(parseCinexShowing(cinexInfo(1, '13:10pm')).showing?.time, undefined);
  assert.deepEqual(parseCinexShowing('<div>otra página</div>'), { showing: undefined, available: undefined });
  const sessions = new class extends EmptySessionStore { override async headers() { return { Cookie: 'synthetic', Authorization: 'Bearer synthetic' }; } };
  let info = cinexInfo(1);
  const cinex = new CinemaService(new HttpClient(async url => new Response(String(url).endsWith('checklogin.php') ? 'on' : String(url).endsWith('asientosdev.php') ? info + cinexMap : ''), 15000, sessions));
  const q = { provider: 'cinex' as const, cinema_id: 'SBC', session_id: 's1' };
  const matched = await cinex.seats(q);
  assert.equal(matched.showing?.movie, 'LAS ALTAGRACIAS EN NAVIDAD'); assert.doesNotMatch(matched.warnings.join(' '), /difiere/);
  info = cinexInfo(5);
  assert.match((await cinex.seats(q)).warnings.join(' '), /contador de asientos disponibles de Cinex \(5\) difiere del mapa \(1 libres\)/);
  // Cines Unidos only names the room, and only when every area shares it.
  let areas = ['SALA 8 - FULL'];
  const cu = new CinemaService(new HttpClient(async () => Response.json({ seats: { areas: areas.map((description, a) => ({ number: a + 1, description, rows: [{ rowIndexZeroBased: 0, physicalName: 'A', seats: [{ id: '1', status: 0, position: { areaNumber: a + 1, rowIndex: 0, columnIndex: 0 } }] }] })) } }), 15000, sessions));
  const cuq = { provider: 'cinesunidos' as const, cinema_id: '1008', session_id: 's1' };
  assert.deepEqual((await cu.seats(cuq)).showing, { screen: 'Sala 8' });
  areas = ['SALA 8 - FULL', 'SALA 9 - VIP'];
  assert.equal((await cu.seats(cuq)).showing, undefined);
});

test('the image header shows the film, venue, room and time, and fits long titles', () => {
  const seats = parseCinepicSeats(map), layout = seatLayout('cinepic', map);
  const svg = renderSeatMapSvg(seats, layout, { ...header, movie: 'EL GATO CON SOMBRERO (ESP)', screen: 'Sala 04', date: '2026-11-05', time: '14:15' });
  assert.match(svg, />EL GATO CON SOMBRERO \(ESP\)</); assert.match(svg, />Cinepic Candelaria · Sala 04</); assert.match(svg, />05\/11\/2026 14:15 · Función 24939</);
  const long = renderSeatMapSvg(seats, layout, { ...header, movie: 'UNA PELÍCULA '.repeat(10) });
  assert.match(long, /…<\/text>/); assert.doesNotMatch(long, /(UNA PELÍCULA ){10}/);
  assert.match(renderSeatMapSvg(seats, layout, header), />Mapa de asientos</);
});

// Candelaria Sala 04 on 2026-11-05: both tariffs carry id "1", so its 11 free
// seats of types 8 and 9 are drawn "no disponible", and the page offers a cupo
// of tot - vend - temp tickets per tariff (lowered here below the free seats).
test('Cinepic seats and ticket counters follow the purchase page', async t => {
  const seat = (columna: string, tipo: string, libre = '1') => ({ butaca: `A-${columna}-1`, nombre_butaca: `A:${columna}`, fila: '1', columna, libre, seleccionada: '1', tipo_butaca_id: tipo, invertida: '0' });
  const tarifas = [{ _id: '2', id: '1', descripcion: 'COMPLETO', precio: '4474.4', tot: '150', vend: '2', temp: '2' }, { _id: '5', id: '1', descripcion: 'NIÑOS', precio: '2237.2', tot: '150', vend: '2', temp: '2' }];
  const butacas = { butacas: [seat('1', '1'), seat('2', '8'), seat('3', '9'), seat('4', '1', '0'), ...Array.from({ length: 300 }, (_, i) => seat(String(i + 5), '1'))].slice(0, 199) };
  assert.deepEqual(parseCinepicSeats(butacas, cinepicBookableTypes(tarifas)).slice(0, 4).map(s => s.status), ['available', 'unavailable', 'unavailable', 'occupied']);
  assert.equal(cinepicBookableTypes([{ ...tarifas[0], id: '' }]), 'all', 'a tariff without id books any free seat');
  assert.equal(cinepicBookableTypes([]), 'all', 'an empty list keeps the map states');
  assert.deepEqual([...instance(cinepicBookableTypes([{ id: '08' }, { id: 'vip' }]), Set)], ['8', 'vip']);
  assert.equal(cinepicTicketsLeft({ tot: '9'.repeat(30), vend: '0', temp: '0' }), undefined, 'an unsafe integer is not a count');
  assert.equal(cinepicTicketsLeft(nth(tarifas, 0)), 146); assert.equal(cinepicTicketsLeft({ tot: '5' }), undefined);
  const body = page({ ...cpBuy, butacasData: butacas, functionData: { datos: [{ id: 'f1', codigo: 'p1' }], tarifas } });
  const server = createServer(new CinemaService(new HttpClient(async () => new Response(body), 15000, new EmptySessionStore())));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cinepic-test', version: '1.0.0' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const args = { provider: 'cinepic', cinema_id: '123300', session_id: 'f1', movie_id: 'p1', image: 'none' };
  const seats = SeatResult.parse((await client.callTool({ name: 'get_seats', arguments: args })).structuredContent);
  assert.deepEqual([seats.available, seats.unavailable, seats.occupied], [196, 2, 1]);
  assert.match(seats.warnings.join(' '), /2 butacas libres de un tipo especial/);
  assert.match(seats.warnings.join(' '), /ofrece en línea 146 entradas COMPLETO, 146 entradas NIÑOS; puede vender menos entradas que las 196 butacas libres/);
  const { image: _, ...priceArgs } = args;
  const prices = Result.parse((await client.callTool({ name: 'get_ticket_prices', arguments: priceArgs })).structuredContent);
  assert.deepEqual(prices.items.map(i => [i.name, i.tickets_available]), [['COMPLETO', 146], ['NIÑOS', 146]]);
});

test('the image survives hostile or oversized maps without hiding the data', async () => {
  const s = (row: string, area: string, row_index: number, column_index: number, status: 'available' | 'unknown' | 'occupied' | 'unavailable' = 'available') => ({ label: `${row}:${column_index + 1}`, row, area, row_index, column_index, status });
  // Control characters and lone surrogates would make the SVG invalid XML.
  const svg = renderSeatMapSvg([s('A', '1', 0, 0)], seatLayout('cinepic', map), { ...header, movie: 'A\u0001B\u0000C￾\uD800' });
  assert.match(svg, />ABC</);
  assert.ok((await renderSeatMapPng(svg)).length > 100);
  // Long titles are cut by characters, never inside an emoji.
  assert.doesNotMatch(renderSeatMapSvg([s('A', '1', 0, 0)], seatLayout('cinepic', map), { ...header, movie: '🎬'.repeat(200) }), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  // Areas share one column scale: C:5 sits under A:5, not under A:1.
  const areas = renderSeatMapSvg([s('A', '1', 0, 0), s('A', '1', 0, 4), s('C', '2', 0, 4)], seatLayout('cinesunidos'), header);
  assert.equal(xOf(areas, 'C:5'), xOf(areas, 'A:5'));
  // A map far taller than any room is refused before drawing, and get_seats keeps its data.
  const tall = Array.from({ length: 60 }, (_, a) => [s('A', String(a), 0, 0), s('B', String(a), 199, 0)]).flat();
  assert.throws(() => renderSeatMapSvg(tall, seatLayout('cinesunidos'), header), MapTooLarge);
  // On a narrow map the full legend wraps inside the card instead of running off it.
  const narrow = renderSeatMapSvg([s('A', '1', 0, 0), s('A', '1', 0, 1, 'occupied'), s('A', '1', 0, 2, 'unavailable'), s('A', '1', 0, 3, 'unknown')], seatLayout('cinesunidos'), header);
  const width = Number(capture(narrow, /width="(\d+)"/));
  for (const label of ['Libre (1)', 'Ocupado (1)', 'No disponible (1)', 'Desconocido (1)']) {
    const x = Number(capture(narrow, new RegExp(`<text x="([\\d.]+)" y="[\\d.]+" font-size="12.5" fill="#b8a7a1">${label.replace(/[()]/g, '\\$&')}<`)));
    assert.ok(x + textWidth(label, 12.5) <= width - 28, `${label} ends at ${x + textWidth(label, 12.5)} of ${width}`);
  }
  // With unknown seats, the headline count says the free seats are only the confirmed ones.
  assert.match(narrow, />1<\/text><text[^>]*>libres confirmados de 4</);
});

test('get_seats warns instead of failing when a map is too large to draw', async t => {
  const sessions = new class extends EmptySessionStore { override async headers() { return { Authorization: 'Bearer synthetic' }; } };
  const areas = Array.from({ length: 60 }, (_, a) => ({ number: a + 1, description: 'SALA 1 - X', rows: [0, 199].map(r => ({ rowIndexZeroBased: r, physicalName: r ? 'B' : 'A', seats: [{ id: '1', status: 0, position: { areaNumber: a + 1, rowIndex: r, columnIndex: 0 } }] })) }));
  const server = createServer(new CinemaService(new HttpClient(async () => Response.json({ seats: { areas } }), 15000, sessions)));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'big-map', version: '1.0.0' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const r = await client.callTool({ name: 'get_seats', arguments: { provider: 'cinesunidos', cinema_id: '1008', session_id: 's1' } });
  const data = SeatResult.parse(r.structuredContent);
  assert.equal(data.status, 'available'); assert.equal(data.total, 120);
  assert.deepEqual(r.content.map(c => c.type), ['text']);
  assert.match(data.warnings.join(' '), /demasiado grande para dibujarlo como imagen/);
});

test('Cinepic seats tolerate odd tariff lists, and Cinex drops impossible dates and times', async () => {
  const seat = (columna: string, tipo: string) => ({ butaca: `A-${columna}-1`, nombre_butaca: `A:${columna}`, fila: '1', columna, libre: '1', seleccionada: '1', tipo_butaca_id: tipo, invertida: '0' });
  // Non-numeric seat types never match each other through NaN.
  assert.deepEqual(parseCinepicSeats({ butacas: [seat('1', 'general'), seat('2', 'vip')] }, cinepicBookableTypes([{ id: 'vip' }])).map(s => s.status), ['unavailable', 'available']);
  const run = async (tarifas: unknown) => {
    const body = page({ ...cpBuy, butacasData: { butacas: [seat('1', '1'), seat('2', '8')] }, functionData: { datos: [{ id: 'f1', codigo: 'p1' }], ...(tarifas === undefined ? {} : { tarifas }) } });
    return new CinemaService(new HttpClient(async () => new Response(body), 15000, new EmptySessionStore())).seats({ provider: 'cinepic', cinema_id: '123300', session_id: 'f1', movie_id: 'p1' });
  };
  for (const missing of [undefined, null]) {
    const r = await run(missing);
    assert.equal(r.status, 'available', 'a missing tariff list no longer fails the map');
    assert.equal(r.available, 2); assert.match(r.warnings.join(' '), /no envió las tarifas/);
  }
  const none = await run([]);
  assert.deepEqual([none.available, none.unavailable], [2, 0]); assert.match(none.warnings.join(' '), /no listó tarifas en línea/);
  // A function served under another film's movie_id names the right one.
  const other = page({ ...cpBuy, functionData: { datos: [{ id: 'f1', codigo: 'p9' }], tarifas: [] } });
  const wrong = await new CinemaService(new HttpClient(async () => new Response(other), 15000, new EmptySessionStore())).seats({ provider: 'cinepic', cinema_id: '123300', session_id: 'f1', movie_id: 'p1' });
  assert.equal(wrong.status, 'unavailable'); assert.match(wrong.warnings.join(' '), /otra película \(movie_id p9\); usa session_id y movie_id de una misma función/);
  // Cinex: impossible values are left out rather than passed on.
  const info = (fecha: string, hora: string) => `<div>CINEX X | Sala 1 | <b>Fecha:</b> ${fecha} | <b>Hora:</b> ${hora} | <b>Asientos disponibles:</b> 3 asiento(s)</div>`;
  assert.deepEqual([parseCinexShowing(info('31-02-2026', '02:99pm')).showing?.date, parseCinexShowing(info('31-02-2026', '02:99pm')).showing?.time], [undefined, undefined]);
  assert.deepEqual([parseCinexShowing(info('29-02-2028', '11:59pm')).showing?.date, parseCinexShowing(info('29-02-2028', '11:59pm')).showing?.time], ['2028-02-29', '23:59']);
});

test('second review: raster budget, real glyph widths, and long tariff names', async t => {
  const s = (row: string, area: string, row_index: number, column_index: number) => ({ label: `${row}:${column_index + 1}`, row, area, row_index, column_index, status: 'available' as const });
  // 100 one-seat areas (17.9 kB upstream) is refused; 40 still draws, within the pixel budget.
  assert.throws(() => renderSeatMapSvg(Array.from({ length: 100 }, (_, a) => s('A', String(a), 0, 0)), seatLayout('cinesunidos'), header), MapTooLarge);
  const png = Buffer.from(await renderSeatMapPng(renderSeatMapSvg(Array.from({ length: 40 }, (_, a) => s('A', String(a), 0, 0)), seatLayout('cinesunidos'), header)));
  assert.ok(png.readUInt32BE(16) * png.readUInt32BE(20) <= MAX_PNG_PIXELS, `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  // Wide letters are measured, not counted: 42 W's do not fit a 560-wide header.
  const svg = renderSeatMapSvg([s('A', '1', 0, 0)], seatLayout('cinesunidos'), { ...header, movie: 'W'.repeat(42) });
  const title = capture(svg, /font-size="22" font-weight="700" letter-spacing="-0.4" fill="#f6eee4">([^<]*)</);
  assert.ok(title.endsWith('…') && textWidth(title, 22, 'display') <= 560 - 56, title);
  assert.ok(textWidth('W', 20, 'display') > 2 * textWidth('i', 20, 'display'));
  // A tariff name over 60 characters still reports its counter in the warning.
  const seat = { butaca: 'A-1-1', nombre_butaca: 'A:1', fila: '1', columna: '1', libre: '1', seleccionada: '1', tipo_butaca_id: '1', invertida: '0' };
  const body = page({ ...cpBuy, butacasData: { butacas: [seat] }, functionData: { datos: [{ id: 'f1', codigo: 'p1' }], tarifas: [{ _id: '2', id: '1', descripcion: 'GENERAL '.repeat(9), precio: '1', tot: '0', vend: '0', temp: '0' }] } });
  const r = await new CinemaService(new HttpClient(async () => new Response(body), 15000, new EmptySessionStore())).seats({ provider: 'cinepic', cinema_id: '123300', session_id: 'f1', movie_id: 'p1' });
  assert.match(r.warnings.join(' '), /ofrece en línea 0 entradas GENERAL GENERAL.*…; puede vender menos entradas que las 1 butacas libres/);
  t.diagnostic(`40-area PNG ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
});

test('an empty Cinex grid reports Cinex\'s own count instead of "no seats"', async () => {
  // As cinex.com.ve sent it on 2026-11-05 for functions whose grid it builds only after tickets are chosen.
  const empty = `${cinexInfo(145)}<a id="btnasientosatras" href="boletosdev.php?cinemaid=SBC&sessionid=s1">Atras</a><div style="display: none;">17;~10;</div><div id="mapcontent"><div class="row centermap"></div></div>`;
  const sessions = new class extends EmptySessionStore { override async headers() { return { Cookie: 'synthetic' }; } };
  const r = await new CinemaService(new HttpClient(async url => new Response(String(url).endsWith('checklogin.php') ? 'on' : String(url).endsWith('asientosdev.php') ? empty : ''), 15000, sessions)).seats({ provider: 'cinex', cinema_id: 'SBC', session_id: 's1' });
  assert.equal(r.status, 'unavailable'); assert.equal(r.total, 0);
  assert.match(r.warnings.join(' '), /Cinex informa 145 asientos disponibles en esta función, pero no envió el mapa/);
  // Another function's empty page is still rejected by the identity guard first.
  const other = empty.replace('sessionid=s1', 'sessionid=s2');
  const wrong = await new CinemaService(new HttpClient(async url => new Response(String(url).endsWith('checklogin.php') ? 'on' : String(url).endsWith('asientosdev.php') ? other : ''), 15000, sessions)).seats({ provider: 'cinex', cinema_id: 'SBC', session_id: 's1' });
  assert.match(wrong.warnings.join(' '), /no corresponde a la sede y función/);
});

/** A strict reader for the PNGs Cinve writes: checks every CRC and returns straight RGBA. */
function decodePng(png: Uint8Array) {
  const b = Buffer.from(png);
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: Record<string, Buffer[]> = {};
  for (let at = 8; at < b.length;) {
    const length = b.readUInt32BE(at), type = b.toString('latin1', at + 4, at + 8);
    assert.equal(b.readUInt32BE(at + 8 + length), crc32(b.subarray(at + 4, at + 8 + length)), `CRC of ${type}`);
    (chunks[type] ??= []).push(b.subarray(at + 8, at + 8 + length)); at += 12 + length;
  }
  const { IHDR, PLTE, IDAT, IEND, tRNS } = chunks;
  assert.ok(IHDR && PLTE && IDAT && IEND, 'IHDR, PLTE, IDAT and IEND');
  const ihdr = nth(IHDR, 0), width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  assert.deepEqual([ihdr[8], ihdr[9], ihdr[12]], [8, 3, 0], '8-bit indexed, not interlaced');
  const plte = nth(PLTE, 0), trns = tRNS?.[0] ?? Buffer.alloc(0);
  assert.ok(plte.length % 3 === 0 && plte.length <= 768 && trns.length <= plte.length / 3);
  const raw = inflateSync(Buffer.concat(IDAT));
  assert.equal(raw.length, (width + 1) * height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width + 1)], 0, 'filter None');
    for (let x = 0; x < width; x++) {
      const k = nth(raw, y * (width + 1) + 1 + x), o = (y * width + x) * 4;
      assert.ok(k * 3 < plte.length, 'index within the palette');
      rgba.set([nth(plte, k * 3), nth(plte, k * 3 + 1), nth(plte, k * 3 + 2), k < trns.length ? nth(trns, k) : 255], o);
    }
  }
  const at = (x: number, y: number) => '#' + [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)].map(v => v.toString(16).padStart(2, '0')).join('') + (rgba[(y * width + x) * 4 + 3] === 255 ? '' : `/${rgba[(y * width + x) * 4 + 3]}`);
  return { width, height, at };
}

test('the PNG is an indexed image that keeps every seat colour exact and the card corners transparent', async () => {
  const s = (i: number, status: 'available' | 'occupied' | 'unavailable' | 'unknown') => ({ label: `R${Math.floor(i / 40)}:${i % 40 + 1}`, row: `R${Math.floor(i / 40)}`, area: '1', row_index: Math.floor(i / 40), column_index: i % 40, status });
  // A big room where one seat is restricted: its colour is rare next to thousands of anti-aliased edges, and still exact.
  const seats = Array.from({ length: 2400 }, (_, i) => s(i, i === 1234 ? 'unavailable' : nth(['available', 'occupied', 'unknown'] as const, i % 3)));
  const svg = renderSeatMapSvg(seats, seatLayout('cinesunidos'), header);
  const png = decodePng(await renderSeatMapPng(svg));
  const scale = png.width / Number(capture(svg, /width="(\d+)"/));
  const fillAt = (label: string) => {
    const seat = new RegExp(`<title>${label}:[^<]*</title><rect x="([\\d.]+)" y="([\\d.]+)"`), x = capture(svg, seat, 1), y = capture(svg, seat, 2);
    return png.at(Math.round((+x + 3) * scale), Math.round((+y + 13) * scale));
  };
  assert.equal(fillAt('R30:35'), '#1b1016', 'the only restricted seat');
  // Cinve's house palette: upholstery red free, dark taken, and an unknown seat is an outline on the room's night.
  assert.equal(fillAt('R0:1'), '#a92037'); assert.equal(fillAt('R0:2'), '#2e1b23'); assert.equal(fillAt('R0:3'), '#120a0e');
  assert.equal(png.at(0, 0), '#000000/0', 'outside the rounded card');
  assert.equal(png.at(Math.floor(png.width / 2), 4), '#120a0e');
});

test('the PNG encoder handles more than 256 colours, unaligned input and the renderer\'s errors', async () => {
  // A 64x64 gradient has 4096 colours; each pixel takes a palette entry close to it.
  const width = 64, height = 64, rgba = new Uint8Array(width * height * 4 + 1).subarray(1);
  for (let i = 0; i < width * height; i++) rgba.set([(i % 64) * 4, Math.floor(i / 64) * 4, 128, 255], i * 4);
  const png = decodePng(encodeIndexedPng(rgba, width, height));
  assert.deepEqual([png.width, png.height], [64, 64]);
  for (const [x, y] of [[0, 0], [63, 0], [17, 40], [63, 63]] as const) {
    const [r, g] = [parseInt(png.at(x, y).slice(1, 3), 16), parseInt(png.at(x, y).slice(3, 5), 16)];
    assert.ok(Math.abs(r - x * 4) <= 24 && Math.abs(g - y * 4) <= 24, `${x},${y}: ${png.at(x, y)}`);
  }
  // 600 frequent colours crowd out a 4-pixel patch of the free-seat red, which still stays exact.
  const crowd = new Uint8Array(100 * 62 * 4);
  for (let i = 0; i < 6000; i++) crowd.set([i % 600 % 25 * 10, Math.floor(i % 600 / 25) * 10, 200, 255], i * 4);
  for (let i = 6000; i < 6200; i++) crowd.set(i < 6004 ? [0xa9, 0x20, 0x37, 255] : [200, 200, 200, 255], i * 4);
  assert.equal(decodePng(encodeIndexedPng(crowd, 100, 62)).at(0, 60), '#a92037');
  assert.throws(() => encodeIndexedPng(new Uint8Array(8), 2, 2), /incompleta/);
  // A document resvg refuses is an error, and the renderer keeps working afterwards.
  await assert.rejects(renderSeatMapPng('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g>'));
  // Concurrent calls share one initialization and each gets its own image.
  const svg = renderSeatMapSvg(parseCinepicSeats(map), seatLayout('cinepic', map), header);
  const images = await Promise.all(Array.from({ length: 8 }, () => renderSeatMapPng(svg)));
  assert.ok(images.every(image => Buffer.from(image).equals(Buffer.from(nth(images, 0)))));
  assert.ok(decodePng(nth(images, 0)).width > 500);
});

test('seat numbers share one size and fit their seats; long row names are cut inside their column', () => {
  const s = (row: string, column_index: number, label = `${row}:${column_index + 1}`) => ({ label, row, area: '1', row_index: row === 'A' ? 0 : 1, column_index, status: 'available' as const });
  // 1000 and 1011 differ in glyph width; a row reads evenly only if both share a size.
  const sizes = (svg: string) => new Set([...svg.matchAll(/<\/title><rect [^>]*\/><text [^>]*font-size="([\d.]+)"/g)].map(m => m[1]));
  const wide = renderSeatMapSvg([s('A', 0, 'A:1000'), s('A', 1, 'A:1011'), s('A', 2, 'A:7')], seatLayout('cinex'), header);
  assert.equal(sizes(wide).size, 1, [...sizes(wide)].join());
  for (const m of wide.matchAll(/<\/title><rect [^>]*width="(\d+)"[^>]*\/><text [^>]*font-size="([\d.]+)"[^>]*>([^<]*)</g)) {
    assert.ok(textWidth(nth(m, 3), Number(m[2]), 'strong') <= Number(m[1]) - 4, `${m[3]} fits`);
  }
  // A 40-character label (the schema's limit) is cut with an ellipsis; its title keeps the whole label.
  const long = renderSeatMapSvg([s('A', 0, `A:${'9'.repeat(38)}`)], seatLayout('cinex'), header);
  assert.match(long, /<title>A:9{38}: libre<\/title>/); assert.match(long, />9+…<\/text><\/g>/);
  // A long row name stays in its side column, away from the seats and the card edge.
  const name = 'PLATEA ALTA LATERAL IZQUIERDA';
  const rows = renderSeatMapSvg([s(name, 0), s(name, 1)], seatLayout('cinex'), header);
  const width = Number(capture(rows, /width="(\d+)"/)), seatX = xOf(rows, `${name}:1`);
  for (const m of rows.matchAll(/<text x="([\d.]+)"[^>]*font-size="12" fill="#8c7d7a">([^<]*)</g)) {
    const center = Number(m[1]), half = textWidth(nth(m, 2), 12, 'strong') / 2;
    assert.ok(nth(m, 2).endsWith('…'), m[2]);
    assert.ok(center - half >= 0 && center + half <= width, `${m[2]} inside the card`);
    assert.ok(center + half <= seatX || center - half >= seatX + 26 * 2 + 4, `${m[2]} clear of the seats`);
  }
});

test('emoji in provider text are dropped instead of drawn as empty boxes', () => {
  const one = [{ label: 'A:1', row: 'A', area: '1', row_index: 0, column_index: 0, status: 'available' as const }];
  assert.match(renderSeatMapSvg(one, seatLayout('cinex'), { ...header, movie: '🎬 ZOOTOPIA 2 🍿' }), />ZOOTOPIA 2</);
  assert.match(renderSeatMapSvg(one, seatLayout('cinex'), { ...header, movie: '🎬🍿👨‍👩‍👧🇻🇪' }), />Mapa de asientos</);
});

test('rooms of every shape render with the right counts, colours and bounds', async () => {
  // A deterministic sweep: sizes from one seat to an IMAX-like room, every layout, mixed states.
  let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const statuses = ['available', 'occupied', 'unavailable', 'unknown'] as const;
  const fills = { available: '#a92037', occupied: '#2e1b23', unavailable: '#1b1016', unknown: '#120a0e' };
  const layouts = [seatLayout('cinex'), seatLayout('cinepic', { butacas: [{ invertida: '1' }] }), seatLayout('cinepic', map), { screen: 'unverified' as const, column_order: 'ascending' as const }];
  for (const [rows, cols, areas] of [[1, 1, 1], [3, 7, 1], [14, 26, 1], [8, 18, 3], [25, 60, 1], [2, 200, 1]] as const) {
    const seats = Array.from({ length: areas * rows * cols }, (_, i) => {
      const area = Math.floor(i / (rows * cols)), r = Math.floor(i / cols) % rows, c = i % cols, row = String.fromCharCode(65 + r);
      return { label: `${row}:${c + 1}`, row, area: String(area + 1), row_index: r, column_index: c, status: nth(statuses, Math.floor(rnd() * 4)) };
    });
    const svg = renderSeatMapSvg(seats, nth(layouts, rows % 4), header);
    const width = Number(capture(svg, /width="(\d+)"/));
    assert.equal(svg.match(/<title>/g)?.length, seats.length);
    for (const k of statuses) {
      const n = seats.filter(seat => seat.status === k).length;
      if (n || k === 'available' || k === 'occupied') assert.match(svg, new RegExp(`>[^<(]+ \\(${n}\\)<`));
    }
    assert.match(svg, new RegExp(`>${seats.filter(seat => seat.status === 'available').length}</text>`));
    const png = decodePng(await renderSeatMapPng(svg)), scale = png.width / width;
    assert.ok(png.width <= 1200 && png.width * png.height <= MAX_PNG_PIXELS, `${png.width}x${png.height}`);
    // Where seats are big enough to sample (and labels are unique: one area), the band above each number shows its state's colour.
    if (scale >= 0.6 && areas === 1) for (const seat of seats) {
      const at = new RegExp(`<title>${seat.label}: [^<]*</title><rect x="([\\d.]+)" y="([\\d.]+)"`);
      const x = Number(capture(svg, at, 1)), y = Number(capture(svg, at, 2));
      assert.equal(png.at(Math.round((x + 13) * scale), Math.round((y + 3.5) * scale)), fills[seat.status], `${rows}x${cols} ${seat.label}`);
    }
  }
});
