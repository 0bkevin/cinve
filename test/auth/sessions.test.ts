import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, chmod, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { SessionStore } from '../../src/auth/sessions.js';
import { HttpClient } from '../../src/http/client.js';
import { CinemaService } from '../../src/service.js';
import { DataError } from '../../src/core.js';
import { spawnSync } from 'node:child_process';
import { login } from '../../src/auth/login.js';

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

test('session FIFO fails promptly and logout cannot follow a symlinked directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-file-auth-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'sessions')); await mkdir(store.directory, { mode: 0o700 });
  const fifo = spawnSync('mkfifo', [join(store.directory, 'cinex.json')]); assert.equal(fifo.status, 0);
  await assert.rejects(store.read('cinex'), DataError);
  const outside = join(dir, 'outside'); await mkdir(outside); await writeFile(join(outside, 'cinex.json'), 'DO_NOT_DELETE');
  await symlink(outside, join(dir, 'link'));
  await assert.rejects(new SessionStore(join(dir, 'link')).remove('cinex'));
  assert.equal(await readFile(join(outside, 'cinex.json'), 'utf8'), 'DO_NOT_DELETE');
});

test('a session Cinex refuses is recorded as expired, but a newer login is kept', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-expire-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'sessions'));
  const jar = JSON.stringify({ version: 'tough-cookie@4.1.4', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, cookies: [{ key: 'PHPSESSID', value: 'x', domain: 'www.cinex.com.ve', path: '/', hostOnly: true, creation: new Date().toISOString(), lastAccessed: new Date().toISOString() }] });
  const save = (saved_at?: number) => store.save({ version: 1, provider: 'cinex', expires_at: Date.now() + 3600000, cookie_jar: jar, ...(saved_at ? { saved_at } : {}) });
  // Cinex answers "off": the next get_auth_status must not say configured.
  let calls = 0;
  const service = new CinemaService(new HttpClient(async url => { calls++; return new Response(String(url).endsWith('checklogin.php') ? 'off' : ''); }, 15000, store));
  await save(Date.now() - 1000);
  const seats = await service.seats({ provider: 'cinex', cinema_id: 'SBC', session_id: 's1' });
  assert.equal(seats.status, 'auth_required'); assert.equal(calls, 1);
  assert.equal((await store.status('cinex')).status, 'expired');
  // Sessions saved before saved_at existed are treated as old.
  await save(); await store.expire('cinex', Date.now());
  assert.equal((await store.status('cinex')).status, 'expired');
  // A login saved after the refused check started is newer than the refusal.
  const checkStarted = Date.now() - 5000;
  await save(Date.now()); await store.expire('cinex', checkStarted);
  assert.equal((await store.status('cinex')).status, 'configured');
});
