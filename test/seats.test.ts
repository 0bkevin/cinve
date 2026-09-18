import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCinepicSeats, parseCinesUnidosSeats, parseCinexSeats, renderSeats } from '../src/seats.js';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http.js';
import { assertPrivateRead } from '../src/auth.js';
import { EmptySessionStore, page } from './fixtures.js';
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
  data.seats.areas[0].rows[0].seats[0].position.areaNumber = 2;
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
  assert.equal(seats[1].column_index, 2);
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
    return new Response(String(url).endsWith('checklogin.php') ? 'on' : String(url).endsWith('asientosdev.php') ? body : '<form id="frmboletos"></form>');
  }, 15000, sessions);
  const q = { provider: 'cinex' as const, cinema_id: 'SBC', session_id: 's1' };
  const partial = await new CinemaService(http).seats(q);
  assert.equal(partial.available, 1);
  assert.equal(partial.occupied, 1); assert.equal(partial.unknown, 1);
  assert.equal(partial.total, 3); assert.equal(partial.availability_complete, false);
  assert.match(partial.warnings.join(' '), /cero libres confirmados no significa agotado/);
  assert.equal(urls.length, 3);
  body = cinexMap.replace('sessionid=s1', 'sessionid=other');
  const result = await new CinemaService(http).seats(q);
  assert.equal(result.status, 'unavailable'); assert.equal(result.ascii, '');
  assert.equal(result.total, 0); assert.equal(result.availability_complete, false);
  assert.doesNotThrow(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/asientosdev.php'));
  assert.throws(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/asientosdev.php?extra=1'));
});

test('Cinex VIP availability accepts empty selected-ticket count without relaxing seat state checks', () => {
  const q = { provider: 'cinex' as const, cinema_id: 'SBC', session_id: 's1' };
  const vip = cinexMap.replaceAll('seatestandar', 'seatvipplus').replace("'0001','0','N','N'", "'0001','','N','N'");
  assert.equal(parseCinexSeats(vip, q)[0].status, 'available');
  assert.equal(parseCinexSeats(vip, q)[0].category, '0001');
  assert.equal(parseCinexSeats(vip.replace("'0001','','N','N'", "'0001','','S','N'"), q)[0].status, 'unavailable');
  assert.equal(parseCinexSeats(vip.replace("'0001','','N','N'", "'0001','','N','S'"), q)[0].status, 'unavailable');
  assert.equal(parseCinexSeats(vip.replace('alt="0"', 'alt="1"'), q)[0].status, 'unknown');
  assert.equal(parseCinexSeats(vip.replace("'0001','','N','N'", "'0001','garbage','N','N'"), q)[0].status, 'unknown');
  assert.equal(parseCinexSeats(vip.replace('decideAsientoNew', 'unrecognized'), q)[0].status, 'unknown');
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
