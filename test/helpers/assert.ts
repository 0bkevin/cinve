import assert from 'node:assert/strict';

/** `list[index]`, failing the test with a clear message when the element is missing. */
export function nth<T>(list: ArrayLike<T>, index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `Expected an element at index ${index}; the list has ${list.length}.`);
  return value;
}

/** Capture group `index` of `pattern` in `text`, failing the test when the pattern does not match. */
export function capture(text: string, pattern: RegExp, index = 1): string {
  const match = text.match(pattern);
  assert.ok(match, `Expected ${pattern} to match.`);
  return nth(match, index);
}

/** The name=value part of a response's Set-Cookie header, failing the test when there is none. */
export function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'Expected a Set-Cookie header.');
  return nth(header.split(';'), 0);
}

/** `value`, failing the test when it is null or undefined. */
export function defined<T>(value: T | null | undefined, what = 'a value'): T {
  assert.ok(value !== undefined && value !== null, `Expected ${what}.`);
  return value;
}

/** The text of the first content block of a tool result, failing the test unless it is a text block. */
export function firstText<B extends { type: string }>(content: readonly B[]): string {
  const block = nth(content, 0);
  assert.ok(block.type === 'text' && 'text' in block && typeof block.text === 'string', `Expected a text block, got ${block.type}.`);
  return block.text;
}

/** `value` as an instance of `type`, failing the test when it is not one. */
export function instance<T>(value: unknown, type: new (...args: never[]) => T): T {
  assert.ok(value instanceof type, `Expected a ${type.name}.`);
  return value;
}
