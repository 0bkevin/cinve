import { hostedAuthInstructions } from './hosted-auth-guidance.js';
import { HostedOAuth } from './oauth.js';
import { serveInstall } from './install.js';
import { createServer as nodeServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';
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
import { ConnectionLinks } from './hosted-links.js';
import { EncryptedSessionStore, HostedUsers, digest } from './hosted-store.js';
import { connectionHomePage, loginPage, loginScript } from './auth-web.js';

class AnonymousSessions extends SessionStore {
  override async read(): Promise<AuthSession | undefined> { return undefined; }
  override async save(): Promise<void> { throw new Error("Anonymous sessions cannot persist credentials."); }
  override async remove(): Promise<void> { throw new Error("Anonymous sessions cannot modify credentials."); }
  override async status(p: AuthProviderId) {
    return { ...await super.status(p), status: 'client_authorization_required', login_command: hostedAuthInstructions };
  }
}

class HostedService extends CinemaService {
  constructor(http: HttpClient, catalog: CinexCinemaCatalog) { super(http, catalog); }
  override async query(op: Operation, q: Query) {
    const result = await super.query(op, q);
    if (result.status === 'auth_required') result.warnings = ['Conecta tu cuenta con connect_account. Introduce tus credenciales solo en el enlace privado, nunca en el chat.'];
    return result;
  }
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function body(req: IncomingMessage, max: number): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'Se requiere JSON.');
  if (Number(req.headers['content-length'] ?? 0) > max) throw new HttpError(413, 'Solicitud demasiado grande.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, 'Solicitud demasiado grande.'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Solicitud no válida.'); }
}
export async function createHostedApp(options: {
  publicUrl: string; pool: Pool; key: Buffer; allowLocal?: boolean; trustedVercelProxy?: boolean; cleanupSecret?: string;
  authenticate?: typeof login; request?: typeof fetch;
}) {
  const publicUrl = new URL(options.publicUrl);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password ||
      (publicUrl.protocol !== 'https:' && !(options.allowLocal && publicUrl.protocol === 'http:' && publicUrl.hostname === '127.0.0.1'))) throw new Error('CINEV_PUBLIC_URL debe ser un origen HTTPS.');
  if (options.key.length !== 32) throw new Error('Clave de cifrado no válida.');
  let origin = publicUrl.origin;
  const oauth = new HostedOAuth(options.pool, () => origin);
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
  const storeFor = (id: string) => new EncryptedSessionStore(options.pool, id, options.key);
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (publicUrl.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = (status: number, data: unknown) => { if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); } };
    try {
      if (serveInstall(req, res, origin)) return;
      if (req.method === 'GET' && req.url === '/health') { send(200, { status: 'ok' }); return; }
      if (req.headers.host !== publicUrl.host) throw new HttpError(403, 'Origen no permitido.');
      const forwarded = options.trustedVercelProxy ? req.headers['x-vercel-forwarded-for'] : undefined;
      const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress ?? 'unknown';
      if (await oauth.handle(req, res, ip)) return;
      if (req.url === '/mcp') {
        // MCP authorization is exclusively bearer-based; cookies are never used.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID');
        res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Session-Id');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      } else if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Origen no permitido.');
      if (req.method === 'GET' && req.url === '/internal/cleanup') {
        if (!options.cleanupSecret || !timingSafeEqual(Buffer.from(digest(req.headers.authorization ?? '')), Buffer.from(digest(`Bearer ${options.cleanupSecret}`)))) throw new HttpError(401, 'Acceso requerido.');
        await links.cleanup(); send(200, { cleaned: true }); return;
      }
      if (req.method === 'GET' && (req.url === '/connect' || req.url === '/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.url === '/' ? connectionHomePage() : loginPage()); return;
      }
      if (req.method === 'GET' && req.url === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(loginScript); return;
      }
      if (req.url === '/mcp') {
        const authorization = req.headers.authorization ?? '';
        const principal = authorization.startsWith('Bearer ') ? await oauth.authenticate(authorization.slice(7)) ?? await users.authenticate(authorization.slice(7)) : undefined;
        if (authorization && !principal) { res.setHeader('WWW-Authenticate', oauth.challenge(true)); throw new HttpError(401, 'Acceso Cinev requerido.'); }
        const clientKey = principal?.id ?? `anonymous:${ip}`;
        if (!await links.budget(`mcp:${clientKey}`, 120) || (active.get(clientKey) ?? 0) >= 4 || totalActive >= 32) throw new HttpError(429, 'Demasiadas consultas. Inténtalo más tarde.');
        const parsed = req.method === 'POST' ? await body(req, 65536) : undefined;
        // Discover public tools anonymously. Calling the connection tool triggers
        // the client's standard OAuth flow, which retries this same tool afterward.
        if (!principal && parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            'method' in parsed && parsed.method === 'tools/call' && 'params' in parsed &&
            parsed.params && typeof parsed.params === 'object' && 'name' in parsed.params &&
            ['connect_account', 'disconnect_account'].includes(String(parsed.params.name))) {
          res.setHeader('WWW-Authenticate', oauth.challenge());
          throw new HttpError(401, hostedAuthInstructions);
        }
        active.set(clientKey, (active.get(clientKey) ?? 0) + 1); totalActive++;
        const store = principal ? storeFor(principal.id) : new AnonymousSessions();
        const service = new HostedService(new HostedHttpClient(options.request ?? fetch, 15000, store, publicHttp), cinexCatalog);
        const handler = createMcpHandler(() => createServer(service, principal ? {
          connect: async provider => {
            if (!await links.budget(`link:${principal.id}`, 12)) throw new Error('Demasiados enlaces. Inténtalo en un minuto.');
            const link = await links.issue(principal.id, principal.tokenHash, provider);
            return { url: `${origin}/connect#${link.token}`, expires_at: link.expires_at };
          },
          disconnect: async provider => { await store.remove(provider); },
        } : undefined, !principal), { maxSubscriptions: 0, keepAliveMs: 0 });
        try {
          await toNodeHandler(handler)(req, res, parsed);
        } finally { await handler.close(); active.set(clientKey, active.get(clientKey)! - 1); if (!active.get(clientKey)) active.delete(clientKey); totalActive--; }
        return;
      }
      if (!req.url?.startsWith('/connect/') || req.method !== 'POST') throw new HttpError(404, 'Ruta no disponible.');
      if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw new HttpError(403, 'Origen no permitido.');
      const token = req.headers['x-cinev-connection'];
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(403, 'Enlace no válido.');
      if (req.url === '/connect/exchange') {
        await body(req, 512);
        const exchanged = await links.exchange(token);
        if (!exchanged || await users.hash(exchanged.connection.user) !== exchanged.connection.tokenHash) throw new HttpError(410, 'Enlace vencido o utilizado.');
        send(200, { browser_token: exchanged.browserToken, provider: exchanged.connection.provider, user_label: exchanged.connection.user.slice(0, 8) }); return;
      }
      const connection = await links.get(token);
      if (!connection || await users.hash(connection.user) !== connection.tokenHash) throw new HttpError(410, 'Conexión vencida o revocada.');
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
        } catch { throw new HttpError(401, 'No se pudo conectar. Revisa tus datos o comprueba en la web del cine si requiere una verificación adicional.'); }
        if (!stagedSession || stagedSession.provider !== connection.provider) throw new HttpError(502, 'El cine no entregó una sesión válida.');
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
