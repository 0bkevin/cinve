import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { load } from 'cheerio';
import * as z from 'zod';
import { DataError } from './core.js';

class LoginError extends Error {}

export const AuthProvider = z.enum(['cinex', 'cinesunidos']);
export type AuthProviderId = z.infer<typeof AuthProvider>;
export const Session = z.object({
  version: z.literal(1), provider: AuthProvider, expires_at: z.number().int().positive().max(8.64e15),
  cookie_jar: z.string().max(100000).optional(), access_token: z.string().min(1).max(16000).regex(/^[A-Za-z0-9._~+\/-]+=*$/).optional(),
}).strict().refine(s => s.provider === 'cinex' ? !!s.cookie_jar && !s.access_token : !!s.access_token && !s.cookie_jar);
export type AuthSession = z.infer<typeof Session>;
const loginHint = (p: AuthProviderId) => `Ejecuta npm run login -- ${p} en una terminal local. No envíes contraseñas al agente.`;

/** One OS user per MCP process. No passwords, profile data, or shared session cache. */
export class SessionStore {
  constructor(readonly directory = join(process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config'), 'cinev')) {}
  private path(p: AuthProviderId) { return join(this.directory, `${AuthProvider.parse(p)}.json`); }
  async read(p: AuthProviderId): Promise<AuthSession | undefined> {
    try {
      const dir = await lstat(this.directory);
      if (!dir.isDirectory() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) throw new Error();
      const handle = await open(this.path(p), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 128 * 1024 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error();
        const session = Session.parse(JSON.parse(await handle.readFile('utf8')));
        if (session.provider !== p) throw new Error();
        if (p === 'cinex') CookieJar.deserializeSync(session.cookie_jar!);
        return session;
      } finally { await handle.close(); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new DataError('auth_required', `La sesión local de ${p} no es válida o tiene permisos inseguros. ${loginHint(p)}`);
    }
  }
  async save(value: AuthSession) {
    const s = Session.parse(value);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Directorio de sesiones no válido.');
    await chmod(this.directory, 0o700);
    const path = this.path(s.provider), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(s)); } finally { await handle.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async remove(p: AuthProviderId) {
    try {
      const dir = await lstat(this.directory);
      if (!dir.isDirectory() || (process.getuid && dir.uid !== process.getuid())) throw new Error('Directorio de sesiones no válido.');
      await unlink(this.path(p));
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  async status(p: AuthProviderId) {
    try {
      const s = await this.read(p);
      return { provider: p, status: !s ? 'missing' : s.expires_at <= Date.now() ? 'expired' : 'configured',
        expires_at: s ? new Date(s.expires_at).toISOString() : null, login_command: `npm run login -- ${p}`, remote_validity_checked: false as const };
    } catch { return { provider: p, status: 'invalid', expires_at: null, login_command: `npm run login -- ${p}`, remote_validity_checked: false as const }; }
  }
  async headers(p: AuthProviderId, url: string): Promise<Record<string, string>> {
    assertPrivateRead(p, url);
    const s = await this.read(p);
    if (!s || s.expires_at <= Date.now()) throw new DataError('auth_required', loginHint(p));
    if (p === 'cinesunidos') return { Authorization: `Bearer ${s.access_token}`, xChannel: 'www' };
    try {
      const cookie = await CookieJar.deserializeSync(s.cookie_jar!).getCookieString(url);
      if (!cookie) throw new Error();
      return { Cookie: cookie, Referer: 'https://www.cinex.com.ve/', 'X-Requested-With': 'XMLHttpRequest' };
    } catch { throw new DataError('auth_required', loginHint(p)); }
  }
}

export function assertPrivateRead(p: AuthProviderId, value: string) {
  const u = new URL(value);
  const safe = u.protocol === 'https:' && !u.port && !u.username && !u.password && !u.hash;
  const expected = ['/boletos.php', '/boletosdev.php'].includes(u.pathname) ? ['cinemaid', 'sessionid'] : u.pathname === '/concesiones.php' ? ['cinemaid'] : [];
  const params = [...u.searchParams];
  const cinexParams = params.length === expected.length && expected.every(key => u.searchParams.getAll(key).length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(u.searchParams.get(key) ?? ''));
  const route = p === 'cinesunidos'
    ? (u.hostname === 'www.cinesunidos.com' && u.pathname === '/api/seats' && params.length === 2 && ['theaterId', 'showTimeId'].every(key => u.searchParams.getAll(key).length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(u.searchParams.get(key) ?? ''))) || (u.hostname === 'gateway.cinesunidos.com' && /^\/tickets\/www\/theaters\/[\w-]+\/sessions\/[\w-]+\/$/.test(u.pathname) && !u.search)
    : u.hostname === 'www.cinex.com.ve' && ['/checklogin.php', '/boletos.php', '/boletosdev.php', '/asientosdev.php', '/concesiones.php'].includes(u.pathname) && cinexParams;
  if (!safe || !route) throw new DataError('error', 'Ruta autenticada no permitida.');
}

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
    const signal = AbortSignal.timeout(Math.max(1, Math.min(25000, this.deadline - Date.now())));
    for (let step = 0; step < 12; step++) {
      signal.throwIfAborted();
      const headers = new Headers(init.headers);
      headers.delete('Cookie'); headers.delete('Authorization');
      headers.set('User-Agent', 'cinev-mcp/0.1');
      const cookie = await this.jar.getCookieString(url);
      if (cookie) headers.set('Cookie', cookie);
      const r = await this.request(url, { method, body, headers, redirect: 'manual', signal });
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
      await store.save({ version: 1, provider, expires_at: Date.now() + 24 * 3600000, cookie_jar: JSON.stringify(await http.jar.serialize()) });
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
    await store.save({ version: 1, provider, expires_at: expiry, access_token: data.access_token });
    return { provider, authenticated: true, profile_update_requested: false };
  } catch (e) {
    // Never surface provider HTML, personal data, request objects, or credential-bearing URLs.
    if (e instanceof LoginError) throw e;
    throw new LoginError('No se pudo completar el login HTTP. Revisa la conexión o inicia sesión en el sitio para comprobar pasos adicionales.');
  }
}
