import { authorizationPage, authorizationErrorPage, styleSource } from './public-web.js';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import * as z from 'zod';
import { digest, lockUser, transaction } from './hosted-store.js';
import { ConnectionLinks, cinemaUnavailableMessage, ipv6Block, signInFloor, signInRefusalMessage } from './hosted-links.js';
import { ClientMetadataCache, isClientIdUrl, redirectUri } from './client-metadata.js';
import { AuthProvider, SessionStore } from './auth.js';
import type { AuthProviderId, AuthSession, login } from './auth.js';

/** Signs in to a cinema during approval and stores the session for the new connection. */
export type ConsentAccounts = {
  authenticate: typeof login;
  save(client: PoolClient, user: string, session: AuthSession): Promise<void>;
  /** Minimum time before answering a refused sign-in (see signInFloor). */
  refusalFloorMs?: number;
};
type ConsentForm = { error?: string; provider?: AuthProviderId; username?: string };

const scope = 'cinve:accounts';
const secret = () => randomBytes(32).toString('base64url');
const registration = z.object({
  client_name: z.string().trim().min(1).max(100).default('Asistente'),
  redirect_uris: z.array(redirectUri).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).default(['code']),
});
/** Until when (epoch ms) unsigned tokens and links issued before signing are accepted. */
export type LegacyCutoffs = { access: number; refresh: number; link: number };
/**
 * Cutoffs from the moment the first instance began signing (recorded in
 * cinev_meta, so they follow the real deployment, not a fixed date). Access
 * tokens and links last at most an hour and refresh tokens their 30-day
 * grant; a day of margin covers instances of the previous version still
 * issuing unsigned ones during a rolling deploy. Without that record (a
 * deployment before migration 006) every legacy token keeps working.
 */
export function legacyCutoffs(since: Date | undefined): LegacyCutoffs {
  if (!since) return { access: Infinity, refresh: Infinity, link: Infinity };
  const day = 86400000, t = since.getTime();
  return { access: t + day, refresh: t + 31 * day, link: t + day };
}
/** Records (once) and reads when signing began. */
export async function readLegacyCutoffs(pool: Pool): Promise<LegacyCutoffs> {
  try {
    const { rows } = await pool.query(`WITH ins AS (INSERT INTO cinev_meta(key,value) VALUES('token_signing_since',now()) ON CONFLICT (key) DO NOTHING RETURNING value)
      SELECT value FROM ins UNION ALL SELECT value FROM cinev_meta WHERE key='token_signing_since'`);
    return legacyCutoffs(rows[0]?.value);
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return legacyCutoffs(undefined); // Migration 006 pending.
    throw error;
  }
}
type TokenPrefix = 'cva_' | 'cvr_';
// The prefix is part of the signed text, so an access signature never validates a refresh token.
const tokenMac = (key: Buffer, prefix: TokenPrefix, id: string) => createHmac('sha256', key).update(prefix + id).digest('base64url');
const signedToken = (key: Buffer, prefix: TokenPrefix) => { const id = secret(); return `${prefix}${id}.${tokenMac(key, prefix, id)}`; };
/**
 * Which kind of token this is, judged in memory: 'signed' when its HMAC is
 * valid, 'legacy' for the unsigned format before the cutoff, and undefined
 * otherwise. Only these reach the database, so a flood of forged tokens
 * costs no queries.
 */
function tokenFormat(prefix: TokenPrefix, cutoff: number, token: string, key: Buffer, now: number): 'signed' | 'legacy' | undefined {
  if (!token.startsWith(prefix)) return undefined;
  const signed = token.slice(prefix.length).match(/^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/);
  if (signed) return timingSafeEqual(Buffer.from(signed[2]), Buffer.from(tokenMac(key, prefix, signed[1]))) ? 'signed' : undefined;
  return /^[A-Za-z0-9_-]{43}$/.test(token.slice(prefix.length)) && now < cutoff ? 'legacy' : undefined;
}
/** legacyUntil: when unsigned tokens stop being accepted (Infinity: still accepted). */
export const accessTokenFormat = (token: string, key: Buffer, legacyUntil = Infinity, now = Date.now()) => tokenFormat('cva_', legacyUntil, token, key, now);
export const refreshTokenFormat = (token: string, key: Buffer, legacyUntil = Infinity, now = Date.now()) => tokenFormat('cvr_', legacyUntil, token, key, now);
class OAuthError extends Error {
  constructor(readonly error: string, readonly status = 400) { super(error); }
}
function required(value: string | null | undefined) {
  if (!value) throw new OAuthError('invalid_request');
  return value;
}
async function payload(req: IncomingMessage, json = false) {
  const type = req.headers['content-type']?.split(';')[0].trim();
  if (type !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 415);
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw new OAuthError('invalid_request', 413);
    chunks.push(Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString('utf8');
  if (json) { try { return JSON.parse(value) as unknown; } catch { throw new OAuthError('invalid_request'); } }
  const params = new URLSearchParams(value);
  for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request');
  return params;
}
async function revoke(client: PoolClient, user: string) {
  await client.query('UPDATE cinev_clients SET revoked_at=now() WHERE id=$1', [user]);
  await client.query('DELETE FROM cinev_links WHERE user_id=$1', [user]);
  await client.query('DELETE FROM cinev_sessions WHERE user_id=$1', [user]);
}

/**
 * A destination Cinve can vouch for: a loopback redirect keeps the code on the
 * user's own machine, and a metadata-document client's redirect on the site
 * that published the document is controlled by that site. Anything else (any
 * registered client with a web redirect) gets a visible warning on consent.
 */
export function recognizedDestination(redirect: string, publisher?: string) {
  const host = new URL(redirect).hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return true;
  if (!publisher) return false;
  const site = publisher.toLowerCase();
  return host === site || host.endsWith('.' + site);
}

/** Self-service, isolated connections. Approval creates a NEW empty principal;
 * it never grants access to an existing cinema session or browser identity. */
export class HostedOAuth {
  private authorizations = 0;
  private cutoffs?: Promise<LegacyCutoffs>;
  /** The legacy cutoffs, read once per instance (and retried after a failure). */
  legacy(): Promise<LegacyCutoffs> {
    return this.cutoffs ??= readLegacyCutoffs(this.pool).catch(error => { this.cutoffs = undefined; throw error; });
  }
  /**
   * Whether a token has an acceptable format. Only a legacy-format token
   * needs the cutoff, so signed and forged ones never cause a query.
   */
  private async acceptable(kind: 'access' | 'refresh', token: string) {
    const format = (kind === 'access' ? accessTokenFormat : refreshTokenFormat)(token, this.tokenKey);
    return format === 'legacy' ? Date.now() < (await this.legacy())[kind] : !!format;
  }
  /** tokenKey: a 32-byte key for signing tokens, the same on every instance; budgets: rate limits (with their key). */
  constructor(readonly pool: Pool, readonly getOrigin: () => string, private readonly clientMetadata: ClientMetadataCache,
    private readonly accounts: ConsentAccounts | undefined, private readonly tokenKey: Buffer, private readonly budgets: ConnectionLinks) {
    if (tokenKey.length !== 32) throw new Error('Clave de firma no válida.');
  }
  /** The consent page, which can also sign in to a cinema; re-rendered with an error after a failed sign-in. */
  private consent(res: ServerResponse, status: number, app: { id: string; name: string }, redirect: string, id: string, csrf: string, form: ConsentForm = {}) {
    // A native form POST inherits this policy. no-referrer makes browsers
    // send Origin: null, which our same-origin CSRF check correctly rejects.
    // Keep referrers private across origins, including the assistant callback.
    res.setHeader('Referrer-Policy', 'same-origin');
    // Chromium also checks form-action against the POST's redirect target.
    // Only allow the already-validated callback origin, never arbitrary sites.
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src ${styleSource}; font-src 'self'; img-src 'self'; form-action 'self' ${new URL(redirect).origin}; frame-ancestors 'none'; base-uri 'none'`);
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    const publisher = isClientIdUrl(app.id) ? new URL(app.id).hostname : undefined;
    res.end(authorizationPage({ app: app.name, destination: new URL(redirect).origin, id, csrf, publisher,
      recognized: recognizedDestination(redirect, publisher), cinemaLogin: !!this.accounts, ...form }));
  }
  /**
   * A client_id that is an HTTPS URL is a Client ID Metadata Document: fetch
   * and validate it, then keep an app row so grants and tokens reference it
   * like any other client. Failures never redirect to the unverified client.
   */
  private async metadataApp(clientId: string, ip: string) {
    if (!await this.budgets.budget(`oauth:metadata:${ip}`, 20)) throw new OAuthError('temporarily_unavailable', 429);
    let metadata;
    try { metadata = await this.clientMetadata.get(clientId); } catch { throw new OAuthError('invalid_client'); }
    const { rows } = await this.pool.query(`INSERT INTO cinev_oauth_apps(id,name,redirect_uris) VALUES($1,$2,$3)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, redirect_uris=EXCLUDED.redirect_uris RETURNING *`,
      [clientId, metadata.client_name, JSON.stringify(metadata.redirect_uris)]);
    return rows[0];
  }
  /** The assistant app an account connection belongs to; undefined for operator-issued access. */
  async appFor(user: string): Promise<{ name: string; publisher: string | null; verified: boolean } | undefined> {
    const { rows } = await this.pool.query(`SELECT a.id,a.name,a.redirect_uris FROM cinev_oauth_grants g JOIN cinev_oauth_apps a ON a.id=g.app_id
      WHERE g.user_id=$1`, [user]);
    if (!rows[0]) return undefined;
    const publisher = isClientIdUrl(rows[0].id) ? new URL(rows[0].id).hostname : undefined;
    // A link can be forwarded to someone else, so loopback earns no trust here:
    // anyone can register a local app on their own machine. Only a client
    // identified by its metadata document, redirecting to that same site, is.
    const verified = !!publisher && (rows[0].redirect_uris as string[]).every(uri => {
      const host = new URL(uri).hostname.toLowerCase();
      return host === publisher || host.endsWith('.' + publisher);
    });
    return { name: rows[0].name, publisher: publisher ?? null, verified };
  }
  get resource() { return this.getOrigin() + '/mcp'; }
  challenge(invalid = false) {
    return `Bearer resource_metadata="${this.getOrigin()}/.well-known/oauth-protected-resource/mcp", scope="${scope}"${invalid ? ', error="invalid_token"' : ''}`;
  }
  async authenticate(token: string) {
    if (!await this.acceptable('access', token)) return undefined;
    const { rows } = await this.pool.query(`SELECT c.id,c.token_hash FROM cinev_oauth_tokens t
      JOIN cinev_oauth_grants g ON g.user_id=t.user_id JOIN cinev_clients c ON c.id=t.user_id
      WHERE t.token_hash=$1 AND t.kind='access' AND t.expires_at>clock_timestamp()
      AND g.expires_at>clock_timestamp() AND g.resource=$2 AND c.revoked_at IS NULL`, [digest(token), this.resource]);
    return rows[0] ? { id: rows[0].id as string, tokenHash: rows[0].token_hash as string } : undefined;
  }
  private async tokens(client: PoolClient, user: string) {
    const access = signedToken(this.tokenKey, 'cva_'), refresh = signedToken(this.tokenKey, 'cvr_');
    await client.query(`INSERT INTO cinev_oauth_tokens(token_hash,user_id,kind,expires_at) VALUES
      ($1,$3,'access',now()+interval '1 hour'),
      ($2,$3,'refresh',(SELECT expires_at FROM cinev_oauth_grants WHERE user_id=$3))`, [digest(access), digest(refresh), user]);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope };
  }
  /** Retention metadata only; never part of the token transaction or its outcome. */
  private async touch(app: string) {
    await this.pool.query('UPDATE cinev_oauth_apps SET last_used_at=now() WHERE id=$1', [app]).catch(() => {});
  }
  /**
   * admit charges the caller's rate limits. It runs after every check that
   * needs no database, so malformed or forged requests cost nothing, and
   * before the first query.
   */
  private async exchange(p: URLSearchParams, admit: () => Promise<void>) {
    const app = required(p.get('client_id'));
    if (p.get('resource') !== this.resource) throw new OAuthError('invalid_target');
    if (p.has('client_secret')) throw new OAuthError('invalid_client');
    const grant = p.get('grant_type');
    if (grant === 'authorization_code') {
      const code = required(p.get('code')), verifier = required(p.get('code_verifier'));
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new OAuthError('invalid_grant');
      await admit();
      const result = await transaction(this.pool, async client => {
        // Expiry is judged on the database clock, the same one cleanup uses.
        const { rows } = await client.query('SELECT *, expires_at>clock_timestamp() AS live FROM cinev_oauth_requests WHERE code_hash=$1 FOR UPDATE', [digest(code)]);
        const r = rows[0];
        if (!r || r.app_id !== app || r.resource !== this.resource || r.redirect_uri !== p.get('redirect_uri') ||
            r.challenge !== createHash('sha256').update(verifier).digest('base64url') || !r.live) return undefined;
        if (r.consumed_at) {
          if (r.user_id) { await lockUser(client, r.user_id); await revoke(client, r.user_id); }
          return undefined;
        }
        const user: string = r.user_id ?? randomUUID();
        if (!r.user_id) await client.query('INSERT INTO cinev_clients(id,token_hash) VALUES($1,$2)', [user, digest(secret())]);
        await client.query(`INSERT INTO cinev_oauth_grants(user_id,app_id,resource,expires_at) VALUES($1,$2,$3,now()+interval '30 days')`, [user, app, this.resource]);
        await client.query('UPDATE cinev_oauth_requests SET consumed_at=now(),user_id=$2 WHERE id=$1', [r.id, user]);
        return this.tokens(client, user);
      });
      if (!result) throw new OAuthError('invalid_grant');
      await this.touch(app);
      return result;
    }
    if (grant === 'refresh_token') {
      const token = required(p.get('refresh_token'));
      if (!await this.acceptable('refresh', token)) throw new OAuthError('invalid_grant'); // Forged: no database work.
      if (p.has('scope') && p.get('scope') !== scope) throw new OAuthError('invalid_scope');
      await admit();
      const result = await transaction(this.pool, async client => {
        const find = () => client.query(`SELECT t.*,g.app_id,g.resource,g.expires_at AS grant_expiry FROM cinev_oauth_tokens t
          JOIN cinev_oauth_grants g ON g.user_id=t.user_id WHERE t.token_hash=$1 AND t.kind='refresh'`, [digest(token)]);
        const candidate = (await find()).rows[0];
        if (!candidate || candidate.app_id !== app || candidate.resource !== this.resource || !await lockUser(client, candidate.user_id)) return undefined;
        const r = (await find()).rows[0];
        if (!r) return undefined; // Removed by cleanup or revocation meanwhile.
        if (r.used_at) { await revoke(client, r.user_id); return undefined; }
        if (r.expires_at.getTime() <= Date.now() || r.grant_expiry.getTime() <= Date.now()) return undefined;
        await client.query('UPDATE cinev_oauth_tokens SET used_at=now() WHERE token_hash=$1', [digest(token)]);
        return this.tokens(client, r.user_id);
      });
      if (!result) throw new OAuthError('invalid_grant');
      await this.touch(app);
      return result;
    }
    throw new OAuthError('unsupported_grant_type');
  }
  async handle(req: IncomingMessage, res: ServerResponse, ip: string): Promise<boolean> {
    const origin = this.getOrigin(), url = new URL(req.url!, origin), path = url.pathname;
    const metadata = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'];
    if (!metadata.includes(path) && !['/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke'].includes(path)) return false;
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    // OAuth discovery/token endpoints are usable by browser-based MCP clients.
    // They never accept cookies as credentials. The approval endpoint is same-origin.
    if (path !== '/oauth/authorize') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    }
    try {
      if (metadata.includes(path) && req.method === 'GET') {
        send(200, path.includes('oauth-protected-resource') ? {
          resource: this.resource, authorization_servers: [origin], scopes_supported: [scope], bearer_methods_supported: ['header'],
        } : {
          issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token',
          // Client ID Metadata Documents are the preferred registration. The
          // registration endpoint (Dynamic Client Registration, deprecated in
          // 2026-07-28) stays for clients that do not support them yet; its
          // removal is tracked in https://github.com/0bkevin/cinve/issues/21.
          client_id_metadata_document_supported: true,
          registration_endpoint: origin + '/oauth/register', revocation_endpoint: origin + '/oauth/revoke',
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'], scopes_supported: [scope], authorization_response_iss_parameter_supported: true,
        });
        return true;
      }
      // Per network (and IPv6 /48), then a service-wide quota charged only when
      // the caller's own admits the request, so one network cannot spend it.
      // The shared quota applies only where new rows are created (registration
      // and starting an authorization): refreshing, exchanging a code or
      // revoking never depends on what other networks do.
      const admit = async (shared?: { key: string; limit: number }) => {
        const block = ipv6Block(ip);
        if (!await this.budgets.budget(`oauth:${ip}`, 60) || (block && !await this.budgets.budget(`oauth:${block}`, 240)) ||
            (shared && !await this.budgets.budget(shared.key, shared.limit))) throw new OAuthError('temporarily_unavailable', 429);
      };
      if (path === '/oauth/register' && req.method === 'POST') {
        // Registrations are rare (once per installed client) and each adds a row kept up to 90 days.
        await admit({ key: 'oauth:register:global', limit: 60 });
        if (!await this.budgets.budget(`oauth:register:${ip}`, 10)) throw new OAuthError('temporarily_unavailable', 429);
        const parsed = registration.safeParse(await payload(req, true));
        if (!parsed.success || !parsed.data.grant_types.includes('authorization_code') || !parsed.data.response_types.includes('code')) throw new OAuthError('invalid_client_metadata');
        const p = parsed.data, id = 'cvapp_' + secret();
        await this.pool.query('INSERT INTO cinev_oauth_apps(id,name,redirect_uris) VALUES($1,$2,$3)', [id, p.client_name, JSON.stringify(p.redirect_uris)]);
        send(201, { ...p, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) }); return true;
      }
      if (path === '/oauth/authorize' && req.method === 'GET') {
        // Each authorization start adds a request row. Unbound expired ones
        // (no connection attached) are dropped as they accumulate; requests
        // holding a connection or a consumed code are left to cleanup.
        if (++this.authorizations % 50 === 0) await this.pool.query(`DELETE FROM cinev_oauth_requests WHERE id IN (SELECT id FROM cinev_oauth_requests
          WHERE expires_at<=now() AND user_id IS NULL LIMIT 500)`).catch(() => {});
        const p = url.searchParams;
        for (const key of p.keys()) if (p.getAll(key).length !== 1) throw new OAuthError('invalid_request');
        const clientId = required(p.get('client_id')), redirect = required(p.get('redirect_uri'));
        // Checks that need no database come first. Errors are rendered here and
        // never redirected, so their order does not matter to the client.
        if (p.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type');
        if (p.get('resource') !== this.resource) throw new OAuthError('invalid_target');
        if (p.has('scope') && p.get('scope') !== scope) throw new OAuthError('invalid_scope');
        if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? '')) throw new OAuthError('invalid_request');
        if ((p.get('state')?.length ?? 0) > 2048) throw new OAuthError('invalid_request');
        await admit({ key: 'oauth:global', limit: 600 });
        const app = isClientIdUrl(clientId) ? await this.metadataApp(clientId, ip)
          : (await this.pool.query('SELECT * FROM cinev_oauth_apps WHERE id=$1', [clientId])).rows[0];
        // Never redirect errors to an unvalidated client URI.
        if (!app || !app.redirect_uris.includes(redirect)) throw new OAuthError('invalid_request');
        const id = randomBytes(16).toString('hex'), csrf = secret();
        await this.pool.query(`INSERT INTO cinev_oauth_requests(id,app_id,redirect_uri,resource,state,challenge,csrf_hash,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`, [id, app.id, redirect, this.resource, p.get('state'), p.get('code_challenge'), digest(csrf)]);
        res.setHeader('Set-Cookie', `cinve_approval_${id}=${csrf}; HttpOnly; SameSite=Lax; Path=/oauth/authorize; Max-Age=600${origin.startsWith('https:') ? '; Secure' : ''}`);
        this.consent(res, 200, app, redirect, id, csrf);
        return true;
      }
      if (path === '/oauth/authorize' && req.method === 'POST') {
        if (req.headers.origin !== origin) throw new OAuthError('invalid_request', 403);
        await admit();
        const p = await payload(req) as URLSearchParams;
        const id = required(p.get('request_id')), csrf = required(p.get('csrf')), decision = p.get('decision') ?? '';
        if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || !['connect', 'approve', 'deny'].includes(decision) ||
            (decision === 'connect' && !this.accounts)) throw new OAuthError('invalid_request');
        const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`cinve_approval_${id}=`))?.split('=')[1];
        if (cookie !== csrf) throw new OAuthError('invalid_request', 403);
        // Approving and connecting a cinema in one step. The upstream sign-in
        // never runs inside a transaction; its session is committed together
        // with the code below, or not at all.
        let session: AuthSession | undefined, claimed = false;
        const release = () => this.pool.query('UPDATE cinev_oauth_requests SET busy_until=NULL WHERE id=$1', [id]).catch(() => {});
        try {
          if (decision === 'connect') {
            const info = (await this.pool.query(`SELECT r.app_id,r.redirect_uri,a.name AS app_name FROM cinev_oauth_requests r
              JOIN cinev_oauth_apps a ON a.id=r.app_id WHERE r.id=$1 AND r.csrf_hash=$2`, [id, digest(csrf)])).rows[0];
            if (!info) throw new OAuthError('invalid_request');
            const provider = AuthProvider.safeParse(p.get('provider'));
            const username = (p.get('username') ?? '').trim(), password = p.get('password') ?? '';
            const again = (status: number, error: string) => {
              this.consent(res, status, { id: info.app_id, name: info.app_name }, info.redirect_uri, id, csrf,
                { error, provider: provider.success ? provider.data : undefined, username: username.slice(0, 320) });
              return true;
            };
            if (!provider.success || !username || username.length > 320 || !password || password.length > 4096) return again(400, 'Revisa el correo y la contraseña.');
            // One sign-in at a time per request. A second submit (a double
            // click, or a resubmit while the first is still signing in) waits
            // for the first: if it succeeds, this response delivers a fresh
            // code below, because the browser shows only the last response.
            // Time budget (Vercel stops a request at 90 s; a sign-in may take
            // 60 s): a sign-in starts only within the first 20 s, and waiting
            // for another one ends at 75 s. The claim outlives a crashed
            // process by at most 90 s.
            for (const started = Date.now(); ;) {
              const { rows } = Date.now() - started > 20000 ? { rows: [] } : await this.pool.query(`UPDATE cinev_oauth_requests
                SET busy_until=clock_timestamp()+interval '90 seconds', attempts=attempts+1
                WHERE id=$1 AND csrf_hash=$2 AND code_hash IS NULL AND expires_at>clock_timestamp() AND attempts<5
                AND (busy_until IS NULL OR busy_until<=clock_timestamp()) RETURNING id`, [id, digest(csrf)]);
              if (rows.length) { claimed = true; break; }
              const r = (await this.pool.query(`SELECT code_hash, attempts, busy_until>clock_timestamp() AS busy,
                expires_at>clock_timestamp() AS live FROM cinev_oauth_requests WHERE id=$1`, [id])).rows[0];
              if (!r || !r.live || r.code_hash) break; // The transaction below decides: re-issue or refuse.
              if (!r.busy && r.attempts >= 5) return again(429, 'Demasiados intentos. Vuelve a tu asistente para empezar de nuevo.');
              if (Date.now() - started > (r.busy ? 75000 : 20000)) return again(503, 'El cine está tardando en responder. Inténtalo de nuevo.');
              await new Promise(resolve => setTimeout(resolve, 300));
            }
            if (claimed) {
              // The per-address budget counts sign-ins, not duplicate submits that only wait.
              const subject = { network: ip, provider: provider.data, username };
              const refusal = await this.budgets.admitSignIn(subject);
              if (refusal) {
                // The sign-in never ran: give back the request's attempt.
                await this.pool.query('UPDATE cinev_oauth_requests SET attempts=GREATEST(attempts-1,0) WHERE id=$1', [id]);
                return again(429, signInRefusalMessage[refusal]);
              }
              const staged = new class extends SessionStore { override async save(value: AuthSession) { session = value; } }();
              const started = Date.now();
              try { await this.accounts!.authenticate(provider.data, username, password, staged); }
              catch (error) {
                if (await this.budgets.signInError(subject, error) === 'unavailable') return again(503, cinemaUnavailableMessage);
                await signInFloor(started, this.accounts!.refusalFloorMs);
                return again(401, 'No se pudo iniciar sesión. Revisa tus datos o comprueba en la web del cine si pide una verificación adicional.');
              }
              // Not a refusal of the credentials, so it is not counted as a failure.
              if (!session || session.provider !== provider.data) return again(502, 'El cine no entregó una sesión válida. Inténtalo de nuevo.');
              await this.budgets.signInSucceeded(subject);
            }
          }
          const destination = await transaction(this.pool, async client => {
            const { rows } = await client.query(`SELECT *, expires_at>clock_timestamp() AS live FROM cinev_oauth_requests WHERE id=$1 FOR UPDATE`, [id]);
            const r = rows[0];
            if (!r || r.csrf_hash !== digest(csrf) || !r.live || r.consumed_at) throw new OAuthError('invalid_request');
            // A code already issued for this request and not yet exchanged
            // (a double submit whose first response the browser dropped):
            // replace it and send the browser on again. Its connection, if
            // any, is kept; what a duplicate "Conectar" typed is not used.
            const reissue = !!r.code_hash;
            if (reissue && (decision === 'deny' || session)) throw new OAuthError('invalid_request');
            const dest = new URL(r.redirect_uri);
            if (decision === 'deny') {
              await client.query('DELETE FROM cinev_oauth_requests WHERE id=$1', [id]); dest.searchParams.set('error', 'access_denied');
            } else {
              const code = secret();
              // A connected cinema needs its owner now; the grant is still made
              // only when the code is exchanged with the PKCE verifier.
              let user: string | null = reissue ? r.user_id : null;
              if (session) {
                user = randomUUID();
                await client.query('INSERT INTO cinev_clients(id,token_hash) VALUES($1,$2)', [user, digest(secret())]);
                await this.accounts!.save(client, user, session);
              }
              // Only a sign-in touches busy_until, so approving keeps working
              // on a deployment that has not run migration 004 yet.
              await client.query(`UPDATE cinev_oauth_requests SET code_hash=$2,user_id=$3${claimed ? ',busy_until=NULL' : ''},
                expires_at=${reissue ? 'expires_at' : "now()+interval '5 minutes'"} WHERE id=$1`, [id, digest(code), user]);
              dest.searchParams.set('code', code);
            }
            if (r.state !== null) dest.searchParams.set('state', r.state);
            // RFC 9207 issuer identification prevents authorization-server mix-up.
            dest.searchParams.set('iss', origin);
            return dest.href;
          });
          claimed = false;
          res.setHeader('Set-Cookie', `cinve_approval_${id}=; HttpOnly; SameSite=Lax; Path=/oauth/authorize; Max-Age=0${origin.startsWith('https:') ? '; Secure' : ''}`);
          res.writeHead(303, { Location: destination }); res.end(); return true;
        } finally { if (claimed) await release(); }
      }
      if (path === '/oauth/token' && req.method === 'POST') {
        send(200, await this.exchange(await payload(req) as URLSearchParams, () => admit())); return true;
      }
      if (path === '/oauth/revoke' && req.method === 'POST') {
        const p = await payload(req) as URLSearchParams;
        const token = required(p.get('token')), app = required(p.get('client_id'));
        // RFC 7009: an invalid token is answered like a revoked one, here without database work.
        if (!await this.acceptable('access', token) && !await this.acceptable('refresh', token)) { send(200, {}); return true; }
        await admit();
        await transaction(this.pool, async client => {
          const { rows } = await client.query(`SELECT t.user_id FROM cinev_oauth_tokens t JOIN cinev_oauth_grants g ON g.user_id=t.user_id
            WHERE t.token_hash=$1 AND g.app_id=$2 AND g.resource=$3`, [digest(token), app, this.resource]);
          if (rows[0] && await lockUser(client, rows[0].user_id)) await revoke(client, rows[0].user_id);
        });
        send(200, {}); return true;
      }
      throw new OAuthError('invalid_request', 405);
    } catch (error) {
      const status = error instanceof OAuthError ? error.status : 500;
      if (path === '/oauth/authorize') {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(authorizationErrorPage());
      } else send(status, { error: error instanceof OAuthError ? error.error : 'server_error' });
      return true;
    }
  }
}
