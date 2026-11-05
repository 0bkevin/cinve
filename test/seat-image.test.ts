import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { cinepicBookableTypes, parseCinepicSeats, parseCinexShowing, renderSeats, seatLayout } from '../src/seats.js';
import { cinepicTicketsLeft } from '../src/providers.js';
import { MapTooLarge, renderSeatMapPng, renderSeatMapSvg, seatNumber } from '../src/seat-image.js';
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
  assert.match(svg, />Cinepic Candelaria<.*>Función 24939</); assert.doesNotMatch(svg, /Cinepic · Cinepic/);
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
  assert.doesNotMatch(cinex, /PANTALLA/); assert.match(cinex, /La web del cine no indica el lado de la pantalla/);
  assert.match(renderSeats(seats, seatLayout("cinex")), /que no indica el lado de la pantalla/);
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
  assert.match((await cinex.seats(q)).warnings.join(' '), /contador de asientos disponibles de Cinex difiere del mapa/);
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
