import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import { HttpClient } from '../src/http.js';
import { SessionStore, LoginHttp, login, assertPrivateRead } from '../src/auth.js';
import { CinemaService } from '../src/service.js';
import { DataError } from '../src/core.js';
import { flight, findField } from '../src/parsers.js';
import { inputSchema } from '../src/server.js';
import { cpBuy, cuMovies, concessions, page } from './fixtures.js';

test('real PTY: multiline paste, separate entry and cancellation never echo credentials and restore terminal', t => {
  const r = spawnSync('python3', ['test/terminal-probe.py', process.execPath], { encoding: 'utf8', timeout: 30000 });
  if ((r.error as NodeJS.ErrnoException)?.code === 'ENOENT') { t.skip('Python 3 required for the POSIX PTY probe'); return; }
  assert.equal(r.status, 0, r.stderr);
  for (const result of JSON.parse(r.stdout)) {
    assert.equal(result.secret_visible, false, result.mode); assert.equal(result.email_visible, false, result.mode);
    assert.equal(result.echo_restored, true, result.mode);
    assert.equal(result.exit_code, ['paste', 'separate'].includes(result.mode) ? 0 : 1);
  }
});
test('malformed conversion cannot escape the structured result handler, even off the requested page', async () => {
  const data = structuredClone(cpBuy); data.configData.tasaConversion = '1e-320';
  const service = new CinemaService(new HttpClient(async () => new Response(page(data))));
  const r = await service.query('prices', { provider: 'cinepic', cinema_id: '123300', movie_id: 'p1', session_id: 'f1', offset: 100 });
  assert.equal(r.status, 'error'); assert.deepEqual(r.items, []); assert.equal(r.total, 0);
});
test('explicit Cinepic provider failure is distinct from an unrecognized page schema', async () => {
  const html = page({ shell: true }) + '<div>No pudimos mostrar la función. (Ref: AC-001)</div>';
  const service = new CinemaService(new HttpClient(async () => new Response(html)));
  const r = await service.query('prices', { provider: 'cinepic', cinema_id: '123300', movie_id: 'p1', session_id: 'f1' });
  assert.equal(r.status, 'unavailable'); assert.match(r.warnings[0], /AC-001/); assert.equal(r.sources.length, 1);
});
test('unsafe upstream links are omitted without losing useful product data', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'https://secret@example.test/image', 'file:///etc/passwd']) {
    const data = structuredClone(concessions).map(r => ({ ...r, itemImageUrl: url }));
    const service = new CinemaService(new HttpClient(async () => new Response(JSON.stringify(data))));
    const r = await service.query('concessions', { provider: 'cinesunidos', cinema_id: '1002' });
    assert.equal(r.status, 'available'); assert.ok(r.items.every(i => i.image_url === undefined));
    assert.equal(JSON.stringify(r).includes(url), false); assert.ok(r.warnings.some(w => w.includes('HTTPS')));
  }
});
test('invalid dates and unusable upstream IDs fail visibly instead of returning bad showtimes', async () => {
  for (const patch of [{ date: '2026-09-11T29:99:99' }, { id: '../../unsafe' }]) {
    const data = structuredClone(cuMovies); Object.assign(data.movies[0].theaters[0].showTimes[0], patch);
    const service = new CinemaService(new HttpClient(async () => new Response(page(data))));
    const r = await service.query('showtimes', { provider: 'cinesunidos', city: 'Caracas', date: '2026-09-11' });
    assert.equal(r.status, 'error'); assert.deepEqual(r.items, []);
  }
  assert.equal(inputSchema('prices').safeParse({ provider: 'cinex', cinema_id: 'TLN', session_id: 's1', movie_id: 'ignored' }).success, false);
});
test('untrusted cinema detail href cannot change the requested route', async () => {
  let calls = 0;
  const service = new CinemaService(new HttpClient(async () => { calls++; return new Response('<a href="cinex-x/../../assets/php/action.php" title="Sede, Caracas"><h3>Sede</h3></a>'); }));
  const r = await service.query('cinemas', { provider: 'cinex' });
  assert.equal(calls, 1); assert.equal(r.partial, true); assert.equal(r.items.length, 0);
});
test('Flight scanner skips markers inside JSON strings and bounds deeply nested traversal', () => {
  const nested = 'self.__next_f.push(' + JSON.stringify([1, 'b:{"injected":true}\n']) + ')';
  assert.equal(findField(flight(page({ label: nested })), 'injected'), undefined);
  let value: unknown = { movies: [] }; for (let i = 0; i < 80; i++) value = [value];
  assert.throws(() => findField([value], 'movies'), (e: unknown) => e instanceof DataError && /límites/.test(e.message));
  assert.throws(() => flight('<script>' + 'self.__next_f.push(['.repeat(5000) + '</script>'), DataError);
});
test('queues reject overload instead of growing without a limit', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let count = 0;
  const http = new HttpClient(async () => { count++; await gate; return new Response('[]'); });
  const pending = Array.from({ length: 40 }, (_, i) => http.get(`https://gateway.cinesunidos.com/load/${i}`).then(() => 'ok', e => e.status));
  await tick(); release(); const results = await Promise.all(pending);
  assert.equal(results.filter(r => r === 'rate_limited').length, 6); assert.equal(count, 34);
});
test('queue wait consumes the deadline and expired queued work never reaches fetch', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let count = 0;
  const http = new HttpClient(async () => { count++; await gate; return new Response('[]'); }, 25);
  const active = [http.get('https://gateway.cinesunidos.com/hold/1'), http.get('https://gateway.cinesunidos.com/hold/2')].map(p => p.catch(() => null));
  const queued = http.get('https://gateway.cinesunidos.com/hold/3');
  await Promise.all([assert.rejects(queued, /cola/), delay(50)]);
  release(); await Promise.all(active); assert.equal(count, 2);
});
test('cache eviction has a byte budget in addition to an entry count', async () => {
  let count = 0; const http = new HttpClient(async () => { count++; return new Response('x'.repeat(2 * 1024 * 1024)); });
  for (let i = 0; i < 5; i++) await http.get(`https://gateway.cinesunidos.com/big/${i}`);
  await http.get('https://gateway.cinesunidos.com/big/0'); assert.equal(count, 6);
});
test('queued authenticated work rechecks logout before sending credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cinev-queued-auth-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'sessions'));
  await store.save({ version: 1, provider: 'cinesunidos', expires_at: Date.now() + 60000, access_token: 'SYNTHETIC_TOKEN' });
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let count = 0;
  const http = new HttpClient(async () => { count++; await gate; return new Response('[]'); }, 1000, store);
  const active = [http.get('https://gateway.cinesunidos.com/hold/1'), http.get('https://gateway.cinesunidos.com/hold/2')];
  const queued = http.getAuthenticated('cinesunidos', 'https://gateway.cinesunidos.com/tickets/www/theaters/1002/sessions/s1/');
  const rejected = assert.rejects(queued, e => e instanceof DataError && e.status === 'auth_required');
  await tick(); await store.remove('cinesunidos'); release(); await Promise.all([...active, rejected]); assert.equal(count, 2);
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
test('Cinex authenticated routes reject extra, duplicate or malformed parameters', () => {
  for (const suffix of ['?cinemaid=TLN&cinemaid=REC', '?cinemaid=TLN&action=buy', '?cinemaid=..%2Fsecret']) {
    assert.throws(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/concesiones.php' + suffix), DataError);
  }
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
test('Cinex expiry redirect becomes auth_required and redirects are never followed', async () => {
  let calls = 0; class Store extends SessionStore { override async headers() { return { Cookie: 'PHPSESSID=SYNTHETIC' }; } }
  const http = new HttpClient(async () => { calls++; return new Response(null, { status: 302, headers: { Location: '/clearsession.html' } }); }, 1000, new Store());
  await assert.rejects(http.getAuthenticated('cinex', 'https://www.cinex.com.ve/concesiones.php?cinemaid=TLN'), e => e instanceof DataError && e.status === 'auth_required');
  assert.equal(calls, 1);
});
