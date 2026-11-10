import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPrivateRead } from '../../src/http/allow-list.js';
import { DataError } from '../../src/core.js';

test('Cinex authenticated routes reject extra, duplicate or malformed parameters', () => {
  for (const suffix of ['?cinemaid=TLN&cinemaid=REC', '?cinemaid=TLN&action=buy', '?cinemaid=..%2Fsecret']) {
    assert.throws(() => assertPrivateRead('cinex', 'https://www.cinex.com.ve/concesiones.php' + suffix), DataError);
  }
});
