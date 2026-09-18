import test from 'node:test';
import assert from 'node:assert/strict';
import { operationItemSchema, outputSchema } from '../src/core.js';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http.js';
import { EmptySessionStore, page } from './fixtures.js';

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

  for (const [op, item] of Object.entries(samples)) {
    const parsed = operationItemSchema(op as keyof typeof samples).parse(item);
    assert.equal(parsed.kind, item.kind);
    assert.equal(parsed.id, item.id);
    assert.equal(parsed.name, item.name);
  }
  const parsed = outputSchema('prices').parse(envelope([samples.prices]));
  assert.deepEqual(parsed.items[0].prices, samples.prices.prices);
  assert.equal(parsed.items[0].provider_conversion_rate, 0);
  assert.equal(parsed.items[0].final_total_verified, false);
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

test('service preserves a named cinema with malformed code as a nonqueryable directory entry', async () => {
  const http = new HttpClient(async () => new Response(page({ theaters: [{ id: '../secret', name: 'Cinema' }] })), 15000, new EmptySessionStore());
  const result = await new CinemaService(http).query('cinemas', { provider: 'cinesunidos', city: 'Caracas' });
  assert.equal(result.status, 'available');
  assert.equal(result.partial, true);
  assert.equal(result.items[0].code_status, 'unverified');
  assert.equal(result.items[0].cinema_id, undefined);
  assert.match(result.items[0].id, /^directory-/);
  assert.equal(result.total, 1);
  assert.match(result.warnings[0], /sede conservada/);
});
