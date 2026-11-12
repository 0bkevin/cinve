/**
 * What a cinema sign-in may contain, checked before anything is sent to a
 * cinema: on the connect page, on the authorization page and in the terminal
 * login. src/client/connect.ts repeats these rules so the browser can explain
 * a mistake before submitting; test/auth/credentials.test.ts keeps both in step.
 *
 * The email is held to the plain shape cinema accounts use (letters, digits,
 * . _ + - before the @, a dotted domain after it), so markup, quotes, spaces or
 * script never pass as one. The password keeps every printable character, since
 * strong passwords use symbols; it is only ever sent as an encoded form field to
 * the cinema, never rendered, stored or logged. What cannot be typed in a
 * password field is refused: control characters, line breaks, invisible
 * formatting characters and broken Unicode.
 */
export const emailMaxLength = 254;
export const passwordMaxLength = 256;

const localPart = /^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*$/;
const domainLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const topLevel = /^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;
const untypable = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type CredentialProblem = 'email' | 'password';

export function emailProblem(raw: unknown): boolean {
  if (typeof raw !== 'string') return true;
  const email = raw.trim();
  if (!email || email.length > emailMaxLength) return true;
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (at < 1 || local.length > 64 || !localPart.test(local)) return true;
  const labels = domain.split('.');
  return labels.length < 2 || !labels.every(label => domainLabel.test(label)) || !topLevel.test(labels.at(-1)!);
}

export function passwordProblem(raw: unknown): boolean {
  return typeof raw !== 'string' || !raw || raw.length > passwordMaxLength || untypable.test(raw) || loneSurrogate.test(raw);
}

/** The checked sign-in (email trimmed, password as typed), or the first field to fix. */
export function checkCredentials(username: unknown, password: unknown):
  { ok: true; username: string; password: string } | { ok: false; problem: CredentialProblem } {
  if (emailProblem(username)) return { ok: false, problem: 'email' };
  if (passwordProblem(password)) return { ok: false, problem: 'password' };
  return { ok: true, username: (username as string).trim(), password: password as string };
}
