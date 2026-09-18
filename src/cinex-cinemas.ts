import { load } from 'cheerio';
import { DataError, folded, Id } from './core.js';
import type { DataItem, Query } from './core.js';
import type { ReadContext } from './http.js';

const base = 'https://www.cinex.com.ve';
const detailPath = /^cinex-[A-Za-z0-9_-]{1,80}\.html$/;
type Venue = { href: string; name: string; city: string; image?: string };
const normalizedName = (name: string) => folded(name).replace(/^cinex\s+/, '').replace(/[^a-z0-9]/g, '');
const cinemaPageTtl = 120000;
const maxDiscoveryVenues = 100;
const maxCatalogWarnings = 32;
const metadataUrl = (id: string) => `${base}/assets/php/datasource.php?${new URLSearchParams({ method: 'getcinemadatafromcinemaid', cinemaid: id })}`;
function imageCode(image = ''): string | undefined {
  return image.match(/(?:^|\/)cinemas\/(?:\d+x\d+x|x)?([a-z0-9_-]+)\.(?:jpg|png|webp)(?:\.|$)/i)?.[1]?.toUpperCase();
}
type Verified = { url: string; name: string; aliases: string[]; metadataConfirmed: boolean };
type Located = { venue: Venue; metadataConfirmed: boolean };

/** Per-service discovery history, bounded and in memory; never evidence of closure. */
export class CinexCinemaCatalog {
  private known = new Map<string, Venue>();
  /** Verified associations are cheap discovery state, not a schedule cache. */
  private verifiedUrls = new Map<string, Verified>();
  private rememberVerified(code: string, url: string, name: string, alias?: string, metadataConfirmed = false) {
    if (!this.verifiedUrls.has(code) && this.verifiedUrls.size >= 100) this.verifiedUrls.delete(this.verifiedUrls.keys().next().value!);
    const previous = this.verifiedUrls.get(code);
    const aliases = [...new Set([...(previous?.aliases ?? []), ...(alias && alias !== url ? [alias] : []), ...(previous && previous.url !== url ? [previous.url] : [])])].slice(-4);
    // This flag describes only the evidence from this observation. A prior
    // metadata result is a rediscovery hint, never proof for a later page.
    this.verifiedUrls.set(code, { url, name, aliases, metadataConfirmed });
  }
  private rememberDirectoryVerified(code: string, url: string, name: string, metadataConfirmed: boolean) {
    // A current directory proof supersedes any older association for the same
    // venue name, even when the old URL is no longer an alias of this one.
    this.dropMappingsByName(name, code);
    this.dropMappingsFor(url, name, code);
    const previous = this.verifiedUrls.get(code);
    // A directory URL already known as an alias is the same page under a
    // previous canonical URL; keeping that canonical URL avoids an unnecessary
    // redirect. A genuinely new directory URL supersedes stale state.
    const canonical = previous && (previous.url === url || previous.aliases.includes(url)) ? previous.url : url;
    this.rememberVerified(code, canonical, name, url, metadataConfirmed);
  }
  private dropMappingsFor(url: string, name: string, except?: string) {
    const target = normalizedName(name);
    for (const [code, value] of this.verifiedUrls) {
      if (code !== except && (value.url === url || value.aliases.includes(url)) && normalizedName(value.name) === target) {
        this.verifiedUrls.delete(code);
      }
    }
  }
  private dropMappingsByName(name: string, except?: string) {
    const target = normalizedName(name);
    for (const [code, value] of this.verifiedUrls) {
      if (code !== except && normalizedName(value.name) === target) this.verifiedUrls.delete(code);
    }
  }
  private mappedCode(url: string, name: string): { code: string; url: string } | undefined {
    const target = normalizedName(name);
    for (const [code, value] of this.verifiedUrls) {
      if ((value.url === url || value.aliases.includes(url)) && normalizedName(value.name) === target) {
        // The remembered URL/code can avoid an alias redirect, but cannot be
        // returned as current verification evidence.
        return { code, url: value.url };
      }
    }
    return undefined;
  }
  private async verifyImage(image: string | undefined, venueName: string, c: ReadContext): Promise<string | undefined> {
    const candidate = imageCode(image);
    if (!candidate || !Id.safeParse(candidate).success) return undefined;
    try {
      const data = await c.json(metadataUrl(candidate)) as { data?: unknown };
      if (!Array.isArray(data?.data)) return undefined;
      const match = data.data.find(r => r && typeof r.name === 'string' && typeof r.siglas === 'string'
        && r.siglas.toUpperCase() === candidate && normalizedName(r.name) === normalizedName(venueName));
      return match && Id.safeParse(match.siglas).success ? match.siglas as string : undefined;
    } catch { return undefined; }
  }
  async list(q: Query, c: ReadContext): Promise<DataItem[]> {
    let emittedWarnings = 0, suppressedWarnings = 0;
    const warn = (message: string) => {
      if (emittedWarnings < maxCatalogWarnings) { c.warnings.push(message); emittedWarnings++; }
      else suppressedWarnings++;
    };
    const finishWarnings = () => {
      if (suppressedWarnings) c.warnings.push(`Se omitieron ${suppressedWarnings} advertencias adicionales de descubrimiento de sedes.`);
    };
    const $ = load(await c.get(`${base}/cines.html`, 3600000));
    const links = $('a[href^="cinex-"]');
    if (!links.length) throw new DataError('error', 'No se reconoció el listado de cines Cinex.');
    const listed = new Map<string, Venue>();
    links.each((_, e) => {
      const href = $(e).attr('href') ?? '';
      if (!detailPath.test(href)) {
        c.partial = true; warn('Enlace de sede Cinex no reconocido; se omitió sin seguirlo.'); return;
      }
      const label = $(e).attr('title')?.trim() ?? '';
      const name = $(e).find('h3').text().trim() || label.split(',')[0];
      if (!name) { c.partial = true; warn(`Sede Cinex sin nombre reconocible: ${href}.`); return; }
      const venue = { href, name, city: label.split(',').slice(1).join(',').trim(), image: $(e).find('img').attr('src') };
      listed.set(href, venue);
      if (this.known.has(href) || this.known.size < 100) this.known.set(href, venue);
    });
    // An invalid directory must not trigger unrelated detail reads.
    if (!listed.size) { finishWarnings(); return []; }
    const candidates = new Map(this.known);
    // Official detail observed 2026-09-18, absent from some directory responses.
    // Seed only discovery, never a provider code or an assertion of operation.
    const seed: Venue = { href: 'cinex-metropolisbarquisimeto.html', name: 'METROPOLIS BARQUISIMETO', city: 'Barquisimeto' };
    if (!candidates.has(seed.href)) candidates.set(seed.href, seed);
    for (const [href, venue] of listed) candidates.set(href, venue);
    const items: DataItem[] = [];
    const venues = [...candidates.values()].filter(v =>
      (!q.city || folded(v.city) === folded(q.city)) &&
      (!q.query || folded(v.name).includes(folded(q.query))));
    const work = venues.slice(0, maxDiscoveryVenues);
    if (venues.length > work.length) {
      c.partial = true;
      warn(`Se limitaron las comprobaciones de sedes a ${maxDiscoveryVenues}; se omitieron ${venues.length - work.length} candidatas. El resultado es parcial.`);
    }
    // Limit fan-out so one discovery call has a real, explicit work bound.
    for (let i = 0; i < work.length; i += 4) {
      const batch = await Promise.all(work.slice(i, i + 4).map(async venue => {
        const present = listed.has(venue.href), url = `${base}/${venue.href}`;
        let code: string | undefined, detailVerifiedUrl: string | undefined, metadataConfirmed = false;
        const mapped = this.mappedCode(url, venue.name);
        const mappedCode = mapped?.code;
        if (present) {
          code = await this.verifyImage(venue.image, venue.name, c);
          metadataConfirmed = !!code;
        }
        if (code) this.rememberDirectoryVerified(code, url, venue.name, metadataConfirmed);
        // A current directory image is sufficient only when its metadata
        // matches now. A remembered association remains a hint for the detail
        // URL, and never suppresses current identity verification.
        const needsDetail = present ? !code : !mapped;
        if (needsDetail) {
          try {
            const page = await c.page(mapped?.url ?? url, cinemaPageTtl);
            const detail = load(page.body);
            const title = detail('h3.title').first().text().trim();
            const titleMatches = !!title && normalizedName(title) === normalizedName(venue.name);
            // A detail-derived code is trusted only after the page identifies
            // the venue. Metadata-confirmed codes may survive an absent title,
            // but a wrong title always rejects the page.
            if (title && !titleMatches) throw new DataError('unavailable', 'La página no confirma la identidad de la sede.');
            // A seed may enter discovery history only after this page names
            // the expected venue. A generic 200 or a code alone is not enough.
            if (!present && !titleMatches) throw new DataError('unavailable', 'La página no confirma la identidad de la sede.');
            if (!present && !this.known.has(venue.href) && this.known.size < 100) this.known.set(venue.href, venue);
            const codes = new Set<string>();
            detail('[onclick]').each((_, e) => {
              const match = detail(e).attr('onclick')?.match(/checkLogin\(\s*['"][^'"]+['"]\s*,\s*['"]([A-Za-z0-9_-]{1,100})['"]\s*\)/);
              if (match) codes.add(match[1]);
            });
            if (codes.size === 1) {
              if (!titleMatches) throw new DataError('unavailable', 'La página no confirma la identidad de la sede.');
              code = [...codes][0]; metadataConfirmed = false;
            } else if (codes.size === 0 && !code) {
              code = await this.verifyImage(detail('img[src*="cinemas/"]').first().attr('src'), venue.name, c);
              metadataConfirmed = !!code;
            }
            if (!code || (!titleMatches && !metadataConfirmed)) throw new DataError('unavailable', 'La página no confirma la identidad de la sede.');
            detailVerifiedUrl = page.source.url;
            if (mappedCode && mappedCode !== code) this.dropMappingsFor(url, venue.name);
            this.rememberVerified(code, page.source.url, venue.name, url, metadataConfirmed);
          } catch {
            if (mappedCode) this.dropMappingsFor(url, venue.name);
            c.partial = true; warn(`No se pudo leer la página oficial de ${venue.name}: ${url}.`);
            if (!present && !this.known.has(venue.href)) return undefined;
          }
        }
        if (code && !detailVerifiedUrl) this.rememberDirectoryVerified(code, url, venue.name, metadataConfirmed);
        if (!present) {
          c.partial = true;
          warn(`${venue.name} no aparece en el directorio recibido; se conserva como pendiente de verificar. Esto no indica cierre.`);
        }
        if (!code) {
          c.partial = true;
          warn(`Código de consulta no verificado para ${venue.name}; sede conservada. Consulta su web oficial: ${url}. Esto no indica cierre.`);
        }
        return { kind: 'cinema' as const, id: code ?? `directory-${venue.href.slice(6, -5)}`, name: venue.name, city: venue.city, url,
          ...(code ? { cinema_id: code } : {}), code_status: code ? 'verified' as const : 'unverified' as const,
          directory_status: present ? 'listed' as const : 'not_listed' as const };
      }));
      items.push(...batch.filter((v): v is NonNullable<typeof v> => v !== undefined));
    }
    finishWarnings();
    return items;
  }

  /**
   * Resolve one verified cinema URL for a showtimes query. A cold lookup reads
   * the directory and only the requested detail page; it never performs the
   * metadata fan-out used by a full cinema discovery call.
   */
  async resolve(cinemaId: string, c: ReadContext): Promise<{ url: string; name?: string; city?: string; body?: string }> {
    if (!Id.safeParse(cinemaId).success) throw new DataError('unavailable', 'El código de sede Cinex no es válido.');
    const remembered = this.verifiedUrls.get(cinemaId);
    if (remembered) {
      try {
        const page = await c.page(remembered.url, cinemaPageTtl);
        // remembered.metadataConfirmed is historical state; only evidence
        // observed during this validation may authorize the page.
        await this.validatePage(page.body, cinemaId, remembered.name, c, false);
        this.rememberVerified(cinemaId, page.source.url, remembered.name, remembered.url, false);
        return { url: page.source.url, name: remembered.name, body: page.body };
      } catch (error) {
        // A stale 404 or an identity change must not pin this code forever.
        // Rediscover only this requested code, once, from the current directory.
        if (!(error instanceof DataError) || error.status !== 'unavailable') throw error;
        this.verifiedUrls.delete(cinemaId);
      }
    }

    return this.resolveFromDirectory(cinemaId, c);
  }

  private async resolveFromDirectory(cinemaId: string, c: ReadContext): Promise<{ url: string; name?: string; city?: string; body?: string }> {
    const located = await this.locate(cinemaId, c);
    const venue = located.venue, requested = `${base}/${venue.href}`;
    const page = await c.page(requested, cinemaPageTtl);
    await this.validatePage(page.body, cinemaId, venue.name, c, located.metadataConfirmed);
    this.rememberVerified(cinemaId, page.source.url, venue.name, requested, located.metadataConfirmed);
    return { url: page.source.url, name: venue.name, city: venue.city, body: page.body };
  }

  private async locate(cinemaId: string, c: ReadContext): Promise<Located> {
    const $ = load(await c.get(`${base}/cines.html`, 3600000));
    const matches: Venue[] = [];
    $('a[href^="cinex-"]').each((_, e) => {
      const href = $(e).attr('href') ?? '';
      if (!detailPath.test(href)) return;
      const image = $(e).find('img').attr('src');
      if (imageCode(image) !== cinemaId) return;
      const label = $(e).attr('title')?.trim() ?? '';
      const name = $(e).find('h3').text().trim() || label.split(',')[0];
      if (name) matches.push({ href, name, city: label.split(',').slice(1).join(',').trim(), image });
    });
    if (matches.length > 1) throw new DataError('unavailable', 'El código de sede Cinex coincide con varias entradas del directorio.');
    if (matches.length === 1) {
      // The image filename narrows the directory candidate but is not itself
      // enough to skip the requested detail-page identity check.
      return { venue: matches[0], metadataConfirmed: false };
    }
    // A code can be confirmed by a detail page even when the directory image
    // uses a different asset code. Ask metadata for this one requested ID,
    // then use the returned name to select one official directory link.
    const metadataName = await this.metadataName(cinemaId, c);
    if (!metadataName) throw new DataError('unavailable', 'No se encontró la sede Cinex en el directorio oficial; consulta list_cinemas para obtener un ID actual.');
    $('a[href^="cinex-"]').each((_, e) => {
      const href = $(e).attr('href') ?? '';
      if (!detailPath.test(href)) return;
      const label = $(e).attr('title')?.trim() ?? '';
      const name = $(e).find('h3').text().trim() || label.split(',')[0];
      if (name && normalizedName(name) === normalizedName(metadataName)) matches.push({ href, name, city: label.split(',').slice(1).join(',').trim(), image: $(e).find('img').attr('src') });
    });
    if (matches.length !== 1) throw new DataError('unavailable', matches.length ? 'El nombre de sede Cinex coincide con varias entradas del directorio.' : 'El código de sede Cinex no coincide con una sede identificable del directorio.');
    return { venue: matches[0], metadataConfirmed: true };
  }

  private async validatePage(html: string, cinemaId: string, venueName: string, c: ReadContext, metadataConfirmed = false) {
    const detail = load(html), title = detail('h3.title').first().text().trim();
    if (title && normalizedName(title) !== normalizedName(venueName)) {
      throw new DataError('unavailable', 'La página oficial no confirma la identidad de la sede Cinex.');
    }
    const codes = new Set<string>();
    detail('[onclick]').each((_, e) => {
      const match = detail(e).attr('onclick')?.match(/checkLogin\(\s*['"][^'"]+['"]\s*,\s*['"]([A-Za-z0-9_-]{1,100})['"]\s*\)/);
      if (match) codes.add(match[1]);
    });
    if (codes.size) {
      if (!codes.has(cinemaId) || (!title && !metadataConfirmed)) throw new DataError('unavailable', 'La página oficial no confirma el código de la sede Cinex.');
      return;
    }
    if (metadataConfirmed) return;
    // An empty schedule has no checkLogin() code to prove the association.
    // Verify the requested code against Cinex metadata instead of trusting the
    // directory image filename alone.
    let data: unknown;
    try { data = await c.json(metadataUrl(cinemaId)); } catch { throw new DataError('unavailable', 'Cinex no confirmó el código de la sede sin funciones visibles.'); }
    if (!Array.isArray(data) && !(data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data))) {
      throw new DataError('unavailable', 'Cinex no confirmó el código de la sede sin funciones visibles.');
    }
    const rows = Array.isArray(data) ? data : (data as { data: unknown[] }).data;
    const verified = rows.some(row => row && typeof row === 'object' && typeof (row as { siglas?: unknown }).siglas === 'string' &&
      typeof (row as { name?: unknown }).name === 'string' &&
      (row as { siglas: string }).siglas.toUpperCase() === cinemaId &&
      normalizedName((row as { name: string }).name) === normalizedName(venueName));
    if (!verified) throw new DataError('unavailable', 'Cinex no confirmó el código de la sede sin funciones visibles.');
  }

  private async metadataName(cinemaId: string, c: ReadContext): Promise<string | undefined> {
    try {
      const data = await c.json(metadataUrl(cinemaId));
      const rows = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data) ? (data as { data: unknown[] }).data : [];
      const match = rows.find(row => row && typeof row === 'object' && typeof (row as { siglas?: unknown }).siglas === 'string' &&
        typeof (row as { name?: unknown }).name === 'string' && (row as { siglas: string }).siglas.toUpperCase() === cinemaId);
      return match && typeof (match as { name: unknown }).name === 'string' ? (match as { name: string }).name : undefined;
    } catch { return undefined; }
  }
}
