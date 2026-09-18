import { DataError } from './core.js';
import type { z } from 'zod';
import type { Source } from './core.js';
import { SessionStore, assertPrivateRead } from './auth.js';
import type { AuthProviderId } from './auth.js';

export type EvidenceSource = z.infer<typeof Source>;
type Page = { body: string; source: EvidenceSource };
type CacheEntry = { page: Page; expires: number; bytes: number; startedAt: number; keys: Set<string> };
type Waiting = { start: () => boolean; cancel: () => void };
type RefreshState = { keys: Set<string> };
const hosts = new Set(['www.cinex.com.ve', 'www.cinesunidos.com', 'gateway.cinesunidos.com', 'cinepiccandelaria.com', 'cinepicvip.com', 'apifront.cinexo.com.ar', 'api.cinexo.com.ar', 'www.trasnochocultural.com']);

function cancelBody(body: ReadableStream<Uint8Array> | null | undefined) {
  if (!body) return;
  try { void body.cancel().catch(() => {}); } catch { /* Best-effort cleanup must not mask the response error. */ }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try { void reader.cancel().catch(() => {}); } catch { /* Best-effort cleanup must not mask the response error. */ }
}

function withSignal<T>(operation: PromiseLike<T>, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true; cleanup(); reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(value => {
      if (settled) { try { onLate?.(value); } catch {} return; }
      settled = true; cleanup(); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    });
    if (signal.aborted) abort();
  });
}

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

function cinexCinemaRedirect(url: string, response: Response): string | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return;
  const location = response.headers.get('location');
  if (!location) return;
  try {
    const from = new URL(url), to = new URL(location, url);
    // Cinex has renamed cinema detail pages (for example, sambil.html to
    // sambilchacao.html). Follow only a single same-origin cinema-page hop;
    // generic public redirects remain unavailable by design.
    if (from.origin !== 'https://www.cinex.com.ve' || to.origin !== from.origin ||
        !/^\/cinex-[A-Za-z0-9_-]{1,80}\.html$/.test(from.pathname) ||
        !/^\/cinex-[A-Za-z0-9_-]{1,80}\.html$/.test(to.pathname) ||
        to.username || to.password || to.search || to.hash) return;
    return to.href;
  } catch { /* Unrecognized redirects remain unavailable, without leaking their URL. */ }
}

/** Public reads are cached. Authenticated reads reload local sessions and bypass all caches. */
export class HttpClient {
  // A single cache entry can be addressed by both the requested cinema URL
  // and its validated one-hop canonical URL. The body is counted once toward
  // the byte budget even though both keys point at the same entry.
  private cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private pending = new Map<string, Promise<Page>>();
  private pendingKeys = new Map<Promise<Page>, Set<string>>();
  private pendingStartedAt = new Map<Promise<Page>, number>();
  private invalidated = new WeakSet<Promise<Page>>();
  private invalidatedAt = new Map<string, number>();
  private refreshing = new Map<string, number>();
  private clock = 0;
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
      const initialTargets = this.invalidate(url), refreshState: RefreshState = { keys: new Set(initialTargets) };
      if (!refreshState.keys.size) refreshState.keys.add(url);
      for (const target of refreshState.keys) this.addRefreshKey(target);
      const refreshTargets = new Set(refreshState.keys);
      try {
        return await this.read(url, parsed.origin, undefined, true, (_alias, canonical) => {
          // The alias may not have been observed before this refresh. Invalidate
          // the target as soon as the official redirect proves the relation,
          // including any older canonical read that is still in flight.
          refreshTargets.add(canonical);
          if (!refreshState.keys.has(canonical)) { refreshState.keys.add(canonical); this.addRefreshKey(canonical); }
          this.invalidate(canonical);
        });
      } finally {
        // Keep the completion generation visible to reads that started while
        // the refresh was active but have not discovered an alias yet. An
        // eviction alone loses that marker, allowing a late alias response to
        // repopulate the canonical entry after refresh completion.
        for (const target of refreshTargets) this.invalidate(target);
        for (const target of refreshState.keys) this.removeRefreshKey(target);
      }
    }
    const hit = this.cache.get(url);
    if (hit && hit.expires > Date.now()) return { ...hit.page, source: { ...hit.page.source, cached: true } };
    if (hit) this.evictEntry(hit);
    const running = this.pending.get(url);
    if (running) return running;
    const startedAt = ++this.clock;
    const startedDuringRefresh = this.refreshing.has(url);
    let task!: Promise<Page>;
    task = this.read(url, parsed.origin, undefined, false, (alias, canonical) => this.bindPendingAlias(alias, canonical, task)).then(page => {
      this.store(url, page, ttl, startedAt, task, startedDuringRefresh);
      return page;
    }).finally(() => this.clearPending(task));
    this.pendingStartedAt.set(task, startedAt);
    this.bindPending(url, task);
    return task;
  }
  private bindPending(url: string, task: Promise<Page>) {
    this.pending.set(url, task);
    const keys = this.pendingKeys.get(task) ?? new Set<string>(); keys.add(url); this.pendingKeys.set(task, keys);
  }
  private bindPendingAlias(alias: string, canonical: string, task: Promise<Page>) {
    // If the canonical URL already has an independent read, do not replace
    // it. The completion ordering guard below keeps either result from
    // allowing an older read to overwrite a newer one.
    const running = this.pending.get(canonical);
    if (!running || running === task) this.bindPending(canonical, task);
    else this.bindPending(alias, task);
  }
  private clearPending(task: Promise<Page>) {
    for (const key of this.pendingKeys.get(task) ?? []) if (this.pending.get(key) === task) this.pending.delete(key);
    this.pendingKeys.delete(task);
    this.pendingStartedAt.delete(task);
    this.pruneInvalidations();
  }
  private invalidate(url: string): Set<string> {
    const entry = this.cache.get(url), keys = new Set(entry?.keys ?? [url]);
    for (const key of keys) this.invalidatedAt.set(key, ++this.clock);
    for (const key of keys) { const task = this.pending.get(key); if (task) this.invalidated.add(task); }
    const task = this.pending.get(url); if (task) this.invalidated.add(task);
    if (entry) this.evictEntry(entry);
    this.pruneInvalidations();
    return keys;
  }
  private pruneInvalidations() {
    const starts = [...this.pendingStartedAt.values()];
    if (!starts.length) { this.invalidatedAt.clear(); return; }
    if (this.invalidatedAt.size <= 128) return;
    const pending = [...this.pendingStartedAt.entries()];
    const generations = [...this.invalidatedAt.entries()].sort((a, b) => a[1] - b[1]);
    while (this.invalidatedAt.size > 128) {
      const [key, generation] = generations.shift()!;
      this.invalidatedAt.delete(key);
      // Once a key marker is removed, preserve its stale-write protection on
      // the finite set of reads that began before that generation.
      for (const [task, startedAt] of pending) if (startedAt < generation) this.invalidated.add(task);
    }
  }
  private stale(startedAt: number, page: Page, requested: string) {
    return [requested, page.source.url].some(key => (this.invalidatedAt.get(key) ?? 0) > startedAt);
  }
  private addRefreshKey(key: string) { this.refreshing.set(key, (this.refreshing.get(key) ?? 0) + 1); }
  private removeRefreshKey(key: string) {
    const count = this.refreshing.get(key) ?? 0;
    if (count <= 1) this.refreshing.delete(key); else this.refreshing.set(key, count - 1);
  }
  private store(requested: string, page: Page, ttl: number, startedAt: number, task: Promise<Page>, startedDuringRefresh: boolean) {
    if (ttl <= 0 || startedDuringRefresh || this.invalidated.has(task) || this.stale(startedAt, page, requested)) return;
    const canonical = page.source.url, existing = this.cache.get(canonical), oldAlias = this.cache.get(requested);
    if (existing && existing.startedAt > startedAt) return;
    if (oldAlias && oldAlias !== existing) this.evictEntry(oldAlias);
    const retainedKeys = new Set(existing?.keys ?? []);
    if (existing) this.evictEntry(existing);
    const bytes = page.body.length * 2; // Conservative UTF-16 string accounting.
    const keys = new Set([...retainedKeys, requested, canonical]);
    while (keys.size > 64) {
      const removable = [...keys].find(key => key !== requested && key !== canonical);
      if (!removable) break;
      keys.delete(removable);
    }
    while (this.cache.size + keys.size > 64 ||
           this.cacheBytes + bytes > 16 * 1024 * 1024) {
      const victim = [...new Set(this.cache.values())].find(entry => entry !== existing);
      if (!victim) break;
      this.evictEntry(victim);
    }
    const entry: CacheEntry = { page, expires: Date.now() + ttl, bytes, startedAt, keys };
    for (const key of keys) this.cache.set(key, entry);
    this.cacheBytes += bytes;
  }
  private evict(url: string) { const entry = this.cache.get(url); if (entry) this.evictEntry(entry); }
  private evictEntry(entry: CacheEntry) {
    for (const key of entry.keys) if (this.cache.get(key) === entry) this.cache.delete(key);
    this.cacheBytes -= entry.bytes;
  }
  private acquire(origin: string, signal: AbortSignal, deadline: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const q = this.queues.get(origin) ?? []; this.queues.set(origin, q);
      const waiting: Waiting = {
        start: () => {
          if (signal.aborted || Date.now() >= deadline) { waiting.cancel(); return false; }
          signal.removeEventListener('abort', waiting.cancel);
          this.active.set(origin, (this.active.get(origin) ?? 0) + 1);
          resolve(() => {
            this.active.set(origin, this.active.get(origin)! - 1);
            while (q.length) if (q.shift()!.start()) break;
          });
          return true;
        },
        cancel: () => {
          signal.removeEventListener('abort', waiting.cancel);
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
  private async read(url: string, origin: string, authorize?: (target: string) => Promise<Record<string, string>>, refresh = false,
    onPublicRedirect?: (alias: string, canonical: string) => void): Promise<Page> {
    const requested = url;
    const deadline = Date.now() + this.timeout;
    const signal = AbortSignal.timeout(this.timeout);
    const release = await this.acquire(origin, signal, deadline);
    try {
      // Reload after queue admission: logout/account changes affect requests not yet sent.
      const requestPage = async (target: string) => {
        const auth = authorize ? await withSignal(authorize(target), signal) : {};
        signal.throwIfAborted();
        return withSignal(this.request(target, {
          headers: { 'User-Agent': 'cinev-mcp/0.1', ...(refresh ? { 'Cache-Control': 'no-cache' } : {}), ...(origin.includes('gateway.cinesunidos.com') ? { xChannel: 'www' } : {}), ...auth },
          signal, redirect: 'manual',
        }), signal, response => cancelBody(response.body));
      };
      let response = await requestPage(url);
      // One observed migration of Cinex's ticket page, with identical cinema
      // and session IDs. Re-read credentials and retain the original deadline.
      const ticketRedirect = authorize && cinexTicketRedirect(url, response);
      if (ticketRedirect) {
        cancelBody(response.body);
        url = ticketRedirect;
        response = await requestPage(url);
      }
      const cinemaRedirect = !authorize && cinexCinemaRedirect(url, response);
      if (cinemaRedirect) {
        onPublicRedirect?.(requested, cinemaRedirect);
        cancelBody(response.body);
        url = cinemaRedirect;
        response = await requestPage(url);
      }
      signal.throwIfAborted();
      if (response.status >= 300 && response.status < 400) {
        const destination = response.headers.get('location'); cancelBody(response.body);
        const redirect = destination ? new URL(destination, url) : undefined;
        if (authorize && redirect?.origin === origin && /^\/(?:clearsession\.html|api\/auth\/signin|login)(?:\/|$)/.test(redirect.pathname)) throw new DataError('auth_required', 'El proveedor redirigió al login; conecta de nuevo tu cuenta en la terminal local.');
        throw new DataError('unavailable', 'El proveedor redirigió la consulta; no se siguió el destino.');
      }
      if (!response.ok) {
        const status = response.status === 401 ? 'auth_required' : response.status === 403 ? 'blocked' : response.status === 429 ? 'rate_limited' : response.status === 404 ? 'unavailable' : 'error';
        cancelBody(response.body);
        throw new DataError(status, `El proveedor respondió HTTP ${response.status} en ${url}.`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DataError('error', 'Respuesta HTTP sin cuerpo.');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await withSignal(reader.read(), signal); if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) { cancelReader(reader); throw new DataError('error', 'Respuesta del proveedor demasiado grande.'); }
          chunks.push(value);
        }
      } catch (error) {
        if (signal.aborted) cancelReader(reader);
        throw error;
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
    if (!this.sources.some(s => s.url === page.source.url)) this.sources.push(page.source);
    return page.body;
  }
  async get(url: string, ttl?: number): Promise<string> {
    return (await this.page(url, ttl)).body;
  }
  async page(url: string, ttl?: number): Promise<Page> {
    const page = await this.http.get(url, ttl, this.refresh);
    if (!this.sources.some(s => s.url === page.source.url)) this.sources.push(page.source);
    return page;
  }
  async json(url: string): Promise<unknown> {
    try { return JSON.parse(await this.get(url)); }
    catch (e) { if (e instanceof DataError) throw e; throw new DataError('error', 'El proveedor no devolvió JSON válido.'); }
  }
}
