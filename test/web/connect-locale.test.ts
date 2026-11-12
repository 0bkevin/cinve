/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { loginPage } from '../../src/auth-web.js';
import { installationPage } from '../../src/public-web.js';
import { invalidEmails, invalidPasswords, validEmails, validPasswords } from '../helpers/credential-cases.js';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function client(request: typeof fetch) {
  const { window, document } = parseHTML(loginPage('es'));
  let url = new URL('https://cinve.example/connect?lang=es#PRIVATE_INVITATION');
  const location = { get href() { return url.href; }, get hash() { return url.hash; }, get origin() { return url.origin; } };
  const history = { replaceState(_state: unknown, _title: string, path: string) { url = new URL(path, url); } };
  // These native form/focus methods have no layout effect in the DOM implementation.
  for (const node of document.querySelectorAll<HTMLElement>('*')) node.focus = () => {};
  const form = document.getElementById('login')!;
  Object.assign(form, { reset() { for (const field of form.querySelectorAll<HTMLInputElement>('input')) field.value = ''; } });
  const script = readFileSync(new URL('../../src/assets/js/connect.js', import.meta.url), 'utf8').replace(/^export \{\};\s*$/m, '');
  new Function('document', 'location', 'history', 'fetch', script)(document, location, history, request);
  const switchTo = (locale: string) => document.querySelector(`[data-locale-switch="${locale}"]`)!.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  const fill = (email: string, password: string) => {
    (document.getElementById('username') as HTMLInputElement).value = email;
    (document.getElementById('password') as HTMLInputElement).value = password;
  };
  const submit = (email = 'person@example.test', password = 'SYNTHETIC_PASSWORD') => {
    fill(email, password);
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  };
  return { document, window, switchTo, submit, get url() { return url; } };
}

test('switching languages during and after exchange keeps one private connection and translates the whole page', async () => {
  const calls: { url: string; token: string }[] = [];
  let finishExchange!: (response: Response) => void;
  const exchange = new Promise<Response>(resolve => { finishExchange = resolve; });
  const c = client((async (path, init) => {
    calls.push({ url: String(path), token: (init!.headers as Record<string, string>)['X-Cinev-Connection']! });
    if (String(path).startsWith('/connect/exchange')) return exchange;
    return Response.json({ connected: true });
  }) as typeof fetch);
  const menu = c.document.querySelector<HTMLDetailsElement>('.language-menu')!;
  menu.open = true;
  c.switchTo('en');
  assert.equal(c.url.searchParams.get('lang'), 'en');
  assert.equal(c.document.documentElement.lang, 'en');
  assert.equal(menu.open, false, 'in-place language selection closes the disclosure');
  assert.equal(c.document.querySelector('[data-current-locale-label]')!.textContent, 'English');
  assert.equal(c.document.querySelector('[data-current-locale-label]')!.getAttribute('lang'), 'en');
  assert.equal(c.document.querySelector('[data-locale-switch="en"]')!.getAttribute('aria-current'), 'page');
  assert.equal(c.document.querySelector('[data-locale-check="en"]')!.textContent, '✓');
  assert.equal(c.document.querySelector('[data-locale-check="es"]')!.textContent, '');
  assert.match(c.document.querySelector('.site-nav')!.textContent!, /What to ask/);
  assert.match(c.document.querySelector('.site-footer')!.textContent!, /Code on GitHub/);
  assert.match(c.document.querySelector('h1')!.textContent!, /Connect your cinema account/);
  assert.equal(c.document.getElementById('connect')!.hasAttribute('disabled'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.token, 'PRIVATE_INVITATION');
  finishExchange(Response.json({ browser_token: 'PRIVATE_BROWSER_TOKEN', provider: 'cinex', app: null }));
  await settle();
  assert.equal(c.url.hash, '');
  assert.equal(c.document.getElementById('login-title')!.textContent, 'Your Cinex account');
  c.switchTo('es'); c.switchTo('en');
  assert.equal(calls.length, 1, 'locale switches must not reuse the single-use invitation');
  assert.equal(c.url.href.includes('PRIVATE'), false);
  c.submit();
  await settle();
  assert.equal(calls[1]!.url, '/connect/login?lang=en');
  assert.equal(calls[1]!.token, 'PRIVATE_BROWSER_TOKEN');
  assert.equal(c.document.getElementById('result-title')!.textContent, 'Account connected');
  c.switchTo('es');
  assert.equal(c.document.getElementById('result-title')!.textContent, 'Cuenta conectada');
  assert.equal(c.document.querySelector('[data-current-locale-label]')!.textContent, 'Español');
  assert.equal(c.document.querySelector('[data-locale-switch="es"]')!.getAttribute('aria-current'), 'page');
  assert.equal(c.document.querySelector('[data-locale-check="es"]')!.textContent, '✓');
  assert.equal(c.document.querySelector('[data-locale-check="en"]')!.textContent, '');
  assert.equal(calls.length, 2);
});

test('an error returned in the earlier request language follows the current page language', async () => {
  let finishLogin!: (response: Response) => void;
  const login = new Promise<Response>(resolve => { finishLogin = resolve; });
  const c = client((async path => String(path).startsWith('/connect/exchange')
    ? Response.json({ browser_token: 'BROWSER_TOKEN', provider: 'cinex', app: null }) : login) as typeof fetch);
  await settle();
  c.submit();
  c.switchTo('en');
  finishLogin(Response.json({ error: 'Revisa correo y contraseña.', error_key: 'credentials' }, { status: 400 }));
  await settle();
  assert.equal(c.document.getElementById('feedback-text')!.textContent, 'Check your email and password.');
  c.switchTo('es');
  assert.equal(c.document.getElementById('feedback-text')!.textContent, 'Revisa correo y contraseña.');
});

test('network failures use the current language instead of the browser error text', async () => {
  const c = client((async path => {
    if (String(path).startsWith('/connect/exchange')) return Response.json({ browser_token: 'BROWSER_TOKEN', provider: 'cinex', app: null });
    throw new TypeError('Failed to fetch');
  }) as typeof fetch);
  await settle();
  c.submit();
  await settle();
  assert.equal(c.document.getElementById('feedback-text')!.textContent, 'No se pudo completar la solicitud.');
  c.switchTo('en');
  assert.equal(c.document.getElementById('feedback-text')!.textContent, 'Could not complete the request.');
});

test('public language links preserve the current section, including after navigation', () => {
  const { document } = parseHTML(installationPage('https://cinve.example', 'en'));
  const location = new URL('https://cinve.example/install?lang=en#mano');
  const hashListeners: (() => void)[] = [];
  const script = readFileSync(new URL('../../src/assets/js/site.js', import.meta.url), 'utf8').replace(/^export \{\};\s*$/m, '');
  new Function('document', 'location', 'matchMedia', 'addEventListener', 'HTMLDetailsElement', script)(document, location,
    () => ({ matches: true }), (event: string, callback: () => void) => { if (event === 'hashchange') hashListeners.push(callback); }, class {});
  const links = () => [...document.querySelectorAll<HTMLAnchorElement>('[data-locale-switch]')].map(link => new URL(link.getAttribute('href')!, location));
  assert.deepEqual(links().map(url => url.hash), ['#mano', '#mano']);
  assert.deepEqual(links().map(url => url.searchParams.get('lang')), ['es', 'en']);
  location.hash = '#contenido';
  for (const listener of hashListeners) listener();
  assert.deepEqual(links().map(url => url.hash), ['#contenido', '#contenido']);
});

test('the eye button inside the password field reveals it and keeps an accessible label in each language', async () => {
  const c = client((async () => Response.json({ browser_token: 'BROWSER_TOKEN', provider: 'cinex', app: null })) as typeof fetch);
  await settle();
  const show = c.document.getElementById('show')!;
  const password = c.document.getElementById('password') as HTMLInputElement;
  assert.ok(show.closest('.password-field')?.contains(password), 'the toggle sits inside the password field');
  assert.equal(show.textContent, '', 'the toggle is an icon, labelled for assistive technology');
  assert.equal(show.getAttribute('aria-label'), 'Mostrar contraseña');
  show.dispatchEvent(new c.window.Event('click'));
  assert.equal(password.type, 'text');
  assert.equal(show.getAttribute('aria-pressed'), 'true');
  assert.equal(show.getAttribute('aria-label'), 'Ocultar contraseña');
  c.switchTo('en');
  assert.equal(show.getAttribute('aria-label'), 'Hide password');
  assert.equal(show.textContent, '');
});

test('the page refuses what the server refuses, before anything is sent', async () => {
  const sent: string[] = [];
  const c = client((async (path, init) => {
    if (String(path).startsWith('/connect/exchange')) return Response.json({ browser_token: 'BROWSER_TOKEN', provider: 'cinex', app: null });
    sent.push(String(init!.body));
    return Response.json({ error: 'Revisa correo y contraseña.', error_key: 'credentials' }, { status: 400 });
  }) as typeof fetch);
  await settle();
  for (const email of invalidEmails) { c.submit(email); await settle(); }
  for (const password of invalidPasswords) { c.submit('person@example.test', password); await settle(); }
  assert.equal(sent.length, 0);
  for (const email of validEmails) { c.submit(email); await settle(); }
  for (const password of validPasswords) { c.submit('person@example.test', password); await settle(); }
  assert.equal(sent.length, validEmails.length + validPasswords.length);
  assert.equal(JSON.parse(sent[3]!).username, 'padded@example.com', 'the email is sent trimmed');
});

test('a field that breaks a rule says what to fix, in the page language, until it is fixed', async () => {
  const c = client((async () => Response.json({ browser_token: 'BROWSER_TOKEN', provider: 'cinex', app: null })) as typeof fetch);
  await settle();
  const username = c.document.getElementById('username') as HTMLInputElement;
  const emailError = c.document.getElementById('username-error')!;
  const passwordError = c.document.getElementById('password-error')!;
  c.submit('<script>alert(1)</script>', '');
  assert.equal(username.getAttribute('aria-invalid'), 'true');
  assert.equal(emailError.hidden, false);
  assert.equal(emailError.textContent, 'Escribe un correo válido, como nombre@ejemplo.com.');
  assert.equal(passwordError.hidden, false);
  assert.equal(c.document.getElementById('feedback')!.hidden, true, 'field mistakes stay next to their field');
  c.switchTo('en');
  assert.equal(emailError.textContent, 'Enter a valid email, like name@example.com.');
  username.value = 'person@example.test';
  username.dispatchEvent(new c.window.Event('input'));
  assert.equal(username.hasAttribute('aria-invalid'), false);
  assert.equal(emailError.hidden, true);
});

test('a field the server refuses is marked like one the page refused', async () => {
  const c = client((async path => String(path).startsWith('/connect/exchange')
    ? Response.json({ browser_token: 'BROWSER_TOKEN', provider: 'cinex', app: null })
    : Response.json({ error: 'Escribe un correo válido, como nombre@ejemplo.com.', error_key: 'email' }, { status: 400 })) as typeof fetch);
  await settle();
  c.submit();
  await settle();
  assert.equal(c.document.getElementById('username')!.getAttribute('aria-invalid'), 'true');
  assert.equal(c.document.getElementById('username-error')!.textContent, 'Escribe un correo válido, como nombre@ejemplo.com.');
  assert.equal(c.document.getElementById('feedback')!.hidden, true);
});
