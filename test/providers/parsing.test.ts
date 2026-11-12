import test from 'node:test';
import assert from 'node:assert/strict';
import { findField, flight } from '../../src/providers/parsing.js';
import { DataError } from '../../src/core.js';
import { page } from '../helpers/fixtures.js';

test('Flight parser handles split records and literal closing brackets in strings without eval', () => {
  const record = 'a:' + JSON.stringify({ movies: [{ name: 'Título ]) y "comillas"' }] }) + '\n';
  const html = [record.slice(0, 20), record.slice(20)].map(s => `<script>self.__next_f.push(${JSON.stringify([1, s])})</script>`).join('');
  assert.deepEqual(findField(flight(html), 'movies'), [{ name: 'Título ]) y "comillas"' }]);
  assert.throws(() => flight('<script>throw new Error("not executed")</script>'));
});

test('Flight scanner skips markers inside JSON strings and bounds deeply nested traversal', () => {
  const nested = 'self.__next_f.push(' + JSON.stringify([1, 'b:{"injected":true}\n']) + ')';
  assert.equal(findField(flight(page({ label: nested })), 'injected'), undefined);
  let value: unknown = { movies: [] }; for (let i = 0; i < 80; i++) value = [value];
  assert.throws(() => findField([value], 'movies'), (e: unknown) => e instanceof DataError && /structure limits/.test(e.message));
  assert.throws(() => flight('<script>' + 'self.__next_f.push(['.repeat(5000) + '</script>'), DataError);
});
