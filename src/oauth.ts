import { authorizationPage, authorizationErrorPage } from './public-web.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import * as z from 'zod';
import { digest, lockUser, transaction } from './hosted-store.js';
import { ConnectionLinks } from './hosted-links.js';

const scope = 'cinve:accounts';
const secret = () => randomBytes(32).toString('base64url');
const redirectUri = z.string().max(2048).refine(value => {
  try {
    const u = new URL(value);
    return !u.username && !u.password && !u.hash &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  } catch { return false; }
});
const registration = z.object({
  client_name: z.string().trim().min(1).max(100).default('Asistente'),
  redirect_uris: z.array(redirectUri).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).default(['code']),
});
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

/** Self-service, isolated connections. Approval creates a NEW empty principal;
 * it never grants access to an existing cinema session or browser identity. */
export class HostedOAuth {
  private budgets: ConnectionLinks;
  constructor(readonly pool: Pool, readonly getOrigin: () => string) { this.budgets = new ConnectionLinks(pool); }
  get resource() { return this.getOrigin() + '/mcp'; }
  challenge(invalid = false) {
    return `Bearer resource_metadata="${this.getOrigin()}/.well-known/oauth-protected-resource/mcp", scope="${scope}"${invalid ? ', error="invalid_token"' : ''}`;
  }
  async authenticate(token: string) {
    if (!/^cva_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const { rows } = await this.pool.query(`SELECT c.id,c.token_hash FROM cinev_oauth_tokens t
      JOIN cinev_oauth_grants g ON g.user_id=t.user_id JOIN cinev_clients c ON c.id=t.user_id
      WHERE t.token_hash=$1 AND t.kind='access' AND t.expires_at>clock_timestamp()
      AND g.expires_at>clock_timestamp() AND g.resource=$2 AND c.revoked_at IS NULL`, [digest(token), this.resource]);
    return rows[0] ? { id: rows[0].id as string, tokenHash: rows[0].token_hash as string } : undefined;
  }
  private async tokens(client: PoolClient, user: string) {
    const access = 'cva_' + secret(), refresh = 'cvr_' + secret();
    await client.query(`INSERT INTO cinev_oauth_tokens(token_hash,user_id,kind,expires_at) VALUES
      ($1,$3,'access',now()+interval '1 hour'),
      ($2,$3,'refresh',(SELECT expires_at FROM cinev_oauth_grants WHERE user_id=$3))`, [digest(access), digest(refresh), user]);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope };
  }
  private async exchange(p: URLSearchParams) {
    const app = required(p.get('client_id'));
    if (p.get('resource') !== this.resource) throw new OAuthError('invalid_target');
    if (p.has('client_secret')) throw new OAuthError('invalid_client');
    const grant = p.get('grant_type');
    if (grant === 'authorization_code') {
      const code = required(p.get('code')), verifier = required(p.get('code_verifier'));
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant');
      const result = await transaction(this.pool, async client => {
        const { rows } = await client.query('SELECT * FROM cinev_oauth_requests WHERE code_hash=$1 FOR UPDATE', [digest(code)]);
        const r = rows[0];
        if (!r || r.app_id !== app || r.resource !== this.resource || r.redirect_uri !== p.get('redirect_uri') ||
            r.challenge !== createHash('sha256').update(verifier).digest('base64url') || r.expires_at.getTime() <= Date.now()) return undefined;
        if (r.consumed_at) {
          if (r.user_id) { await lockUser(client, r.user_id); await revoke(client, r.user_id); }
          return undefined;
        }
        const user = randomUUID();
        await client.query('INSERT INTO cinev_clients(id,token_hash) VALUES($1,$2)', [user, digest(secret())]);
        await client.query(`INSERT INTO cinev_oauth_grants(user_id,app_id,resource,expires_at) VALUES($1,$2,$3,now()+interval '30 days')`, [user, app, this.resource]);
        await client.query('UPDATE cinev_oauth_requests SET consumed_at=now(),user_id=$2 WHERE id=$1', [r.id, user]);
        return this.tokens(client, user);
      });
      if (!result) throw new OAuthError('invalid_grant');
      return result;
    }
    if (grant === 'refresh_token') {
      const token = required(p.get('refresh_token'));
      if (p.has('scope') && p.get('scope') !== scope) throw new OAuthError('invalid_scope');
      const result = await transaction(this.pool, async client => {
        const find = () => client.query(`SELECT t.*,g.app_id,g.resource,g.expires_at AS grant_expiry FROM cinev_oauth_tokens t
          JOIN cinev_oauth_grants g ON g.user_id=t.user_id WHERE t.token_hash=$1 AND t.kind='refresh'`, [digest(token)]);
        const candidate = (await find()).rows[0];
        if (!candidate || candidate.app_id !== app || candidate.resource !== this.resource || !await lockUser(client, candidate.user_id)) return undefined;
        const r = (await find()).rows[0];
        if (r.used_at) { await revoke(client, r.user_id); return undefined; }
        if (r.expires_at.getTime() <= Date.now() || r.grant_expiry.getTime() <= Date.now()) return undefined;
        await client.query('UPDATE cinev_oauth_tokens SET used_at=now() WHERE token_hash=$1', [digest(token)]);
        return this.tokens(client, r.user_id);
      });
      if (!result) throw new OAuthError('invalid_grant');
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
          registration_endpoint: origin + '/oauth/register', revocation_endpoint: origin + '/oauth/revoke',
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'], scopes_supported: [scope], authorization_response_iss_parameter_supported: true,
        });
        return true;
      }
      if (!await this.budgets.budget('oauth:global', 600) || !await this.budgets.budget(`oauth:${ip}`, 60)) throw new OAuthError('temporarily_unavailable', 429);
      if (path === '/oauth/register' && req.method === 'POST') {
        if (!await this.budgets.budget(`oauth:register:${ip}`, 10)) throw new OAuthError('temporarily_unavailable', 429);
        const parsed = registration.safeParse(await payload(req, true));
        if (!parsed.success || !parsed.data.grant_types.includes('authorization_code') || !parsed.data.response_types.includes('code')) throw new OAuthError('invalid_client_metadata');
        const p = parsed.data, id = 'cvapp_' + secret();
        await this.pool.query('INSERT INTO cinev_oauth_apps(id,name,redirect_uris) VALUES($1,$2,$3)', [id, p.client_name, JSON.stringify(p.redirect_uris)]);
        send(201, { ...p, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) }); return true;
      }
      if (path === '/oauth/authorize' && req.method === 'GET') {
        const p = url.searchParams;
        for (const key of p.keys()) if (p.getAll(key).length !== 1) throw new OAuthError('invalid_request');
        const { rows } = await this.pool.query('SELECT * FROM cinev_oauth_apps WHERE id=$1', [required(p.get('client_id'))]);
        const app = rows[0], redirect = required(p.get('redirect_uri'));
        // Never redirect errors to an unvalidated client URI.
        if (!app || !app.redirect_uris.includes(redirect)) throw new OAuthError('invalid_request');
        if (p.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type');
        if (p.get('resource') !== this.resource) throw new OAuthError('invalid_target');
        if (p.has('scope') && p.get('scope') !== scope) throw new OAuthError('invalid_scope');
        if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? '')) throw new OAuthError('invalid_request');
        if ((p.get('state')?.length ?? 0) > 2048) throw new OAuthError('invalid_request');
        const id = randomBytes(16).toString('hex'), csrf = secret();
        await this.pool.query(`INSERT INTO cinev_oauth_requests(id,app_id,redirect_uri,resource,state,challenge,csrf_hash,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`, [id, app.id, redirect, this.resource, p.get('state'), p.get('code_challenge'), digest(csrf)]);
        res.setHeader('Set-Cookie', `cinve_approval_${id}=${csrf}; HttpOnly; SameSite=Lax; Path=/oauth/authorize; Max-Age=600${origin.startsWith('https:') ? '; Secure' : ''}`);
        // A native form POST inherits this policy. no-referrer makes browsers
        // send Origin: null, which our same-origin CSRF check correctly rejects.
        // Keep referrers private across origins, including the assistant callback.
        res.setHeader('Referrer-Policy', 'same-origin');
        // Chromium also checks form-action against the POST's redirect target.
        // Only allow the already-validated callback origin, never arbitrary sites.
        res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self' ${new URL(redirect).origin}; frame-ancestors 'none'; base-uri 'none'`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(authorizationPage(app.name, new URL(redirect).origin, id, csrf));
        return true;
      }
      if (path === '/oauth/authorize' && req.method === 'POST') {
        if (req.headers.origin !== origin) throw new OAuthError('invalid_request', 403);
        const p = await payload(req) as URLSearchParams;
        const id = required(p.get('request_id')), csrf = required(p.get('csrf'));
        if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || !['approve', 'deny'].includes(p.get('decision') ?? '')) throw new OAuthError('invalid_request');
        const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`cinve_approval_${id}=`))?.split('=')[1];
        if (cookie !== csrf) throw new OAuthError('invalid_request', 403);
        const destination = await transaction(this.pool, async client => {
          const { rows } = await client.query('SELECT * FROM cinev_oauth_requests WHERE id=$1 FOR UPDATE', [id]);
          const r = rows[0];
          if (!r || r.csrf_hash !== digest(csrf) || r.expires_at.getTime() <= Date.now() || r.code_hash) throw new OAuthError('invalid_request');
          const dest = new URL(r.redirect_uri);
          if (p.get('decision') === 'deny') {
            await client.query('DELETE FROM cinev_oauth_requests WHERE id=$1', [id]); dest.searchParams.set('error', 'access_denied');
          } else {
            const code = secret();
            await client.query("UPDATE cinev_oauth_requests SET code_hash=$2,expires_at=now()+interval '5 minutes' WHERE id=$1", [id, digest(code)]);
            dest.searchParams.set('code', code);
          }
          if (r.state !== null) dest.searchParams.set('state', r.state);
          // RFC 9207 issuer identification prevents authorization-server mix-up.
          dest.searchParams.set('iss', origin);
          return dest.href;
        });
        res.setHeader('Set-Cookie', `cinve_approval_${id}=; HttpOnly; SameSite=Lax; Path=/oauth/authorize; Max-Age=0${origin.startsWith('https:') ? '; Secure' : ''}`);
        res.writeHead(303, { Location: destination }); res.end(); return true;
      }
      if (path === '/oauth/token' && req.method === 'POST') {
        send(200, await this.exchange(await payload(req) as URLSearchParams)); return true;
      }
      if (path === '/oauth/revoke' && req.method === 'POST') {
        const p = await payload(req) as URLSearchParams;
        const token = required(p.get('token')), app = required(p.get('client_id'));
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
