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
  const data = { seats: { areas: [{ number: 1, areaCategoryCode: 'general', rows: [{ rowIndexZeroBased: 0, physicalName: 'P', seats: [0, 1, 2, 7, 99].map((status, columnIndex) => ({ id: String(columnIndex + 1), status, position: { areaNumber: 1, rowIndex: 0, columnIndex } })) }] }] } };
  assert.deepEqual(parseCinesUnidosSeats(data).map(s => s.status), ['available', 'occupied', 'occupied', 'unavailable', 'unknown']);
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
  assert.equal((await new CinemaService(http).seats(q)).available, 1);
  assert.equal(urls.length, 3);
  body = cinexMap.replace('sessionid=s1', 'sessionid=other');
  const result = await new CinemaService(http).seats(q);
  assert.equal(result.status, 'unavailable'); assert.equal(result.ascii, '');
  assert.doesNotThrow(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/asientosdev.php'));
  assert.throws(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/asientosdev.php?extra=1'));
});
