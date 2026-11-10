import { lookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
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

/**
 * Structural checks on the raw identifier, which stays the exact string used
 * for comparisons (the draft requires simple string comparison). The WHATWG
 * parser is used only to read components: it would silently drop an empty
 * fragment, a default port or dot segments, so those are checked on the raw
 * text. Deliberate restrictions beyond the draft: no IP-literal host and no
 * port other than 443, so a document can only come from a named HTTPS site.
 */
export function isClientIdUrl(value: string): boolean {
  if (value.length > 2048 || !/^https:\/\//i.test(value) || /[#\\\s\u0000-\u001f\u007f]/.test(value)) return false;
  const raw = value.match(/^https:\/\/([^/?]+)(\/[^?]*)(?:\?.*)?$/i);
  if (!raw) return false;
  const [, authority, path] = raw;
  if (authority.includes('@')) return false;
  if (path.split('/').some(segment => ['.', '..'].includes(segment.toLowerCase().replace(/%2e/g, '.')))) return false;
  if (path === '/') return false;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    if (isIP(u.hostname.replace(/^\[|\]$/g, '')) || /^[\d.]+$/.test(u.hostname)) return false;
    return true;
  } catch { return false; }
}

/** IPv4 or IPv6 text to its address bytes; undefined when it is not an address. */
function addressBytes(address: string): number[] | undefined {
  const family = isIP(address);
  if (family === 4) return address.split('.').map(Number);
  if (family !== 6) return undefined;
  let text = address.toLowerCase();
  const tail: number[] = [];
  const v4 = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    tail.push(...v4[1].split('.').map(Number));
    text = text.slice(0, -v4[1].length) + '0:0';
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const left = head ? head.split(':') : [], right = rest ? rest.split(':') : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const bytes = groups.flatMap(g => { const n = parseInt(g || '0', 16); return [n >> 8, n & 0xff]; });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

type Range = readonly [prefix: readonly number[], bits: number];
const inRange = (bytes: readonly number[], [prefix, bits]: Range) => {
  for (let i = 0; i < bits; i++) {
    const mask = 0x80 >> (i % 8);
    if ((bytes[i >> 3] & mask) !== (prefix[i >> 3] & mask)) return false;
  }
  return true;
};
// IPv4 ranges that are not globally reachable unicast (IANA special-purpose
// registry): this network, private, CGNAT, loopback, link-local, IETF
// protocol assignments, documentation, 6to4 relay, benchmarking, multicast,
// reserved and limited broadcast.
const blockedV4: readonly Range[] = [
  [[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16], [[172, 16], 12], [[192, 0, 0], 24], [[192, 0, 2], 24],
  [[192, 88, 99], 24], [[192, 168], 16], [[198, 18], 15], [[198, 51, 100], 24], [[203, 0, 113], 24], [[224], 4], [[240], 4],
];
// Within global unicast 2000::/3, ranges that are not public destinations:
// IETF protocol assignments (incl. Teredo, ORCHID), documentation (2001:db8::/32
// and 3fff::/20) and 6to4, whose embedded IPv4 address could be private.
const blockedV6: readonly Range[] = [
  [[0x20, 0x01, 0x00, 0x00], 23], [[0x20, 0x01, 0x0d, 0xb8], 32], [[0x20, 0x02], 16], [[0x3f, 0xff], 20],
];

/**
 * True unless the address is globally reachable unicast. Decided on address
 * bytes, so every textual form of one address gets the same answer. IPv6 is
 * an allowlist of 2000::/3; an IPv4-mapped address (::ffff:0:0/96) is judged
 * as its IPv4 address, and every other embedding (IPv4-compatible,
 * translated, NAT64) is refused.
 */
export function isBlockedAddress(address: string): boolean {
  const bytes = addressBytes(address);
  if (!bytes) return true;
  if (bytes.length === 4) return blockedV4.some(range => inRange(bytes, range));
  const mapped = bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return blockedV4.some(range => inRange(bytes.slice(12), range));
  if ((bytes[0] & 0xe0) !== 0x20) return true;
  return blockedV6.some(range => inRange(bytes, range));
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
      // Do not drain a rejected body: it is not bounded by the size limit.
      reject(new Error(`Client metadata request failed (${res.statusCode}).`)); req.destroy(); return;
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
