import { DataError } from '../core.js';
import type { z } from 'zod';
import type { Source } from '../core.js';
import { SessionStore } from '../auth.js';
import { assertPrivateRead, publicHosts } from './allow-list.js';
import { cancelBody, cancelReader, decodeBody, withSignal } from './response.js';
import { cinexCinemaRedirect, cinexTicketRedirect } from './redirects.js';
import type { AuthProviderId } from '../auth.js';

export type EvidenceSource = z.infer<typeof Source>;
export type Page = { body: string; source: EvidenceSource };
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
// Cinepic's backend (api.cinexo.com.ar) has been seen taking ~19 s on its own
// side, even to plain curl, and its sites render from it. These origins get a
// longer read deadline (25 s at the default 15 s) so a slow-but-working
// response is not reported as a failure. A Cinepic call chains at most two
// reads, so it stays under the hosted 90 s limit.
const slowHosts = new Set(['cinepiccandelaria.com', 'cinepicvip.com', 'apifront.cinexo.com.ar', 'api.cinexo.com.ar']);
const slowHostFactor = 5 / 3;
// A Cinex login check that answered "on" proves the session was in use just
// now, and Cinex ends sessions only after many idle minutes. Within this
// window the check is not repeated; any failed Cinex read drops it.
const sessionCheckMs = 60000;

/** Gateway errors from an edge proxy, and resets of reused connections, are worth one more try. */
const transientStatus = (status: number) => status === 502 || status === 504;
const retryPause = () => 200 + Math.floor(Math.random() * 300);

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
  private sessionChecks = new Map<string, number>();
  constructor(private request: typeof fetch = fetch, private timeout = 15000, readonly sessions = new SessionStore()) {}
  /** Whether this account's provider login check passed within the last minute. */
  recentSessionCheck(account: string) { return (this.sessionChecks.get(account) ?? 0) > Date.now(); }
  rememberSessionCheck(account: string) { this.sessionChecks.set(account, Date.now() + sessionCheckMs); }
  forgetSessionCheck(account: string) { this.sessionChecks.delete(account); }
  private readTimeout(origin: string) { return slowHosts.has(new URL(origin).hostname) ? Math.round(this.timeout * slowHostFactor) : this.timeout; }
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
    if (parsed.protocol !== 'https:' || !publicHosts.has(parsed.hostname) || parsed.port || parsed.username || parsed.password || parsed.hash) throw new DataError('error', 'Origen de consulta no permitido.');
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
  private evictEntry(entry: CacheEntry) {
    for (const key of entry.keys) if (this.cache.get(key) === entry) this.cache.delete(key);
    this.cacheBytes -= entry.bytes;
  }
  private acquire(origin: string, signal: AbortSignal, deadline: number, timeout: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const q = this.queues.get(origin) ?? []; this.queues.set(origin, q);
      const waiting: Waiting = {
        start: () => {
          // Admit queued work only while a meaningful part of its deadline
          // remains (1 s, or half of a shorter timeout). A request admitted
          // with almost no time left cannot finish; it would only add load.
          if (signal.aborted || deadline - Date.now() <= Math.min(1000, timeout / 2)) { waiting.cancel(); return false; }
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
    const controller = new AbortController(), timeout = this.readTimeout(origin);
    const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), timeout);
    try { return await this.readUntil(controller.signal, timeout, url, origin, authorize, refresh, onPublicRedirect); }
    finally { clearTimeout(timer); }
  }
  private async readUntil(signal: AbortSignal, timeout: number, url: string, origin: string, authorize?: (target: string) => Promise<Record<string, string>>, refresh = false,
    onPublicRedirect?: (alias: string, canonical: string) => void): Promise<Page> {
    const requested = url;
    const deadline = Date.now() + timeout;
    const release = await this.acquire(origin, signal, deadline, timeout);
    // Which side a failure belongs to: Cinve's own session store, or the provider.
    const at: { phase: 'session' | 'provider' } = { phase: 'provider' };
    try {
      // Reload after queue admission: logout/account changes affect requests not yet sent.
      const requestPage = async (target: string) => {
        at.phase = 'session';
        const auth = authorize ? await withSignal(authorize(target), signal) : {};
        at.phase = 'provider';
        signal.throwIfAborted();
        return withSignal(this.request(target, {
          headers: { 'User-Agent': 'cinev-mcp/0.1', ...(refresh ? { 'Cache-Control': 'no-cache' } : {}), ...(origin.includes('gateway.cinesunidos.com') ? { xChannel: 'www' } : {}), ...auth },
          signal, redirect: 'manual',
        }), signal, response => cancelBody(response.body));
      };
      // Public reads are idempotent GETs: retry once, after a short pause, a
      // connection that failed before any response (such as a reused
      // keep-alive socket the server had just closed) or a 502/504 from an
      // edge proxy, while at least half of this read's deadline remains. Never
      // 4xx, 429, 503 (maintenance, often with Retry-After), timeouts, or
      // authenticated reads, whose pages can act on the account's session.
      const canRetry = () => !authorize && deadline - Date.now() > timeout / 2;
      let response: Response;
      try { response = await requestPage(url); }
      catch (error) {
        if (signal.aborted || error instanceof DataError || !canRetry()) throw error;
        await withSignal(new Promise(resolve => setTimeout(resolve, retryPause())), signal);
        response = await requestPage(url);
      }
      if (transientStatus(response.status) && canRetry()) {
        cancelBody(response.body);
        await withSignal(new Promise(resolve => setTimeout(resolve, retryPause())), signal);
        response = await requestPage(url);
      }
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
        if (authorize && response.status === 401) { cancelBody(response.body); throw new DataError(status, 'El proveedor rechazó la sesión guardada de la cuenta (HTTP 401); conéctala de nuevo.'); }
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
      // A failing session store (the hosted database, a local file) is Cinve's
      // problem: never report it as the provider's connection failing.
      if (at.phase === 'session') throw new DataError('error', signal.aborted
        ? `Se agotó el plazo total de la consulta a ${url} mientras Cinve leía la sesión guardada; no llegó a consultarse al proveedor. Inténtalo de nuevo.`
        : 'Cinve no pudo leer la sesión guardada de la cuenta; no llegó a consultarse al proveedor. Inténtalo de nuevo más tarde.');
      if (signal.aborted) throw new DataError('error', `Se agotó el plazo total de la consulta a ${url}: el proveedor no terminó de responder en ${Math.round(timeout / 1000)} s.`);
      throw new DataError('error', `No se pudo conectar con el proveedor ni leer su respuesta en ${url} (conexión rechazada, cortada o con un error de red).`);
    } finally {
      release();
    }
  }
}
