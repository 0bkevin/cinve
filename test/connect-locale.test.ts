import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { loginPage } from '../src/auth-web.js';

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
  const script = readFileSync(new URL('../src/assets/js/connect.js', import.meta.url), 'utf8').replace(/^export \{\};\s*$/m, '');
  new Function('document', 'location', 'history', 'fetch', script)(document, location, history, request);
  const switchTo = (locale: string) => document.querySelector(`[data-locale-switch="${locale}"]`)!.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  return { document, window, switchTo, get url() { return url; } };
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
  c.switchTo('en');
  assert.equal(c.url.searchParams.get('lang'), 'en');
  assert.equal(c.document.documentElement.lang, 'en');
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
  c.document.getElementById('login')!.dispatchEvent(new c.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(calls[1]!.url, '/connect/login?lang=en');
  assert.equal(calls[1]!.token, 'PRIVATE_BROWSER_TOKEN');
  assert.equal(c.document.getElementById('result-title')!.textContent, 'Account connected');
  c.switchTo('es');
  assert.equal(c.document.getElementById('result-title')!.textContent, 'Cuenta conectada');
  assert.equal(calls.length, 2);
});

test('an error returned in the earlier request language follows the current page language', async () => {
  let finishLogin!: (response: Response) => void;
  const login = new Promise<Response>(resolve => { finishLogin = resolve; });
  const c = client((async path => String(path).startsWith('/connect/exchange')
    ? Response.json({ browser_token: 'BROWSER_TOKEN', provider: 'cinex', app: null }) : login) as typeof fetch);
  await settle();
  c.document.getElementById('login')!.dispatchEvent(new c.window.Event('submit', { cancelable: true }));
  c.switchTo('en');
  finishLogin(Response.json({ error: 'Revisa correo y contraseña.', error_key: 'credentials' }, { status: 400 }));
  await settle();
  assert.equal(c.document.getElementById('feedback-text')!.textContent, 'Check your email and password.');
  c.switchTo('es');
  assert.equal(c.document.getElementById('feedback-text')!.textContent, 'Revisa correo y contraseña.');
});
