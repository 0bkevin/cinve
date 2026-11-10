import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationSql } from '../../src/hosted/migrations.js';
import { EncryptedSessionStore } from '../../src/hosted/store.js';
import { ConnectionLinks } from '../../src/hosted/connection-links.js';
import { fixture } from '../helpers/hosted.js';
import { defined } from '../helpers/assert.js';

test('database links expire and cancellation invalidates browser stages', async t => {
  const f = await fixture(t), hash = defined(await f.users.hash(f.alice.id));
  const first = await f.links.issue(f.alice.id, hash, 'cinex');
  await f.pool.query("UPDATE cinev_links SET expires_at=now()-interval '1 second'");
  assert.equal(await f.links.exchange(first.token), undefined);
  const next = await f.links.issue(f.alice.id, hash, 'cinex');
  const browser = defined(await f.links.exchange(next.token));
  await f.links.cancel(f.alice.id, 'cinex'); assert.equal(await f.links.get(browser.browserToken), undefined);
});

test('independent server instances consume a link only once and share saved sessions', async t => {
  const f = await fixture(t), other = new ConnectionLinks(f.pool);
  const hash = defined(await f.users.hash(f.alice.id));
  const invite = await f.links.issue(f.alice.id, hash, 'cinesunidos');
  const results = await Promise.all([f.links.exchange(invite.token), other.exchange(invite.token)]);
  assert.equal(results.filter(Boolean).length, 1);
  const token = defined(results.find(Boolean)).browserToken;
  const claims = await Promise.all([f.links.claim(token), other.claim(token)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const session = { version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: 'SECRET_SESSION' };
  assert.equal(await other.complete(token, session, f.key), true);
  assert.equal((await new EncryptedSessionStore(f.pool, f.alice.id, f.key).read('cinesunidos'))?.access_token, 'SECRET_SESSION');
  assert.equal(await f.links.complete(token, session, f.key), undefined);
  const dump = JSON.stringify((await f.pool.query('SELECT * FROM cinev_clients')).rows) + JSON.stringify((await f.pool.query('SELECT * FROM cinev_sessions')).rows);
  assert.ok(!dump.includes('SECRET_SESSION')); assert.ok(!dump.includes(f.alice.token));
});

test('revocation and newer invitations prevent another instance from saving a late login', async t => {
  const f = await fixture(t), other = new ConnectionLinks(f.pool);
  const hash = defined(await f.users.hash(f.alice.id));
  const session = { version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: 'SECRET_SESSION' };
  const invite = await f.links.issue(f.alice.id, hash, 'cinesunidos');
  const token = defined(await other.exchange(invite.token)).browserToken;
  await other.claim(token);
  await f.links.issue(f.alice.id, hash, 'cinesunidos');
  assert.equal(await other.complete(token, session, f.key), undefined);
  const newest = await f.links.issue(f.alice.id, hash, 'cinesunidos');
  const nextToken = defined(await other.exchange(newest.token)).browserToken;
  await other.claim(nextToken); await f.users.revoke(f.alice.id);
  assert.equal(await other.complete(nextToken, session, f.key), undefined);
  assert.equal(await f.storeFor(f.alice.id).read('cinesunidos'), undefined);
  await assert.rejects(other.issue(f.alice.id, hash, 'cinesunidos'));
});

test('database attempt limits and rate budgets survive new instances', async t => {
  const f = await fixture(t), other = new ConnectionLinks(f.pool), hash = defined(await f.users.hash(f.alice.id));
  const invite = await f.links.issue(f.alice.id, hash, 'cinex');
  const token = defined(await other.exchange(invite.token)).browserToken;
  for (let i = 0; i < 5; i++) { assert.ok(await other.claim(token)); await f.links.release(token); }
  assert.equal(await f.links.claim(token), undefined);
  const requests = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? f.links : other).budget('same-client', 4)));
  assert.equal(requests.filter(Boolean).length, 4);
  await f.pool.query("UPDATE cinev_budgets SET expires_at=now()-interval '1 second'");
  assert.equal(await other.budget('same-client', 4), true);
});

test('daily cleanup still completes on a deployment that precedes migration 003', async t => {
  const f = await fixture(t);
  await f.pool.query('ALTER TABLE cinev_oauth_apps DROP COLUMN last_used_at');
  await f.pool.query("INSERT INTO cinev_budgets(key_hash,expires_at,count) VALUES('stale',now()-interval '1 minute',1)");
  await f.links.cleanup();
  assert.equal((await f.pool.query("SELECT count(*) FROM cinev_budgets WHERE key_hash='stale'")).rows[0].count, '0');
  await f.pool.query(await migrationSql());
});
