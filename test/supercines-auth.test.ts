// Synthetic Supercines login and fare pages; no real account or customer data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { SessionStore, login, CredentialsRejected, CinemaUnavailable } from '../src/auth.js';
import { HttpClient } from '../src/http.js';
import { CinemaService } from '../src/service.js';
import { DataError, today } from '../src/core.js';

const SC = 'https://supercines.com.ve';
const D = today();
async function store(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-supercines-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new SessionStore(join(dir, 'sessions'));
}
async function memberSession(sessions: SessionStore, expiresIn = 3600000) {
  const jar = new CookieJar();
  await jar.setCookie('supercines_session=MEMBER_SESSION; Secure; HttpOnly; Path=/', `${SC}/`);
  await jar.setCookie('XSRF-TOKEN=MEMBER%3DXSRF; Secure; Path=/', `${SC}/`);
  await jar.setCookie('other=NO_LEAK; Secure; Path=/', 'https://example.com/');
  await sessions.save({ version: 1, provider: 'supercines', expires_at: Date.now() + expiresIn, cookie_jar: JSON.stringify(await jar.serialize()) });
}

test('Supercines login posts the site form once, saves only cookies, and sends them only to the fare list', async t => {
  const sessions = await store(t);
  const calls: string[] = [];
  const result = await login('supercines', 'person@example.test', 'SYNTHETIC_PASSWORD', sessions, async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/cartelera') return new Response('<form id="formLogin"><input type="hidden" name="_token" value="FORMTOKEN0000000000000000000000000000000" autocomplete="off"></form>',
      { headers: [['set-cookie', 'XSRF-TOKEN=GUEST; Secure; Path=/'], ['set-cookie', 'supercines_session=GUEST; Secure; HttpOnly; Path=/']] });
    assert.equal(url.pathname, '/do-login');
    const form = new URLSearchParams(String(init?.body));
    assert.deepEqual([...form.keys()].sort(), ['_token', 'email', 'password', 'urlActual']);
    assert.equal(form.get('password'), 'SYNTHETIC_PASSWORD');
    assert.equal(headers.get('x-csrf-token'), 'FORMTOKEN0000000000000000000000000000000');
    assert.match(headers.get('cookie') ?? '', /supercines_session=GUEST/);
    return new Response(JSON.stringify({ status: true, redirect_location: `${SC}/cartelera`, nombre: 'PRIVATE_PROFILE' }),
      { headers: [['set-cookie', 'XSRF-TOKEN=MEMBER%3DXSRF; Max-Age=7200; Secure; Path=/'], ['set-cookie', 'supercines_session=MEMBER_SESSION; Max-Age=7200; Secure; HttpOnly; Path=/']] });
  });
  assert.equal(result.authenticated, true);
  assert.deepEqual(calls, ['GET /cartelera', 'POST /do-login']);
  const saved = await readFile(join(sessions.directory, 'supercines.json'), 'utf8');
  assert.ok(!/SYNTHETIC_PASSWORD|PRIVATE_PROFILE|person@example/.test(saved));
  const status = await sessions.status('supercines');
  assert.equal(status.status, 'configured');
  // The session cookie's own lifetime (two hours here), not a guess.
  assert.ok(Date.parse(status.expires_at!) - Date.now() > 7100000 && Date.parse(status.expires_at!) - Date.now() <= 7200000);
  const headers = await sessions.headers('supercines', `${SC}/listBoletos`);
  assert.match(headers.Cookie, /supercines_session=MEMBER_SESSION/);
  assert.equal(headers['X-XSRF-TOKEN'], 'MEMBER=XSRF');
  for (const url of [`${SC}/addSessionbook`, `${SC}/bookSeat`, `${SC}/listBoletos?x=1`, `${SC}/mis-cortesias`, 'https://example.com/listBoletos'])
    await assert.rejects(sessions.headers('supercines', url), DataError);
});

test('a refused Supercines login is CredentialsRejected, stores nothing and leaks neither the password nor the reply', async t => {
  const sessions = await store(t);
  // A Laravel validation 422 and a 200 with status:false are both the cinema evaluating
  // and refusing the credentials: each must be CredentialsRejected (charged, never refunded
  // as an outage), so an attacker cannot reclaim sign-in attempts against Supercines.
  const replies = [() => new Response(JSON.stringify({ message: 'PRIVATE_REASON SYNTHETIC_PASSWORD' }), { status: 422 }), () => new Response(JSON.stringify({ status: false, message: 'PRIVATE_REASON' }))];
  for (const reply of replies) {
    await assert.rejects(login('supercines', 'person@example.test', 'SYNTHETIC_PASSWORD', sessions, async input =>
      new URL(String(input)).pathname === '/cartelera' ? new Response('<input type="hidden" name="_token" value="FORMTOKEN0000000000000000000000000000000">', { headers: { 'set-cookie': 'supercines_session=GUEST; Path=/' } }) : reply()),
    e => e instanceof CredentialsRejected && !/SYNTHETIC_PASSWORD|PRIVATE_REASON/.test((e as Error).message));
  }
  assert.equal(await sessions.read('supercines'), undefined);
});

test('a Supercines outage before and during submission is CinemaUnavailable, not a credential verdict', async t => {
  const sessions = await store(t);
  const form = () => new Response('<input type="hidden" name="_token" value="FORMTOKEN0000000000000000000000000000000">', { headers: { 'set-cookie': 'supercines_session=GUEST; Path=/' } });
  // The form page itself is down: credentials never left the client.
  await assert.rejects(login('supercines', 'person@example.test', 'SYNTHETIC_PASSWORD', sessions,
    async () => new Response('', { status: 503 })),
    e => e instanceof CinemaUnavailable && !/SYNTHETIC_PASSWORD/.test((e as Error).message));
  // A Cloudflare challenge on the submission's first hop stopped it before the login.
  await assert.rejects(login('supercines', 'person@example.test', 'SYNTHETIC_PASSWORD', sessions, async input =>
    new URL(String(input)).pathname === '/cartelera' ? form()
      : new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } })),
    e => e instanceof CinemaUnavailable);
  assert.equal(await sessions.read('supercines'), undefined);
});

// One function (id 100, La Granja, today) of title 3991, and its fare list.
const fare = (id: number, name: string, a: string, b: string, shown: string) => `<div class="row"><h6>${name}</h6>
<button onclick="changeQtyBoleto(1,${id},'${name}   ','${a}','${b}'); return false;">+</button><div class="col-md-3"><h6>Bs. ${shown}</h6></div></div>`;
// Signed in, the live page adds the account's courtesy-ticket container (observed November 2026).
const courtesies = `<hr class="my-4"><div class="row" id="superfriends-cortesias-div"><div class="col-12"><h6 class="">Mis Cortesías Super Friends</h6><div id="cortesias-usuario-container" class="mb-3"><span>Cargando cortesías...</span></div></div></div>`;
const fares = (member: boolean) => `<div id="seleccionboletos">${fare(77, 'BOLETO GENERAL 2D', '86.00', '3971.29', '4,057.29')}${member ? fare(90, 'CANJE SUPERPUNTOS', '0.00', '0.00', '0.00') + courtesies : ''}</div>`;
function site(options: { expired?: boolean } = {}) {
  const calls: { path: string; cookie: string; xsrf: string; csrf: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    const call = { path: url.pathname, cookie: headers.get('cookie') ?? '', xsrf: headers.get('x-xsrf-token') ?? '', csrf: headers.get('x-csrf-token') ?? '' };
    calls.push(call);
    if (url.pathname === '/cartelera') return new Response('<meta name="csrf-token" content="GUESTTOKEN000000000000000000000000000000">', { headers: [['set-cookie', 'XSRF-TOKEN=GUEST; Path=/'], ['set-cookie', 'supercines_session=GUEST; Path=/']] });
    if (url.pathname === '/booking/3991') return new Response(`<script>const tasa = '901.62'; postRequest("/listBoletos",\`idFuncion=\${idTurno}&fecha=\${fechaInicial}&unico=3991&tresD=0&idEmpresa=\${idEmpresa}\`);</script>`);
    if (url.pathname === '/listCartelerafecha') return new Response(`<div class="st_calender_row_cont"><h6>LA GRANJA</h6><div class="horariosNew"><ul><li><a href="javascript:void(0)" id="hora_100" onclick="getDetailsNoauth(7,'hora_100','100','3991','${D}')">11:50 PM</a></li></ul></div></div>`);
    if (url.pathname === '/listBoletos') {
      if (call.xsrf) {
        // A signed-in read: the account's cookies only, never the guest token.
        assert.match(call.cookie, /supercines_session=MEMBER_SESSION/);
        assert.ok(!/GUEST|NO_LEAK/.test(call.cookie) && !call.csrf);
        if (options.expired) return new Response('', { status: 419 });
        return new Response(fares(true));
      }
      assert.ok(!/MEMBER/.test(call.cookie));
      return new Response(fares(false));
    }
    throw new Error(`Unexpected ${url.pathname}`);
  };
  return { calls, fetcher };
}
const query = { provider: 'supercines' as const, cinema_id: '7', movie_id: '3991', session_id: '100' };

test('without an account Supercines fares stay public', async t => {
  const { calls, fetcher } = site();
  const result = await new CinemaService(new HttpClient(fetcher, 15000, await store(t))).query('prices', query);
  assert.deepEqual(result.items.map(i => i.name), ['BOLETO GENERAL 2D']);
  assert.ok(result.warnings.some(w => /Tarifas públicas de Supercines, sin cuenta/.test(w)));
  assert.ok(!calls.some(c => c.xsrf));
});

test('a connected Supercines account reads fares as that account, uncached', async t => {
  const sessions = await store(t);
  await memberSession(sessions);
  const { calls, fetcher } = site();
  const service = new CinemaService(new HttpClient(fetcher, 15000, sessions));
  const result = await service.query('prices', query);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.items.map(i => i.name), ['BOLETO GENERAL 2D', 'CANJE SUPERPUNTOS']);
  // The courtesy-ticket section is not a fare and does not make the result partial.
  assert.equal(result.partial, false);
  assert.ok(result.warnings.some(w => /leídas con tu cuenta de Supercines/.test(w)));
  // Exactly one fare read, made with the account; no guest fare read.
  assert.deepEqual(calls.filter(c => c.path === '/listBoletos').map(c => !!c.xsrf), [true]);
  await service.query('prices', query);
  assert.equal(calls.filter(c => c.path === '/listBoletos').length, 2);
  // Nothing but the fare list ever carries the account.
  assert.ok(calls.filter(c => c.path !== '/listBoletos').every(c => !/MEMBER/.test(c.cookie)));
});

test('an ended Supercines session falls back to public fares and is marked refused', async t => {
  const sessions = await store(t);
  await memberSession(sessions);
  const { calls, fetcher } = site({ expired: true });
  const http = new HttpClient(fetcher, 15000, sessions);
  const result = await new CinemaService(http).query('prices', query);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.items.map(i => i.name), ['BOLETO GENERAL 2D']);
  assert.ok(result.warnings.some(w => /no reconoció la sesión de tu cuenta/.test(w)));
  assert.deepEqual(calls.filter(c => c.path === '/listBoletos').map(c => !!c.xsrf), [true, false]);
  assert.ok(http.rejectedSessions.has('supercines'));
});

test('an expired local Supercines session is not used', async t => {
  const sessions = await store(t);
  await memberSession(sessions, -1000);
  const { calls, fetcher } = site();
  const result = await new CinemaService(new HttpClient(fetcher, 15000, sessions)).query('prices', query);
  assert.ok(result.warnings.some(w => /Tarifas públicas de Supercines, sin cuenta/.test(w)));
  assert.ok(!calls.some(c => c.xsrf));
});
