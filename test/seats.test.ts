import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCinepicSeats, parseCinesUnidosSeats, renderSeats } from '../src/seats.js';
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
  assert.equal((await service.seats({ ...q, provider: 'cinex' })).status, 'unavailable');
});
test('Cines Unidos allows only the exact GET seat URL with bounded identifiers', () => {
  const valid = 'https://www.cinesunidos.com/api/seats?theaterId=1005&showTimeId=49993';
  assert.doesNotThrow(() => assertPrivateRead('cinesunidos', valid));
  for (const bad of [valid + '&token=x', valid + '&theaterId=1002', valid.replace('www.', 'evil.'), valid.replace('49993', '../orders'), valid + '#fragment']) assert.throws(() => assertPrivateRead('cinesunidos', bad));
});
