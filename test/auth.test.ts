import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { SessionStore, LoginHttp, login } from '../src/auth.js';
import { HttpClient } from '../src/http.js';
import { CinemaService } from '../src/service.js';
import { DataError } from '../src/core.js';

const ticketUrl = 'https://gateway.cinesunidos.com/tickets/www/theaters/1002/sessions/s1/';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new SessionStore(join(dir, 'sessions'));
}
const cuSession = (token = 'SYNTHETIC_TOKEN') => ({ version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: token });

test('sessions persist with private permissions, expose no token in status and reject extra password fields', async t => {
  const store = await fixture(t);
  await store.save(cuSession());
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(store.directory, 'cinesunidos.json'))).mode & 0o777, 0o600);
  assert.equal((await store.status('cinesunidos')).status, 'configured');
  assert.ok(!JSON.stringify(await store.status('cinesunidos')).includes('SYNTHETIC_TOKEN'));
  await assert.rejects(store.save({ ...cuSession(), password: 'DO_NOT_SAVE' } as never));
  assert.ok(!(await readFile(join(store.directory, 'cinesunidos.json'), 'utf8')).includes('DO_NOT_SAVE'));
  await chmod(join(store.directory, 'cinesunidos.json'), 0o644);
  await assert.rejects(store.headers('cinesunidos', ticketUrl), DataError);
});
test('session loading rejects symlinks', async t => {
  const store = await fixture(t); await store.save(cuSession());
  await symlink(join(store.directory, 'cinesunidos.json'), join(store.directory, 'cinex.json'));
  await assert.rejects(store.read('cinex'), DataError);
});
test('bearer is scoped to ticket reads and authenticated responses never use the public cache', async t => {
  const store = await fixture(t); await store.save(cuSession('FIRST_TOKEN'));
  const seen: Array<string | null> = [];
  const http = new HttpClient(async (_, init) => { seen.push(new Headers(init?.headers).get('Authorization')); return new Response('[]'); }, 1000, store);
  await http.getAuthenticated('cinesunidos', ticketUrl);
  await store.save(cuSession('SECOND_TOKEN'));
  await http.getAuthenticated('cinesunidos', ticketUrl);
  await http.get('https://gateway.cinesunidos.com/search/cities');
  assert.deepEqual(seen, ['Bearer FIRST_TOKEN', 'Bearer SECOND_TOKEN', null]);
  for (const url of ['https://gateway.cinesunidos.com/configuration', 'https://www.cinesunidos.com/', 'https://example.com/', ticketUrl + '?destination=other']) {
    await assert.rejects(http.getAuthenticated('cinesunidos', url), DataError);
  }
  await store.remove('cinesunidos');
  await assert.rejects(http.getAuthenticated('cinesunidos', ticketUrl), e => e instanceof DataError && e.status === 'auth_required');
  assert.equal(seen.length, 3);
});
test('expired sessions prevent requests and separate stores cannot share account data', async t => {
  const store = await fixture(t), other = await fixture(t);
  await store.save({ ...cuSession(), expires_at: Date.now() - 1000 });
  assert.equal((await store.status('cinesunidos')).status, 'expired');
  assert.equal((await other.status('cinesunidos')).status, 'missing');
  await assert.rejects(store.headers('cinesunidos', ticketUrl), DataError);
});
test('Cinex sends only cookies matching domain and path and only to read routes', async t => {
  const store = await fixture(t), jar = new CookieJar();
  await jar.setCookie('PHPSESSID=CINEX_SESSION; Secure; Path=/', 'https://www.cinex.com.ve/');
  await jar.setCookie('other=NO_LEAK; Secure; Path=/', 'https://example.com/');
  await jar.setCookie('account=NO_LEAK; Secure; Path=/account', 'https://www.cinex.com.ve/account');
  await store.save({ version: 1, provider: 'cinex', expires_at: Date.now() + 60000, cookie_jar: JSON.stringify(await jar.serialize()) });
  assert.equal((await store.headers('cinex', 'https://www.cinex.com.ve/checklogin.php')).Cookie, 'PHPSESSID=CINEX_SESSION');
  await assert.rejects(store.headers('cinex', 'https://www.cinex.com.ve/assets/php/prepareconcessionprocess.php'), DataError);
});
test('normal Cinex HTTP login uses form headers, verifies session and saves no password/profile', async t => {
  const store = await fixture(t); let called = 0;
  await login('cinex', 'person@example.test', 'SYNTHETIC_PASSWORD', store, async (input, init) => {
    const url = String(input); called++;
    if (url.endsWith('validatelogin.php')) {
      assert.equal(new Headers(init?.headers).get('X-Requested-With'), 'XMLHttpRequest');
      assert.equal((init?.body as FormData).get('password'), 'SYNTHETIC_PASSWORD');
      return new Response(JSON.stringify({ result: 'OK', nombres: 'PRIVATE_PROFILE', usuario_dataupdate: 'S' }), { headers: { 'Set-Cookie': 'PHPSESSID=FIXTURE_SESSION; Secure; HttpOnly; Path=/' } });
    }
    if (url.endsWith('checklogin.php')) { assert.match(new Headers(init?.headers).get('Cookie')!, /FIXTURE_SESSION/); return new Response('on'); }
    return new Response('<html>home</html>');
  });
  assert.equal(called, 3);
  const saved = await readFile(join(store.directory, 'cinex.json'), 'utf8');
  assert.ok(!/SYNTHETIC_PASSWORD|PRIVATE_PROFILE|person@example/.test(saved));
});
test('failed login neither stores credentials nor surfaces upstream private content', async t => {
  const store = await fixture(t);
  await assert.rejects(login('cinex', 'person@example.test', 'SYNTHETIC_PASSWORD', store, async () => new Response('SYNTHETIC_PASSWORD PRIVATE_PROFILE')), e => e instanceof Error && !/SYNTHETIC_PASSWORD|PRIVATE_PROFILE/.test(e.message));
  assert.equal(await store.read('cinex'), undefined);
});
test('login redirects preserve cookies but cannot replay password to another host', async () => {
  let calls = 0;
  const http = new LoginHttp('cinesunidos', async () => { calls++; return new Response(null, { status: 307, headers: { Location: 'https://www.cinesunidos.com/' } }); });
  await assert.rejects(http.read('https://keycloak.cinesunidos.com/realms/cinesunidos/login-actions/authenticate', { method: 'POST', body: new URLSearchParams({ password: 'SYNTHETIC_PASSWORD' }) }), /No se reenvían/);
  assert.equal(calls, 1);
  const outside = new LoginHttp('cinesunidos', async () => new Response(null, { status: 302, headers: { Location: 'https://example.com/callback' } }));
  await assert.rejects(outside.read('https://www.cinesunidos.com/'), /no permitido/);
});
test('HTTP Keycloak flow keeps state cookies and stores only the bearer and its expiry', async t => {
  const store = await fixture(t), exp = Math.floor(Date.now() / 1000) + 600;
  const token = `synthetic.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
  const request: typeof fetch = async (input, init) => {
    const u = new URL(String(input)), headers = new Headers(init?.headers);
    if (u.pathname === '/api/auth/csrf') return new Response('{"csrfToken":"CSRF"}', { headers: { 'Set-Cookie': 'csrf=CSRF; Secure; Path=/' } });
    if (u.pathname === '/api/auth/signin/keycloak') { assert.match(headers.get('Cookie')!, /csrf=CSRF/); assert.equal((init?.body as URLSearchParams).get('csrfToken'), 'CSRF'); return new Response('{"url":"https://keycloak.cinesunidos.com/realms/cinesunidos/protocol/openid-connect/auth"}'); }
    if (u.pathname.endsWith('/openid-connect/auth')) return new Response('<form action="/realms/cinesunidos/login-actions/authenticate?state=STATE"><input name="credentialId" type="hidden" value="ID"><input type="password" name="password"></form>', { headers: { 'Set-Cookie': 'auth_session=STATE; Secure; Path=/' } });
    if (u.pathname.endsWith('/login-actions/authenticate')) { assert.match(headers.get('Cookie')!, /auth_session=STATE/); assert.equal((init?.body as URLSearchParams).get('password'), 'SYNTHETIC_PASSWORD'); return new Response(null, { status: 302, headers: { Location: 'https://www.cinesunidos.com/api/auth/callback/keycloak?code=CODE' } }); }
    if (u.pathname === '/api/auth/callback/keycloak') { assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); assert.ok(!headers.get('Cookie')!.includes('auth_session')); return new Response('home'); }
    if (u.pathname === '/api/auth/session') return new Response(JSON.stringify({ user: { email: 'PRIVATE_PROFILE' }, access_token: token, id_token: 'PRIVATE_ID_TOKEN' }));
    throw new Error('Unexpected fixture route');
  };
  await login('cinesunidos', 'person@example.test', 'SYNTHETIC_PASSWORD', store, request);
  const saved = await readFile(join(store.directory, 'cinesunidos.json'), 'utf8');
  assert.equal((await store.read('cinesunidos'))?.expires_at, exp * 1000);
  assert.ok(!/SYNTHETIC_PASSWORD|PRIVATE_PROFILE|PRIVATE_ID_TOKEN|auth_session|csrf/.test(saved));
});
test('authenticated 401 returns auth_required without leaking bearer or response body', async t => {
  const store = await fixture(t); await store.save(cuSession());
  const service = new CinemaService(new HttpClient(async () => new Response('PRIVATE_PROFILE', { status: 401 }), 1000, store));
  const result = await service.query('prices', { provider: 'cinesunidos', cinema_id: '1002', session_id: 's1' });
  assert.equal(result.status, 'auth_required'); assert.ok(!/SYNTHETIC_TOKEN|PRIVATE_PROFILE/.test(JSON.stringify(result)));
});
