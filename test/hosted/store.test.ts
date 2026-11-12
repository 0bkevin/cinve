import test from 'node:test';
import assert from 'node:assert/strict';
import { EncryptedSessionStore } from '../../src/hosted/store.js';
import { fixture } from '../helpers/hosted.js';

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
