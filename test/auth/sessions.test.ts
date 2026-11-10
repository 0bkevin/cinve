import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { SessionStore } from '../../src/auth/sessions.js';
import { HttpClient } from '../../src/http/client.js';
import { CinemaService } from '../../src/service.js';
import { DataError } from '../../src/core.js';

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

test('authenticated 401 returns auth_required without leaking bearer or response body', async t => {
  const store = await fixture(t); await store.save(cuSession());
  const service = new CinemaService(new HttpClient(async () => new Response('PRIVATE_PROFILE', { status: 401 }), 1000, store));
  const result = await service.query('prices', { provider: 'cinesunidos', cinema_id: '1002', session_id: 's1' });
  assert.equal(result.status, 'auth_required'); assert.ok(!/SYNTHETIC_TOKEN|PRIVATE_PROFILE/.test(JSON.stringify(result)));
});
