import test from 'node:test';
import assert from 'node:assert/strict';
import { DataError } from '../src/core.js';
import { SessionStore } from '../src/auth.js';
import type { AuthProviderId } from '../src/auth.js';
import { HttpClient } from '../src/http.js';
import { HostedHttpClient } from '../src/hosted-http.js';

const publicUrl = 'https://gateway.cinesunidos.com/search/cities';
const privateUrl = 'https://gateway.cinesunidos.com/tickets/www/theaters/1005/sessions/s1/';

test('hosted clients share public cache and in-flight reads, including source metadata', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const request: typeof fetch = async () => {
    calls++;
    await gate;
    return new Response('["Caracas"]');
  };
  const shared = new HttpClient(request, 1000);
  const one = new HostedHttpClient(request, 1000, new SessionStore(), shared);
  const two = new HostedHttpClient(request, 1000, new SessionStore(), shared);

  const pending = Promise.all([one.get(publicUrl), two.get(publicUrl)]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const [first, second] = await pending;
  assert.equal(first.body, second.body);
  assert.equal(first.source.fetched_at, second.source.fetched_at);
  assert.equal(first.source.cached, false);
  assert.equal(second.source.cached, false);

  const cached = await two.get(publicUrl);
  assert.equal(calls, 1);
  assert.equal(cached.source.cached, true);
  assert.equal(cached.source.fetched_at, first.source.fetched_at);
});

test('hosted public refresh is strict and cannot serve stale data after failure', async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return calls === 2 ? new Response('upstream failure', { status: 503 }) : new Response(String(calls));
  };
  const shared = new HttpClient(request, 1000);
  const one = new HostedHttpClient(request, 1000, new SessionStore(), shared);
  const two = new HostedHttpClient(request, 1000, new SessionStore(), shared);

  assert.equal((await one.get(publicUrl)).body, '1');
  assert.equal((await two.get(publicUrl)).source.cached, true);
  await assert.rejects(two.get(publicUrl, 120000, true));
  assert.equal(calls, 2);
  const afterFailure = await one.get(publicUrl);
  assert.equal(afterFailure.body, '3');
  assert.equal(afterFailure.source.cached, false);
});

test('hosted authenticated reads keep credentials and logout isolated per client', async () => {
  class Store extends SessionStore {
    constructor(private token: string) { super(); }
    override async headers() {
      if (!this.token) throw new DataError('auth_required', 'logged out');
      return { Authorization: `Bearer ${this.token}` };
    }
    override async remove(_provider: AuthProviderId) { this.token = ''; }
  }
  const authorization: string[] = [];
  const request: typeof fetch = async (_url, init) => {
    authorization.push(new Headers(init?.headers).get('Authorization') ?? '');
    return new Response('private');
  };
  const shared = new HttpClient(request, 1000);
  const aliceStore = new Store('alice-token');
  const bobStore = new Store('bob-token');
  const alice = new HostedHttpClient(request, 1000, aliceStore, shared);
  const bob = new HostedHttpClient(request, 1000, bobStore, shared);

  assert.equal((await alice.getAuthenticated('cinesunidos', privateUrl)).body, 'private');
  assert.equal((await bob.getAuthenticated('cinesunidos', privateUrl)).body, 'private');
  assert.deepEqual(authorization, ['Bearer alice-token', 'Bearer bob-token']);
  await aliceStore.remove('cinesunidos');
  await assert.rejects(alice.getAuthenticated('cinesunidos', privateUrl), e => e instanceof DataError && e.status === 'auth_required');
  assert.equal((await bob.getAuthenticated('cinesunidos', privateUrl)).body, 'private');
  assert.deepEqual(authorization, ['Bearer alice-token', 'Bearer bob-token', 'Bearer bob-token']);
});
