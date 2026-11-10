import { CookieJar } from 'tough-cookie';
import { load } from 'cheerio';
import { AuthProvider, SessionStore } from './sessions.js';
import type { AuthProviderId } from './sessions.js';

class LoginError extends Error {}

/** Normal website login over HTTPS; redirects cannot forward the password to another origin. */
export class LoginHttp {
  readonly jar = new CookieJar();
  private deadline = Date.now() + 60000;
  constructor(private provider: AuthProviderId, private request: typeof fetch = fetch) {}
  private allowed(value: string) {
    const u = new URL(value);
    const hosts = this.provider === 'cinex' ? ['www.cinex.com.ve'] : ['www.cinesunidos.com', 'keycloak.cinesunidos.com'];
    if (u.protocol !== 'https:' || u.port || u.username || u.password || !hosts.includes(u.hostname)) throw new Error('Destino de autenticación no permitido.');
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
          if (!location) throw new Error('Redirección de login incompleta.');
          const next = this.allowed(new URL(location, url).href);
          if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
          if (body && next.origin !== new URL(url).origin) throw new Error('No se reenvían credenciales entre orígenes.');
          url = next.href; continue;
        }
        if (!r.ok) { await r.body?.cancel(); throw new LoginError(`El login respondió HTTP ${r.status}.`); }
        const reader = r.body?.getReader(); if (!reader) throw new Error('Respuesta de login vacía.');
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Respuesta de login demasiado grande.'); }
          chunks.push(value);
        }
        return { url, body: Buffer.concat(chunks).toString('utf8') };
      }
      throw new Error('Demasiadas redirecciones de login.');
    } finally { clearTimeout(timer); }
  }
}

export async function login(provider: AuthProviderId, username: string, password: string, store = new SessionStore(), request: typeof fetch = fetch) {
  AuthProvider.parse(provider);
  const http = new LoginHttp(provider, request);
  try {
    if (provider === 'cinex') {
      const base = 'https://www.cinex.com.ve';
      await http.read(`${base}/`);
      const form = new FormData(); form.set('username', username); form.set('password', password);
      const r = await http.read(`${base}/assets/php/validatelogin.php`, { method: 'POST', body: form,
        headers: { Origin: base, Referer: `${base}/`, 'X-Requested-With': 'XMLHttpRequest' } });
      let data; try { data = JSON.parse(r.body); } catch { throw new LoginError('Cinex no aceptó la solicitud de login.'); }
      if (data.result !== 'OK') throw new LoginError('Cinex no aceptó el login. Revisa las credenciales en su sitio.');
      if ((await http.read(`${base}/checklogin.php`)).body.trim() !== 'on') throw new LoginError('Cinex no estableció una sesión válida.');
      // An upper bound: Cinex's PHP session can end much sooner when idle (seen under an hour).
      await store.save({ version: 1, provider, expires_at: Date.now() + 24 * 3600000, saved_at: Date.now(), cookie_jar: JSON.stringify(await http.jar.serialize()) });
      return { provider, authenticated: true, profile_update_requested: data.usuario_dataupdate !== 'S' };
    }
    const base = 'https://www.cinesunidos.com';
    const csrf = JSON.parse((await http.read(`${base}/api/auth/csrf`)).body).csrfToken;
    if (typeof csrf !== 'string' || !csrf) throw new LoginError('Cines Unidos no entregó CSRF de login.');
    const form = new URLSearchParams({ csrfToken: csrf, callbackUrl: `${base}/?city=Caracas`, json: 'true' });
    const start = JSON.parse((await http.read(`${base}/api/auth/signin/keycloak`, { method: 'POST', body: form })).body);
    const page = await http.read(start.url);
    const $ = load(page.body), loginForm = $('form').filter((_, el) => $(el).find('input[type=password]').length > 0).first();
    const action = loginForm.attr('action');
    if (!action) throw new LoginError('El proveedor requiere un paso de login adicional que aún no se admite.');
    const target = new URL(action, page.url);
    if (target.origin !== 'https://keycloak.cinesunidos.com' || target.pathname !== '/realms/cinesunidos/login-actions/authenticate') throw new LoginError('Formulario de login no reconocido.');
    const fields = new URLSearchParams();
    loginForm.find('input[type=hidden][name]').each((_, el) => { fields.set($(el).attr('name')!, $(el).attr('value') ?? ''); });
    fields.set('username', username); fields.set('password', password); fields.set('login', 'Sign In');
    const callback = await http.read(target.href, { method: 'POST', body: fields });
    if (new URL(callback.url).origin !== base) throw new LoginError('Login incompleto: credenciales rechazadas o verificación adicional requerida.');
    const data = JSON.parse((await http.read(`${base}/api/auth/session`)).body);
    if (typeof data.access_token !== 'string') throw new LoginError('Cines Unidos no entregó una sesión autenticada.');
    // Only inspect expiry to bound local reuse; the upstream API validates the token itself.
    const claims = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url').toString());
    const expiry = Number(claims.exp) * 1000;
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new LoginError('El token de Cines Unidos ya expiró.');
    await store.save({ version: 1, provider, expires_at: expiry, saved_at: Date.now(), access_token: data.access_token });
    return { provider, authenticated: true, profile_update_requested: false };
  } catch (e) {
    // Never surface provider HTML, personal data, request objects, or credential-bearing URLs.
    if (e instanceof LoginError) throw e;
    throw new LoginError('No se pudo completar el login HTTP. Revisa la conexión o inicia sesión en el sitio para comprobar pasos adicionales.');
  }
}
