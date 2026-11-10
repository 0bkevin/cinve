import test from 'node:test';
import assert from 'node:assert/strict';
import { DateInput, operationItemSchema, outputSchema, Id } from '../src/core.js';
import { nth } from './helpers/assert.js';

test('calendar validation rejects impossible dates and accepts leap day', () => {
  assert.equal(DateInput.safeParse('2026-02-30').success, false);
  assert.equal(DateInput.safeParse('2024-02-29').success, true);
});

const envelope = (items: unknown[]) => ({
  provider: 'cinepic', status: 'available', queried_at: '2026-09-11T12:00:00.000Z',
  timezone: 'America/Caracas', sources: [], items, warnings: [], total: items.length,
  next_offset: null, partial: false,
});

test('operation result schemas advertise their literal item kind and retain relevant fields', () => {
  const samples = {
    cities: { kind: 'city', id: 'Mérida', name: 'Mérida' },
    cinemas: { kind: 'cinema', id: '1005', name: 'Centro', city: 'Caracas', address: 'Av. 1', url: 'https://example.com/cine' },
    movies: { kind: 'movie', id: 'p1', name: 'Película', cinema_id: '123300', duration_minutes: 100, format: '2D', url: 'https://example.com/movie' },
    showtimes: { kind: 'showtime', id: 'f1', name: 'Película', cinema_id: '123300', movie_id: 'p1', date: '2026-09-11', time: '20:30', starts_at: '2026-09-11T20:30:00-04:00', screen: '4' },
    prices: { kind: 'ticket_price', id: 'adult:1', name: 'Adulto', cinema_id: '123300', session_id: 'f1', prices: [{ currency: 'VES', amount: 0, basis: 'provider' }], provider_conversion_rate: 0, final_total_verified: false },
    concessions: { kind: 'concession', id: '1', name: 'Combo', cinema_id: '1002', prices: [], stock: 0, options_required: true, final_total_verified: false },
  } as const;

  for (const op of ['cities', 'cinemas', 'movies', 'showtimes', 'prices', 'concessions'] as const) {
    const item = samples[op], parsed = operationItemSchema(op).parse(item);
    assert.equal(parsed.kind, item.kind);
    assert.equal(parsed.id, item.id);
    assert.equal(parsed.name, item.name);
  }
  const parsed = outputSchema('prices').parse(envelope([samples.prices]));
  assert.deepEqual(nth(parsed.items, 0).prices, samples.prices.prices);
  assert.equal(nth(parsed.items, 0).provider_conversion_rate, 0);
  assert.equal(nth(parsed.items, 0).final_total_verified, false);
});

test('operation schemas reject a mismatched kind and missing required IDs', () => {
  assert.equal(operationItemSchema('cities').safeParse({ kind: 'movie', id: 'p1', name: 'Película' }).success, false);
  assert.equal(operationItemSchema('showtimes').safeParse({ kind: 'showtime', id: 'f1', name: 'Película', movie_id: 'p1', date: '2026-09-11', time: '20:30' }).success, false);
  assert.equal(operationItemSchema('prices').safeParse({ kind: 'ticket_price', id: 'adult:1', name: 'Adulto', cinema_id: '123300', prices: [] }).success, false);
  assert.equal(outputSchema('cities').safeParse(envelope([{ kind: 'movie', id: 'p1', name: 'Película' }])).success, false);
});

test('operation schemas strip fields belonging to another operation and allow overnight showtimes without starts_at', () => {
  const movie = operationItemSchema('movies').parse({
    kind: 'movie', id: 'p1', name: 'Película', url: 'https://example.com/movie',
    prices: [{ currency: 'VES', amount: 10, basis: 'provider' }],
  });
  assert.equal('prices' in movie, false);
  const overnight = operationItemSchema('showtimes').parse({
    kind: 'showtime', id: 'f2', name: 'Película', cinema_id: '123300', movie_id: 'p1',
    date: '2026-09-11', time: '00:30',
  });
  assert.equal(overnight.starts_at, undefined);
});

test('IDs allow interior dots but never relative path segments', () => {
  for (const ok of ['a', 'TLN', 'seres.parte1lainvasion', 'x'.repeat(100)]) assert.ok(Id.safeParse(ok).success, ok);
  for (const bad of ['', '.', '..', '.a', 'a.', 'a..b', '../x', 'a/b', 'x'.repeat(101)]) assert.equal(Id.safeParse(bad).success, false, bad);
});
