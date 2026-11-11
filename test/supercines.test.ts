// Synthetic minimal responses shaped like the observed Supercines pages; no customer data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../src/service.js';
import { HttpClient, assertPublicForm, assertPublicRead } from '../src/http.js';
import { inputSchema } from '../src/server.js';
import { EmptySessionStore } from './fixtures.js';

const SC = 'https://supercines.com.ve';
const directory = [
  { id: 7, nombre: 'LA GRANJA', ciudad: 'VALENCIA', estatus: 1, ip: 'granja.internal:8000', merchantB: 123 },
  { id: 9, nombre: 'UNICENTRO', ciudad: 'MARACAY', estatus: 1, ip: 'unicentro.internal:8000' },
  { id: 4, nombre: 'LOS AVIADORES', ciudad: 'MARACAY', estatus: 1 },
  { id: 6, nombre: 'CERRADA', ciudad: 'VALENCIA', estatus: 0 },
];
const billboard = {
  cartelera: [
    { unico: 3991, pelicula: 'CLAYFACE', imagenPelicula: 'image-pelicula1.jpg', generos: 'CENSURA B ' },
    { unico: 4092, pelicula: 'EL GATO CON SOMBRERO (3D)', imagenPelicula: '../x.jpg', generos: 'CENSURA A' },
  ],
  preventa: [{ unico: 3976, pelicula: 'ESTRENO EN PREVENTA', imagenPelicula: 'p.png', generos: 'CENSURA A' }],
  proximamente: [{ unico: 4015, pelicula: 'SIN FUNCIONES', fechaEstreno: '2026-12-01' }],
};
const block = (venue: string, anchors: string) => `<div class="st_calender_row_cont"><h6>${venue}</h6><div class="horariosNew"><ul>${anchors}</ul></div></div>`;
const slot = (cinema: number, id: number, movie: number, date: string, time: string) =>
  `<li><a href="javascript:void(0)" id="hora_${id}" onclick="getDetailsNoauth(${cinema},'hora_${id}','${id}','${movie}','${date}')">${time}   </a></li>`;
const schedule3991 = `<!-- ${block('LA GRANJA', slot(7, 999, 3991, '2026-11-11', '1:00 PM'))} -->` +
  block('LA GRANJA', slot(7, 100, 3991, '2026-11-11', '5:40 PM') + slot(7, 101, 3991, '2026-11-11', '12:10 AM') +
    '<li><a href="javascript:void(0)" id="hora_102" class="disabledFunction" onclick="ventasDesactivadas()">9:00 PM</a></li>' +
    slot(7, 103, 4000, '2026-11-11', '7:00 PM')) +
  block('UNICENTRO', slot(9, 200, 3991, '2026-11-11', '12:30 PM'));
const booking = (threeD: '0' | '1') => `<meta name="csrf-token" content="TOKEN0000000000000000000000000000000000">
<script>const tasa = '901.62';
const listBoletosPromise = postRequest("/listBoletos",\`idFuncion=\${idTurno}&fecha=\${fechaInicial}&unico=3991&tresD=${threeD}&idEmpresa=\${idEmpresa}\`);</script>`;
const fare = (id: number, name: string, a: string, b: string, shown: string) => `<div class="row align-items-center mb-3"><div class="col-6 col-md-5"><h6>${name}</h6></div>
<button onclick="changeQtyBoleto(0,${id},'${name}   ','${a}','${b}'); return false;">-</button><button onclick="changeQtyBoleto(1,${id},'${name}   ','${a}','${b}'); return false;">+</button>
<div class="col-md-3 text-end d-none d-md-block"><h6 class=" mb-0 ">Bs. ${shown}</h6></div></div>`;
const fares = `<div id="seleccionboletos" class="p-5 card mb-3"><input type="hidden" id="espectaculo" value="10" />` +
  fare(77, 'BOLETO GENERAL 2D', '86.00', '3971.29', '4,057.29') + fare(79, 'TERCERA EDAD 2D', '43.00', '2211.05', '9,999.00') + '</div>';
const candy = `<button class="btn" data-filtro="1" onclick="flitraCarameleria('1')">Individuales</button>
<div class="categos cat_1"><div class="card"><div class="product-img-container"><img src="storage/image/productos/a.jpeg"></div>
<div class="card-body" data-id="90" data-nombre="AGUA MINERAL   " data-precio="1713.08" data-stock="2"><h6>AGUA</h6></div></div></div>
<div class="categos cat_1"><div class="card"><div class="card-body" data-id="91" data-nombre="SIN PRECIO" data-precio=""></div></div></div>`;

type Call = { method: string; path: string; body: string; cookie: string; token: string };
function provider(options: { expireOnce?: boolean } = {}) {
  const calls: Call[] = [];
  let sessions = 0, expired = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname, body: String(init?.body ?? ''), cookie: headers.get('cookie') ?? '', token: headers.get('x-csrf-token') ?? '' };
    calls.push(call);
    if (call.method === 'GET' && call.path === '/cartelera') {
      sessions++;
      return new Response(`<meta name="csrf-token" content="TOKEN${sessions}00000000000000000000000000000000000">`, { status: 200, headers: [
        ['set-cookie', `XSRF-TOKEN=x${sessions}; path=/; secure`], ['set-cookie', `supercines_session=s${sessions}; path=/; httponly`]] });
    }
    if (call.method === 'GET' && call.path === '/booking/3991') return new Response(booking('0'));
    if (call.method !== 'POST') throw new Error(`Unexpected ${call.method} ${call.path}`);
    if (!call.token.startsWith('TOKEN') || !call.cookie.includes('supercines_session=')) return new Response('', { status: 419 });
    if (options.expireOnce && !expired) { expired = true; return new Response('', { status: 419 }); }
    const form = new URLSearchParams(call.body);
    if (call.path === '/dame_empresas') return new Response(JSON.stringify(directory));
    if (call.path === '/api/app/cartelera/list') return new Response(JSON.stringify(billboard));
    if (call.path === '/listCartelerafecha') {
      if (form.get('id') === '3991') return new Response(schedule3991);
      return new Response('', { status: 302, headers: { location: SC } });
    }
    if (call.path === '/listBoletos') return new Response(fares);
    if (call.path === '/listCarameleria') return new Response(candy);
    throw new Error(`Unexpected POST ${call.path}`);
  };
  return { calls, service: new CinemaService(new HttpClient(fetcher, 15000, new EmptySessionStore())) };
}

test('Supercines reads only its public listing routes, with exactly their fields', () => {
  assert.doesNotThrow(() => assertPublicForm(`${SC}/listCartelerafecha`, { fecha: '2026-11-11', id: '3991' }));
  assert.doesNotThrow(() => assertPublicForm(`${SC}/api/app/cartelera/list`, { type: 'all' }));
  assert.doesNotThrow(() => assertPublicRead(`${SC}/booking/3991`));
  for (const [url, fields] of [
    [`${SC}/bookSeat`, {}], [`${SC}/addSessionbook`, {}], [`${SC}/do-login`, {}], [`${SC}/verifyCortesia`, {}],
    [`${SC}/listCartelerafecha`, { fecha: '2026-11-11', id: '3991', extra: '1' }],
    [`${SC}/listCartelerafecha`, { fecha: '2026-11-11' }],
    [`${SC}/listCarameleria`, { idEmpresa: '7', constructor: 'x' }],
    [`${SC}/listBoletos`, { idFuncion: '1', fecha: '2026-11-11', unico: '2', tresD: '2', idEmpresa: '7' }],
    [`${SC}/listCarameleria?x=1`, { idEmpresa: '7' }],
    ['https://evil.example/listCarameleria', { idEmpresa: '7' }],
  ] as const) assert.throws(() => assertPublicForm(url, fields), /no permitida/);
  assert.throws(() => assertPublicRead(`${SC}/mis-cortesias`), /no permitida/);
  assert.throws(() => assertPublicRead(`${SC}/booking/1?x=1`), /no permitida/);
});

test('Supercines lists active venues and cities without exposing internal directory fields', async () => {
  const { service, calls } = provider();
  const cinemas = await service.query('cinemas', { provider: 'supercines', city: 'maracay' });
  assert.deepEqual(cinemas.items.map(c => [c.id, c.name, c.city, c.code_status]), [
    ['4', 'Supercines Los Aviadores', 'Maracay', 'verified'], ['9', 'Supercines Unicentro', 'Maracay', 'verified']]);
  assert.doesNotMatch(JSON.stringify(cinemas), /internal|merchant/);
  const cities = await service.query('cities', { provider: 'supercines' });
  assert.deepEqual(cities.items.map(c => c.name), ['Maracay', 'Valencia']);
  // One visitor session: its cookies and token accompany every listing read.
  assert.equal(calls.filter(c => c.path === '/cartelera').length, 1);
  const post = calls.find(c => c.method === 'POST')!;
  assert.match(post.cookie, /XSRF-TOKEN=x1; supercines_session=s1|supercines_session=s1; XSRF-TOKEN=x1/);
  assert.equal(post.token, 'TOKEN100000000000000000000000000000000000');
});

test('Supercines renews an expired visitor token once', async () => {
  const { service, calls } = provider({ expireOnce: true });
  const result = await service.query('cinemas', { provider: 'supercines' });
  assert.equal(result.status, 'available');
  assert.equal(calls.filter(c => c.path === '/cartelera').length, 2);
});

test('Supercines billboard keeps presales, drops unsafe images and maps ratings and 3D', async () => {
  const { service } = provider();
  const result = await service.query('movies', { provider: 'supercines' });
  assert.deepEqual(result.items.map(m => m.id).sort(), ['3976', '3991', '4092']);
  const gato = result.items.find(m => m.id === '4092')!;
  assert.equal(gato.format, '3D'); assert.equal(gato.rating, 'A'); assert.equal(gato.image_url, undefined);
  assert.equal(result.items.find(m => m.id === '3991')?.image_url, `${SC}/storage/image/image-pelicula1.jpg`);
  assert.equal(inputSchema('movies').safeParse({ provider: 'supercines', date: '2026-11-11' }).success, false);
});

test('Supercines functions: live blocks only, 12-hour clock, late night without timestamp, venue filter', async () => {
  const { service } = provider();
  const result = await service.query('showtimes', { provider: 'supercines', cinema_id: '7', date: '2026-11-11' });
  // The service sorts by starts_at, then name: the late-night function last.
  assert.deepEqual(result.items.map(s => [s.id, s.time, s.starts_at ?? null, s.cinema_name]), [
    ['100', '17:40', '2026-11-11T17:40:00-04:00', 'Supercines La Granja'],
    ['101', '00:10', null, 'Supercines La Granja'],
  ]);
  // A function attributed to another title is not reported under this one.
  assert.equal(result.partial, true);
  assert.ok(result.warnings.some(w => /venta en línea desactivada/.test(w)));
  // Titles without functions that day (redirect to the home page) are empty, not failures.
  assert.ok(!result.warnings.some(w => /No se pudieron consultar/.test(w)));
  const city = await service.query('showtimes', { provider: 'supercines', city: 'Maracay', date: '2026-11-11' });
  assert.deepEqual(city.items.map(s => [s.id, s.cinema_id, s.time]), [['200', '9', '12:30']]);
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'supercines' }).success, false);
});

test('Supercines fares require the function to exist and never keep an inconsistent amount', async () => {
  const { service, calls } = provider();
  const result = await service.query('prices', { provider: 'supercines', cinema_id: '7', movie_id: '3991', session_id: '100', date: '2026-11-11' });
  assert.equal(result.status, 'available');
  assert.deepEqual(result.items.map(r => [r.id, r.prices]), [['77', [{ currency: 'VES', amount: 4057.29, basis: 'provider' }, { currency: 'USD', amount: 4.5, basis: 'provider_conversion' }]]]);
  assert.equal(result.items[0].final_total_verified, false);
  assert.equal(result.partial, true);
  const fareRead = new URLSearchParams(calls.find(c => c.path === '/listBoletos')!.body);
  assert.deepEqual(Object.fromEntries(fareRead), { fecha: '2026-11-11', idEmpresa: '7', idFuncion: '100', tresD: '0', unico: '3991' });
  // The same function ID at another venue is not this function.
  const other = await service.query('prices', { provider: 'supercines', cinema_id: '9', movie_id: '3991', session_id: '100', date: '2026-11-11' });
  assert.equal(other.status, 'unavailable');
  assert.equal(inputSchema('prices').safeParse({ provider: 'supercines', cinema_id: '7', session_id: '100' }).success, false);
  assert.equal(inputSchema('prices').safeParse({ provider: 'supercines', cinema_id: '7', session_id: '100', movie_id: '3991', date: '2026-11-11' }).success, true);
  assert.equal(inputSchema('prices').safeParse({ provider: 'cinepic', cinema_id: '123300', session_id: 'f1', movie_id: 'p1', date: '2026-11-11' }).success, false);
});

test('Supercines concessions keep category and price, and skip products without a price', async () => {
  const { service } = provider();
  const result = await service.query('concessions', { provider: 'supercines', cinema_id: '7' });
  assert.deepEqual(result.items.map(r => [r.id, r.name, r.category, r.prices, r.stock]), [['90', 'AGUA MINERAL', 'Individuales', [{ currency: 'VES', amount: 1713.08, basis: 'provider' }], undefined]]);
  assert.equal(result.items[0].image_url, `${SC}/storage/image/productos/a.jpeg`);
  assert.equal(result.partial, true);
  const unknown = await service.query('concessions', { provider: 'supercines', cinema_id: '6' });
  assert.equal(unknown.status, 'unavailable');
});

test('Supercines seat maps are reported as not implemented', async () => {
  const { service, calls } = provider();
  const result = await service.seats({ provider: 'supercines', cinema_id: '7', session_id: '100' });
  assert.equal(result.status, 'unavailable');
  assert.equal(calls.length, 0);
});
