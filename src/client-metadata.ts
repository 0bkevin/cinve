import { lookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import * as z from 'zod';

/**
 * OAuth Client ID Metadata Documents (the client registration method MCP
 * authorization prefers since revision 2026-07-28; Dynamic Client
 * Registration is deprecated). A client identifies itself with an HTTPS URL
 * whose JSON document lists its name and redirect URIs; the authorization
 * server fetches and validates that document instead of storing a
 * registration.
 *
 * Fetching a client-chosen URL is an SSRF surface, so the fetch:
 * - accepts only https URLs on the default port, with a path, no
 *   credentials, fragment, dot segments or IP-literal host;
 * - resolves the host itself and connects only to the address it checked
 *   (no second resolution, so no DNS rebinding between check and connect),
 *   refusing loopback, private, link-local, CGNAT, documentation, multicast
 *   and other special-purpose ranges;
 * - follows no redirects, requires application/json, reads at most 16 KiB
 *   and gives up after 5 s.
 */

export const metadataDocumentLimitBytes = 16 * 1024;
const metadataTimeoutMs = 5000;

export function isClientIdUrl(value: string): boolean {
  if (value.length > 2048 || !value.startsWith('https://')) return false;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port || u.href !== value) return false;
    if (isIP(u.hostname.replace(/^\[|\]$/g, ''))) return false;
    if (u.pathname === '/' || u.pathname.split('/').some(segment => segment === '.' || segment === '..')) return false;
    return true;
  } catch { return false; }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6');

/** True for addresses a metadata fetch must never reach. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return true;
  // An IPv4-mapped IPv6 address (::ffff:a.b.c.d) reaches its IPv4 address, so
  // judge it as that address. (A ::ffff:0:0/96 rule cannot be used instead:
  // Node's BlockList also matches every plain IPv4 address against it.)
  const mapped = family === 6 ? address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1] : undefined;
  if (mapped) return isBlockedAddress(mapped);
  if (family === 6 && /^::ffff:/i.test(address)) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
/** Resolves once and hands the socket only addresses that passed the check. */
function checkedLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    if (!addresses.length || addresses.some(a => isBlockedAddress(a.address))) {
      return callback(Object.assign(new Error('Client metadata host resolves to a non-public address.'), { code: 'EBLOCKED' }), '');
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export type FetchedDocument = { document: unknown; maxAgeSeconds?: number };
export type ClientMetadataFetcher = (url: string) => Promise<FetchedDocument>;

export const fetchClientMetadataDocument: ClientMetadataFetcher = url => new Promise((resolve, reject) => {
  if (!isClientIdUrl(url)) { reject(new Error('Invalid client_id URL.')); return; }
  const req = request(url, {
    method: 'GET', lookup: checkedLookup as never, timeout: metadataTimeoutMs,
    headers: { Accept: 'application/json', 'User-Agent': 'cinve-oauth/0.1' },
  }, res => {
    const type = res.headers['content-type']?.split(';')[0].trim().toLowerCase();
    if (res.statusCode !== 200 || type !== 'application/json') {
      res.resume(); reject(new Error(`Client metadata request failed (${res.statusCode}).`)); return;
    }
    const chunks: Buffer[] = []; let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > metadataDocumentLimitBytes) { req.destroy(new Error('Client metadata document too large.')); return; }
      chunks.push(chunk);
    });
    res.on('end', () => {
      try {
        const maxAge = res.headers['cache-control']?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
        resolve({ document: JSON.parse(Buffer.concat(chunks).toString('utf8')), maxAgeSeconds: maxAge === undefined ? undefined : Number(maxAge) });
      } catch { reject(new Error('Client metadata document is not JSON.')); }
    });
    res.on('error', reject);
  });
  const deadline = setTimeout(() => req.destroy(new Error('Client metadata request timed out.')), metadataTimeoutMs);
  req.on('timeout', () => req.destroy(new Error('Client metadata request timed out.')));
  req.on('error', reject);
  req.on('close', () => clearTimeout(deadline));
  req.end();
});

export const redirectUri = z.string().max(2048).refine(value => {
  try {
    const u = new URL(value);
    return !u.username && !u.password && !u.hash &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  } catch { return false; }
});

// Members of a JWK that only a private or symmetric key carries.
const privateKeyMembers = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
const metadataDocument = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(redirectUri).min(1).max(10),
  // Cinve's authorization server serves public clients only. The draft lets a
  // document declare its method with either property; both are honoured.
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  // A metadata document is public, so it must never carry a shared secret
  // or private/symmetric key material, and jwks and jwks_uri are exclusive.
  client_secret: z.never().optional(),
  client_secret_expires_at: z.never().optional(),
  jwks: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).optional(),
  jwks_uri: z.string().optional(),
}).passthrough();

export type ClientMetadata = { client_id: string; client_name: string; redirect_uris: string[] };

/** A document is valid only for the exact URL it was fetched from. */
export function validateClientMetadata(url: string, document: unknown): ClientMetadata {
  const parsed = metadataDocument.safeParse(document);
  if (!parsed.success || parsed.data.client_id !== url) throw new Error('Invalid client metadata document.');
  const d = parsed.data;
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== 'none') throw new Error('Only public clients (token_endpoint_auth_method none) are supported.');
  if (d.token_endpoint_auth_methods_supported && !d.token_endpoint_auth_methods_supported.includes('none')) throw new Error('Only public clients (token_endpoint_auth_method none) are supported.');
  if (d.token_endpoint_auth_method && d.token_endpoint_auth_methods_supported && !d.token_endpoint_auth_methods_supported.includes(d.token_endpoint_auth_method)) throw new Error('Inconsistent client authentication methods.');
  if (d.jwks && d.jwks_uri !== undefined) throw new Error('jwks and jwks_uri are mutually exclusive.');
  if (d.jwks?.keys.some(key => key.kty === 'oct' || privateKeyMembers.some(member => member in key))) throw new Error('Client metadata must not contain private or symmetric keys.');
  if (d.grant_types && !d.grant_types.includes('authorization_code')) throw new Error('Client does not use the authorization code grant.');
  if (d.response_types && !d.response_types.includes('code')) throw new Error('Client does not use the code response type.');
  return { client_id: url, client_name: d.client_name ?? new URL(url).hostname, redirect_uris: d.redirect_uris };
}

/** Bounded cache of validated documents, honouring max-age within 1 min to 24 h (default 5 min). */
export class ClientMetadataCache {
  private entries = new Map<string, { metadata: ClientMetadata; expires: number }>();
  constructor(private readonly fetcher: ClientMetadataFetcher = fetchClientMetadataDocument, private readonly capacity = 256) {}
  async get(url: string): Promise<ClientMetadata> {
    const hit = this.entries.get(url);
    if (hit && hit.expires > Date.now()) return hit.metadata;
    this.entries.delete(url);
    const { document, maxAgeSeconds } = await this.fetcher(url);
    const metadata = validateClientMetadata(url, document);
    const ttl = Math.min(Math.max(maxAgeSeconds ?? 300, 60), 86400) * 1000;
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(url, { metadata, expires: Date.now() + ttl });
    return metadata;
  }
}
