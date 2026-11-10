import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EncryptedSessionStore, HostedUsers } from '../../src/hosted/store.js';
import { fixture } from '../helpers/hosted.js';

test('encrypted sessions reject tampering and ciphertext moved to a different user', async t => {
  const f = await fixture(t);
  const session = { version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: 'SYNTHETIC_TOKEN' };
  await f.storeFor(f.alice.id).save(session);
  const { rows } = await f.pool.query('SELECT ciphertext FROM cinev_sessions WHERE user_id=$1', [f.alice.id]);
  await f.pool.query('INSERT INTO cinev_sessions(user_id,provider,ciphertext,expires_at) VALUES($1,$2,$3,now())', [f.bob.id, 'cinesunidos', rows[0].ciphertext]);
  await assert.rejects(f.storeFor(f.bob.id).read('cinesunidos'));
  const tampered = JSON.parse(rows[0].ciphertext); tampered.tag = randomBytes(16).toString('base64');
  await f.pool.query('UPDATE cinev_sessions SET ciphertext=$1 WHERE user_id=$2', [JSON.stringify(tampered), f.alice.id]);
  await assert.rejects(f.storeFor(f.alice.id).read('cinesunidos'));
  assert.equal((await new HostedUsers(f.pool).authenticate(f.alice.token))?.id, f.alice.id);
  assert.equal(await f.users.authenticate(f.alice.token + 'bad'), undefined);
});

test('the hosted store expires a refused session under the account lock, keeping newer logins', async t => {
  const f = await fixture(t), store = new EncryptedSessionStore(f.pool, f.alice.id, f.key);
  const session = { version: 1 as const, provider: 'cinesunidos' as const, expires_at: Date.now() + 60000, access_token: 'SECRET_SESSION' };
  await store.save({ ...session, saved_at: Date.now() - 1000 });
  await store.expire('cinesunidos', Date.now());
  assert.equal((await store.status('cinesunidos')).status, 'expired');
  await store.save({ ...session, saved_at: Date.now() });
  await store.expire('cinesunidos', Date.now() - 5000);
  assert.equal((await store.status('cinesunidos')).status, 'configured');
});
