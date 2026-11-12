import { beforeFirst, DataError } from '../core.js';
import type { z } from 'zod';
import type { Source } from '../core.js';
import { SessionStore } from '../auth/sessions.js';
import { assertCinexSeatOrder, assertPrivateRead, assertPublicForm, assertPublicRead, assertSupercinesSeatPage, publicHosts } from './allow-list.js';
import { cancelBody, cancelReader, decodeBody, withSignal } from './response.js';
import { cinexCinemaRedirect, cinexTicketRedirect } from './redirects.js';
import type { AuthProviderId } from '../auth/sessions.js';

export type EvidenceSource = z.infer<typeof Source>;
/** empty: the provider confirmed it has no data for this request (cacheable, unlike an error). */
export type Page = { body: string; source: EvidenceSource; empty?: true };
/** Cache lifetime in ms, or one chosen from the answer (e.g. shorter for "no data yet"). */
export type Ttl = number | ((page: Page) => number);
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
// After HTTP 429, wait as the provider asks (Retry-After, at most the
// challenge memory) or a minute, so a fan-out or a retrying client does not
// keep sending requests the provider already refused.
const rateLimitDefaultMs = 60 * 1000;
function retryAfterMs(response: Response): number {
  const value = response.headers.get('retry-after')?.trim() ?? '';
  const seconds = /^\d{1,6}$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, challengeMemoryMs) : rateLimitDefaultMs;
}
/**
 * Supercines serves its schedule, fares and concessions only to form POSTs
 * that carry the anti-forgery token of an anonymous visitor session, exactly
 * as its own pages do. The token proves the request came through the public
 * site; it is not an anti-bot control. Sessions last two hours upstream.
 */
const formSessionMs = 60 * 60 * 1000;
const formSessionPage = 'https://supercines.com.ve/cartelera';
type FormSession = { cookies: Map<string, string>; token: string; expires: number };
type FormRequest = { method: 'GET' | 'POST'; body?: string; headers: Record<string, string>; onResponse?: (response: Response) => void };
/** Laravel answers an expired anti-forgery token with HTTP 419. */
class FormTokenExpired extends DataError { constructor() { super('error', 'The provider rejected the public query token (HTTP 419).'); } }

function sessionCookies(response: Response, into: Map<string, string>) {
  const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const value of values) {
    const pair = beforeFirst(value, ';'), i = pair.indexOf('=');
    const name = pair.slice(0, i).trim(), cookie = pair.slice(i + 1).trim();
    // Only the framework's own session and token cookies, never a third party's.
    if (i > 0 && /^[A-Za-z0-9_-]{1,64}$/.test(name) && /^[A-Za-z0-9%=._-]{1,4096}$/.test(cookie) && (into.has(name) || into.size < 4)) into.set(name, cookie);
  }
}

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
  /** Providers whose session a request made with its credentials was refused on. */
  readonly rejectedSessions = new Set<AuthProviderId>();
  /**
   * A form read made with the user's own account: never cached or shared.
   * Supercines answers 419 when the account's session has ended (a guest
   * session has another form token), so that becomes auth_required rather
   * than a silent guest read. Two purchase steps also go through here, each
   * with its own field check: the one-ticket Cinex order and the Supercines
   * seat page that a seat lookup opens and always closes (seats/seat-map.ts).
   */
  async postAuthenticated(provider: AuthProviderId, url: string, fields: Record<string, string> | Array<[string, string]>): Promise<Page> {
    assertPrivateRead(provider, url);
    const path = new URL(url).pathname;
    // Supercines takes POSTs only on its fare list and seat page; its purchase is closed with a GET.
    if (provider === 'supercines' && !['/listBoletos', '/bookSeat'].includes(path)) throw new DataError('error', 'Authenticated route is not allowed.');
    // Cinex takes one POST: the one-ticket order a seat lookup may open.
    if (provider === 'cinex' && (path !== '/boletos_data.php' || Array.isArray(fields))) throw new DataError('error', 'Authenticated route is not allowed.');
    if (provider === 'cinesunidos') throw new DataError('error', 'Authenticated route is not allowed.');
    // Repeated keys (idBoleto[]) are only sent to Supercines' seat page, which has its own checks.
    const entries = Array.isArray(fields) ? fields : Object.entries(fields);
    if (path === '/bookSeat') assertSupercinesSeatPage(entries);
    else if (Array.isArray(fields)) throw new DataError('error', 'Public query path not allowed.');
    else if (provider === 'cinex') assertCinexSeatOrder(fields);
    else assertPublicForm(url, fields);
    // A stable sort keeps the order of repeated keys, which the site pairs by position.
    const body = new URLSearchParams([...entries].sort(([a], [b]) => a.localeCompare(b))).toString();
    try {
      return await this.read(url, new URL(url).origin, target => this.sessions.headers(provider, target), false, undefined,
        { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
    } catch (error) {
      if (error instanceof FormTokenExpired || (error instanceof DataError && error.status === 'auth_required')) {
        this.rejectedSessions.add(provider);
        throw new DataError('auth_required', 'The cinema did not recognize your account\'s session (it expired or was closed); connect it again.');
      }
      throw error;
    }
  }
  async getAuthenticated(provider: AuthProviderId, url: string): Promise<Page> {
    assertPrivateRead(provider, url);
    const path = new URL(url).pathname;
    // The only Supercines GET with the account closes a purchase; fares and the seat page are POSTs with checked fields.
    if (provider === 'supercines' && path !== '/cancelaCompra') throw new DataError('error', 'Authenticated route is not allowed.');
    // Cinex's order route takes only the checked POST.
    if (provider === 'cinex' && path === '/boletos_data.php') throw new DataError('error', 'Authenticated route is not allowed.');
    try {
      const page = await this.read(url, new URL(url).origin, target => this.sessions.headers(provider, target));
      // Cinex answers its session probe with 200 and a body other than "on".
      if (new URL(url).pathname === '/checklogin.php' && page.body.trim() !== 'on') this.rejectedSessions.add(provider);
      return page;
    } catch (error) {
      if (error instanceof DataError && error.status === 'auth_required') this.rejectedSessions.add(provider);
      throw error;
    }
  }
  /**
   * @param accept Whether a successful body is worth caching. A 200 response
   * that is empty or fails this check (an HTML error page where JSON was
   * expected, a maintenance page without the expected markup) is still
   * returned, so the caller reports it, but the next call asks again.
   */
  async get(url: string, ttl = 120000, refresh = false, accept?: (body: string) => boolean): Promise<Page> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !publicHosts.has(parsed.hostname) || parsed.port || parsed.username || parsed.password || parsed.hash) throw new DataError('error', 'Query origin not allowed.');
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
  /**
   * A public form read: same cache, queue, deadline and size limits as get().
   * The cache key and the reported source are the URL plus its sorted form
   * fields, so different queries never share an entry. Callers must validate
   * the route and fields with assertPublicForm first (ReadContext does).
   */
  async post(url: string, fields: Record<string, string>, ttl: Ttl = 120000, refresh = false): Promise<Page> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'supercines.com.ve' || parsed.port || parsed.username || parsed.password || parsed.hash || parsed.search) throw new DataError('error', 'Query origin not allowed.');
    const body = new URLSearchParams(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))).toString();
    const key = body ? `${url}?${body}` : url;
    if (refresh) this.invalidate(key);
    const hit = this.cache.get(key);
    if (!refresh && hit && hit.expires > Date.now()) {
      this.touch(hit);
      return { ...hit.page, source: { ...hit.page.source, cached: true } };
    }
    if (hit && !refresh) this.evictEntry(hit);
    const challenge = this.challenged.get(parsed.origin);
    if (challenge && challenge.until > Date.now()) throw new DataError(challenge.error.status, challenge.error.message);
    const running = !refresh && this.pending.get(key);
    if (running) return running;
    const startedAt = ++this.clock;
    let task!: Promise<Page>;
    task = this.readForm(url, key, body, parsed.origin, refresh).then(page => {
      this.store(key, page, typeof ttl === 'function' ? ttl(page) : ttl, startedAt, task, false);
      return page;
    }).finally(() => this.clearPending(task));
    this.pendingStartedAt.set(task, startedAt);
    this.bindPending(key, task);
    return task;
  }
  private formSessions = new Map<string, Promise<FormSession>>();
  /**
   * One anonymous visitor session per origin, shared by concurrent reads.
   * stale: the session a caller found expired or refused. Only the first such
   * caller opens a replacement; the others share it.
   */
  private formSession(origin: string, stale?: Promise<FormSession>): Promise<FormSession> {
    const current = this.formSessions.get(origin);
    if (current && current !== stale) return current.then(session => session.expires > Date.now() ? session : this.formSession(origin, current));
    const opened = this.readSessionPage(origin);
    this.formSessions.set(origin, opened);
    opened.catch(() => { if (this.formSessions.get(origin) === opened) this.formSessions.delete(origin); });
    return opened;
  }
  private async readSessionPage(origin: string): Promise<FormSession> {
    assertPublicRead(formSessionPage);
    const cookies = new Map<string, string>();
    const page = await this.read(formSessionPage, origin, undefined, false, undefined,
      { method: 'GET', headers: {}, onResponse: response => sessionCookies(response, cookies) });
    const token = page.body.match(/<meta\s+name="csrf-token"\s+content="([A-Za-z0-9]{20,128})"/)?.[1];
    if (!token || !cookies.size) throw new DataError('error', 'The provider did not open a recognizable public query session.');
    return { cookies, token, expires: Date.now() + formSessionMs };
  }
  private async readForm(url: string, key: string, body: string, origin: string, refresh: boolean): Promise<Page> {
    const started = Date.now();
    let used: Promise<FormSession> | undefined;
    for (let attempt = 0; ; attempt++) {
      used = this.formSession(origin, used);
      const session = await used;
      try {
        const page = await this.read(url, origin, undefined, refresh, undefined, {
          method: 'POST', body,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json, text/html',
            'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-TOKEN': session.token,
            Cookie: [...session.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          },
          onResponse: response => sessionCookies(response, session.cookies),
        });
        return { ...page, source: { ...page.source, url: key } };
      } catch (error) {
        // One renewal: the upstream session may have expired before ours.
        // A refused token answers at once; renew only while the call has
        // not already spent a read's time, so one read stays near 2 × timeout.
        if (error instanceof FormTokenExpired && attempt === 0 && Date.now() - started < this.timeout / 3) continue;
        throw error;
      }
    }
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
    for (const [key, generation] of generations) {
      if (this.invalidatedAt.size <= 128) break;
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
            this.active.set(origin, (this.active.get(origin) ?? 0) - 1);
            for (let next = q.shift(); next; next = q.shift()) if (next.start()) break;
          });
          return true;
        },
        cancel: () => {
          signal.removeEventListener('abort', waiting.cancel);
          const i = q.indexOf(waiting); if (i >= 0) q.splice(i, 1);
          reject(new DataError('error', 'Timed out waiting in the query queue.'));
        },
      };
      if (signal.aborted) { waiting.cancel(); return; }
      if ((this.active.get(origin) ?? 0) < 2) { waiting.start(); return; }
      if (q.length >= 32) { reject(new DataError('rate_limited', 'The local query queue is full; try again later.')); return; }
      q.push(waiting); signal.addEventListener('abort', waiting.cancel, { once: true });
    });
  }
  private async read(url: string, origin: string, authorize?: (target: string) => Promise<Record<string, string>>, refresh = false,
    onPublicRedirect?: (alias: string, canonical: string) => void, form?: FormRequest): Promise<Page> {
    // AbortSignal.timeout() uses an unreferenced timer: when the only pending
    // work is a stalled promise (a hung transport, session store or body
    // reader), Node may exit or drop the task before the deadline fires. A
    // referenced timer, always cleared, makes the deadline deterministic.
    const controller = new AbortController(), timeout = this.readTimeout(origin);
    const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), timeout);
    try { return await this.readUntil(controller.signal, timeout, url, origin, authorize, refresh, onPublicRedirect, form); }
    finally { clearTimeout(timer); }
  }
  private async readUntil(signal: AbortSignal, timeout: number, url: string, origin: string, authorize?: (target: string) => Promise<Record<string, string>>, refresh = false,
    onPublicRedirect?: (alias: string, canonical: string) => void, form?: FormRequest): Promise<Page> {
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
          headers: { 'User-Agent': 'cinev-mcp/0.1', ...(refresh ? { 'Cache-Control': 'no-cache' } : {}), ...(origin.includes('gateway.cinesunidos.com') ? { xChannel: 'www' } : {}), ...form?.headers, ...auth },
          signal, redirect: 'manual', ...(form ? { method: form.method, ...(form.body !== undefined ? { body: form.body } : {}) } : {}),
        }), signal, response => cancelBody(response.body));
      };
      // Public reads are idempotent: retry once, after a short pause, a
      // connection that failed before any response (such as a reused
      // keep-alive socket the server had just closed) or a 502/504 from an
      // edge proxy, while at least half of this read's deadline remains. Never
      // 4xx, 429, 503 (maintenance, often with Retry-After), timeouts, form
      // posts, or authenticated reads, whose pages can act on the account's session.
      let retried = false;
      const canRetry = () => !retried && !authorize && form?.method !== 'POST' && deadline - Date.now() > timeout / 2;
      let response: Response;
      try { response = await requestPage(url); }
      catch (error) {
        if (signal.aborted || error instanceof DataError || !canRetry()) throw error;
        retried = true;
        await withSignal(new Promise(resolve => setTimeout(resolve, retryPause())), signal);
        response = await requestPage(url);
      }
      if (transientStatus(response.status) && canRetry()) {
        cancelBody(response.body);
        retried = true;
        await withSignal(new Promise(resolve => setTimeout(resolve, retryPause())), signal);
        response = await requestPage(url);
      }
      form?.onResponse?.(response);
      if (form && response.status === 419) { cancelBody(response.body); throw new FormTokenExpired(); }
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
        const from = new URL(url).pathname;
        // Supercines sends a schedule request for a title with no functions
        // on that date (a presale before release, an unknown title) to its
        // home page: a cacheable "no data", not a failure. Other routes
        // redirected anywhere remain unavailable.
        if (form?.method === 'POST' && from === '/listCartelerafecha' && redirect?.origin === origin && redirect.pathname === '/' && !redirect.search) {
          return { body: '', empty: true, source: { url, fetched_at: new Date().toISOString(), cached: false } };
        }
        // Cinex's order answers with its seat page and its reset with its ticket page: both are done, read
        // separately by the caller (seats/seat-map.ts); neither redirect is followed here.
        if (authorize && redirect?.origin === origin && ((from === '/boletos_data.php' && redirect.pathname === '/asientos.php') || (from === '/resetpurchase.php' && redirect.pathname === '/boletos.php'))) {
          return { body: '', empty: true, source: { url, fetched_at: new Date().toISOString(), cached: false } };
        }
        // Cancelling a Supercines purchase answers with its home page: the purchase is closed.
        if (authorize && from === '/cancelaCompra' && redirect?.origin === origin && redirect.pathname === '/' && !redirect.search) {
          return { body: '', empty: true, source: { url, fetched_at: new Date().toISOString(), cached: false } };
        }
        if (authorize && redirect?.origin === origin && /^\/(?:clearsession\.html|api\/auth\/signin|login)(?:\/|$)/.test(redirect.pathname)) throw new DataError('auth_required', 'The provider redirected to the login; connect your account again in the local terminal.');
        throw new DataError('unavailable', 'The provider redirected the query; the destination was not followed.');
      }
      if (!response.ok) {
        const status = response.status === 401 ? 'auth_required' : response.status === 403 ? 'blocked' : response.status === 429 ? 'rate_limited' : response.status === 404 ? 'unavailable' : 'error';
        if (authorize && response.status === 401) { cancelBody(response.body); throw new DataError(status, 'The provider refused the account\'s saved session (HTTP 401); connect it again.'); }
        cancelBody(response.body);
        if (response.status === 429 && !authorize) {
          const error = new DataError('rate_limited', `The provider rate-limited queries on ${new URL(url).hostname} (HTTP 429); Cinve waits before querying it again.`);
          this.challenged.set(origin, { until: Date.now() + retryAfterMs(response), error });
          throw error;
        }
        // An interactive anti-bot challenge is an explicit refusal of automated
        // clients. Report it as such; Cinve never tries to solve or evade it.
        if (response.status === 403 && response.headers.get('cf-mitigated')?.toLowerCase() === 'challenge') {
          const error = new DataError('blocked', `The provider requires an anti-bot challenge (Cloudflare) on ${new URL(url).hostname} and does not allow automated queries. Cinve does not bypass that protection; check the schedule on its website or official social media.`);
          if (!authorize) this.challenged.set(origin, { until: Date.now() + challengeMemoryMs, error });
          throw error;
        }
        throw new DataError(status, `The provider responded HTTP ${response.status} at ${url}.`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DataError('error', 'HTTP response without a body.');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await withSignal(reader.read(), signal); if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) { cancelReader(reader); throw new DataError('error', 'Provider response too large.'); }
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
        ? `The overall time limit for the query to ${url} ran out while Cinve read the saved session; the provider was not queried. Try again.`
        : 'Cinve could not read the account\'s saved session; the provider was not queried. Try again later.');
      if (signal.aborted) throw new DataError('error', `The overall time limit for the query to ${url} ran out: the provider did not finish answering within ${Math.round(timeout / 1000)} s.`);
      throw new DataError('error', `Could not connect to the provider or read its answer at ${url} (connection refused, cut off or a network error).`);
    } finally {
      release();
    }
  }
}
