import test from 'node:test';
import assert from 'node:assert/strict';
import { findField, flight } from '../../src/providers/parsing.js';

test('Flight parser handles split records and literal closing brackets in strings without eval', () => {
  const record = 'a:' + JSON.stringify({ movies: [{ name: 'Título ]) y "comillas"' }] }) + '\n';
  const html = [record.slice(0, 20), record.slice(20)].map(s => `<script>self.__next_f.push(${JSON.stringify([1, s])})</script>`).join('');
  assert.deepEqual(findField(flight(html), 'movies'), [{ name: 'Título ]) y "comillas"' }]);
  assert.throws(() => flight('<script>throw new Error("not executed")</script>'));
});
