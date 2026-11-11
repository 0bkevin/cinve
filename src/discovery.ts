// Files crawlers and answer engines look for: robots.txt, sitemap.xml,
// llms.txt and security.txt. Served before the Host check, like /install, so
// they answer on the public origin. URLs are built from the origin, never hard-coded.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { escapeHtml } from './web/jsx.js';
import { canonicalUrl } from './web/locale.js';

/** Public, indexable pages. /connect, OAuth and errors stay out (noindex). */
export const indexedPaths = ['/', '/install', '/instrucciones', '/privacidad'];

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
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${indexedPaths.flatMap(path => {
  const es = escapeHtml(canonicalUrl(new URL(path, origin).href, 'es'));
  const en = escapeHtml(canonicalUrl(new URL(path, origin).href, 'en'));
  const alternates = `<xhtml:link rel="alternate" hreflang="es" href="${es}"/><xhtml:link rel="alternate" hreflang="en" href="${en}"/><xhtml:link rel="alternate" hreflang="x-default" href="${es}"/>`;
  return [es, en].map(url => `  <url><loc>${url}</loc>${alternates}</url>`);
}).join('\n')}
</urlset>
`;

// The llms.txt proposal (llmstxt.org): cheap to serve, adoption unproven.
const llms = (origin: string) => `# Cinve

> Servidor MCP gratuito, independiente y de código abierto para que tu asistente consulte la cartelera, los horarios, los precios y los asientos de cines en Venezuela (Cinex, Cines Unidos, Cinepic, Supercines y Gran Cine), según lo que publica cada cine. Solo consulta: no compra entradas ni reserva asientos.

- [Guía de instalación para asistentes](${origin}/install?format=text)
- [Cómo añadir Cinve a mano](${origin}/install)
- [Instrucciones que recibe el asistente](${origin}/instrucciones)
- [Política de privacidad](${origin}/privacidad)
- [Código fuente](https://github.com/0bkevin/cinve)
- Endpoint MCP (Streamable HTTP): ${origin}/mcp

## English

Cinve is a free, independent, open-source MCP server for cinema listings,
showtimes, ticket prices, concessions, and published seat availability in
Venezuela. Coverage includes Cinex, Cines Unidos, Cinepic, Supercines, and
Gran Cine, depending on what each provider publishes. Some queries need the
visitor's cinema account. Information can change; confirm it with the cinema.
Cinve only reads information: it does not buy tickets or reserve seats.

- [Cinve in English](${origin}/?lang=en)
- [Installation for visitors](${origin}/install?lang=en)
- [Assistant installation guide (English)](${origin}/install?format=text)
- [Assistant instructions and original source text](${origin}/instrucciones?lang=en)
- [Privacy policy](${origin}/privacidad?lang=en)

The website supports Spanish and English through ?lang=es and ?lang=en.
MCP tool descriptions, server instructions, and diagnostic messages are in English.
The assistant answers in the language of the user’s prompt.
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
