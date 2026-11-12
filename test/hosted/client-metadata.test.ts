import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientMetadataCache, cacheDirectives, fetchClientMetadataDocument, isBlockedAddress, isClientIdUrl, validateClientMetadata } from '../../src/hosted/client-metadata.js';

const url = 'https://assistant.example/oauth/client.json';
const doc = { client_id: url, client_name: 'Assistant', redirect_uris: ['https://assistant.example/callback'], token_endpoint_auth_method: 'none' };

test('client_id URLs must be plain https URLs with a path', () => {
  // The raw identifier is kept for exact comparison, so forms the URL parser would normalize are accepted.
  for (const ok of [url, 'https://a.example/c', 'https://a.example/client?v=1', 'https://A.example/c', 'https://a.example:443/c']) assert.ok(isClientIdUrl(ok), ok);
  for (const bad of ['http://a.example/c', 'https://a.example', 'https://a.example/', 'https://a.example:8443/c', 'https://u:p@a.example/c',
    'https://a.example/c#x', 'https://a.example/c#', 'https://a.example/a/../c', 'https://a.example/a/%2E%2E/c', 'https://a.example/./c',
    'https://127.0.0.1/c', 'https://0x7f.1/c', 'https://[::1]/c', 'https://a.example/c d', 'cvapp_x'])
    assert.equal(isClientIdUrl(bad), false, bad);
});

test('metadata fetches refuse non-public addresses', () => {
  for (const blocked of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fec0::1', 'fd00::1', 'ff02::1', '100:0:0:1::1', '5f00::1', '3fff::1', '2001:db8::1', '2001::1', '2002:c0a8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::127.0.0.1', '::ffff:0:7f00:1', '0:0:0:0:ffff:0:7f00:1', '64:ff9b::1.1.1.1', 'not-an-ip'])
    assert.ok(isBlockedAddress(blocked), blocked);
  for (const ok of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:1.1.1.1', '::ffff:101:101'])
    assert.equal(isBlockedAddress(ok), false, ok);
});

test('a host that resolves to loopback is refused before any connection', async () => {
  await assert.rejects(fetchClientMetadataDocument('https://localhost/oauth/client.json'), /non-public address/);
});

test('a metadata document is valid only for its own URL and for public clients', () => {
  assert.deepEqual(validateClientMetadata(url, doc), { client_id: url, client_name: 'Assistant', redirect_uris: doc.redirect_uris });
  assert.equal(validateClientMetadata(url, { ...doc, client_name: undefined }).client_name, 'assistant.example');
  assert.ok(validateClientMetadata(url, { ...doc, token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] }));
  assert.ok(validateClientMetadata(url, { ...doc, jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }] } }), 'public keys are allowed');
  for (const bad of [{ ...doc, client_id: 'https://other.example/c.json' }, { ...doc, redirect_uris: [] }, { ...doc, redirect_uris: ['https://x.example/cb#f'] },
    { ...doc, client_secret: 's' }, { ...doc, token_endpoint_auth_method: 'private_key_jwt' }, { ...doc, grant_types: ['client_credentials'] }, 'not json',
    // A confidential method declared only through the plural property is still confidential.
    { ...doc, token_endpoint_auth_method: undefined, token_endpoint_auth_methods_supported: ['private_key_jwt'] },
    { ...doc, token_endpoint_auth_methods_supported: ['private_key_jwt'] },
    { ...doc, jwks: { keys: [{ kty: 'oct', k: 'private-secret' }] } },
    { ...doc, jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'private' }] } },
    { ...doc, jwks: { keys: [] }, jwks_uri: 'https://assistant.example/jwks.json' }])
    assert.throws(() => validateClientMetadata(url, bad), JSON.stringify(bad));
});

test('validated documents are cached within the max-age bounds', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let fetches = 0;
  const cache = new ClientMetadataCache(async () => { fetches++; return { document: doc, maxAgeSeconds: 1 }; });
  await cache.get(url); await cache.get(url); assert.equal(fetches, 1);
  t.mock.timers.tick(59_000); await cache.get(url); assert.equal(fetches, 1, 'max-age below one minute is raised to one minute');
  t.mock.timers.tick(2_000); await cache.get(url); assert.equal(fetches, 2);
  const failing = new ClientMetadataCache(async () => ({ document: { ...doc, client_id: 'https://evil.example/c' } }));
  await assert.rejects(failing.get(url)); await assert.rejects(failing.get(url), 'invalid documents are not cached');
});

test('documents that forbid reuse are fetched again on every lookup', async () => {
  let fetches = 0;
  const cache = new ClientMetadataCache(async () => { fetches++; return { document: doc, noStore: true }; });
  await cache.get(url); await cache.get(url);
  assert.equal(fetches, 2);
  assert.deepEqual(cacheDirectives('public, max-age=600'), { maxAgeSeconds: 600, noStore: false });
  for (const control of ['no-store', 'private, no-cache', 'max-age=0', 'No-Store, max-age=600'])
    assert.equal(cacheDirectives(control).noStore, true, control);
  assert.deepEqual(cacheDirectives(undefined), { noStore: false });
  assert.equal(cacheDirectives('no-cache="set-cookie"').noStore, false, 'a field-scoped no-cache does not forbid reuse of the body');
});
