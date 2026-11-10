import test from 'node:test';
import assert from 'node:assert/strict';
import { CinemaService } from '../../src/service.js';
import { HttpClient } from '../../src/http/client.js';
import { mockFetch, EmptySessionStore } from '../helpers/fixtures.js';

const service = () => new CinemaService(new HttpClient(mockFetch, 15000, new EmptySessionStore()));

test('Cinex HTML separators do not merge screen number and showtime', async () => {
  const result = await service().query('showtimes', { provider: 'cinex', movie_id: 'pelicula', date: '2026-09-11' });
  assert.equal(result.items[0].screen, '4'); assert.equal(result.items[0].time, '11:20');
});
