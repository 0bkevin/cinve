import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { renderSeats } from '../src/seats/ascii.js';
import { cinepicBookableTypes, parseCinepicSeats, parseCinexShowing } from '../src/seats/parsers.js';
import { seatLayout } from '../src/seats/schema.js';
import { cinepicTicketsLeft } from '../src/providers/cinepic/sites.js';
import { crc32, inflateSync } from 'node:zlib';
import { encodeIndexedPng, MapTooLarge, MAX_PNG_PIXELS, renderSeatMapPng, renderSeatMapSvg, seatNumber, textWidth } from '../src/seats/image.js';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http/client.js';
import { createServer } from '../src/mcp/server.js';
import { SeatResult } from '../src/seats/schema.js';
import { cpBuy, EmptySessionStore, page } from './helpers/fixtures.js';

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
  assert.match(svg, />Cinepic Candelaria<.*>Función 24939</); assert.doesNotMatch(svg, /Cinepic · Cinepic/);
  assert.match(svg, /Libre \(2\)/); assert.match(svg, /Ocupado \(1\)/); assert.match(svg, /2 libres de 3/);
  assert.match(svg, /Consultado 05\/11\/2026, 12:52/);
  // The ASCII map uses the same orientation.
  const ascii = renderSeats(seats, layout).split('\n');
  assert.equal(ascii[2], '[ PANTALLA ]');
  assert.ok(ascii[4].indexOf('A:1O') < ascii[4].indexOf('A:5O'), ascii[4]);
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
  assert.deepEqual([...cinepicBookableTypes([{ id: '08' }, { id: 'vip' }]) as Set<string>], ['8', 'vip']);
  assert.equal(cinepicTicketsLeft({ tot: '9'.repeat(30), vend: '0', temp: '0' }), undefined, 'an unsafe integer is not a count');
  assert.equal(cinepicTicketsLeft(tarifas[0]), 146); assert.equal(cinepicTicketsLeft({ tot: '5' }), undefined);
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
  const prices = (await client.callTool({ name: 'get_ticket_prices', arguments: priceArgs })).structuredContent as { items: { name: string; tickets_available?: number }[] };
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
  // On a narrow map the full legend no longer overlaps the total.
  const narrow = renderSeatMapSvg([s('A', '1', 0, 0), s('A', '1', 0, 1, 'occupied'), s('A', '1', 0, 2, 'unavailable'), s('A', '1', 0, 3, 'unknown')], seatLayout('cinesunidos'), header);
  const legendY = Number(narrow.match(/y="([\d.]+)" font-size="12" fill="#3c4043">Desconocido/)![1]);
  const totalY = Number(narrow.match(/y="([\d.]+)" font-size="12" font-weight="700" fill="#202124" text-anchor="end">1 libres de 4/)![1]);
  assert.ok(totalY > legendY, `${totalY} > ${legendY}`);
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
  assert.deepEqual((r.content as { type: string }[]).map(c => c.type), ['text']);
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
  const title = svg.match(/font-size="20" font-weight="700" fill="#202124">([^<]*)</)![1];
  assert.ok(title.endsWith('…') && textWidth(title, 20, true) <= 560 - 56, title);
  assert.ok(textWidth('W', 20, true) > 2 * textWidth('i', 20, true));
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
  assert.ok(chunks.IEND, 'IEND');
  const ihdr = chunks.IHDR[0], width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  assert.deepEqual([ihdr[8], ihdr[9], ihdr[12]], [8, 3, 0], '8-bit indexed, not interlaced');
  const plte = chunks.PLTE[0], trns = chunks.tRNS?.[0] ?? Buffer.alloc(0);
  assert.ok(plte.length % 3 === 0 && plte.length <= 768 && trns.length <= plte.length / 3);
  const raw = inflateSync(Buffer.concat(chunks.IDAT));
  assert.equal(raw.length, (width + 1) * height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width + 1)], 0, 'filter None');
    for (let x = 0; x < width; x++) {
      const k = raw[y * (width + 1) + 1 + x], o = (y * width + x) * 4;
      assert.ok(k * 3 < plte.length, 'index within the palette');
      rgba.set([plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], k < trns.length ? trns[k] : 255], o);
    }
  }
  const at = (x: number, y: number) => '#' + [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)].map(v => v.toString(16).padStart(2, '0')).join('') + (rgba[(y * width + x) * 4 + 3] === 255 ? '' : `/${rgba[(y * width + x) * 4 + 3]}`);
  return { width, height, at };
}

test('the PNG is an indexed image that keeps every seat colour exact and the card corners transparent', async () => {
  const s = (i: number, status: 'available' | 'occupied' | 'unavailable' | 'unknown') => ({ label: `R${Math.floor(i / 40)}:${i % 40 + 1}`, row: `R${Math.floor(i / 40)}`, area: '1', row_index: Math.floor(i / 40), column_index: i % 40, status });
  // A big room where one seat is unknown: its colour is rare next to thousands of anti-aliased edges, and still exact.
  const seats = Array.from({ length: 2400 }, (_, i) => s(i, i === 1234 ? 'unknown' : (['available', 'occupied', 'unavailable'] as const)[i % 3]));
  const svg = renderSeatMapSvg(seats, seatLayout('cinesunidos'), header);
  const png = decodePng(await renderSeatMapPng(svg));
  const scale = png.width / Number(svg.match(/width="(\d+)"/)![1]);
  const fillAt = (label: string) => { const [, x, y] = svg.match(new RegExp(`<title>${label}:[^<]*</title><rect x="([\\d.]+)" y="([\\d.]+)"`))!; return png.at(Math.round((+x + 3) * scale), Math.round((+y + 13) * scale)); };
  assert.equal(fillAt('R30:35'), '#f9ab00', 'the only unknown seat');
  assert.equal(fillAt('R0:1'), '#1e8e3e'); assert.equal(fillAt('R0:2'), '#80868b'); assert.equal(fillAt('R0:3'), '#eceff1');
  assert.equal(png.at(0, 0), '#000000/0', 'outside the rounded card');
  assert.equal(png.at(Math.floor(png.width / 2), 4), '#ffffff');
});

test('the PNG encoder handles more than 256 colours, unaligned input and the renderer\'s errors', async () => {
  // A 64x64 gradient has 4096 colours; each pixel takes a palette entry close to it.
  const width = 64, height = 64, rgba = new Uint8Array(width * height * 4 + 1).subarray(1);
  for (let i = 0; i < width * height; i++) rgba.set([(i % 64) * 4, Math.floor(i / 64) * 4, 128, 255], i * 4);
  const png = decodePng(encodeIndexedPng(rgba, width, height));
  assert.deepEqual([png.width, png.height], [64, 64]);
  for (const [x, y] of [[0, 0], [63, 0], [17, 40], [63, 63]]) {
    const [r, g] = [parseInt(png.at(x, y).slice(1, 3), 16), parseInt(png.at(x, y).slice(3, 5), 16)];
    assert.ok(Math.abs(r - x * 4) <= 24 && Math.abs(g - y * 4) <= 24, `${x},${y}: ${png.at(x, y)}`);
  }
  // 600 frequent colours crowd out a 4-pixel patch of the unknown-seat yellow, which still stays exact.
  const crowd = new Uint8Array(100 * 62 * 4);
  for (let i = 0; i < 6000; i++) crowd.set([i % 600 % 25 * 10, Math.floor(i % 600 / 25) * 10, 200, 255], i * 4);
  for (let i = 6000; i < 6200; i++) crowd.set(i < 6004 ? [0xf9, 0xab, 0x00, 255] : [200, 200, 200, 255], i * 4);
  assert.equal(decodePng(encodeIndexedPng(crowd, 100, 62)).at(0, 60), '#f9ab00');
  assert.throws(() => encodeIndexedPng(new Uint8Array(8), 2, 2), /incompleta/);
  // A document resvg refuses is an error, and the renderer keeps working afterwards.
  await assert.rejects(renderSeatMapPng('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g>'));
  // Concurrent calls share one initialization and each gets its own image.
  const svg = renderSeatMapSvg(parseCinepicSeats(map), seatLayout('cinepic', map), header);
  const images = await Promise.all(Array.from({ length: 8 }, () => renderSeatMapPng(svg)));
  assert.ok(images.every(image => Buffer.from(image).equals(Buffer.from(images[0]))));
  assert.ok(decodePng(images[0]).width > 500);
});
