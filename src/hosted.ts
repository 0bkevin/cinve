import { instructionsPage, landingPage, privacyPage, notFoundPage, publicPageCache, servePublicAsset, setSecurityHeaders } from './public-web.js';
import { hostedAuthInstructions } from './hosted-auth-guidance.js';
import { HostedOAuth, accessTokenFormat } from './oauth.js';
import { LocalLimiter, LocalSet } from './local-limit.js';
import { ClientMetadataCache } from './client-metadata.js';
import { addressBytes } from './client-metadata.js';
import type { ClientMetadataFetcher } from './client-metadata.js';
import { serveInstall } from './install.js';
import { serveDiscovery } from './discovery.js';
import { createServer as nodeServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { hkdfSync, timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createServer } from './server.js';
import { CinemaService } from './service.js';
import { CinexCinemaCatalog } from './cinex-cinemas.js';
import { HttpClient } from './http.js';
import { HostedHttpClient } from './hosted-http.js';
import { SessionStore, login } from './auth.js';
import type { AuthSession, AuthProviderId } from './auth.js';
import type { Operation, Query } from './core.js';
import type { CallOptions } from './http.js';
import { ConnectionLinks, cinemaUnavailableMessage, ipv6Block, signInFloor, signInRefusalMessage } from './hosted-links.js';
import type { SignInSubject } from './hosted-links.js';
import { EncryptedSessionStore, HostedUsers, digest } from './hosted-store.js';
import { loginPage } from './auth-web.js';

class AnonymousSessions extends SessionStore {
  constructor(private readonly origin: string) { super(); }
  override async read(): Promise<AuthSession | undefined> { return undefined; }
  override async save(): Promise<void> { throw new Error("Anonymous sessions cannot persist credentials."); }
  override async remove(): Promise<void> { throw new Error("Anonymous sessions cannot modify credentials."); }
  override async status(p: AuthProviderId) {
    return { ...await super.status(p), status: 'client_authorization_required', login_command: hostedAuthInstructions(this.origin) };
  }
}

class HostedService extends CinemaService {
  constructor(private readonly client: HttpClient, catalog: CinexCinemaCatalog, private readonly store?: EncryptedSessionStore) { super(client, catalog); }
  /**
   * A cinema can end a session before its stored expiry; drop it so
   * reconnecting is offered. Only when a request made with the session's own
   * credentials was refused, never for an unrelated auth_required.
   */
  private async rejected(status: string, provider: string) {
    // Supercines fares fall back to public ones when its session is refused,
    // so that refusal arrives with an available result, not auth_required.
    const cinema = provider === 'cinex' || provider === 'cinesunidos' || provider === 'supercines';
    if ((status === 'auth_required' || provider === 'supercines') && this.store && cinema && this.client.rejectedSessions.has(provider))
      await this.store.discardRejected(provider).catch(() => {});
  }
  override async query(op: Operation, q: Query, call?: CallOptions) {
    const result = await super.query(op, q, call);
    await this.rejected(result.status, q.provider);
    if (result.status === 'auth_required') result.warnings = ['Connect your account with connect_account. Enter your credentials only through the private link, never in chat.'];
    return result;
  }
  override async seats(q: Query, call?: CallOptions) {
    const result = await super.seats(q, call);
    await this.rejected(result.status, q.provider);
    return result;
  }
}
/** A serialized web origin (scheme://host[:port]), or "null" from sandboxed documents. */
function wellFormedOrigin(value: string): boolean {
  if (value === 'null') return true;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && u.origin === value; } catch { return false; }
}
/**
 * The network a rate limit is charged to. One IPv6 subscriber is normally
 * delegated at least a /64, so per-address IPv6 limits could be bypassed by
 * rotating addresses; IPv4 (including IPv4-mapped IPv6) stays per address.
 */
export function rateLimitNetwork(address: string): string {
  const bytes = addressBytes(address);
  // Not an address (no socket address): one shared key, never caller-chosen text.
  if (!bytes) return 'unknown';
  if (bytes.length === 4) return bytes.join('.');
  if (bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join('.');
  return Buffer.from(bytes.slice(0, 8)).toString('hex').replace(/(.{4})(?!$)/g, '$1:') + '::/64';
}
/**
 * Purpose-specific subkeys of CINEV_ENCRYPTION_KEY, which itself only
 * encrypts cinema sessions: one signs OAuth tokens, one keys rate limits.
 */
export function hostedKeys(key: Buffer) {
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, 32));
  return { tokenKey: derive('cinve oauth access token v1'), budgetKey: derive('cinve rate limit keys v1'), linkKey: derive('cinve connection links v1') };
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function body(req: IncomingMessage, max: number, deadlineMs = 10000): Promise<unknown> {
  const message = (english: string, spanish: string) => req.url === '/mcp' ? english : spanish;
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, message('JSON is required.', 'Se requiere JSON.'));
  if (Number(req.headers['content-length'] ?? 0) > max) throw new HttpError(413, message('Request is too large.', 'Solicitud demasiado grande.'));
  const chunks: Buffer[] = []; let size = 0;
  // A slow sender must not hold a request slot indefinitely. On Vercel the
  // node:http server timeouts do not apply to the exported handler.
  const timer = setTimeout(() => req.destroy(new HttpError(408, message('The request timed out.', 'La solicitud tardó demasiado.'))), deadlineMs);
  try {
    for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, message('Request is too large.', 'Solicitud demasiado grande.')); chunks.push(Buffer.from(chunk)); }
  } finally { clearTimeout(timer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, message('Invalid request.', 'Solicitud no válida.')); }
}
/** Whether a (single) JSON-RPC message is a tool call that asks to bypass the public cache. */
function refreshCall(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const { method, params } = message as { method?: unknown; params?: unknown };
  const args = params && typeof params === 'object' ? (params as { arguments?: unknown }).arguments : undefined;
  return method === 'tools/call' && !!args && typeof args === 'object' && (args as { refresh?: unknown }).refresh === true;
}
export async function createHostedApp(options: {
  publicUrl: string; pool: Pool; key: Buffer; allowLocal?: boolean; trustedVercelProxy?: boolean; cleanupSecret?: string;
  authenticate?: typeof login; request?: typeof fetch; bodyTimeoutMs?: number; clientMetadata?: ClientMetadataFetcher; signInFloorMs?: number;
}) {
  const publicUrl = new URL(options.publicUrl);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password ||
      (publicUrl.protocol !== 'https:' && !(options.allowLocal && publicUrl.protocol === 'http:' && publicUrl.hostname === '127.0.0.1'))) throw new Error('CINEV_PUBLIC_URL must be an HTTPS origin.');
  if (options.key.length !== 32) throw new Error('Invalid encryption key.');
  let origin = publicUrl.origin;
  const { tokenKey, budgetKey, linkKey } = hostedKeys(options.key);
  const links = new ConnectionLinks(options.pool, { budgetKey, linkKey });
  const oauth = new HostedOAuth(options.pool, () => origin, new ClientMetadataCache(options.clientMetadata), {
    authenticate: options.authenticate ?? login,
    save: (client, user, session) => new EncryptedSessionStore(options.pool, user, options.key).saveInTransaction(client, session),
    refusalFloorMs: options.signInFloorMs,
  }, tokenKey, links);
  const users = new HostedUsers(options.pool);
  // Public cache and in-flight deduplication live for this hosted app. The
  // client is never used for authenticated reads; those remain request/user
  // scoped below.
  const publicHttp = new HttpClient(options.request ?? fetch, 15000);
  // Catalog URL associations are public discovery state, bounded by the
  // catalog itself; authenticated session state remains request-scoped.
  const cinexCatalog = new CinexCinemaCatalog();
  // Process-level concurrency is an extra bound; rate budgets live in Postgres.
  const active = new Map<string, number>(); let totalActive = 0;
  // In-memory first filters for this instance, checked before any database
  // work; Postgres keeps the limits shared by all instances.
  // - Requests without a validly signed token: per network and per IPv6 /48.
  // - Signed tokens cannot be forged, so each gets its own headroom and junk
  //   from others on a shared address (carrier-grade NAT) never slows it.
  //   A high per-network cap bounds anyone minting many tokens.
  // - Failed lookups of unsigned credentials (legacy or operator tokens,
  //   legacy links) per network; an unsigned token that recently worked is
  //   exempt. A signed credential whose lookup failed is revoked, expired or
  //   used for good, so it is answered from memory for an hour.
  const localRequests = new LocalLimiter(600), localBlockRequests = new LocalLimiter(2400);
  const localTokenRequests = new LocalLimiter(600), localSignedRequests = new LocalLimiter(3000), localSignedBlockRequests = new LocalLimiter(6000);
  const oauthRoutes = new Set(['/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke']);
  const localAuthFailures = new LocalLimiter(30), knownTokens = new LocalSet(30 * 60000), deadTokens = new LocalSet(60 * 60000);
  const tooManyFailures = (req: IncomingMessage) => new HttpError(429, req.url === '/mcp'
    ? 'Too many attempts with invalid credentials. Try again in one minute.'
    : 'Demasiados intentos con credenciales no válidas. Inténtalo en un minuto.');
  const storeFor = (id: string) => new EncryptedSessionStore(options.pool, id, options.key);
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    setSecurityHeaders(res, publicUrl.protocol === 'https:');
    const send = (status: number, data: unknown) => { if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); } };
    try {
      if (servePublicAsset(req, res) || serveInstall(req, res, origin) || serveDiscovery(req, res, origin)) return;
      if (req.method === 'GET' && req.url === '/health') { send(200, { status: 'ok' }); return; }
      if (req.headers.host !== publicUrl.host) throw new HttpError(403, req.url === '/mcp' ? 'Origin not allowed.' : 'Origen no permitido.');
      // Static pages cost no database work, so they are served before any
      // limit: a user behind a shared address can always open the link page.
      const pagePath = req.url?.split('?')[0];
      if (['GET', 'HEAD'].includes(req.method ?? '') && (pagePath === '/connect' || pagePath === '/' || pagePath === '/instrucciones' || pagePath === '/privacidad')) {
        if (pagePath !== '/connect') res.setHeader('Cache-Control', publicPageCache);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : pagePath === '/' ? landingPage(origin) : pagePath === '/instrucciones' ? instructionsPage(origin) : pagePath === '/privacidad' ? privacyPage(origin) : loginPage()); return;
      }
      const forwarded = options.trustedVercelProxy ? req.headers['x-vercel-forwarded-for'] : undefined;
      const ip = rateLimitNetwork(typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress ?? 'unknown');
      const authorization = req.headers.authorization ?? '';
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      // A credential earns its own headroom only where it is used, and only
      // while it is live: a revoked or used one is treated like no credential.
      const signedBearer = req.url === '/mcp' && !!bearer && accessTokenFormat(bearer, tokenKey) === 'signed' && !deadTokens.has(digest(bearer));
      const linkHeader = req.headers['x-cinev-connection'];
      const signedLink = typeof linkHeader === 'string' && !!req.url?.startsWith('/connect/') && !deadTokens.has(digest(linkHeader)) &&
        links.linkFormat(linkHeader, req.url === '/connect/exchange' ? 'invitation' : 'browser') === 'signed';
      const credential = signedBearer ? 'token:' + bearer!.slice(0, 47) : signedLink ? 'link:' + (linkHeader as string).slice(0, 64) : undefined;
      const block = ipv6Block(ip);
      // OAuth routes apply these limits themselves, after their free checks.
      if (!oauthRoutes.has(pagePath ?? '') && !(credential
        ? localTokenRequests.hit(credential) && localSignedRequests.hit(ip) && (!block || localSignedBlockRequests.hit(block))
        : localRequests.hit(ip) && (!block || localBlockRequests.hit(block)))) {
        const excludedWebError = pagePath === '/connect' || pagePath?.startsWith('/connect/') || pagePath?.startsWith('/oauth/');
        throw new HttpError(429, excludedWebError ? 'Demasiadas consultas. Inténtalo más tarde.' : 'Too many requests. Try again later.');
      }
      if (await oauth.handle(req, res, ip, {
        // OAuth routes skip the general filter above and apply these after
        // their free checks, so a signed code or refresh token is limited by
        // its own id and never by junk from others on its network.
        credential: id => localTokenRequests.hit('oauth:' + id),
        network: () => localRequests.hit(ip) && (!block || localBlockRequests.hit(block)),
      })) return;
      if (req.url === '/mcp') {
        // MCP authorization is exclusively bearer-based; cookies are never used,
        // so any web origin may call it. The Host check above blocks DNS
        // rebinding; a present but malformed Origin is still refused, as the
        // Streamable HTTP transport requires for invalid origins.
        if (req.headers.origin !== undefined && !wellFormedOrigin(req.headers.origin)) throw new HttpError(403, 'Origin not allowed.');
        res.setHeader('Access-Control-Allow-Origin', '*');
        // The endpoint is stateless: it answers POST only (GET and DELETE get
        // 405) and never issues a session, so the session and SSE-resumption
        // headers that protocol 2026-07-28 removed are not offered. Mcp-Method
        // and Mcp-Name are required request headers since that revision.
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name');
        res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      } else if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Origen no permitido.');
      if (req.method === 'GET' && req.url === '/internal/cleanup') {
        if (!options.cleanupSecret || !timingSafeEqual(Buffer.from(digest(req.headers.authorization ?? '')), Buffer.from(digest(`Bearer ${options.cleanupSecret}`)))) throw new HttpError(401, 'Access is required.');
        await links.cleanup(); send(200, { cleaned: true }); return;
      }
      if (req.url === '/mcp') {
        const tokenId = bearer === undefined ? undefined : digest(bearer);
        const refuse = () => { res.setHeader('WWW-Authenticate', oauth.challenge(true)); return new HttpError(401, 'Cinve access is required.'); };
        if (tokenId && deadTokens.has(tokenId)) throw refuse();
        if (authorization && !signedBearer && !(tokenId && knownTokens.has(tokenId)) && localAuthFailures.exhausted(ip)) throw tooManyFailures(req);
        const principal = bearer ? await oauth.authenticate(bearer) ?? await users.authenticate(bearer) : undefined;
        if (authorization && !principal) {
          if (signedBearer) deadTokens.add(tokenId!); else localAuthFailures.hit(ip);
          throw refuse();
        }
        if (principal && !signedBearer) knownTokens.add(tokenId!);
        const clientKey = principal?.id ?? `anonymous:${ip}`;
        if (!await links.budget(`mcp:${clientKey}`, 120) || (active.get(clientKey) ?? 0) >= 4 || totalActive >= 32) throw new HttpError(429, 'Too many requests. Try again later.');
        // Reserve capacity synchronously with the check, before awaiting the
        // body, so concurrent slow uploads cannot all pass the same admission.
        active.set(clientKey, (active.get(clientKey) ?? 0) + 1); totalActive++;
        let handler: ReturnType<typeof createMcpHandler> | undefined;
        try {
          const parsed = req.method === 'POST' ? await body(req, 65536, options.bodyTimeoutMs) : undefined;
          // JSON-RPC batches were removed from MCP (2025-06-18) and no client
          // sends them. Every limit here counts HTTP requests, so a batch would
          // multiply them (one request carrying 100 refresh=true calls).
          if (Array.isArray(parsed)) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported.' } }));
            return;
          }
          // Discover public tools anonymously. Calling the connection tool triggers
          // the client's standard OAuth flow, which retries this same tool afterward.
          if (!principal && parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
              'method' in parsed && parsed.method === 'tools/call' && 'params' in parsed &&
              parsed.params && typeof parsed.params === 'object' && 'name' in parsed.params &&
              ['connect_account', 'disconnect_account'].includes(String(parsed.params.name))) {
            res.setHeader('WWW-Authenticate', oauth.challenge());
            throw new HttpError(401, hostedAuthInstructions(origin));
          }
          // refresh bypasses the shared public cache and can fan out to many
          // provider reads (for example, Cinex venue discovery). Keep it scarce so
          // one client cannot get the shared egress address blocked upstream.
          // A service-wide cap too, since many addresses could each use their own.
          if (refreshCall(parsed) && (!await links.budget(`refresh:${clientKey}`, 10) || !await links.budget(principal ? 'refresh:global' : 'refresh:global:anon', 120))) throw new HttpError(429, 'Too many requests with refresh=true. Retry without refresh or try again in one minute.');
          const store = principal ? storeFor(principal.id) : new AnonymousSessions(origin);
          const service = new HostedService(new HostedHttpClient(options.request ?? fetch, 15000, store, publicHttp), cinexCatalog,
            store instanceof EncryptedSessionStore ? store : undefined);
          handler = createMcpHandler(() => createServer(service, principal ? {
            connect: async provider => {
              // An account connected while authorizing (or earlier) needs no link.
              if ((await store.status(provider)).status === 'configured') return { connected: true as const };
              if (!await links.budget(`link:${principal.id}`, 12)) throw new Error('Too many links. Try again in one minute.');
              const link = await links.issue(principal.id, principal.tokenHash, provider);
              return { connected: false as const, url: `${origin}/connect#${link.token}`, expires_at: link.expires_at };
            },
            disconnect: async provider => { await store.remove(provider); },
          } : undefined, !principal, origin), { maxSubscriptions: 0, keepAliveMs: 0 });
          await toNodeHandler(handler)(req, res, parsed);
        } finally {
          await handler?.close();
          active.set(clientKey, active.get(clientKey)! - 1); if (!active.get(clientKey)) active.delete(clientKey); totalActive--;
        }
        return;
      }
      if (!req.url?.startsWith('/connect/') || req.method !== 'POST') throw new HttpError(404, 'Ruta no disponible.');
      if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw new HttpError(403, 'Origen no permitido.');
      const token = req.headers['x-cinev-connection'];
      const format = typeof token === 'string' ? links.linkFormat(token, req.url === '/connect/exchange' ? 'invitation' : 'browser') : undefined;
      if (typeof token !== 'string' || !format || (format === 'legacy' && Date.now() >= (await oauth.legacy()).link)) throw new HttpError(403, 'Enlace no válido.');
      // A signed link cannot be forged, so others' failures never hold it back,
      // and one that already failed (used, expired, revoked) fails from memory.
      const linkFailed = () => { if (format === 'signed') deadTokens.add(digest(token)); else localAuthFailures.hit(ip); };
      if (format === 'signed' ? deadTokens.has(digest(token)) : localAuthFailures.exhausted(ip)) {
        if (format === 'signed') throw new HttpError(410, 'Enlace vencido o utilizado.');
        throw tooManyFailures(req);
      }
      if (req.url === '/connect/exchange') {
        await body(req, 512);
        const exchanged = await links.exchange(token);
        if (!exchanged || await users.hash(exchanged.connection.user) !== exchanged.connection.tokenHash) { linkFailed(); throw new HttpError(410, 'Enlace vencido o utilizado.'); }
        send(200, { browser_token: exchanged.browserToken, provider: exchanged.connection.provider, app: await oauth.appFor(exchanged.connection.user) ?? null }); return;
      }
      const connection = await links.get(token);
      if (!connection || await users.hash(connection.user) !== connection.tokenHash) { linkFailed(); throw new HttpError(410, 'Conexión vencida o revocada.'); }
      if (req.url === '/connect/cancel') { await links.consume(token); send(200, { cancelled: true }); return; }
      if (req.url !== '/connect/login') throw new HttpError(404, 'Ruta no disponible.');
      if (connection.busy || connection.attempts >= 5 || !await links.budget(`login:${connection.user}`, 10)) throw new HttpError(429, 'Demasiados intentos. Pide un enlace nuevo más tarde.');
      let claimed = false, refund = false;
      let data: Record<string, unknown> = {};
      try {
        const parsed = await body(req, 16384);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Solicitud no válida.');
        data = parsed as Record<string, unknown>;
        if (Object.keys(data).some(k => !['username', 'password'].includes(k)) || typeof data.username !== 'string' || !data.username.trim() || data.username.length > 320 || typeof data.password !== 'string' || !data.password || data.password.length > 4096) throw new HttpError(400, 'Revisa correo y contraseña.');
        // Claim first: a duplicate submit that only finds the link busy uses no sign-in attempt.
        if (!await links.claim(token)) throw new HttpError(429, 'Conexión en uso o vencida. Pide un enlace nuevo.');
        claimed = true;
        // Proof of ownership: the Cinve connection this account was connected through before.
        const subject: SignInSubject = { network: ip, provider: connection.provider, username: data.username, proofs: [`principal:${connection.user}`] };
        const refusal = await links.admitSignIn(subject);
        if (refusal) { refund = true; throw new HttpError(429, signInRefusalMessage[refusal]); }
        let stagedSession: AuthSession | undefined;
        // Stage credentials in memory. Commit only if the invitation still exists
        // after upstream login (disconnect/cancel/revocation may happen meanwhile).
        const staged = new class extends SessionStore { override async save(value: AuthSession) { stagedSession = value; } }();
        let profile = false;
        const started = Date.now();
        try {
          const result = await (options.authenticate ?? login)(connection.provider, data.username.trim(), data.password, staged);
          profile = result.profile_update_requested;
        } catch (error) {
          // Nothing was tested: the link keeps its attempt too.
          if (await links.signInError(subject, error) === 'unavailable') { refund = true; throw new HttpError(503, cinemaUnavailableMessage); }
          await signInFloor(started, options.signInFloorMs);
          throw new HttpError(401, 'No se pudo conectar. Revisa tus datos o comprueba en la web del cine si requiere una verificación adicional.');
        }
        // Not a refusal of the credentials, so it is not counted as a failure.
        if (!stagedSession || stagedSession.provider !== connection.provider) throw new HttpError(502, 'El cine no entregó una sesión válida.');
        await links.signInSucceeded(subject);
        if (!await links.complete(token, stagedSession, options.key)) throw new HttpError(410, 'Conexión cancelada, vencida o revocada.');
        send(200, { connected: true, profile_update_requested: profile });
      } finally { data.username = ''; data.password = ''; if (claimed) await links.release(token, refund); }
    } catch (error) {
      // People following a broken link get a page; API clients keep JSON.
      if (error instanceof HttpError && error.status === 404 && ['GET', 'HEAD'].includes(req.method ?? '') && req.headers.accept?.includes('text/html') && !res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : notFoundPage()); return;
      }
      send(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message
        : req.url === '/mcp' ? 'Could not complete the request.' : 'No se pudo completar la solicitud.' });
    }
  };
  const server = nodeServer(handler);
  server.on('listening', () => {
    const address = server.address();
    if (options.allowLocal && publicUrl.port === '0' && address && typeof address !== 'string') {
      publicUrl.port = String(address.port); origin = publicUrl.origin;
    }
  });
  server.requestTimeout = 75000; server.headersTimeout = 10000; server.maxConnections = 128;
  return { handler, server, users, links, storeFor, oauth };
}
