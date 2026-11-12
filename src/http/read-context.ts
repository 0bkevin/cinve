import { DataError } from '../core.js';
import type { AuthProviderId } from '../auth/sessions.js';
import { HttpClient } from './client.js';
import { assertPublicForm, assertPublicRead } from './allow-list.js';
import type { EvidenceSource, Page, Ttl } from './client.js';
import { exclusive } from './account-lock.js';

/** Per-call options from the MCP request: its cancellation and progress reporting. */
export type CallOptions = {
  signal?: AbortSignal;
  progress?: (message: string) => void;
  /**
   * When the request reached the server (epoch ms). The hosted service sets it
   * so time spent before the tool runs (reading the body, OAuth, admission)
   * counts against the call's budget. Defaults to when the context is created.
   */
  startedAt?: number | undefined;
};

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
 * already in flight may still take its own 15 s (25 s for Cinepic's slow
 * backend), so a call stays near 75 s (85 s at worst, counted from when the
 * hosted server received the request), under the hosted 90 s limit, however
 * its reads are chained or fanned out.
 */
const operationBudgetMs = 60000;
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
    this.deadline = Math.min(Date.now(), call.startedAt ?? Infinity) + budgetMs;
  }
  /** The earlier of `ms` from now and the call's own deadline, for a fan-out's loop. */
  budget(ms: number) { return Math.min(Date.now() + ms, this.deadline); }
  private checkCanRead() {
    if (this.call.signal?.aborted) throw new CallStopped('The query was cancelled by the client.');
    // 'error', like a read timeout: an 'unavailable' here would read as a
    // missing page and make callers discard verified state or try fallbacks.
    if (Date.now() >= this.deadline) throw new CallStopped('This query ran out of time before it finished reading the provider; repeat it or narrow it with cinema_id, movie_id or query.');
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
  /**
   * Cinex's own login check: "on" or "off" (observed 2026-11-10). A refused
   * session is recorded as expired, so get_auth_status tells the truth. Any
   * other answer is Cinex failing, not the session: it is neither recorded
   * nor reported as auth_required. A pass is reused for one minute.
   */
  async cinexSessionActive(): Promise<boolean> {
    const account = this.http.sessions.accountKey('cinex');
    if (this.http.recentSessionCheck(account)) return true;
    const started = Date.now();
    const answer = (await this.authenticated('cinex', 'https://www.cinex.com.ve/checklogin.php')).trim();
    if (answer === 'on') { this.http.rememberSessionCheck(account); return true; }
    if (answer !== 'off') throw new DataError('error', 'Cinex answered its session check unexpectedly, so Cinve could not confirm whether the session is still active; it was not marked as expired. Try again later.');
    try { await this.http.sessions.expire('cinex', started); } catch { /* the answer is auth_required either way */ }
    return false;
  }
  /** Opens the one-ticket Cinex order a seat lookup may need (see seats/seat-map.ts); its body is empty. */
  async cinexSeatOrder(fields: Record<string, string>): Promise<void> {
    await this.authenticatedForm('cinex', 'https://www.cinex.com.ve/boletos_data.php', fields);
  }
  /** Whether the user has a stored, unexpired session for this provider (not checked upstream). */
  async hasSession(provider: AuthProviderId): Promise<boolean> {
    return (await this.http.sessions.status(provider)).status === 'configured';
  }
  /** An account form POST (see HttpClient.postAuthenticated); never cached. */
  async authenticatedForm(provider: AuthProviderId, url: string, fields: Record<string, string> | Array<[string, string]>): Promise<string> {
    this.checkCanRead();
    const started = Date.now();
    let page: Page;
    try { page = await this.http.postAuthenticated(provider, url, fields); }
    catch (error) {
      if (error instanceof DataError && error.status === 'auth_required') {
        try { await this.http.sessions.expire(provider, started); } catch { /* the answer is auth_required either way */ }
      }
      throw error;
    }
    if (!this.sources.some(s => s.url === page.source.url)) this.sources.push(page.source);
    return page.body;
  }
  /**
   * An account read that must go out even after the client cancelled the call
   * or its deadline passed: resetting an order the same call opened. It skips
   * those checks and is tried a second time if the first attempt fails.
   */
  async closeAuthenticated(provider: AuthProviderId, url: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await this.http.getAuthenticated(provider, url); return true; } catch { /* tried again once */ }
    }
    return false;
  }
  async authenticated(provider: AuthProviderId, url: string): Promise<string> {
    this.checkCanRead();
    const started = Date.now();
    let page: Page;
    try { page = await this.http.getAuthenticated(provider, url); }
    catch (error) {
      // A failed read may mean the session ended: check it again next time.
      if (provider === 'cinex') this.http.forgetSessionCheck(this.http.sessions.accountKey('cinex'));
      // The provider refused the saved session (HTTP 401, a redirect to its
      // login). Record that, so get_auth_status does not keep saying configured.
      if (error instanceof DataError && error.status === 'auth_required') {
        try { await this.http.sessions.expire(provider, started); } catch { /* the answer is auth_required either way */ }
      }
      throw error;
    }
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
    catch (e) { if (e instanceof DataError) throw e; throw new DataError('error', 'The provider did not return valid JSON.'); }
  }
  /** A public listing read sent as a form POST; see HttpClient.post. */
  async form(url: string, fields: Record<string, string>, ttl?: Ttl): Promise<string> {
    return (await this.formPage(url, fields, ttl)).body;
  }
  /** Like form(), keeping the provider's confirmation that it has no data (empty). */
  async formPage(url: string, fields: Record<string, string>, ttl?: Ttl): Promise<Page> {
    assertPublicForm(url, fields);
    this.checkCanRead();
    const page = await this.http.post(url, fields, ttl, this.refresh);
    if (!this.sources.some(s => s.url === page.source.url)) this.sources.push(page.source);
    return page;
  }
  async formJson(url: string, fields: Record<string, string>, ttl?: Ttl): Promise<unknown> {
    try { return JSON.parse(await this.form(url, fields, ttl)); }
    catch (e) { if (e instanceof DataError) throw e; throw new DataError('error', 'The provider did not return valid JSON.'); }
  }
}

function isJson(body: string) {
  try { JSON.parse(body); return true; } catch { return false; }
}
