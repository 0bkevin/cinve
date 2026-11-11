import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';

type Asset = { file: URL; type: string; compress?: boolean };

// Literal URLs let Vercel's file tracer bundle each asset with the function.
const assets: Record<string, Asset> = {
  '/assets/basecoat.css': { file: new URL('../assets/basecoat.css', import.meta.url), type: 'text/css; charset=utf-8', compress: true },
  '/assets/site.css': { file: new URL('../assets/site.css', import.meta.url), type: 'text/css; charset=utf-8', compress: true },
  '/assets/js/site.js': { file: new URL('../assets/js/site.js', import.meta.url), type: 'text/javascript; charset=utf-8', compress: true },
  '/assets/js/connect.js': { file: new URL('../assets/js/connect.js', import.meta.url), type: 'text/javascript; charset=utf-8', compress: true },
  '/assets/bricolage-grotesque.woff2': { file: new URL('../assets/bricolage-grotesque.woff2', import.meta.url), type: 'font/woff2' },
  '/assets/instrument-sans.woff2': { file: new URL('../assets/instrument-sans.woff2', import.meta.url), type: 'font/woff2' },
  '/og.png': { file: new URL('../assets/og.png', import.meta.url), type: 'image/png' },
  '/favicon.svg': { file: new URL('../assets/favicon.svg', import.meta.url), type: 'image/svg+xml', compress: true },
};

type Loaded = { body: Buffer; br?: Buffer; gzip?: Buffer; version: string };
const loaded = new Map<string, Loaded>();

function load(path: string): Loaded {
  let entry = loaded.get(path);
  if (!entry) {
    const asset = assets[path]!, body = readFileSync(asset.file);
    entry = { body, version: createHash('sha256').update(body).digest('hex').slice(0, 10) };
    // Not every host compresses responses (a plain Node server does not), and
    // the stylesheet is mostly repeated selectors, so compress once up front.
    if (asset.compress) { entry.br = brotliCompressSync(body); entry.gzip = gzipSync(body, { level: 9 }); }
    loaded.set(path, entry);
  }
  return entry;
}

/** The asset's path with a content hash, so a deploy never pairs new pages with stale cached files. */
export const assetUrl = (path: string) => `${path}?v=${load(path).version}`;

export function servePublicAsset(req: IncomingMessage, res: ServerResponse) {
  const path = req.url?.split('?')[0] ?? '';
  const asset = assets[path];
  if (!asset) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
  const entry = load(path);
  const accepts = String(req.headers['accept-encoding'] ?? '');
  const encoding = entry.br && /\bbr\b/.test(accepts) ? 'br' : entry.gzip && /\bgzip\b/.test(accepts) ? 'gzip' : undefined;
  const body = encoding === 'br' ? entry.br! : encoding === 'gzip' ? entry.gzip! : entry.body;
  res.writeHead(200, {
    'Content-Type': asset.type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
    'Content-Length': body.length, ...(asset.compress ? { Vary: 'Accept-Encoding' } : {}), ...(encoding ? { 'Content-Encoding': encoding } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body); return true;
}
