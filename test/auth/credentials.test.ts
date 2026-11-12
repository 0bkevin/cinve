import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCredentials } from '../../src/auth/credentials.js';
import { invalidEmails, invalidPasswords, validEmails, validPasswords } from '../helpers/credential-cases.js';

test('only plain email addresses pass, trimmed', () => {
  for (const email of validEmails) assert.deepEqual(checkCredentials(email, 'x'), { ok: true, username: email.trim(), password: 'x' }, email);
  for (const email of invalidEmails) assert.deepEqual(checkCredentials(email, 'x'), { ok: false, problem: 'email' }, JSON.stringify(email));
});

test('passwords keep every printable character but nothing that cannot be typed', () => {
  for (const password of validPasswords) assert.deepEqual(checkCredentials('person@example.test', password), { ok: true, username: 'person@example.test', password }, password);
  for (const password of invalidPasswords) assert.deepEqual(checkCredentials('person@example.test', password), { ok: false, problem: 'password' }, JSON.stringify(password));
});

test('values that are not strings are refused, the email first', () => {
  assert.deepEqual(checkCredentials(undefined, undefined), { ok: false, problem: 'email' });
  assert.deepEqual(checkCredentials(['person@example.test'], 'x'), { ok: false, problem: 'email' });
  assert.deepEqual(checkCredentials('person@example.test', { toString: () => 'x' }), { ok: false, problem: 'password' });
  assert.deepEqual(checkCredentials('nope', ''), { ok: false, problem: 'email' });
});
