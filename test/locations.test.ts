import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, knownPlaces, nearestCity, resolvePlace, venueLocation, venueLocations } from '../src/locations.js';
import { Id, outputSchema, Provider } from '../src/core.js';
import { CinemaService } from '../src/service.js';
import { HttpClient } from '../src/http/client.js';
import { inputSchema } from '../src/mcp/server.js';
import { page } from './helpers/fixtures.js';
import { defined } from './helpers/assert.js';

test('every venue location names a real provider and venue ID, an area, and a point in Venezuela', () => {
  for (const [key, where] of Object.entries(venueLocations)) {
    const [provider, id] = key.split(':');
    assert.ok(Provider.safeParse(provider).success, key);
    assert.ok(Id.safeParse(id).success, key);
    assert.ok(where.area.length > 0 && where.city.length > 0, key);
    assert.ok(where.lat > 0.5 && where.lat < 12.5 && where.lng > -73.5 && where.lng < -59.5, key);
    // A Caracas venue lies inside the valley and its southern municipalities, not in another state.
    if (where.city === 'Caracas') assert.ok(where.lat > 10.38 && where.lat < 10.53 && where.lng > -67.0 && where.lng < -66.75, key);
  }
  for (const [name, point] of Object.entries(knownPlaces)) assert.ok(point.lat > 0.5 && point.lat < 12.5 && point.lng > -73.5 && point.lng < -59.5, name);
});

test('a place is found by its name in any accent, case or common prefix, or as coordinates inside Venezuela', () => {
  for (const text of ['Chacao', 'chacao', 'CHACAO, Caracas', 'municipio Chacao', 'cerca de Chacao']) assert.equal(resolvePlace(text)?.name, 'Chacao', text);
  assert.equal(resolvePlace('Urbanización Las Mercedes')?.name, 'Las Mercedes');
  assert.equal(resolvePlace('el paraiso')?.name, 'El Paraíso');
  assert.equal(resolvePlace('Lecheria')?.name, 'Lechería');
  assert.deepEqual(resolvePlace(' 10.49 , -66.85 ')?.point, { lat: 10.49, lng: -66.85 });
  // Madrid, and a place Cinve does not know, resolve to nothing rather than a guess.
  assert.equal(resolvePlace('40.41,-3.70'), undefined);
  assert.equal(resolvePlace('Timbuktu'), undefined);
  assert.equal(resolvePlace('constructor'), undefined);
  assert.deepEqual(resolvePlace('10.49 -66.85')?.point, { lat: 10.49, lng: -66.85 });
  // Decimal commas are ambiguous with the separator: unknown, not misread.
  assert.equal(resolvePlace('10,49, -66,85'), undefined);
});

test('a place is found in the ways people write it, preferring the neighbourhood to its city', () => {
  const cases: Array<[string, string | undefined]> = [
    ['Caracas, Chacao', 'Chacao'], ['Chacao Caracas', 'Chacao'], ['Chacao, Caracas, Venezuela', 'Chacao'], ['estoy en Chacao', 'Chacao'],
    ['Sambil Chacao', 'Chacao'], ['Plaza Altamira', 'Altamira'], ['Altamira Chacao', 'Altamira'], ['Palos Grandes', 'Los Palos Grandes'],
    ['Hatillo', 'El Hatillo'], ['Las Mercedes Baruta', 'Las Mercedes'], ['Valencia, Naguanagua', 'Naguanagua'], ['Valencia, Carabobo', 'Valencia'],
    ['Isla de Margarita', 'Margarita'], ['Paraguaná', 'Paraguaná'], ['estoy en caracas', 'Caracas'], ['Petare, Sucre', 'Petare'],
    // A longer name that only starts with a known place is not that place.
    // A street or building named after a place is not in it, and a city named with a neighbourhood
    // it does not contain is the place ("La Candelaria" is in Caracas).
    ['Calle Chacao, El Recreo', 'El Recreo'], ['Edificio Altamira, Los Palos Grandes', 'Los Palos Grandes'], ['La Candelaria, Valencia', 'Valencia'],
    ['Las Delicias, Maracaibo', 'Maracaibo'], ['Las Delicias, Maracay', 'Las Delicias'], ['La Candelaria, Caracas', 'La Candelaria'], ['Cabudare, Barquisimeto', 'Cabudare'],
    ['San Francisco de Yare', undefined], ['San Diego de los Altos', undefined], ['Valle de la Pascua', undefined], ['Sucre', undefined],
  ];
  for (const [text, name] of cases) assert.equal(resolvePlace(text)?.name, name, text);
  // Every known place resolves to itself, so no two names collide once accents and articles are dropped.
  for (const name of Object.keys(knownPlaces)) assert.equal(resolvePlace(name)?.name, name);
});

test('distances are straight lines in km, and Cines Unidos gets the city nearest to the place', () => {
  const chacao = defined(resolvePlace('Chacao')).point;
  const sambil = defined(venueLocation('cinex', 'SBC'));
  assert.ok(distanceKm(chacao, sambil) < 1);
  // Caracas to Valencia is about 120 km in a straight line.
  const km = distanceKm(chacao, defined(resolvePlace('Valencia')).point);
  assert.ok(km > 100 && km < 140, String(km));
  assert.equal(nearestCity('cinesunidos', chacao), 'Caracas');
  assert.equal(nearestCity('cinesunidos', defined(resolvePlace('Naguanagua')).point), 'Valencia');
  assert.equal(nearestCity('cinesunidos', defined(resolvePlace('Lechería')).point), 'Puerto La Cruz');
  assert.equal(venueLocation('cinex', 'toString'), undefined);
  // A venue listed without a verified code keeps its location.
  assert.deepEqual(venueLocation('cinex', 'directory-lagomall'), venueLocation('cinex', 'LMM'));
  assert.deepEqual(venueLocation('cinepic', 'directory-cinepic-123301'), venueLocation('cinepic', '123301'));
  assert.ok(venueLocation('cinex', 'directory-lagomall'));
});

const cinesUnidos = () => {
  const requested: string[] = [];
  const s = new CinemaService(new HttpClient(async input => {
    requested.push(String(input));
    return new Response(page({ theaters: [
      { id: '1002', name: 'Metrocenter' }, { id: '1026', name: 'Millennium' }, { id: '1005', name: 'Sambil Caracas' }, { id: '9999', name: 'New Venue' },
    ] }));
  }));
  return { s, requested };
};

test('list_cinemas near a place sorts venues nearest first, with their area and distance', async () => {
  const { s, requested } = cinesUnidos();
  const result = await s.query('cinemas', { provider: 'cinesunidos', near: 'Chacao' });
  assert.equal(result.status, 'available');
  assert.ok(requested.every(url => new URL(url).searchParams.get('city') === 'Caracas'), requested.join(' '));
  assert.deepEqual(result.items.map(i => [i.name, i.area]), [['Sambil Caracas', 'Chacao'], ['Millennium', 'Los Dos Caminos, Sucre'], ['Metrocenter', 'El Silencio, Libertador'], ['New Venue', undefined]]);
  const [first, second, third, last] = result.items.map(i => i.distance_km);
  assert.ok(defined(first) < defined(second) && defined(second) < defined(third));
  assert.equal(last, undefined);
  assert.ok(result.warnings.some(w => /Caracas, the one nearest to Chacao/.test(w)));
  assert.ok(result.warnings.some(w => /straight line from Chacao/.test(w)));
  assert.ok(result.warnings.some(w => /1 venues have no known location/.test(w)));
  assert.deepEqual(outputSchema('cinemas').parse(result).items, result.items);
  // Without near, venues keep the provider's order and still carry their area.
  const plain = await s.query('cinemas', { provider: 'cinesunidos', city: 'Caracas' });
  assert.equal(plain.items.find(i => i.name === 'Millennium')?.area, 'Los Dos Caminos, Sucre');
  assert.ok(plain.items.every(i => i.distance_km === undefined));
});

test('an unknown place is said so instead of sorting by a guessed position', async () => {
  const { s, requested } = cinesUnidos();
  const missingCity = await s.query('cinemas', { provider: 'cinesunidos', near: 'Timbuktu' });
  assert.equal(missingCity.status, 'unavailable');
  assert.match(missingCity.warnings.join(' '), /does not know the place "Timbuktu"/);
  assert.equal(requested.length, 0);
  const withCity = await s.query('cinemas', { provider: 'cinesunidos', city: 'Caracas', near: 'Timbuktu' });
  assert.equal(withCity.status, 'available');
  assert.ok(withCity.items.every(i => i.distance_km === undefined));
  assert.match(withCity.warnings.join(' '), /not sorted by distance/);
});

test('list_cinemas accepts near instead of a Cines Unidos city; the other tools do not take near', () => {
  assert.ok(inputSchema('cinemas').safeParse({ provider: 'cinesunidos', near: 'Chacao' }).success);
  assert.equal(inputSchema('cinemas').safeParse({ provider: 'cinesunidos' }).success, false);
  assert.equal(inputSchema('showtimes').safeParse({ provider: 'cinex', city: 'Caracas', near: 'Chacao' }).success, false);
  assert.equal(inputSchema('cinemas').safeParse({ provider: 'cinex', near: 'x'.repeat(121) }).success, false);
});

test('a place far from every venue of a chain is said so, and distance notes come before the provider\'s warnings', async () => {
  const { s } = cinesUnidos();
  const result = await s.query('cinemas', { provider: 'cinesunidos', city: 'Caracas', near: 'Mérida' });
  assert.match(result.warnings.join(' '), /No cinesunidos venue is within 30 km of Mérida: the nearest is \d+(\.\d)? km away/);
  assert.match(defined(result.warnings[0]), /straight line from Mérida/);
  const near = await s.query('cinemas', { provider: 'cinesunidos', near: 'Chacao' });
  assert.ok(!near.warnings.some(w => /within 30 km/.test(w)));
  // An empty page carries no distance notes.
  const none = await s.query('cinemas', { provider: 'cinesunidos', near: 'Chacao', query: 'no such venue' });
  assert.equal(none.status, 'empty');
  assert.ok(!none.warnings.some(w => /distance_km/.test(w)), none.warnings.join(' '));
});
