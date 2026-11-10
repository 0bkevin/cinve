import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers/hosted.js';
import { defined } from '../helpers/assert.js';
import { fakeElements, runScript, settle } from '../helpers/browser.js';
import type { Obj } from '../../src/core.js';
import { object } from '../../src/providers/parsing.js';

// The script passes fetch a plain init object, with browser-only fields such as cache.
type Call = { path: string; credential: unknown; body: unknown; init: Obj };
/** Runs the served /app.js against the served /connect page, with scripted answers per path. */
async function connectPage(t: { after(fn: () => Promise<void>): void }, answers: Record<string, [number, unknown]>, hash = '#INVITE') {
  const f = await fixture(t);
  const html = await (await fetch(f.origin + '/connect')).text(), served = await fetch(f.origin + '/app.js');
  assert.equal(served.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const elements = fakeElements(html), calls: Call[] = [], replaced: unknown[][] = [];
  const request = async (input: string, init: Obj = {}) => {
    calls.push({ path: input, credential: object(init.headers)['X-Cinev-Connection'], body: JSON.parse(String(init.body)), init });
    const [status, body] = defined(answers[input], `an answer for ${input}`);
    return Response.json(body, { status });
  };
  runScript(await served.text(), elements, { location: { hash }, history: { replaceState: (...args: unknown[]) => { replaced.push(args); } }, fetch: request });
  await settle();
  const element = (id: string) => defined(elements.get(id), `#${id}`);
  return { calls, replaced, element };
}

test('the connect page exchanges its invitation, then sends the login with the browser token only', async t => {
  const page = await connectPage(t, {
    '/connect/exchange': [200, { browser_token: 'BROWSER', provider: 'cinesunidos', user_label: 'abcd1234' }],
    '/connect/login': [200, { connected: true, profile_update_requested: true }],
  });
  assert.deepEqual(page.replaced, [[null, '', '/connect']], 'the invitation leaves the address bar');
  const [exchange] = page.calls;
  assert.deepEqual([exchange?.path, exchange?.credential, exchange?.body], ['/connect/exchange', 'INVITE', {}]);
  assert.deepEqual([exchange?.init.method, exchange?.init.cache, exchange?.init.credentials], ['POST', 'no-store', 'omit']);
  assert.equal(page.element('accounts').textContent, 'Conectar Cines Unidos a tu acceso Cinve (abcd1234).');
  assert.equal(page.element('provider').value, 'cinesunidos');
  assert.equal(page.element('connect').disabled, false);

  await defined(page.element('show').onclick)();
  assert.equal(page.element('password').type, 'text');
  assert.deepEqual([page.element('show').textContent, page.element('show').attributes.get('aria-pressed')], ['Ocultar', 'true']);

  page.element('username').value = 'person@example.test'; page.element('password').value = 'SYNTHETIC_PASSWORD';
  let prevented = false;
  await defined(page.element('login').onsubmit)({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  const login = page.calls[1];
  assert.deepEqual([login?.path, login?.credential, login?.body], ['/connect/login', 'BROWSER', { username: 'person@example.test', password: 'SYNTHETIC_PASSWORD' }]);
  assert.equal(page.element('password').value, '', 'the password field is cleared as soon as it is sent');
  assert.equal(page.element('accounts').textContent, 'Cuenta conectada. Vuelve a tu asistente para consultar precios. Cinex solicita actualizar tu perfil en su sitio.');
  assert.deepEqual([page.element('login').hidden, page.element('done').hidden], [true, true]);
});

test('the connect page reports a refused login and lets the person retry or cancel', async t => {
  const page = await connectPage(t, {
    '/connect/exchange': [200, { browser_token: 'BROWSER', provider: 'cinex', user_label: 'abcd1234' }],
    '/connect/login': [400, { error: 'Revisa correo y contraseña.' }],
    '/connect/cancel': [200, { cancelled: true }],
  });
  assert.equal(page.element('accounts').textContent, 'Conectar Cinex a tu acceso Cinve (abcd1234).');
  await defined(page.element('login').onsubmit)({ preventDefault: () => {} });
  assert.deepEqual([page.element('feedback').textContent, page.element('feedback').className], ['Revisa correo y contraseña.', 'feedback error']);
  assert.deepEqual([page.element('connect').disabled, page.element('connect').textContent, page.element('done').disabled], [false, 'Conectar cuenta', false]);
  await defined(page.element('done').onclick)();
  assert.deepEqual(page.calls.map(c => [c.path, c.credential]), [['/connect/exchange', 'INVITE'], ['/connect/login', 'BROWSER'], ['/connect/cancel', 'BROWSER']]);
  assert.equal(page.element('accounts').textContent, 'Conexión cancelada. Puedes cerrar esta pestaña.');
  assert.ok(page.element('login').resets > 0 && page.element('login').hidden);
});

test('the connect page explains an expired invitation', async t => {
  const page = await connectPage(t, { '/connect/exchange': [410, { error: 'Conexión vencida o revocada.' }] });
  assert.equal(page.element('accounts').textContent, 'Enlace vencido o ya utilizado.');
  assert.deepEqual(page.element('accounts').children.map(c => c.textContent), ['Pide a tu asistente un enlace nuevo para conectar tu cuenta.']);
  assert.deepEqual([page.element('login').hidden, page.element('done').hidden, page.element('connect').disabled], [true, true, true]);
});
