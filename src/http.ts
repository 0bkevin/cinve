import { DataError, Id } from './core.js';
import type { z } from 'zod';
import type { Source } from './core.js';
import { SessionStore, assertPrivateRead } from './auth.js';
import type { AuthProviderId } from './auth.js';

export type EvidenceSource = z.infer<typeof Source>;
type Page = { body: string; source: EvidenceSource };
type CacheEntry = { page: Page; expires: number; bytes: number; startedAt: number; keys: Set<string> };
type Waiting = { start: () => boolean; cancel: () => void };
type RefreshState = { keys: Set<string> };
// Entry count bounds bookkeeping; the byte budget bounds memory. One Cines
// Unidos city read through its search API alone needs ~50 small responses,
// and one Cinex city needs about ten venue pages of ~2 MB each (1 MB once
// whitespace is collapsed; see compactBody).
const cacheEntries = 512, cacheBytesLimit = 64 * 1024 * 1024;
// An anti-bot challenge is a refusal of automated clients that does not clear
// within seconds. Remember it per origin so later public reads fail fast (or
// take an adapter's documented fallback) instead of being refused again.
const challengeMemoryMs = 10 * 60 * 1000;
const hosts = new Set(['www.cinex.com.ve', 'www.cinesunidos.com', 'gateway.cinesunidos.com', 'cinepiccandelaria.com', 'cinepicvip.com', 'apifront.cinexo.com.ar', 'api.cinexo.com.ar']);

/**
 * Decodes with the charset the response declares (UTF-8 when absent or
 * unknown). The observed providers all send UTF-8; a page declared as
 * ISO-8859-1 or windows-1252 would otherwise lose every accented letter.
 * TextDecoder also drops a UTF-8 byte-order mark, which JSON.parse rejects.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const label = contentType?.match(/;\s*charset\s*=\s*"?([^";\s]+)/i)?.[1];
  if (label) {
    try { return new TextDecoder(label).decode(bytes); } catch { /* Unknown label: fall back to UTF-8. */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}
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

/**
 * Cinex venue pages are about 55% whitespace (1.9 MB, of which 1 MB is
 * indentation between calendar blocks). Its HTML parsers read only element
 * structure, attributes and \s-tolerant text, so collapsing whitespace runs
 * before caching gives identical results at half the memory. Other
 * providers embed JSON in their pages and are left byte-for-byte intact.
 */
function compactBody(url: string, body: string): string {
  const u = new URL(url);
  return u.hostname === 'www.cinex.com.ve' && u.pathname.endsWith('.html') ? body.replace(/\s+/g, ' ') : body;
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
  private challenged = new Map<string, { until: number; error: DataError }>();
  constructor(private request: typeof fetch = fetch, private timeout = 15000, readonly sessions = new SessionStore()) {}
  async getAuthenticated(provider: AuthProviderId, url: string): Promise<Page> {
    assertPrivateRead(provider, url);
    return this.read(url, new URL(url).origin, target => this.sessions.headers(provider, target));
  }
  /**
   * @param accept Whether a successful body is worth caching. A 200 response
   * that is empty or fails this check (an HTML error page where JSON was
   * expected, a maintenance page without the expected markup) is still
   * returned, so the caller reports it, but the next call asks again.
   */
  async get(url: string, ttl = 120000, refresh = false, accept?: (body: string) => boolean): Promise<Page> {
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
    if (hit && hit.expires > Date.now()) {
      this.touch(hit);
      return { ...hit.page, source: { ...hit.page.source, cached: true } };
    }
    if (hit) this.evictEntry(hit);
    const challenge = this.challenged.get(parsed.origin);
    if (challenge && challenge.until > Date.now()) throw new DataError(challenge.error.status, challenge.error.message);
    if (challenge) this.challenged.delete(parsed.origin);
    const running = this.pending.get(url);
    if (running) return running;
    const startedAt = ++this.clock;
    const startedDuringRefresh = this.refreshing.has(url);
    let task!: Promise<Page>;
    task = this.read(url, parsed.origin, undefined, false, (alias, canonical) => this.bindPendingAlias(alias, canonical, task)).then(page => {
      if (page.body.trim() && (!accept || accept(page.body))) this.store(url, page, ttl, startedAt, task, startedDuringRefresh);
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
    while (this.cache.size + keys.size > cacheEntries ||
           this.cacheBytes + bytes > cacheBytesLimit) {
      const victim = [...new Set(this.cache.values())].find(entry => entry !== existing);
      if (!victim) break;
      this.evictEntry(victim);
    }
    const entry: CacheEntry = { page, expires: Date.now() + ttl, bytes, startedAt, keys };
    for (const key of keys) this.cache.set(key, entry);
    this.cacheBytes += bytes;
  }
  /** Eviction takes the first entry in Map order; a hit moves its keys to the end (LRU). */
  private touch(entry: CacheEntry) {
    for (const key of entry.keys) if (this.cache.get(key) === entry) { this.cache.delete(key); this.cache.set(key, entry); }
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
          // Admit queued work only while a meaningful part of its deadline
          // remains (1 s, or half of a shorter timeout). A request admitted
          // with almost no time left cannot finish; it would only add load.
          if (signal.aborted || deadline - Date.now() <= Math.min(1000, this.timeout / 2)) { waiting.cancel(); return false; }
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
    // AbortSignal.timeout() uses an unreferenced timer: when the only pending
    // work is a stalled promise (a hung transport, session store or body
    // reader), Node may exit or drop the task before the deadline fires. A
    // referenced timer, always cleared, makes the deadline deterministic.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), this.timeout);
    try { return await this.readUntil(controller.signal, url, origin, authorize, refresh, onPublicRedirect); }
    finally { clearTimeout(timer); }
  }
  private async readUntil(signal: AbortSignal, url: string, origin: string, authorize?: (target: string) => Promise<Record<string, string>>, refresh = false,
    onPublicRedirect?: (alias: string, canonical: string) => void): Promise<Page> {
    const requested = url;
    const deadline = Date.now() + this.timeout;
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
        // An interactive anti-bot challenge is an explicit refusal of automated
        // clients. Report it as such; Cinve never tries to solve or evade it.
        if (response.status === 403 && response.headers.get('cf-mitigated')?.toLowerCase() === 'challenge') {
          const error = new DataError('blocked', `El proveedor exige un desafío anti-bots (Cloudflare) en ${new URL(url).hostname} y no admite consultas automatizadas. Cinve no evade esa protección; consulta la programación en su web o redes oficiales.`);
          if (!authorize) this.challenged.set(origin, { until: Date.now() + challengeMemoryMs, error });
          throw error;
        }
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
      if (!authorize) this.challenged.delete(origin);
      const text = decodeBody(Buffer.concat(chunks), response.headers.get('content-type'));
      return { body: authorize ? text : compactBody(url, text), source: { url, fetched_at: new Date().toISOString(), cached: false } };
    } catch (error) {
      if (error instanceof DataError) throw error;
      if (signal.aborted) throw new DataError('error', `Se agotó el plazo total de la consulta a ${url}.`);
      throw new DataError('error', `No se pudo leer ${url} (conexión, redirección o tiempo de espera).`);
    } finally {
      release();
    }
  }
}

const ids = (value: string | null) => value !== null && Id.safeParse(value).success;
/** Each listed query key appears exactly once, and no other key appears. */
function exactQuery(u: URL, rules: Record<string, (value: string | null) => boolean>) {
  const keys = [...u.searchParams.keys()];
  return keys.length === Object.keys(rules).length &&
    Object.entries(rules).every(([key, valid]) => u.searchParams.getAll(key).length === 1 && valid(u.searchParams.get(key)));
}
const cinexDatasource: Record<string, Record<string, (value: string | null) => boolean>> = {
  getcinemacitieslist: { method: () => true },
  getcinemadatafromcinemaid: { method: () => true, cinemaid: ids },
};
/**
 * Public GET routes the provider adapters are allowed to read. The host
 * allowlist in HttpClient bounds egress; this bounds it to the read-only pages
 * and APIs Cinve actually parses, so a future adapter bug cannot turn a
 * permitted host into a request for a purchase or account endpoint.
 */
export function assertPublicRead(value: string) {
  const u = new URL(value), path = u.pathname, none = !u.search;
  const allowed = (() => {
    switch (u.hostname) {
      case 'www.cinex.com.ve':
        if (['/cines.html', '/cartelera.html'].includes(path)) return none;
        if (/^\/cinex-[A-Za-z0-9_-]{1,80}\.html$/.test(path)) return none;
        if (path.startsWith('/sinopsis-') && path.endsWith('.html')) return none && Id.safeParse(path.slice(10, -5)).success;
        if (path === '/assets/php/datasource.php') {
          const rules = cinexDatasource[u.searchParams.get('method') ?? ''];
          return !!rules && exactQuery(u, rules);
        }
        return false;
      case 'www.cinesunidos.com':
        return ['/cines', '/cartelera'].includes(path) && exactQuery(u, { city: v => !!v && v.length <= 80 });
      case 'gateway.cinesunidos.com':
        if (path === '/search/cities') return none;
        {
          const m = path.match(/^\/search\/cities\/([^/]+)\/(theaters|films|sessions)$/);
          if (m) {
            let city = '';
            try { city = decodeURIComponent(m[1]); } catch { return false; }
            if (!city || city.length > 80 || /[\u0000-\u001f/\\]/.test(city)) return false;
            return m[2] === 'sessions' ? exactQuery(u, { Title: v => !!v && v.length <= 200 }) : none;
          }
        }
        { const m = path.match(/^\/concessions\/www\/cinemas\/([^/]+)\/concessions$/); return !!m && none && Id.safeParse(m[1]).success; }
      case 'cinepiccandelaria.com': case 'cinepicvip.com':
        if (path === '/es-AR') return none;
        return path === '/es-AR/compra' && exactQuery(u, { cid: ids, fid: ids, pid: ids });
      case 'apifront.cinexo.com.ar':
        return path === '/mobile/consultas/peliculas/PeliculasConFuncionesYHorarios' &&
          exactQuery(u, { idComplejo: ids, fecha: v => !!v && /^\d{2}\/\d{2}\/\d{4}$/.test(v) });
      case 'api.cinexo.com.ar':
        { const m = path.match(/^\/api\/complejo\/([^/]+)\/(?:candy|configuration)$/); return !!m && none && Id.safeParse(m[1]).success; }
      default:
        return false;
    }
  })();
  if (!allowed) throw new DataError('error', 'Ruta de consulta pública no permitida.');
}

/** Per-call options from the MCP request: its cancellation and progress reporting. */
export type CallOptions = { signal?: AbortSignal; progress?: (message: string) => void };

/**
 * The call itself stopped: the client cancelled it or its deadline passed.
 * Not evidence about the provider, so callers rethrow it before treating a
 * failed read as a missing page or changing shared discovery state.
 */
export class CallStopped extends DataError {
  constructor(message: string) { super('error', message); }
}
/**
 * No provider read starts once this much of one tool call has elapsed. A read
 * already in flight may still take its own 15 s, so a call stays near 75 s,
 * under the hosted 90 s limit, however its reads are chained or fanned out.
 */
export const operationBudgetMs = 60000;
const exclusiveTails = new Map<string, Promise<void>>();
/** Runs fn once every earlier holder of key has finished, one at a time, in call order. */
export async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = exclusiveTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
  exclusiveTails.set(key, tail);
  await previous;
  try { return await fn(); }
  finally { release(); if (exclusiveTails.get(key) === tail) exclusiveTails.delete(key); }
}
export class ReadContext {
  sources: EvidenceSource[] = [];
  warnings: string[] = [];
  partial = false;
  /** Epoch ms after which this call starts no further provider reads. */
  readonly deadline: number;
  /**
   * @param signal The MCP request's cancellation. A cancelled call starts no
   * further provider reads, so fan-outs stop at their next read; reads already
   * in flight finish, since other callers may share them through the cache.
   */
  constructor(private http: HttpClient, private refresh = false, private call: CallOptions = {}, budgetMs = operationBudgetMs) {
    this.deadline = Date.now() + budgetMs;
  }
  /** The earlier of `ms` from now and the call's own deadline, for a fan-out's loop. */
  budget(ms: number) { return Math.min(Date.now() + ms, this.deadline); }
  private checkCanRead() {
    if (this.call.signal?.aborted) throw new CallStopped('La consulta fue cancelada por el cliente.');
    // 'error', like a read timeout: an 'unavailable' here would read as a
    // missing page and make callers discard verified state or try fallbacks.
    if (Date.now() >= this.deadline) throw new CallStopped('Se agotó el tiempo de esta consulta antes de terminar de leer el proveedor; repítela o acótala con cinema_id, movie_id o query.');
  }
  /** Reports one completed step of a fan-out, when the client asked for progress. */
  progress(message: string) {
    try { this.call.progress?.(message); } catch { /* Progress is advisory; it never fails a read. */ }
  }
  /**
   * For provider pages that keep the selected function in the account's server
   * session (Cinex): reads for one account run one at a time, so parallel calls
   * cannot switch each other's function between two requests.
   */
  exclusive<T>(provider: AuthProviderId, fn: () => Promise<T>): Promise<T> {
    return exclusive(this.http.sessions.accountKey(provider), fn);
  }
  /** Cinex's own login check. A refused session is recorded as expired, so get_auth_status tells the truth. */
  async cinexSessionActive(): Promise<boolean> {
    const started = Date.now();
    if ((await this.authenticated('cinex', 'https://www.cinex.com.ve/checklogin.php')).trim() === 'on') return true;
    try { await this.http.sessions.expire('cinex', started); } catch { /* the answer is auth_required either way */ }
    return false;
  }
  async authenticated(provider: AuthProviderId, url: string): Promise<string> {
    this.checkCanRead();
    const page = await this.http.getAuthenticated(provider, url);
    if (!this.sources.some(s => s.url === page.source.url)) this.sources.push(page.source);
    return page.body;
  }
  async get(url: string, ttl?: number, accept?: (body: string) => boolean): Promise<string> {
    return (await this.page(url, ttl, accept)).body;
  }
  async page(url: string, ttl?: number, accept?: (body: string) => boolean): Promise<Page> {
    assertPublicRead(url);
    this.checkCanRead();
    const page = await this.http.get(url, ttl, this.refresh, accept);
    if (!this.sources.some(s => s.url === page.source.url)) this.sources.push(page.source);
    return page;
  }
  /** Only a body that parses is cached; an HTML error page in its place is reported and asked for again. */
  async json(url: string, ttl?: number): Promise<unknown> {
    try { return JSON.parse(await this.get(url, ttl, isJson)); }
    catch (e) { if (e instanceof DataError) throw e; throw new DataError('error', 'El proveedor no devolvió JSON válido.'); }
  }
}

function isJson(body: string) {
  try { JSON.parse(body); return true; } catch { return false; }
}
