import { CookieJar } from 'tough-cookie';
import { load } from 'cheerio';
import { AuthProvider, SessionStore } from './sessions.js';
import type { AuthProviderId } from './sessions.js';
import { isObj } from '../core.js';

/**
 * A sign-in that did not complete; its message is safe to show. A plain
 * LoginError is ambiguous: the cinema may have evaluated the credentials
 * (an error after they were sent), so it says nothing about them.
 */
export class LoginError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
/** The cinema evaluated the credentials and refused them (or demanded a step Cinve cannot complete). */
export class CredentialsRejected extends LoginError {}
/** The credentials never reached the cinema: it failed, or changed its login flow, before that step. */
export class CinemaUnavailable extends LoginError {}
/**
 * A firewall challenge (cf-mitigated: challenge) stopped a request at the
 * cinema's edge. firstHop: it was the first request of its read, so for the
 * credential submission the credentials provably never reached the login.
 */
class ChallengeError extends LoginError {
  constructor(readonly firstHop: boolean) { super('The cinema requires an anti-bot challenge and does not allow automated sign-in.', 403); }
}
// Answers to the credential submission that mean the cinema refused it. 429
// (the cinema throttling Cinve) and 5xx are outages, not verdicts.
const refusalStatuses = new Set([400, 401, 403, 422]);

/** Normal website login over HTTPS; redirects cannot forward the password to another origin. */
export class LoginHttp {
  readonly jar = new CookieJar();
  private deadline = Date.now() + 60000;
  constructor(private provider: AuthProviderId, private request: typeof fetch = fetch) {}
  private allowed(value: string) {
    const u = new URL(value);
    const hosts = this.provider === 'cinex' ? ['www.cinex.com.ve'] : this.provider === 'supercines' ? ['supercines.com.ve'] : ['www.cinesunidos.com', 'keycloak.cinesunidos.com'];
    if (u.protocol !== 'https:' || u.port || u.username || u.password || !hosts.includes(u.hostname)) throw new Error('Authentication destination is not allowed.');
    return u;
  }
  async read(value: string, init: RequestInit = {}): Promise<{ url: string; body: string }> {
    let url = this.allowed(value).href, method = init.method ?? 'GET', body = init.body;
    // Referenced, always-cleared timer: see HttpClient.read for why
    // AbortSignal.timeout() alone is not a reliable deadline.
    const controller = new AbortController(), signal = controller.signal;
    const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), Math.max(1, Math.min(25000, this.deadline - Date.now())));
    try {
      for (let step = 0; step < 12; step++) {
        signal.throwIfAborted();
        const headers = new Headers(init.headers);
        headers.delete('Cookie'); headers.delete('Authorization');
        headers.set('User-Agent', 'cinev-mcp/0.1');
        const cookie = await this.jar.getCookieString(url);
        if (cookie) headers.set('Cookie', cookie);
        const r = await this.request(url, { method, ...(body === undefined ? {} : { body }), headers, redirect: 'manual', signal });
        for (const c of r.headers.getSetCookie()) await this.jar.setCookie(c, url);
        if ([301, 302, 303, 307, 308].includes(r.status)) {
          const location = r.headers.get('location'); await r.body?.cancel();
          if (!location) throw new Error('Incomplete sign-in redirect.');
          const next = this.allowed(new URL(location, url).href);
          if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
          if (body && next.origin !== new URL(url).origin) throw new Error('Credentials are not forwarded across origins.');
          url = next.href; continue;
        }
        if (!r.ok) {
          await r.body?.cancel();
          if (r.status === 403 && r.headers.get('cf-mitigated')?.toLowerCase() === 'challenge') throw new ChallengeError(step === 0);
          throw new LoginError(`Sign-in returned HTTP ${r.status}.`, r.status);
        }
        const reader = r.body?.getReader(); if (!reader) throw new Error('Empty sign-in response.');
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Sign-in response is too large.'); }
          chunks.push(value);
        }
        return { url, body: Buffer.concat(chunks).toString('utf8') };
      }
      throw new Error('Too many sign-in redirects.');
    } finally { clearTimeout(timer); }
  }
}

/**
 * `value[key]` on parsed JSON, read the way plain property access reads it:
 * null and undefined throw a TypeError, and any other non-object has no such
 * field. Typed access to the provider's answer, with the failures unchanged.
 */
function member(value: unknown, key: string): unknown {
  if (value === null || value === undefined) throw new TypeError(`Cannot read ${key} of ${value}.`);
  return isObj(value) ? value[key] : undefined;
}

export async function login(provider: AuthProviderId, username: string, password: string, store = new SessionStore(), request: typeof fetch = fetch) {
  AuthProvider.parse(provider);
  const http = new LoginHttp(provider, request);
  // Whether the credentials have been submitted: errors before that cannot
  // reflect on them, and errors after it may.
  let sent = false;
  const submit = async (url: string, init: RequestInit) => {
    sent = true;
    try { return await http.read(url, init); } catch (e) {
      // A challenge on the submission itself stopped it before the login: an
      // outage. One on a later hop (a redirect after the cinema accepted the
      // password) is unclear, never an outage, which would reveal the password.
      if (e instanceof ChallengeError) throw e.firstHop ? new CinemaUnavailable(e.message) : new LoginError(e.message);
      if (e instanceof LoginError && e.status !== undefined && refusalStatuses.has(e.status)) throw new CredentialsRejected('The cinema rejected sign-in.');
      throw e;
    }
  };
  try {
    if (provider === 'cinex') {
      const base = 'https://www.cinex.com.ve';
      await http.read(`${base}/`);
      const form = new FormData(); form.set('username', username); form.set('password', password);
      const r = await submit(`${base}/assets/php/validatelogin.php`, { method: 'POST', body: form,
        headers: { Origin: base, Referer: `${base}/`, 'X-Requested-With': 'XMLHttpRequest' } });
      let data: unknown; try { data = JSON.parse(r.body); } catch { throw new LoginError('Cinex did not accept the sign-in request.'); }
      if (member(data, 'result') !== 'OK') throw new CredentialsRejected('Cinex did not accept sign-in. Check the credentials on its website.');
      if ((await http.read(`${base}/checklogin.php`)).body.trim() !== 'on') throw new LoginError('Cinex did not establish a valid session.');
      // An upper bound: Cinex's PHP session can end much sooner when idle (seen under an hour).
      await store.save({ version: 1, provider, expires_at: Date.now() + 24 * 3600000, saved_at: Date.now(), cookie_jar: JSON.stringify(await http.jar.serialize()) });
      return { provider, authenticated: true, profile_update_requested: member(data, 'usuario_dataupdate') !== 'S' };
    }
    if (provider === 'supercines') return await supercinesLogin(http, username, password, store, submit);
    const base = 'https://www.cinesunidos.com';
    const csrf = member(JSON.parse((await http.read(`${base}/api/auth/csrf`)).body), 'csrfToken');
    if (typeof csrf !== 'string' || !csrf) throw new LoginError('Cines Unidos did not return a sign-in CSRF token.');
    const form = new URLSearchParams({ csrfToken: csrf, callbackUrl: `${base}/?city=Caracas`, json: 'true' });
    const start = member(JSON.parse((await http.read(`${base}/api/auth/signin/keycloak`, { method: 'POST', body: form })).body), 'url');
    // String() is the conversion new URL() applies to a non-string anyway.
    const page = await http.read(String(start));
    const $ = load(page.body), loginForm = $('form').filter((_, el) => $(el).find('input[type=password]').length > 0).first();
    const action = loginForm.attr('action');
    if (!action) throw new LoginError('The provider requires an additional sign-in step that is not supported yet.');
    const target = new URL(action, page.url);
    if (target.origin !== 'https://keycloak.cinesunidos.com' || target.pathname !== '/realms/cinesunidos/login-actions/authenticate') throw new LoginError('Unrecognized sign-in form.');
    const fields = new URLSearchParams();
    loginForm.find('input[type=hidden][name]').each((_, el) => {
      const name = $(el).attr('name');
      if (name !== undefined) fields.set(name, $(el).attr('value') ?? '');
    });
    fields.set('username', username); fields.set('password', password); fields.set('login', 'Sign In');
    const callback = await submit(target.href, { method: 'POST', body: fields });
    if (new URL(callback.url).origin !== base) throw new CredentialsRejected('Incomplete sign-in: credentials were rejected or additional verification is required.');
    const token = member(JSON.parse((await http.read(`${base}/api/auth/session`)).body), 'access_token');
    if (typeof token !== 'string') throw new LoginError('Cines Unidos did not return an authenticated session.');
    // Only inspect expiry to bound local reuse; the upstream API validates the token itself.
    const payload = token.split('.')[1];
    if (payload === undefined) throw new TypeError('The access token has no payload.');
    const expiry = Number(member(JSON.parse(Buffer.from(payload, 'base64url').toString()), 'exp')) * 1000;
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new LoginError('The Cines Unidos token has expired.');
    await store.save({ version: 1, provider, expires_at: expiry, saved_at: Date.now(), access_token: token });
    return { provider, authenticated: true, profile_update_requested: false };
  } catch (e) {
    // Never surface provider HTML, personal data, request objects, or credential-bearing URLs.
    if (e instanceof CredentialsRejected || e instanceof CinemaUnavailable) throw e;
    const message = e instanceof LoginError ? e.message : 'Could not complete HTTP sign-in. Check the connection or sign in on the website to check for additional steps.';
    throw sent ? new LoginError(message) : new CinemaUnavailable(message);
  }
}

/**
 * Supercines (Laravel): the site's own login form. Email and password go
 * only to supercines.com.ve, with the form token of the page that showed it;
 * only the resulting cookies are stored. Accounts created with Google have no
 * password and cannot use this flow.
 */
async function supercinesLogin(http: LoginHttp, username: string, password: string, store: SessionStore,
  submit: (url: string, init: RequestInit) => Promise<{ url: string; body: string }>) {
  const base = 'https://supercines.com.ve';
  const page = await http.read(`${base}/cartelera`);
  const token = page.body.match(/<input type="hidden" name="_token" value="([A-Za-z0-9]{20,128})"/)?.[1]
    ?? page.body.match(/<meta\s+name="csrf-token"\s+content="([A-Za-z0-9]{20,128})"/)?.[1];
  if (!token) throw new LoginError('Supercines did not show its sign-in form.');
  // Submit the credentials through the classifier: a refusal is CredentialsRejected,
  // a challenge or transport failure on this hop is an outage, never a verdict.
  const reply = await submit(`${base}/do-login`, { method: 'POST',
    body: new URLSearchParams({ _token: token, email: username, password, urlActual: `${base}/cartelera` }),
    headers: { 'X-CSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json', Origin: base, Referer: `${base}/cartelera` } });
  let data: unknown; try { data = JSON.parse(reply.body); } catch { throw new LoginError('Supercines did not accept the sign-in request.'); }
  // A 200 with status:false is Laravel evaluating the credentials and refusing them.
  if (!isObj(data) || data.status !== true) throw new CredentialsRejected('Supercines did not accept sign-in. Check the email and password on its website (accounts created with Google do not have a password).');
  const cookies = await http.jar.getCookies(`${base}/`);
  const session = cookies.find(c => c.key === 'supercines_session');
  if (!session || !cookies.some(c => c.key === 'XSRF-TOKEN')) throw new LoginError('Supercines did not establish a valid session.');
  // The session cookie's own expiry (Laravel's session lifetime), at most a day.
  const cookieExpiry = session.expiryTime() ?? Infinity;
  const expires = Math.min(Number.isFinite(cookieExpiry) ? cookieExpiry : Date.now() + 2 * 3600000, Date.now() + 24 * 3600000);
  if (expires <= Date.now()) throw new LoginError('The Supercines session has expired.');
  await store.save({ version: 1, provider: 'supercines', expires_at: expires, saved_at: Date.now(), cookie_jar: JSON.stringify(await http.jar.serialize()) });
  return { provider: 'supercines' as const, authenticated: true, profile_update_requested: false };
}
