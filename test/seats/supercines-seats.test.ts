// Synthetic Supercines seat pages shaped like the one its site served on
// 2026-11-11 (makeSala.js, construyeNormal); no account or customer data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { SessionStore } from '../../src/auth/sessions.js';
import { HttpClient } from '../../src/http/client.js';
import { assertSupercinesSeatPage } from '../../src/http/allow-list.js';
import { CinemaService } from '../../src/service.js';
import { parseSupercinesSeats } from '../../src/seats/parsers.js';
import { today } from '../../src/core.js';
import { shiftDate } from '../helpers/fixtures.js';

const SC = 'https://supercines.com.ve';
const D1 = shiftDate(today(), 1);

type Page = { layout: string; width: number; height: number; dir?: string; sold?: string; restricted?: string; own?: string; enabled?: string; cinema?: string; date?: string; time?: string };
const seatPage = (p: Page) => `<div class="text-center"><h2 class="mb-1 ">LA GRANJA</h2><h3 class="mb-0">PELICULA</h3><h4 class="mb-0">${p.time ?? '5:40 PM'}   </h4></div>
<div id="gridNormal"></div><div class="pantalla"></div><h2 class="pt-3">PANTALLA</h2>
<script>var roomName = "6-1-6037-${p.date ?? D1}";
var asientosVendidos = '${p.sold ?? ''}'.split(',').filter(a => a);
var asientosUsuario = '${p.own ?? ''}'.split(',').filter(a => a);
var restringidosGlobales = "${p.restricted ?? ''}";
function SendSeatSelected(seats_info){ $.ajax({ url: "seatSelected", type: "POST",
 data:"seats_info=" + JSON.stringify(seats_info) +
 "&idEmpresa=${p.cinema ?? '7'}" +
 "&idSala=6" +
 "&idTurno=1" +
 "&idPelicula=6037" +
 "&fecha=${p.date ?? D1}" }); }
var direccionSala = '${p.dir ?? 'RL'}';
$(document).ready(function () {
 construyeNormal('${p.enabled ?? ''}', '${p.layout}', '${p.width}', '${p.height}','','',asientosAdquirido);
});</script>`;
const expected = { cinemaId: '7', date: D1, time: '17:40' };
// Two rows of five positions: aisle, seat, numbered gap, seat, seat (row B), and four seats after an aisle (row A).
const small = 'A:0,1,1,1,1|B:1,0,2,1,1';

test('Supercines seats are placed as makeSala.js draws them, right to left or left to right', () => {
  const rl = parseSupercinesSeats(seatPage({ layout: small, width: 5, height: 2 }), expected);
  const at = (seats: typeof rl, label: string) => { const s = seats.find(x => x.label === label); assert.ok(s, label); return [s.row_index, s.column_index]; };
  // Row B (the last letter) is the top row; A sits next to the screen below.
  assert.deepEqual(at(rl, 'B1'), [0, 4], 'RL: position 1 is drawn on the right');
  // Position 3 is a numbered place without a seat: B2 does not exist, and positions 4 and 5 are B3 and B4.
  assert.equal(rl.find(s => s.label === 'B2'), undefined);
  assert.deepEqual(at(rl, 'B3'), [0, 1]); assert.deepEqual(at(rl, 'B4'), [0, 0]);
  // An aisle (0) takes no number: row A's seats are A1..A4 at positions 2..5.
  assert.deepEqual(rl.filter(s => s.row === 'A').map(s => s.label), ['A1', 'A2', 'A3', 'A4']);
  assert.deepEqual(at(rl, 'A1'), [1, 3]);
  const lr = parseSupercinesSeats(seatPage({ layout: small, width: 5, height: 2, dir: 'LR' }), expected);
  assert.deepEqual(at(lr, 'B1'), [0, 0]); assert.deepEqual(at(lr, 'A4'), [1, 4]);
  assert.ok(rl.every(s => s.status === 'available' && s.provider_status === 'libre'));
});

test('Supercines seat states: sold, reserved for special tickets, and seats outside the enabled list', () => {
  const seats = parseSupercinesSeats(seatPage({ layout: small, width: 5, height: 2, sold: 'A1,B4', restricted: 'A2' }), expected);
  const state = (label: string) => seats.find(s => s.label === label)?.status;
  assert.deepEqual(['A1', 'A2', 'A3', 'B4', 'B1'].map(state), ['occupied', 'unavailable', 'available', 'occupied', 'available']);
  const enabled = parseSupercinesSeats(seatPage({ layout: small, width: 5, height: 2, enabled: 'A3,A4' }), expected);
  assert.deepEqual(enabled.filter(s => s.status === 'available').map(s => s.label).sort(), ['A3', 'A4']);
  // A seat held by this session (none should be: Cinve picks no seat) is never reported free.
  assert.equal(parseSupercinesSeats(seatPage({ layout: small, width: 5, height: 2, own: 'A3' }), expected).find(s => s.label === 'A3')?.status, 'unavailable');
});

test('a Supercines seat page for another venue, date or time is refused, and a changed page fails visibly', () => {
  for (const other of [{ cinema: '9' }, { date: shiftDate(D1, 1) }, { time: '7:00 PM' }]) {
    assert.throws(() => parseSupercinesSeats(seatPage({ layout: small, width: 5, height: 2, ...other }), expected), /does not match/);
  }
  assert.equal(parseSupercinesSeats(seatPage({ layout: small, width: 5, height: 2, time: '12:10 AM' }), { ...expected, time: '00:10' }).length, 7);
  // As makeSala.js: exactly `width` codes are read (Unicentro sends an extra one), a missing code hides its place
  // but takes a number, and a row outside the grid is not drawn.
  const loose = parseSupercinesSeats(seatPage({ layout: 'A:1,1,1,0,0,0|B:1,1|C:1,1,1,1,1', width: 5, height: 2 }), expected);
  assert.deepEqual(loose.map(s => s.label).sort(), ['A1', 'A2', 'A3', 'B1', 'B2']);
  for (const broken of [{ layout: 'A:0,1,3,1,1' }, { layout: 'AA:1,1,1,1,1' }, { layout: 'A' }, { dir: 'XX' }]) {
    assert.throws(() => parseSupercinesSeats(seatPage({ layout: small, width: 5, height: 2, ...broken }), expected), /Unrecognized/);
  }
  assert.throws(() => parseSupercinesSeats('<html>otra página</html>', expected), /Unrecognized/);
});

test('the purchase request Cinve may send carries exactly one ticket and nothing else', () => {
  const base: Array<[string, string]> = [['id', '3991'], ['cartelera', '100'], ['flagForm', '1'], ['espectaculo', '10'],
    ['quantityBoleto[77]', '1'], ['idBoleto[]', '77'], ['promoCombinada[]', ''], ['quantityBoleto[79]', '0'], ['idBoleto[]', '79'], ['promoCombinada[]', ''],
    ['cortesia_boleto', ''], ['quantityBoletoCortesia[]', '0']];
  assert.doesNotThrow(() => assertSupercinesSeatPage(base));
  const swap = (key: string, value: string) => base.map(([k, v]) => [k, k === key ? value : v] as [string, string]);
  for (const bad of [
    swap('quantityBoleto[79]', '1'), swap('quantityBoleto[77]', '2'), swap('quantityBoleto[77]', '0'), swap('cortesia_boleto', 'CODIGO'),
    swap('quantityBoletoCortesia[]', '1'), [...base, ['cb[]', 'A5']], [...base, ['idCanje[]', '3']], [...base, ['id', '1']],
    base.filter(([k]) => k !== 'cartelera'), [...base, ['idBoleto[]', '80']],
  ] as Array<Array<[string, string]>>) assert.throws(() => assertSupercinesSeatPage(bad), /not allowed/);
});

/** A signed-in account and a mock of the site: public schedule and booking pages, fares, the seat page and cancellation. */
async function site(t: { after(fn: () => Promise<void>): void }, options: { failSeatPage?: boolean; delayMs?: number; film?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-supercines-seats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = new SessionStore(join(dir, 'sessions')), jar = new CookieJar();
  await jar.setCookie('supercines_session=MEMBER; Secure; HttpOnly; Path=/', `${SC}/`);
  await jar.setCookie('XSRF-TOKEN=MEMBERXSRF; Secure; Path=/', `${SC}/`);
  await sessions.save({ version: 1, provider: 'supercines', expires_at: Date.now() + 3600000, cookie_jar: JSON.stringify(await jar.serialize()) });
  const calls: string[] = [], seatForms: URLSearchParams[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', headers = new Headers(init?.headers), member = /supercines_session=MEMBER/.test(headers.get('cookie') ?? '');
    calls.push(`${method} ${url.pathname}${member ? ' (account)' : ''}`);
    if (method === 'GET' && url.pathname === '/cartelera') return new Response('<meta name="csrf-token" content="TOKEN1000000000000000000000000000000000000">', { headers: [['set-cookie', 'XSRF-TOKEN=g; path=/'], ['set-cookie', 'supercines_session=GUEST; path=/']] });
    if (method === 'GET' && url.pathname === '/booking/3991') return new Response(`<script>const listBoletosPromise = postRequest("/listBoletos",\`idFuncion=\${idTurno}&fecha=\${fechaInicial}&unico=3991&tresD=0&idEmpresa=\${idEmpresa}\`);</script>`);
    // The billboard names the film the seat page must show (its <h3> is "PELICULA" in seatPage()).
    if (method === 'POST' && url.pathname === '/api/app/cartelera/list') return Response.json({ cartelera: [{ unico: 3991, pelicula: options.film ?? 'PELICULA', imagenPelicula: 'x.jpg', generos: 'CENSURA A' }], preventa: [], proximamente: [] });
    if (method === 'POST' && url.pathname === '/listCartelerafecha') {
      const date = new URLSearchParams(String(init?.body)).get('fecha');
      return new Response(`<div class="st_calender_row_cont"><h6>LA GRANJA</h6><ul><li><a id="hora_100" onclick="getDetailsNoauth(7,'hora_100','100','3991','${date}')">5:40 PM</a></li></ul></div>`);
    }
    if (method === 'POST' && url.pathname === '/listBoletos') {
      assert.ok(member, 'fares for the seat page are read as the account');
      return new Response('<div id="seleccionboletos"><input type="hidden" name="espectaculo" id="espectaculo" value="10" /><input type="text" name="quantityBoleto[77]" value="0"><input type="hidden" name="idBoleto[]" value="77"><input type="text" name="quantityBoleto[79]" value="0"><input type="hidden" name="idBoleto[]" value="79"></div>');
    }
    if (method === 'POST' && url.pathname === '/bookSeat') {
      assert.ok(member);
      seatForms.push(new URLSearchParams(String(init?.body)));
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      return options.failSeatPage ? new Response('', { status: 500 }) : new Response(seatPage({ layout: small, width: 5, height: 2, sold: 'A1' }));
    }
    if (method === 'GET' && url.pathname === '/cancelaCompra') { assert.ok(member); return new Response('', { status: 302, headers: { location: SC } }); }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  };
  return { calls, seatForms, sessions, fetcher, service: new CinemaService(new HttpClient(fetcher, 15000, sessions)) };
}

test('a Supercines seat lookup opens a one-ticket purchase, reads the map and always cancels it', async t => {
  const { calls, seatForms, service } = await site(t);
  const r = await service.seats({ provider: 'supercines', cinema_id: '7', session_id: '100', movie_id: '3991', date: D1 });
  assert.equal(r.status, 'available'); assert.equal(r.total, 7); assert.equal(r.occupied, 1);
  assert.match(r.warnings.join(' '), /opened one with a single ticket, chose no seat, read the map and cancelled it right away/);
  assert.deepEqual(calls.filter(c => c.includes('(account)')), ['POST /listBoletos (account)', 'POST /bookSeat (account)', 'GET /cancelaCompra (account)']);
  const form = seatForms[0]!;
  assert.deepEqual([form.get('id'), form.get('cartelera'), form.get('quantityBoleto[77]'), form.get('quantityBoleto[79]')], ['3991', '100', '1', '0']);
  assert.deepEqual(form.getAll('idBoleto[]'), ['77', '79']);
  // A function that is not in the schedule never opens a purchase.
  const wrong = await service.seats({ provider: 'supercines', cinema_id: '7', session_id: '101', movie_id: '3991', date: D1 });
  assert.equal(wrong.status, 'unavailable'); assert.equal(calls.filter(c => c.startsWith('POST /bookSeat')).length, 1);
});

test('the purchase is cancelled even when the seat page fails, and lookups never overlap on one account', async t => {
  const failing = await site(t, { failSeatPage: true });
  const r = await failing.service.seats({ provider: 'supercines', cinema_id: '7', session_id: '100', movie_id: '3991', date: D1 });
  assert.equal(r.status, 'error');
  assert.deepEqual(failing.calls.slice(-2), ['POST /bookSeat (account)', 'GET /cancelaCompra (account)']);
  const slow = await site(t, { delayMs: 30 });
  const q = { provider: 'supercines' as const, cinema_id: '7', session_id: '100', movie_id: '3991', date: D1 };
  const both = await Promise.all([slow.service.seats(q), slow.service.seats(q)]);
  assert.ok(both.every(x => x.status === 'available'));
  // Each purchase is cancelled before the next one opens.
  assert.deepEqual(slow.calls.filter(c => /bookSeat|cancelaCompra/.test(c)).map(c => c.split(' ')[1]), ['/bookSeat', '/cancelaCompra', '/bookSeat', '/cancelaCompra']);
});

test('final review: the purchase is closed even when the client cancels, and one account runs one purchase across clients', async t => {
  // Cancelled while /bookSeat is in flight: the call stops, but /cancelaCompra still goes out.
  const slow = await site(t, { delayMs: 60 });
  const abort = new AbortController();
  const pending = slow.service.seats({ provider: 'supercines', cinema_id: '7', session_id: '100', movie_id: '3991', date: D1 }, { signal: abort.signal });
  setTimeout(() => abort.abort(), 30);
  await pending;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(slow.calls.includes('GET /cancelaCompra (account)'), slow.calls.join(', '));
  // Two clients (as the hosted server builds per request) on one account: purchases never overlap.
  const shared = await site(t, { delayMs: 30 });
  const q = { provider: 'supercines' as const, cinema_id: '7', session_id: '100', movie_id: '3991', date: D1 };
  const two = [new CinemaService(new HttpClient(shared.fetcher, 15000, shared.sessions)), new CinemaService(new HttpClient(shared.fetcher, 15000, shared.sessions))];
  await Promise.all(two.map(service => service.seats(q)));
  assert.deepEqual(shared.calls.filter(c => /bookSeat|cancelaCompra/.test(c)).map(c => c.split(' ')[1]), ['/bookSeat', '/cancelaCompra', '/bookSeat', '/cancelaCompra']);
  // A seat page for another film at the same venue and time is refused.
  const other = await site(t, { film: 'PELICULA 2' });
  const r = await other.service.seats(q);
  assert.equal(r.status, 'unavailable'); assert.match(r.warnings.join(' '), /does not match/);
  assert.ok(other.calls.includes('GET /cancelaCompra (account)'));
  // Tags in parentheses and accents do not make a different film.
  const tagged = await site(t, { film: 'Película (3D)' });
  assert.equal((await tagged.service.seats(q)).status, 'available');
});

test('final review: Supercines seat lists must be declared, and each account route takes only its own method', async t => {
  // Without the sold-seat declaration the map is refused, never shown all free.
  const page = seatPage({ layout: small, width: 5, height: 2, sold: 'A1' });
  assert.equal(parseSupercinesSeats(page, expected).find(s => s.label === 'A1')?.status, 'occupied');
  for (const name of ['asientosVendidos', 'restringidosGlobales', 'asientosUsuario']) {
    assert.throws(() => parseSupercinesSeats(page.replace(`var ${name}`, `var renamed`), expected), /Unrecognized/, name);
  }
  // let/const and double quotes are still read.
  assert.equal(parseSupercinesSeats(page.replace("var asientosVendidos = 'A1'", 'let asientosVendidos = "A1"'), expected).find(s => s.label === 'A1')?.status, 'occupied');
  const { sessions } = await site(t);
  const http = new HttpClient(async () => new Response('x'), 15000, sessions);
  await assert.rejects(http.getAuthenticated('supercines', `${SC}/bookSeat`), /not allowed/);
  await assert.rejects(http.getAuthenticated('supercines', `${SC}/listBoletos`), /not allowed/);
  await assert.rejects(http.postAuthenticated('supercines', `${SC}/cancelaCompra`, {}), /not allowed/);
});
