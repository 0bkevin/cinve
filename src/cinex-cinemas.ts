import { load } from 'cheerio';
import { DataError, folded, Id } from './core.js';
import type { DataItem, Query } from './core.js';
import type { ReadContext } from './http.js';

const base = 'https://www.cinex.com.ve';
const detailPath = /^cinex-[A-Za-z0-9_-]{1,80}\.html$/;
type Venue = { href: string; name: string; city: string; image?: string };
const normalizedName = (name: string) => folded(name).replace(/^cinex\s+/, '').replace(/[^a-z0-9]/g, '');
function imageCode(image = ''): string | undefined {
  return image.match(/(?:^|\/)cinemas\/(?:\d+x\d+x|x)?([a-z0-9_-]+)\.(?:jpg|png|webp)(?:\.|$)/i)?.[1]?.toUpperCase();
}

/** Per-service discovery history, bounded and in memory; never evidence of closure. */
export class CinexCinemaCatalog {
  private known = new Map<string, Venue>();
  async list(q: Query, c: ReadContext): Promise<DataItem[]> {
    const $ = load(await c.get(`${base}/cines.html`, 3600000));
    const links = $('a[href^="cinex-"]');
    if (!links.length) throw new DataError('error', 'No se reconoció el listado de cines Cinex.');
    const listed = new Map<string, Venue>();
    links.each((_, e) => {
      const href = $(e).attr('href') ?? '';
      if (!detailPath.test(href)) {
        c.partial = true; c.warnings.push('Enlace de sede Cinex no reconocido; se omitió sin seguirlo.'); return;
      }
      const label = $(e).attr('title')?.trim() ?? '';
      const name = $(e).find('h3').text().trim() || label.split(',')[0];
      if (!name) { c.partial = true; c.warnings.push(`Sede Cinex sin nombre reconocible: ${href}.`); return; }
      const venue = { href, name, city: label.split(',').slice(1).join(',').trim(), image: $(e).find('img').attr('src') };
      listed.set(href, venue);
      if (this.known.has(href) || this.known.size < 100) this.known.set(href, venue);
    });
    // An invalid directory must not trigger unrelated detail reads.
    if (!listed.size) return [];
    const candidates = new Map(this.known);
    // Official detail observed 2026-09-18, absent from some directory responses.
    // Seed only discovery, never a provider code or an assertion of operation.
    const seed: Venue = { href: 'cinex-metropolisbarquisimeto.html', name: 'METROPOLIS BARQUISIMETO', city: 'Barquisimeto' };
    if (!candidates.has(seed.href)) candidates.set(seed.href, seed);
    for (const [href, venue] of listed) candidates.set(href, venue);
    const items: DataItem[] = [];
    const venues = [...candidates.values()].filter(v => !q.city || folded(v.city) === folded(q.city));
    // Limit fan-out so discovery history cannot overflow the HTTP admission queue.
    for (let i = 0; i < venues.length; i += 4) {
      const batch = await Promise.all(venues.slice(i, i + 4).map(async venue => {
        const present = listed.has(venue.href), url = `${base}/${venue.href}`;
        let code: string | undefined;
        const verifyImage = async (image?: string) => {
          const candidate = imageCode(image);
          if (!candidate || !Id.safeParse(candidate).success) return undefined;
          try {
            const data = await c.json(`${base}/assets/php/datasource.php?${new URLSearchParams({ method: 'getcinemadatafromcinemaid', cinemaid: candidate })}`) as { data?: unknown };
            if (!Array.isArray(data?.data)) return undefined;
            const match = data.data.find(r => r && typeof r.name === 'string' && typeof r.siglas === 'string'
              && r.siglas.toUpperCase() === candidate && normalizedName(r.name) === normalizedName(venue.name));
            return match && Id.safeParse(match.siglas).success ? match.siglas as string : undefined;
          } catch { return undefined; }
        };
        if (present) code = await verifyImage(venue.image);
        if (!code || !present) {
          try {
            const detail = load(await c.get(url, 3600000));
            const title = detail('h3.title').first().text().trim();
            // Seeds require current page evidence; a generic HTTP 200 is insufficient.
            if (!present && !this.known.has(venue.href) && normalizedName(title) !== normalizedName(venue.name)) {
              c.partial = true; c.warnings.push(`No se pudo confirmar la página oficial de ${venue.name}: ${url}.`); return undefined;
            }
            if ((title && normalizedName(title) !== normalizedName(venue.name)) || (!present && !title)) {
              throw new DataError('unavailable', 'La página no confirma la identidad de la sede.');
            }
            if (!present && this.known.size < 100) this.known.set(venue.href, venue);
            const codes = new Set<string>();
            detail('[onclick]').each((_, e) => {
              const match = detail(e).attr('onclick')?.match(/checkLogin\(\s*['"][^'"]+['"]\s*,\s*['"]([A-Za-z0-9_-]{1,100})['"]\s*\)/);
              if (match) codes.add(match[1]);
            });
            if (codes.size === 1) code = [...codes][0];
            else if (codes.size === 0 && !code) code = await verifyImage(detail('img[src*="cinemas/"]').first().attr('src'));
          } catch {
            c.partial = true; c.warnings.push(`No se pudo leer la página oficial de ${venue.name}: ${url}.`);
            if (!present && !this.known.has(venue.href)) return undefined;
          }
        }
        if (!present) {
          c.partial = true;
          c.warnings.push(`${venue.name} no aparece en el directorio recibido; se conserva como pendiente de verificar. Esto no indica cierre.`);
        }
        if (!code) {
          c.partial = true;
          c.warnings.push(`Código de consulta no verificado para ${venue.name}; sede conservada. Consulta su web oficial: ${url}. Esto no indica cierre.`);
        }
        return { kind: 'cinema' as const, id: code ?? `directory-${venue.href.slice(6, -5)}`, name: venue.name, city: venue.city, url,
          ...(code ? { cinema_id: code } : {}), code_status: code ? 'verified' as const : 'unverified' as const,
          directory_status: present ? 'listed' as const : 'not_listed' as const };
      }));
      items.push(...batch.filter((v): v is NonNullable<typeof v> => v !== undefined));
    }
    return items;
  }
}
