import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSeats } from '../../src/seats/ascii.js';
import { parseCinepicSeats, parseCinesUnidosSeats, parseCinexSeats } from '../../src/seats/parsers.js';
import { seatLayout } from '../../src/seats/schema.js';
import { CinemaService } from '../../src/service.js';
import { HttpClient } from '../../src/http/client.js';
import { assertPrivateRead } from '../../src/http/allow-list.js';
import { EmptySessionStore, page } from '../helpers/fixtures.js';
import { defined, nth } from '../helpers/assert.js';

const cp = (overrides = {}) => ({ butaca: 'A-1-1', nombre_butaca: 'A:1', fila: '1', columna: '1', libre: '1', seleccionada: '1', tipo_butaca_id: '1', ...overrides });
test('Cinepic availability ignores seleccionada and preserves physical labels, gaps, and unknown states', () => {
  const seats = parseCinepicSeats({ butacas: [cp(), cp({ butaca: 'A-3-1', columna: '3', nombre_butaca: 'A:2', libre: '0' }), cp({ butaca: 'A-4-1', columna: '4', nombre_butaca: 'A:3', libre: 'new' })] });
  assert.deepEqual(seats.map(s => s.status), ['available', 'occupied', 'unknown']);
  assert.match(renderSeats(seats), /A:1O\s{6}A:2X\s+A:3\?/);
  assert.throws(() => parseCinepicSeats({ butacas: [cp(), cp()] }));
  assert.throws(() => parseCinepicSeats({ butacas: [cp({ columna: '-1' })] }));
  assert.throws(() => parseCinepicSeats({ butacas: [cp({ nombre_butaca: 'A\nFAKE' })] }));
});
test('Cines Unidos keeps special and unknown states separate from free seats', () => {
  const data = { seats: { areas: [{ number: 1, areaCategoryCode: 'general', rows: [{ rowIndexZeroBased: 0, physicalName: 'P', seats: [0, 1, 2, 3, 4, 5, 6, 7, 99].map((status, columnIndex) => ({ id: String(columnIndex + 1), status, position: { areaNumber: 1, rowIndex: 0, columnIndex } })) }] }] } };
  assert.deepEqual(parseCinesUnidosSeats(data).map(s => s.status), ['available', 'occupied', 'occupied', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'available', 'unknown']);
  nth(nth(nth(data.seats.areas, 0).rows, 0).seats, 0).position.areaNumber = 2;
  assert.throws(() => parseCinesUnidosSeats(data));
});
test('seat reads bypass cached price pages and retain function identity checks', async () => {
  let reads = 0;
  const body = page({ functionData: { datos: [{ id: 's1', codigo: 'm1', entradasDisponibles: '1' }], tarifas: [] }, butacasData: { butacas: [cp()] } });
  const http = new HttpClient(async (_url, init) => { reads++; assert.equal(init?.headers && new Headers(init.headers).get('Cache-Control'), 'no-cache'); return new Response(body); }, 15000, new EmptySessionStore());
  const service = new CinemaService(http);
  const q = { provider: 'cinepic' as const, cinema_id: '123301', session_id: 's1', movie_id: 'm1' };
  assert.equal((await service.seats(q)).available, 1);
  assert.equal((await service.seats(q)).status, 'available');
  assert.equal(reads, 2);
  const mismatch = await service.seats({ ...q, session_id: 'other' });
  assert.equal(mismatch.status, 'unavailable'); assert.equal(mismatch.ascii, '');
  assert.equal((await service.seats({ ...q, provider: 'cinex' })).status, 'auth_required');
});
test('Cines Unidos allows only the exact GET seat URL with bounded identifiers', () => {
  const valid = 'https://www.cinesunidos.com/api/seats?theaterId=1005&showTimeId=49993';
  assert.doesNotThrow(() => assertPrivateRead('cinesunidos', valid));
  for (const bad of [valid + '&token=x', valid + '&theaterId=1002', valid.replace('www.', 'evil.'), valid.replace('49993', '../orders'), valid + '#fragment']) assert.throws(() => assertPrivateRead('cinesunidos', bad));
});

const cinexMap = `<a id="btnasientosatras" href="boletosdev.php?cinemaid=SBC&sessionid=s1">Atras</a><div id="mapcontent"><div class="row centermap"><div class="rowletter">B</div><div id="B1" class="seatestandar" alt="0" onclick="javascript:decideAsientoNew('B1','0','0','1','0001','0','N','N');"></div><div class="blankspace"></div><div title="B3" class="seatestandar-occupied" alt="B3"></div><div id="B4" class="new-class" alt="0"></div></div></div>`;
test('Cinex map verifies function identity, occupied states, gaps, and unknown classes', () => {
  const q = { provider: 'cinex' as const, cinema_id: 'SBC', session_id: 's1' };
  const seats = parseCinexSeats(cinexMap, q);
  assert.deepEqual(seats.map(s => s.status), ['available', 'occupied', 'unknown']);
  assert.equal(nth(seats, 1).column_index, 2);
  assert.throws(() => parseCinexSeats(cinexMap, { ...q, session_id: 'other' }));
  assert.throws(() => parseCinexSeats(cinexMap, { ...q, cinema_id: 'TLN' }));
  assert.throws(() => parseCinexSeats(cinexMap.replace('B1\',', 'ZZ\','), q));
});
test('Cinex seat workflow uses only authenticated GETs and rejects an interleaved function', async () => {
  const urls: string[] = [];
  const sessions = new class extends EmptySessionStore { override async headers() { return { Cookie: 'synthetic' }; } };
  let body = cinexMap;
  const http = new HttpClient(async (url, init) => {
    urls.push(String(url)); assert.ok(!init?.method || init.method === 'GET');
    assert.equal(new Headers(init?.headers).get('Cookie'), 'synthetic');
    const path = new URL(String(url)).pathname;
    return new Response(path === '/checklogin.php' ? 'on' : path === '/asientos.php' ? body : '<form id="frmboletos"></form>');
  }, 15000, sessions);
  const q = { provider: 'cinex' as const, cinema_id: 'SBC', session_id: 's1' };
  const partial = await new CinemaService(http).seats(q);
  assert.equal(partial.available, 1);
  assert.equal(partial.occupied, 1); assert.equal(partial.unknown, 1);
  assert.equal(partial.total, 3); assert.equal(partial.availability_complete, false);
  assert.match(partial.warnings.join(' '), /cero libres confirmados no significa agotado/);
  // Session check, the function selected on Cinex's regular checkout page, then its seat page.
  assert.deepEqual(urls.map(u => new URL(u).pathname), ['/checklogin.php', '/boletos.php', '/asientos.php']);
  body = cinexMap.replace('sessionid=s1', 'sessionid=other');
  const result = await new CinemaService(http).seats(q);
  assert.equal(result.status, 'unavailable'); assert.equal(result.ascii, '');
  assert.equal(result.total, 0); assert.equal(result.availability_complete, false);
  assert.doesNotThrow(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/asientosdev.php'));
  assert.doesNotThrow(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/asientos.php'));
  assert.throws(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/asientos_datadevx.php'));
  assert.throws(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/boletos_data.php'));
  assert.throws(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/asientosdev.php?extra=1'));
});

test('Cinex VIP availability accepts empty selected-ticket count without relaxing seat state checks', () => {
  const q = { provider: 'cinex' as const, cinema_id: 'SBC', session_id: 's1' };
  const vip = cinexMap.replaceAll('seatestandar', 'seatvipplus').replace("'0001','0','N','N'", "'0001','','N','N'");
  assert.equal(nth(parseCinexSeats(vip, q), 0).status, 'available');
  assert.equal(nth(parseCinexSeats(vip, q), 0).category, '0001');
  assert.equal(nth(parseCinexSeats(vip.replace("'0001','','N','N'", "'0001','','S','N'"), q), 0).status, 'unavailable');
  assert.equal(nth(parseCinexSeats(vip.replace("'0001','','N','N'", "'0001','','N','S'"), q), 0).status, 'unavailable');
  assert.equal(nth(parseCinexSeats(vip.replace('alt="0"', 'alt="1"'), q), 0).status, 'unknown');
  assert.equal(nth(parseCinexSeats(vip.replace("'0001','','N','N'", "'0001','garbage','N','N'"), q), 0).status, 'unknown');
  assert.equal(nth(parseCinexSeats(vip.replace('decideAsientoNew', 'unrecognized'), q), 0).status, 'unknown');
  assert.throws(() => parseCinexSeats(vip.replace("('B1',", "('WRONG',"), q));
});

test('Cines Unidos reports confirmed and unknown counts independently, including selectable state 7', async () => {
  let codes: unknown[] = [0, 7, 1, 2, 3, 4, 5, 6, 99, null];
  const sessions = new class extends EmptySessionStore { override async headers() { return { Authorization: 'Bearer synthetic' }; } };
  const http = new HttpClient(async (url, init) => {
    assert.equal(String(url), 'https://www.cinesunidos.com/api/seats?theaterId=1005&showTimeId=s1');
    assert.ok(!init?.method || init.method === 'GET');
    return Response.json({ seats: { areas: [{ number: 1, areaCategoryCode: 'general', rows: [{ rowIndexZeroBased: 0, physicalName: 'G', seats: codes.map((status, columnIndex) => ({ id: String(columnIndex + 1), status, position: { areaNumber: 1, rowIndex: 0, columnIndex } })) }] }] } });
  }, 15000, sessions);
  const q = { provider: 'cinesunidos' as const, cinema_id: '1005', session_id: 's1' };
  const result = await new CinemaService(http).seats(q);
  assert.equal(result.status, 'available');
  assert.deepEqual([result.available, result.occupied, result.unavailable, result.unknown, result.total], [2, 2, 4, 2, 10]);
  assert.equal(result.availability_complete, false);
  assert.match(result.ascii, /G:1O\s+G:2O\s+G:3X/);
  codes = [7, 1];
  const complete = await new CinemaService(http).seats(q);
  assert.equal(complete.availability_complete, true); assert.equal(complete.available, 1);
  codes = [99];
  const unknown = await new CinemaService(http).seats(q);
  assert.equal(unknown.available, 0); assert.equal(unknown.unknown, 1);
  assert.equal(unknown.availability_complete, false);
  assert.match(unknown.warnings.join(' '), /no significa agotado/);
});

test('a Cinepic movie_id from another function is reported as a mismatched pair', async () => {
  // Observed on 2026-11-05: the purchase page for a valid session with another
  // film's pid renders without functionData.
  const service = new CinemaService(new HttpClient(async () => new Response(page({ shell: true })), 15000, new EmptySessionStore()));
  const r = await service.seats({ provider: 'cinepic', cinema_id: '123301', session_id: '3720', movie_id: '981' });
  assert.equal(r.status, 'unavailable');
  assert.match(r.warnings.join(' '), /usa session_id y movie_id de una misma función/);
});

test('the ASCII map is oriented as each provider website draws it', () => {
  // Cinepic Candelaria on 2026-11-05: invertida "1", drawn right to left under the screen.
  const map = { butacas: [cp({ butaca: 'A-15-1', columna: '15', nombre_butaca: 'A:5', invertida: '1' }), cp({ butaca: 'A-23-1', columna: '23', nombre_butaca: 'A:1', invertida: '1' })] };
  const lines = renderSeats(parseCinepicSeats(map), seatLayout('cinepic', map)).split('\n');
  assert.equal(lines[1], 'Orientado como la web del proveedor: pantalla arriba.'); assert.equal(lines[2], '[ PANTALLA ]');
  assert.ok(nth(lines, 4).indexOf('A:1O') < nth(lines, 4).indexOf('A:5O'), lines[4]);
  assert.deepEqual(seatLayout('cinesunidos'), { screen: 'bottom', column_order: 'ascending' });
  assert.deepEqual(seatLayout('cinex'), { screen: 'bottom', column_order: 'ascending' });
  assert.match(renderSeats(parseCinepicSeats(map)), /que no indica el lado de la pantalla/, 'no layout claims nothing');
});

test('parallel Cinex seat and price reads for different functions do not switch each other', async () => {
  // Cinex keeps one selected function per PHP session: the last boletos page opened wins.
  let selected = '', inFlight = 0, maxInFlight = 0;
  const sessions = new class extends EmptySessionStore { override async headers() { return { Cookie: 'synthetic' }; } };
  const http = new HttpClient(async url => {
    const u = new URL(String(url));
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 5 + Math.random() * 15));
    inFlight--;
    if (u.pathname === '/checklogin.php') return new Response('on');
    if (u.pathname === '/boletosdev.php' || u.pathname === '/boletos.php') { selected = defined(u.searchParams.get('sessionid')); return new Response('<form id="frmboletos"></form>'); }
    if (u.pathname === '/asientos.php') return new Response(cinexMap.replace('sessionid=s1', `sessionid=${selected}`));
    return new Response('', { status: 404 });
  }, 15000, sessions);
  const service = new CinemaService(http);
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const [results] = await Promise.all([
    Promise.all(ids.map(session_id => service.seats({ provider: 'cinex', cinema_id: 'SBC', session_id }))),
    service.query('prices', { provider: 'cinex', cinema_id: 'SBC', session_id: 's9' }),
  ]);
  for (const [i, r] of results.entries()) {
    assert.equal(r.status, 'available', `${ids[i]}: ${r.warnings.join(' ')}`);
    assert.equal(r.session_id, ids[i]);
  }
  assert.ok(maxInFlight >= 2, 'other reads still run in parallel');
});

test('a Cines Unidos seat answer that is not JSON names the provider response', async () => {
  const sessions = new class extends EmptySessionStore { override async headers() { return { Authorization: 'Bearer synthetic' }; } };
  const r = await new CinemaService(new HttpClient(async () => new Response('<html></html>'), 15000, sessions)).seats({ provider: 'cinesunidos', cinema_id: '1002', session_id: 's1' });
  assert.equal(r.status, 'error'); assert.match(r.warnings.join(' '), /Cines Unidos no devolvió un mapa de asientos en JSON válido/);
});

test('a Cines Unidos function no longer on sale online is reported as unavailable, not as a format change', async () => {
  // cinesunidos.com answered this for functions that had started or closed sales (2026-11-11).
  const sessions = new class extends EmptySessionStore { override async headers() { return { Authorization: 'Bearer synthetic' }; } };
  const service = new CinemaService(new HttpClient(async () => Response.json({ maxSeatsPerTransaction: 0 }), 15000, sessions));
  const r = await service.seats({ provider: 'cinesunidos', cinema_id: '1005', session_id: 's1' });
  assert.equal(r.status, 'unavailable'); assert.equal(r.total, 0);
  assert.match(r.warnings.join(' '), /no vende en línea esta función/); assert.doesNotMatch(r.warnings.join(' '), /estructura/);
  // A body that is truly different still says so.
  const odd = await new CinemaService(new HttpClient(async () => Response.json({ maxSeatsPerTransaction: 4 }), 15000, sessions)).seats({ provider: 'cinesunidos', cinema_id: '1005', session_id: 's1' });
  assert.equal(odd.status, 'error');
});

test('Cinex: the regular seat page is read first, and the newer one only when it draws no grid', async () => {
  // 2026-11-11: asientos.php drew every room's map once the function was selected; asientosdev.php only VIP rooms.
  const sessions = new class extends EmptySessionStore { override async headers() { return { Cookie: 'synthetic' }; } };
  const empty = '<a id="btnasientosatras" href="boletos.php?cinemaid=SBC&sessionid=s1">Atras</a><div id="mapcontent"><div class="row centermap"></div></div>';
  for (const [regular, newer, expected] of [[cinexMap, empty, ['/checklogin.php', '/boletos.php', '/asientos.php']], [empty, cinexMap, ['/checklogin.php', '/boletos.php', '/asientos.php', '/asientosdev.php']]] as const) {
    const paths: string[] = [];
    const http = new HttpClient(async url => {
      const path = new URL(String(url)).pathname; paths.push(path);
      return new Response(path === '/checklogin.php' ? 'on' : path === '/asientos.php' ? regular.replace('boletosdev.php', 'boletos.php') : path === '/asientosdev.php' ? newer : '<form id="frmboletos"></form>');
    }, 15000, sessions);
    const r = await new CinemaService(http).seats({ provider: 'cinex', cinema_id: 'SBC', session_id: 's1' });
    assert.equal(r.status, 'available'); assert.equal(r.total, 3);
    assert.deepEqual(paths, expected);
  }
});
