import { DataError } from './core.js';
import type { z } from 'zod';
import type { Source } from './core.js';
import { SessionStore, assertPrivateRead } from './auth.js';
import type { AuthProviderId } from './auth.js';

export type EvidenceSource = z.infer<typeof Source>;
type Page = { body: string; source: EvidenceSource };
type Waiting = { start: () => void; cancel: () => void };
const hosts = new Set(['www.cinex.com.ve', 'www.cinesunidos.com', 'gateway.cinesunidos.com', 'cinepiccandelaria.com', 'cinepicvip.com', 'apifront.cinexo.com.ar', 'api.cinexo.com.ar', 'www.trasnochocultural.com']);

function cinexTicketRedirect(url: string, response: Response): string | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return;
  const location = response.headers.get('location');
  if (!location) return;
  try {
    const from = new URL(url), to = new URL(location, url);
    if (from.origin !== 'https://www.cinex.com.ve' || from.pathname !== '/boletos.php' ||
        to.origin !== from.origin || to.pathname !== '/boletosdev.php') return;
    assertPrivateRead('cinex', to.href);
    if (['cinemaid', 'sessionid'].every(key => to.searchParams.get(key) === from.searchParams.get(key))) return to.href;
  } catch { /* Unrecognized redirects remain unavailable, without leaking their URL. */ }
}

/** Public reads are cached. Authenticated reads reload local sessions and bypass all caches. */
export class HttpClient {
  private cache = new Map<string, { page: Page; expires: number; bytes: number }>();
  private cacheBytes = 0;
  private pending = new Map<string, Promise<Page>>();
  private invalidated = new WeakSet<Promise<Page>>();
  private active = new Map<string, number>();
  private queues = new Map<string, Waiting[]>();
  constructor(private request: typeof fetch = fetch, private timeout = 15000, readonly sessions = new SessionStore()) {}
  async getAuthenticated(provider: AuthProviderId, url: string): Promise<Page> {
    assertPrivateRead(provider, url);
    return this.read(url, new URL(url).origin, target => this.sessions.headers(provider, target));
  }
  async get(url: string, ttl = 120000, refresh = false): Promise<Page> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname) || parsed.port || parsed.username || parsed.password || parsed.hash) throw new DataError('error', 'Origen de consulta no permitido.');
    // Fresh reads never consume a cached response or an older in-flight read.
    // Invalidate the old entry, but do not let overlapping requests overwrite
    // each other's cache with responses obtained in an indeterminate order.
    if (refresh) {
      this.evict(url);
      const older = this.pending.get(url);
      if (older) this.invalidated.add(older);
      try { return await this.read(url, parsed.origin, undefined, true); }
      finally { this.evict(url); }
    }
    const hit = this.cache.get(url);
    if (hit && hit.expires > Date.now()) return { ...hit.page, source: { ...hit.page.source, cached: true } };
    this.evict(url);
    const running = this.pending.get(url);
    if (running) return running;
    const task = this.read(url, parsed.origin).then(page => {
      const bytes = page.body.length * 2; // Conservative UTF-16 string accounting.
      if (ttl > 0 && !this.invalidated.has(task)) {
        while (this.cache.size && (this.cache.size >= 64 || this.cacheBytes + bytes > 16 * 1024 * 1024)) this.evict(this.cache.keys().next().value!);
        this.cache.set(url, { page, expires: Date.now() + ttl, bytes }); this.cacheBytes += bytes;
      }
      return page;
    }).finally(() => this.pending.delete(url));
    this.pending.set(url, task);
    return task;
  }
  private evict(url: string) { this.cacheBytes -= this.cache.get(url)?.bytes ?? 0; this.cache.delete(url); }
  private acquire(origin: string, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const q = this.queues.get(origin) ?? []; this.queues.set(origin, q);
      const waiting: Waiting = {
        start: () => {
          signal.removeEventListener('abort', waiting.cancel);
          this.active.set(origin, (this.active.get(origin) ?? 0) + 1);
          resolve(() => { this.active.set(origin, this.active.get(origin)! - 1); q.shift()?.start(); });
        },
        cancel: () => {
          const i = q.indexOf(waiting); if (i >= 0) q.splice(i, 1);
          reject(new DataError('error', 'Se agotó el tiempo de espera en la cola de consultas.'));
        },
      };
      if (signal.aborted) { waiting.cancel(); return; }
      if ((this.active.get(origin) ?? 0) < 2) { waiting.start(); return; }
      if (q.length >= 32) { reject(new DataError('rate_limited', 'La cola local de consultas está llena; inténtalo de nuevo más tarde.')); return; }
      q.push(waiting); signal.addEventListener('abort', waiting.cancel, { once: true });
    });
  }
  private async read(url: string, origin: string, authorize?: (target: string) => Promise<Record<string, string>>, refresh = false): Promise<Page> {
    const signal = AbortSignal.timeout(this.timeout);
    const release = await this.acquire(origin, signal);
    try {
      // Reload after queue admission: logout/account changes affect requests not yet sent.
      const requestPage = async (target: string) => {
        const auth = authorize ? await authorize(target) : {};
        signal.throwIfAborted();
        return this.request(target, {
          headers: { 'User-Agent': 'cinev-mcp/0.1', ...(refresh ? { 'Cache-Control': 'no-cache' } : {}), ...(origin.includes('gateway.cinesunidos.com') ? { xChannel: 'www' } : {}), ...auth },
          signal, redirect: 'manual',
        });
      };
      let response = await requestPage(url);
      // One observed migration of Cinex's ticket page, with identical cinema
      // and session IDs. Re-read credentials and retain the original deadline.
      const ticketRedirect = authorize && cinexTicketRedirect(url, response);
      if (ticketRedirect) {
        await response.body?.cancel();
        url = ticketRedirect;
        response = await requestPage(url);
      }
      signal.throwIfAborted();
      if (response.status >= 300 && response.status < 400) {
        const destination = response.headers.get('location'); await response.body?.cancel();
        const redirect = destination ? new URL(destination, url) : undefined;
        if (authorize && redirect?.origin === origin && /^\/(?:clearsession\.html|api\/auth\/signin|login)(?:\/|$)/.test(redirect.pathname)) throw new DataError('auth_required', 'El proveedor redirigió al login; conecta de nuevo tu cuenta en la terminal local.');
        throw new DataError('unavailable', 'El proveedor redirigió la consulta; no se siguió el destino.');
      }
      if (!response.ok) {
        const status = response.status === 401 ? 'auth_required' : response.status === 403 ? 'blocked' : response.status === 429 ? 'rate_limited' : response.status === 404 ? 'unavailable' : 'error';
        await response.body?.cancel();
        throw new DataError(status, `El proveedor respondió HTTP ${response.status} en ${url}.`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DataError('error', 'Respuesta HTTP sin cuerpo.');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new DataError('error', 'Respuesta del proveedor demasiado grande.'); }
        chunks.push(value);
      }
      return { body: Buffer.concat(chunks).toString('utf8'), source: { url, fetched_at: new Date().toISOString(), cached: false } };
    } catch (error) {
      if (error instanceof DataError) throw error;
      if (signal.aborted) throw new DataError('error', `Se agotó el plazo total de la consulta a ${url}.`);
      throw new DataError('error', `No se pudo leer ${url} (conexión, redirección o tiempo de espera).`);
    } finally {
      release();
    }
  }
}

export class ReadContext {
  sources: EvidenceSource[] = [];
  warnings: string[] = [];
  partial = false;
  constructor(private http: HttpClient, private refresh = false) {}
  async authenticated(provider: AuthProviderId, url: string): Promise<string> {
    const page = await this.http.getAuthenticated(provider, url);
    if (!this.sources.some(s => s.url === url)) this.sources.push(page.source);
    return page.body;
  }
  async get(url: string, ttl?: number): Promise<string> {
    const page = await this.http.get(url, ttl, this.refresh);
    if (!this.sources.some(s => s.url === url)) this.sources.push(page.source);
    return page.body;
  }
  async json(url: string): Promise<unknown> {
    try { return JSON.parse(await this.get(url)); }
    catch (e) { if (e instanceof DataError) throw e; throw new DataError('error', 'El proveedor no devolvió JSON válido.'); }
  }
}
