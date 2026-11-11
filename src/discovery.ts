// Files crawlers and answer engines look for: robots.txt, sitemap.xml,
// llms.txt and security.txt. Served before the Host check, like /install, so
// they answer on the public origin. URLs are built from the origin, never hard-coded.
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Public, indexable pages. /connect, OAuth and errors stay out (noindex). */
export const indexedPaths = ['/', '/install', '/instrucciones'];

// /connect stays crawlable so its noindex can be read; only the POST API
// under /connect/ is disallowed. AI crawlers get the same rules as everyone.
const robots = (origin: string) => `User-agent: *
Allow: /
Disallow: /oauth/
Disallow: /connect/
Disallow: /internal/

Sitemap: ${origin}/sitemap.xml
`;

const sitemap = (origin: string) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexedPaths.map(path => `  <url><loc>${origin}${path}</loc></url>`).join('\n')}
</urlset>
`;

// The llms.txt proposal (llmstxt.org): cheap to serve, adoption unproven.
const llms = (origin: string) => `# Cinve

> Servidor MCP gratuito, independiente y de código abierto para que tu asistente consulte la cartelera, los horarios, los precios y los asientos de cines en Venezuela (Cinex, Cines Unidos, Cinepic, Supercines y Gran Cine), según lo que publica cada cine. Solo consulta: no compra entradas ni reserva asientos.

- [Guía de instalación para asistentes](${origin}/install?format=text)
- [Cómo añadir Cinve a mano](${origin}/install)
- [Instrucciones que recibe el asistente](${origin}/instrucciones)
- [Código fuente](https://github.com/0bkevin/cinve)
- Endpoint MCP (Streamable HTTP): ${origin}/mcp
`;

// RFC 9116. Expires is required and must stay under a year away, so it is
// computed per response instead of being a date someone must remember to bump.
const securityTxt = (origin: string) => `Contact: https://github.com/0bkevin/cinve/security/advisories/new
Expires: ${new Date(Date.now() + 180 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')}
Policy: https://github.com/0bkevin/cinve/blob/main/SECURITY.md
Preferred-Languages: es, en
Canonical: ${origin}/.well-known/security.txt
`;

const files: Record<string, [string, (origin: string) => string]> = {
  '/robots.txt': ['text/plain; charset=utf-8', robots],
  '/sitemap.xml': ['application/xml; charset=utf-8', sitemap],
  '/llms.txt': ['text/plain; charset=utf-8', llms],
  '/.well-known/security.txt': ['text/plain; charset=utf-8', securityTxt],
};

export function serveDiscovery(req: IncomingMessage, res: ServerResponse, origin: string): boolean {
  const file = files[req.url?.split('?')[0] ?? ''];
  if (!file) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
  res.writeHead(200, { 'Content-Type': file[0], 'Cache-Control': 'public, max-age=3600' });
  res.end(req.method === 'HEAD' ? undefined : file[1](origin));
  return true;
}
