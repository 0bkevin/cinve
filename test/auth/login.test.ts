import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/auth/sessions.js';
import { CinemaUnavailable, CredentialsRejected, LoginError, LoginHttp, login } from '../../src/auth/login.js';
import { defined, instance } from '../helpers/assert.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new SessionStore(join(dir, 'sessions'));
}

test('normal Cinex HTTP login uses form headers, verifies session and saves no password/profile', async t => {
  const store = await fixture(t); let called = 0;
  await login('cinex', 'person@example.test', 'SYNTHETIC_PASSWORD', store, async (input, init) => {
    const url = String(input); called++;
    if (url.endsWith('validatelogin.php')) {
      assert.equal(new Headers(init?.headers).get('X-Requested-With'), 'XMLHttpRequest');
      assert.equal(instance(init?.body, FormData).get('password'), 'SYNTHETIC_PASSWORD');
      return new Response(JSON.stringify({ result: 'OK', nombres: 'PRIVATE_PROFILE', usuario_dataupdate: 'S' }), { headers: { 'Set-Cookie': 'PHPSESSID=FIXTURE_SESSION; Secure; HttpOnly; Path=/' } });
    }
    if (url.endsWith('checklogin.php')) { assert.match(defined(new Headers(init?.headers).get('Cookie')), /FIXTURE_SESSION/); return new Response('on'); }
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
  await assert.rejects(http.read('https://keycloak.cinesunidos.com/realms/cinesunidos/login-actions/authenticate', { method: 'POST', body: new URLSearchParams({ password: 'SYNTHETIC_PASSWORD' }) }), /Credentials are not forwarded/);
  assert.equal(calls, 1);
  const outside = new LoginHttp('cinesunidos', async () => new Response(null, { status: 302, headers: { Location: 'https://example.com/callback' } }));
  await assert.rejects(outside.read('https://www.cinesunidos.com/'), /not allowed/);
});
test('HTTP Keycloak flow keeps state cookies and stores only the bearer and its expiry', async t => {
  const store = await fixture(t), exp = Math.floor(Date.now() / 1000) + 600;
  const token = `synthetic.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
  const request: typeof fetch = async (input, init) => {
    const u = new URL(String(input)), headers = new Headers(init?.headers);
    if (u.pathname === '/api/auth/csrf') return new Response('{"csrfToken":"CSRF"}', { headers: { 'Set-Cookie': 'csrf=CSRF; Secure; Path=/' } });
    if (u.pathname === '/api/auth/signin/keycloak') { assert.match(defined(headers.get('Cookie')), /csrf=CSRF/); assert.equal(instance(init?.body, URLSearchParams).get('csrfToken'), 'CSRF'); return new Response('{"url":"https://keycloak.cinesunidos.com/realms/cinesunidos/protocol/openid-connect/auth"}'); }
    if (u.pathname.endsWith('/openid-connect/auth')) return new Response('<form action="/realms/cinesunidos/login-actions/authenticate?state=STATE"><input name="credentialId" type="hidden" value="ID"><input type="password" name="password"></form>', { headers: { 'Set-Cookie': 'auth_session=STATE; Secure; Path=/' } });
    if (u.pathname.endsWith('/login-actions/authenticate')) { assert.match(defined(headers.get('Cookie')), /auth_session=STATE/); assert.equal(instance(init?.body, URLSearchParams).get('password'), 'SYNTHETIC_PASSWORD'); return new Response(null, { status: 302, headers: { Location: 'https://www.cinesunidos.com/api/auth/callback/keycloak?code=CODE' } }); }
    if (u.pathname === '/api/auth/callback/keycloak') { assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); assert.ok(!defined(headers.get('Cookie')).includes('auth_session')); return new Response('home'); }
    if (u.pathname === '/api/auth/session') return new Response(JSON.stringify({ user: { email: 'PRIVATE_PROFILE' }, access_token: token, id_token: 'PRIVATE_ID_TOKEN' }));
    throw new Error('Unexpected fixture route');
  };
  await login('cinesunidos', 'person@example.test', 'SYNTHETIC_PASSWORD', store, request);
  const saved = await readFile(join(store.directory, 'cinesunidos.json'), 'utf8');
  assert.equal((await store.read('cinesunidos'))?.expires_at, exp * 1000);
  assert.ok(!/SYNTHETIC_PASSWORD|PRIVATE_PROFILE|PRIVATE_ID_TOKEN|auth_session|csrf/.test(saved));
});

test('upstream exceptions cannot masquerade as safe login messages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-error-auth-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(login('cinex', 'person@example.test', 'SYNTHETIC_PASSWORD', new SessionStore(dir), async () => { throw new Error('Cinex SYNTHETIC_PASSWORD PRIVATE_PROFILE'); }), e => e instanceof Error && !/SYNTHETIC_PASSWORD|PRIVATE_PROFILE/.test(e.message));
});
test('login redirects share one deadline signal and cannot propagate caller-supplied auth headers', async () => {
  const signals: unknown[] = []; let calls = 0;
  const http = new LoginHttp('cinesunidos', async (_, init) => {
    signals.push(init?.signal); const h = new Headers(init?.headers);
    assert.equal(h.get('Authorization'), null); assert.equal(h.get('Cookie'), null);
    return ++calls === 1 ? new Response(null, { status: 302, headers: { Location: 'https://www.cinesunidos.com/' } }) : new Response('ok');
  });
  await http.read('https://keycloak.cinesunidos.com/', { headers: { Authorization: 'SECRET', Cookie: 'secret=SECRET' } });
  assert.equal(calls, 2); assert.equal(signals[0], signals[1]);
});

test('login errors say whether the cinema refused the credentials, never saw them, or is unclear', async t => {
  const store = await fixture(t);
  const kind = async (provider: 'cinex' | 'cinesunidos', request: typeof fetch) => {
    try { await login(provider, 'person@example.test', 'SYNTHETIC_PASSWORD', store, request); return 'ok'; } catch (e) {
      assert.ok(!/SYNTHETIC_PASSWORD/.test((e as Error).message));
      return e instanceof CredentialsRejected ? 'refused' : e instanceof CinemaUnavailable ? 'unavailable' : e instanceof LoginError ? 'unclear' : 'other';
    }
  };
  const cinex = (validate: () => Response | Promise<Response>, home = () => new Response('<html>home</html>')): typeof fetch => async input =>
    String(input).endsWith('validatelogin.php') ? validate() : String(input).endsWith('checklogin.php') ? new Response('off') : home();
  assert.equal(await kind('cinex', cinex(() => new Response('{"result":"ERROR"}'))), 'refused');
  for (const status of [400, 401, 403, 422]) assert.equal(await kind('cinex', cinex(() => new Response('', { status }))), 'refused', String(status));
  // Before the credentials are sent nothing reflects on them.
  assert.equal(await kind('cinex', cinex(() => new Response('{"result":"OK"}'), () => new Response('', { status: 503 }))), 'unavailable');
  assert.equal(await kind('cinex', async () => { throw new TypeError('fetch failed'); }), 'unavailable');
  // After they are sent, outages and throttling are unclear, never refusals...
  for (const status of [429, 500, 503]) assert.equal(await kind('cinex', cinex(() => new Response('', { status }))), 'unclear', String(status));
  assert.equal(await kind('cinex', cinex(() => { throw new TypeError('fetch failed'); })), 'unclear');
  // ...and so is a password Cinex accepted without establishing a session.
  assert.equal(await kind('cinex', cinex(() => new Response('{"result":"OK"}'))), 'unclear');
  const unidos = (authenticate: () => Response): typeof fetch => async input => {
    const u = new URL(String(input));
    if (u.pathname === '/api/auth/csrf') return new Response('{"csrfToken":"CSRF"}');
    if (u.pathname === '/api/auth/signin/keycloak') return new Response('{"url":"https://keycloak.cinesunidos.com/realms/cinesunidos/protocol/openid-connect/auth"}');
    if (u.pathname.endsWith('/openid-connect/auth')) return new Response('<form action="/realms/cinesunidos/login-actions/authenticate?state=S"><input type="password" name="password"></form>');
    if (u.pathname.endsWith('/login-actions/authenticate')) return authenticate();
    throw new Error('Unexpected fixture route');
  };
  // Keycloak re-rendering its form (on its own origin) is a refusal, as is a 401.
  assert.equal(await kind('cinesunidos', unidos(() => new Response('<form><input type="password"></form>'))), 'refused');
  assert.equal(await kind('cinesunidos', unidos(() => new Response('', { status: 401 }))), 'refused');
  assert.equal(await kind('cinesunidos', unidos(() => new Response('', { status: 502 }))), 'unclear');
  assert.equal(await kind('cinesunidos', async () => new Response('', { status: 503 })), 'unavailable');
  // A firewall challenge on the submission never reached the login: an outage, not a refusal.
  const challenge = () => new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
  assert.equal(await kind('cinex', cinex(challenge)), 'unavailable');
  assert.equal(await kind('cinesunidos', unidos(challenge)), 'unavailable');
  assert.equal(await kind('cinex', cinex(() => new Response('', { status: 403 }))), 'refused', 'a plain 403 is still a refusal');
  // A challenge after the cinema accepted the password is unclear, never an outage that would reveal it.
  const accepted: typeof fetch = async input => String(input).endsWith('validatelogin.php') ? new Response('{"result":"OK"}')
    : String(input).endsWith('checklogin.php') ? challenge() : new Response('<html>home</html>');
  assert.equal(await kind('cinex', accepted), 'unclear');
  assert.equal(await kind('cinesunidos', unidos(() => new Response(null, { status: 302, headers: { Location: 'https://www.cinesunidos.com/api/auth/callback/keycloak?code=C' } }))
    ), 'unclear', 'without a challenge: a callback that fails is unclear');
  const challengedCallback: typeof fetch = async (input, init) => new URL(String(input)).pathname === '/api/auth/callback/keycloak' ? challenge() : unidos(() =>
    new Response(null, { status: 302, headers: { Location: 'https://www.cinesunidos.com/api/auth/callback/keycloak?code=C' } }))(input, init);
  assert.equal(await kind('cinesunidos', challengedCallback), 'unclear', 'a challenge on the redirect after the submission');
  assert.equal(await store.read('cinex'), undefined); assert.equal(await store.read('cinesunidos'), undefined);
});
