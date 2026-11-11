import { landingPage, servePublicAsset, setSecurityHeaders } from './public-web.js';
import { hostedAuthInstructions } from './hosted-auth-guidance.js';
import { HostedOAuth, accessTokenFormat } from './oauth.js';
import { LocalLimiter } from './local-limit.js';
import { ClientMetadataCache } from './client-metadata.js';
import { addressBytes } from './client-metadata.js';
import type { ClientMetadataFetcher } from './client-metadata.js';
import { serveInstall } from './install.js';
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
import { ConnectionLinks, signInRefusalMessage } from './hosted-links.js';
import type { SignInSubject } from './hosted-links.js';
import { EncryptedSessionStore, HostedUsers, digest } from './hosted-store.js';
import { loginPage, loginScript } from './auth-web.js';

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
    if (status === 'auth_required' && this.store && (provider === 'cinex' || provider === 'cinesunidos') && this.client.rejectedSessions.has(provider))
      await this.store.discardRejected(provider).catch(() => {});
  }
  override async query(op: Operation, q: Query, call?: CallOptions) {
    const result = await super.query(op, q, call);
    await this.rejected(result.status, q.provider);
    if (result.status === 'auth_required') result.warnings = ['Conecta tu cuenta con connect_account. Introduce tus credenciales solo en el enlace privado, nunca en el chat.'];
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
  if (!bytes) return address;
  if (bytes.length === 4) return bytes.join('.');
  if (bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join('.');
  return Buffer.from(bytes.slice(0, 8)).toString('hex').replace(/(.{4})(?!$)/g, '$1:') + '::/64';
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function body(req: IncomingMessage, max: number, deadlineMs = 10000): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'Se requiere JSON.');
  if (Number(req.headers['content-length'] ?? 0) > max) throw new HttpError(413, 'Solicitud demasiado grande.');
  const chunks: Buffer[] = []; let size = 0;
  // A slow sender must not hold a request slot indefinitely. On Vercel the
  // node:http server timeouts do not apply to the exported handler.
  const timer = setTimeout(() => req.destroy(new HttpError(408, 'La solicitud tardó demasiado.')), deadlineMs);
  try {
    for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, 'Solicitud demasiado grande.'); chunks.push(Buffer.from(chunk)); }
  } finally { clearTimeout(timer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Solicitud no válida.'); }
}
/** Tool calls in a JSON-RPC message (single or batch) that ask to bypass the public cache. */
function refreshCalls(message: unknown): number {
  const calls = Array.isArray(message) ? message : [message];
  return calls.filter(m => {
    if (!m || typeof m !== 'object') return false;
    const { method, params } = m as { method?: unknown; params?: unknown };
    const args = params && typeof params === 'object' ? (params as { arguments?: unknown }).arguments : undefined;
    return method === 'tools/call' && !!args && typeof args === 'object' && (args as { refresh?: unknown }).refresh === true;
  }).length;
}
export async function createHostedApp(options: {
  publicUrl: string; pool: Pool; key: Buffer; allowLocal?: boolean; trustedVercelProxy?: boolean; cleanupSecret?: string;
  authenticate?: typeof login; request?: typeof fetch; bodyTimeoutMs?: number; clientMetadata?: ClientMetadataFetcher;
}) {
  const publicUrl = new URL(options.publicUrl);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password ||
      (publicUrl.protocol !== 'https:' && !(options.allowLocal && publicUrl.protocol === 'http:' && publicUrl.hostname === '127.0.0.1'))) throw new Error('CINEV_PUBLIC_URL debe ser un origen HTTPS.');
  if (options.key.length !== 32) throw new Error('Clave de cifrado no válida.');
  let origin = publicUrl.origin;
  // A separate subkey: the session encryption key itself never signs anything.
  const tokenKey = Buffer.from(hkdfSync('sha256', options.key, Buffer.alloc(0), 'cinve oauth access token v1', 32));
  const oauth = new HostedOAuth(options.pool, () => origin, new ClientMetadataCache(options.clientMetadata), {
    authenticate: options.authenticate ?? login,
    save: (client, user, session) => new EncryptedSessionStore(options.pool, user, options.key).saveInTransaction(client, session),
  }, tokenKey);
  const users = new HostedUsers(options.pool);
  const links = new ConnectionLinks(options.pool);
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
  // work. Each network gets generous request headroom, and few failed
  // credential lookups (bearer or connection-link tokens) per minute.
  const localRequests = new LocalLimiter(600), localAuthFailures = new LocalLimiter(30);
  const tooManyFailures = () => new HttpError(429, 'Demasiados intentos con credenciales no válidas. Inténtalo en un minuto.');
  const storeFor = (id: string) => new EncryptedSessionStore(options.pool, id, options.key);
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    setSecurityHeaders(res, publicUrl.protocol === 'https:');
    const send = (status: number, data: unknown) => { if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); } };
    try {
      if (servePublicAsset(req, res) || serveInstall(req, res, origin)) return;
      if (req.method === 'GET' && req.url === '/health') { send(200, { status: 'ok' }); return; }
      if (req.headers.host !== publicUrl.host) throw new HttpError(403, 'Origen no permitido.');
      const forwarded = options.trustedVercelProxy ? req.headers['x-vercel-forwarded-for'] : undefined;
      const ip = rateLimitNetwork(typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress ?? 'unknown');
      if (!localRequests.hit(ip)) throw new HttpError(429, 'Demasiadas consultas. Inténtalo más tarde.');
      if (await oauth.handle(req, res, ip)) return;
      if (req.url === '/mcp') {
        // MCP authorization is exclusively bearer-based; cookies are never used,
        // so any web origin may call it. The Host check above blocks DNS
        // rebinding; a present but malformed Origin is still refused, as the
        // Streamable HTTP transport requires for invalid origins.
        if (req.headers.origin !== undefined && !wellFormedOrigin(req.headers.origin)) throw new HttpError(403, 'Origen no permitido.');
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
        if (!options.cleanupSecret || !timingSafeEqual(Buffer.from(digest(req.headers.authorization ?? '')), Buffer.from(digest(`Bearer ${options.cleanupSecret}`)))) throw new HttpError(401, 'Acceso requerido.');
        await links.cleanup(); send(200, { cleaned: true }); return;
      }
      const pagePath = req.url?.split('?')[0];
      if (['GET', 'HEAD'].includes(req.method ?? '') && (pagePath === '/connect' || pagePath === '/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : pagePath === '/' ? landingPage(origin) : loginPage()); return;
      }
      if (req.method === 'GET' && req.url === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(loginScript); return;
      }
      if (req.url === '/mcp') {
        const authorization = req.headers.authorization ?? '';
        const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined;
        // A validly signed token cannot be forged, so it is never held back by
        // others' failures on a shared address; anything else needs a lookup.
        if (authorization && accessTokenFormat(bearer ?? '', tokenKey) !== 'signed' && localAuthFailures.exhausted(ip)) throw tooManyFailures();
        const principal = bearer ? await oauth.authenticate(bearer) ?? await users.authenticate(bearer) : undefined;
        if (authorization && !principal) {
          localAuthFailures.hit(ip);
          res.setHeader('WWW-Authenticate', oauth.challenge(true)); throw new HttpError(401, 'Acceso Cinev requerido.');
        }
        const clientKey = principal?.id ?? `anonymous:${ip}`;
        if (!await links.budget(`mcp:${clientKey}`, 120) || (active.get(clientKey) ?? 0) >= 4 || totalActive >= 32) throw new HttpError(429, 'Demasiadas consultas. Inténtalo más tarde.');
        // Reserve capacity synchronously with the check, before awaiting the
        // body, so concurrent slow uploads cannot all pass the same admission.
        active.set(clientKey, (active.get(clientKey) ?? 0) + 1); totalActive++;
        let handler: ReturnType<typeof createMcpHandler> | undefined;
        try {
          const parsed = req.method === 'POST' ? await body(req, 65536, options.bodyTimeoutMs) : undefined;
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
          const refreshes = refreshCalls(parsed);
          // A service-wide cap too, since many addresses could each use their own.
          if (refreshes && (!await links.budget(`refresh:${clientKey}`, 10) || !await links.budget('refresh:global', 120))) throw new HttpError(429, 'Demasiadas consultas con refresh=true. Repite sin refresh o inténtalo en un minuto.');
          const store = principal ? storeFor(principal.id) : new AnonymousSessions(origin);
          const service = new HostedService(new HostedHttpClient(options.request ?? fetch, 15000, store, publicHttp), cinexCatalog,
            store instanceof EncryptedSessionStore ? store : undefined);
          handler = createMcpHandler(() => createServer(service, principal ? {
            connect: async provider => {
              // An account connected while authorizing (or earlier) needs no link.
              if ((await store.status(provider)).status === 'configured') return { connected: true as const };
              if (!await links.budget(`link:${principal.id}`, 12)) throw new Error('Demasiados enlaces. Inténtalo en un minuto.');
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
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(403, 'Enlace no válido.');
      if (localAuthFailures.exhausted(ip)) throw tooManyFailures();
      if (req.url === '/connect/exchange') {
        await body(req, 512);
        const exchanged = await links.exchange(token);
        if (!exchanged || await users.hash(exchanged.connection.user) !== exchanged.connection.tokenHash) { localAuthFailures.hit(ip); throw new HttpError(410, 'Enlace vencido o utilizado.'); }
        send(200, { browser_token: exchanged.browserToken, provider: exchanged.connection.provider, app: await oauth.appFor(exchanged.connection.user) ?? null }); return;
      }
      const connection = await links.get(token);
      if (!connection || await users.hash(connection.user) !== connection.tokenHash) { localAuthFailures.hit(ip); throw new HttpError(410, 'Conexión vencida o revocada.'); }
      if (req.url === '/connect/cancel') { await links.consume(token); send(200, { cancelled: true }); return; }
      if (req.url !== '/connect/login') throw new HttpError(404, 'Ruta no disponible.');
      if (connection.busy || connection.attempts >= 5 || !await links.budget(`login:${connection.user}`, 10)) throw new HttpError(429, 'Demasiados intentos. Pide un enlace nuevo más tarde.');
      let claimed = false;
      let data: Record<string, unknown> = {};
      try {
        const parsed = await body(req, 16384);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Solicitud no válida.');
        data = parsed as Record<string, unknown>;
        if (Object.keys(data).some(k => !['username', 'password'].includes(k)) || typeof data.username !== 'string' || !data.username.trim() || data.username.length > 320 || typeof data.password !== 'string' || !data.password || data.password.length > 4096) throw new HttpError(400, 'Revisa correo y contraseña.');
        const subject: SignInSubject = { network: ip, provider: connection.provider, username: data.username };
        const refusal = await links.admitSignIn(subject);
        if (refusal) throw new HttpError(429, signInRefusalMessage[refusal]);
        if (!await links.claim(token)) throw new HttpError(429, 'Conexión en uso o vencida. Pide un enlace nuevo.');
        claimed = true;
        let stagedSession: AuthSession | undefined;
        // Stage credentials in memory. Commit only if the invitation still exists
        // after upstream login (disconnect/cancel/revocation may happen meanwhile).
        const staged = new class extends SessionStore { override async save(value: AuthSession) { stagedSession = value; } }();
        let profile = false;
        try {
          const result = await (options.authenticate ?? login)(connection.provider, data.username.trim(), data.password, staged);
          profile = result.profile_update_requested;
        } catch {
          await links.signInFailed(subject);
          throw new HttpError(401, 'No se pudo conectar. Revisa tus datos o comprueba en la web del cine si requiere una verificación adicional.');
        }
        if (!stagedSession || stagedSession.provider !== connection.provider) { await links.signInFailed(subject); throw new HttpError(502, 'El cine no entregó una sesión válida.'); }
        await links.signInSucceeded(subject);
        if (!await links.complete(token, stagedSession, options.key)) throw new HttpError(410, 'Conexión cancelada, vencida o revocada.');
        send(200, { connected: true, profile_update_requested: profile });
      } finally { data.username = ''; data.password = ''; if (claimed) await links.release(token); }
    } catch (error) {
      send(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'No se pudo completar la solicitud.' });
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
  return { handler, server, users, links, storeFor };
}
