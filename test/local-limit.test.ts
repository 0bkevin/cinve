import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalLimiter } from '../src/local-limit.js';

test('local limiter counts per key in fixed windows and peeking counts nothing', () => {
  let now = 0;
  const limiter = new LocalLimiter(3, 1000, 100, () => now);
  assert.equal(limiter.exhausted('a'), false);
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.hit('a')), [true, true, true, false]);
  assert.equal(limiter.exhausted('a'), true); assert.equal(limiter.exhausted('b'), false);
  assert.equal(limiter.hit('b'), true);
  now = 1000;
  assert.equal(limiter.exhausted('a'), false, 'the window resets');
  assert.equal(limiter.hit('a'), true);
});

test('local limiter memory stays bounded under a flood of distinct keys', () => {
  let now = 0;
  const limiter = new LocalLimiter(1, 1000, 50, () => now);
  for (let i = 0; i < 10000; i++) { limiter.hit(`k${i}`); if (i % 100 === 0) now += 10; }
  assert.ok(limiter.size <= 50, `size ${limiter.size}`);
  // Expired windows are dropped first, oldest first.
  now += 1000; limiter.hit('fresh');
  assert.equal(limiter.size, 1);
});
