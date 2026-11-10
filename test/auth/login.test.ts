import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/auth/sessions.js';
import { LoginHttp, login } from '../../src/auth/login.js';

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
