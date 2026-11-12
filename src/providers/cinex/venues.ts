import { load } from 'cheerio';
import { DataError, folded, Id, isObj } from '../../core.js';
import type { DataItem, Query } from '../../core.js';
import { CallStopped, type ReadContext } from '../../http/read-context.js';
import { decodeLabel } from '../parsing.js';

const base = 'https://www.cinex.com.ve';
const detailPath = /^cinex-[A-Za-z0-9_-]{1,80}\.html$/;
type Venue = { href: string; name: string; city: string; image?: string | undefined };
const normalizedName = (name: string) => folded(name).replace(/^cinex\s+/, '').replace(/[^a-z0-9]/g, '');
const cinemaPageTtl = 120000;
// Venue identity (code and name) changes about as often as the directory, so
// metadata lives as long: a warm list_cinemas then needs no read per venue.
const metadataTtl = 3600000, directoryTtl = 3600000;
/** A directory page that lists venues; an error or maintenance page is not cached. */
const directoryPage = (body: string) => /href=["']?cinex-/.test(body);
const maxDiscoveryVenues = 100;
const maxCatalogWarnings = 32;
const metadataUrl = (id: string) => `${base}/assets/php/datasource.php?${new URLSearchParams({ method: 'getcinemadatafromcinemaid', cinemaid: id })}`;
type MetadataRow = { siglas: string; name: string; desc?: unknown };
/**
 * The venue rows of a Cinex datasource answer, `{ data: [...] }` or, where
 * `bareArray` allows it, a bare array; undefined when it is neither. Rows
 * without a string code and name are dropped.
 */
function metadataRows(data: unknown, bareArray: boolean): MetadataRow[] | undefined {
  const list = bareArray && Array.isArray(data) ? data : isObj(data) && Array.isArray(data.data) ? data.data : undefined;
  return list?.filter((row): row is MetadataRow => isObj(row) && typeof row.siglas === 'string' && typeof row.name === 'string');
}
function imageCode(image = ''): string | undefined {
  return image.match(/(?:^|\/)cinemas\/(?:\d+x\d+x|x)?([a-z0-9_-]+)\.(?:jpg|png|webp)(?:\.|$)/i)?.[1]?.toUpperCase();
}
// Official details observed 2026-09-18, absent from some directory responses.
// Seeds only enable discovery; they never supply a provider code or assert
// that the venue operates. Every use re-validates the current detail page.
const seedVenues: readonly Venue[] = [
  { href: 'cinex-metropolisbarquisimeto.html', name: 'METROPOLIS BARQUISIMETO', city: 'Barquisimeto' },
];
/**
 * The directory labels each venue with its town ("Cinex Sotavento, Maiquetía"),
 * but list_cities returns Cinex's own area names (LA GUAIRA, PARAGUANÁ,
 * LECHERÍAS), and the site's own city filter has no mapping (cinemasdata is
 * empty). Without this table those areas listed no venue at all. Keys and
 * values are folded; a venue keeps its town as its city.
 */
const cityAreas: Readonly<Record<string, string>> = {
  maiquetia: 'la guaira',
  'punto fijo': 'paraguana',
  lecheria: 'lecherias',
  // Cinex lists no Cabimas area; Costa Mall is the Zulia venue nearest Maracaibo.
  cabimas: 'maracaibo',
};
/** Whether a venue labelled with `town` belongs to the requested city or area. */
function inCinexCity(town: string, city: string): boolean {
  const venue = folded(town), wanted = folded(city);
  return venue === wanted || cityAreas[venue] === wanted;
}
type Verified = { url: string; name: string; aliases: string[]; metadataConfirmed: boolean };
type Located = { venue: Venue; metadataConfirmed: boolean };

/** Per-service discovery history, bounded and in memory; never evidence of closure. */
export class CinexCinemaCatalog {
  /**
   * @param discoveryBudgetMs Wall-clock budget for one list() fan-out. Each read
   * already has its own 15 s deadline; this bounds the whole operation so a
   * slow provider cannot push a hosted call past the platform's 90 s limit.
   */
  constructor(private readonly discoveryBudgetMs = 40000) {}
  private known = new Map<string, Venue>();
  /** Verified associations are cheap discovery state, not a schedule cache. */
  private verifiedUrls = new Map<string, Verified>();
  private rememberVerified(code: string, url: string, name: string, alias?: string, metadataConfirmed = false) {
    const oldest = this.verifiedUrls.keys().next();
    if (!this.verifiedUrls.has(code) && this.verifiedUrls.size >= 100 && !oldest.done) this.verifiedUrls.delete(oldest.value);
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
  /** The venue's code, and its address (desc) when the metadata confirms the venue. */
  private async verifyImage(image: string | undefined, venueName: string, c: ReadContext): Promise<{ code: string; address?: string } | undefined> {
    const candidate = imageCode(image);
    if (!candidate || !Id.safeParse(candidate).success) return undefined;
    try {
      const rows = metadataRows(await c.json(metadataUrl(candidate), metadataTtl), false);
      const match = rows?.find(r => r.siglas.toUpperCase() === candidate && normalizedName(r.name) === normalizedName(venueName));
      if (!match || !Id.safeParse(match.siglas).success) return undefined;
      // "C.C. Plaza Mayor. Prolongación Paseo Colón. Lecherías, Edo. Anzoátegui."
      // desc is text, but may carry markup or entities ("Nivel C1<br>Chacao", "&amp;").
      const address = typeof match.desc === 'string'
        ? load(decodeLabel(match.desc.slice(0, 2000)).replace(/<br\s*\/?>/gi, ' '), null, false).root().text().replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      return { code: match.siglas, ...(address ? { address } : {}) };
    } catch (error) { if (error instanceof CallStopped) throw error; return undefined; }
  }
  async list(q: Query, c: ReadContext): Promise<DataItem[]> {
    let emittedWarnings = 0, suppressedWarnings = 0;
    const warn = (message: string) => {
      if (emittedWarnings < maxCatalogWarnings) { c.warnings.push(message); emittedWarnings++; }
      else suppressedWarnings++;
    };
    const finishWarnings = () => {
      if (suppressedWarnings) c.warnings.push(`${suppressedWarnings} additional venue discovery warnings were omitted.`);
    };
    const $ = load(await c.get(`${base}/cines.html`, directoryTtl, directoryPage));
    const links = $('a[href^="cinex-"]');
    if (!links.length) throw new DataError('error', 'Unrecognized Cinex cinema listing.');
    const listed = new Map<string, Venue>();
    links.each((_, e) => {
      const href = $(e).attr('href') ?? '';
      if (!detailPath.test(href)) {
        c.partial = true; warn('Unrecognized Cinex venue link; it was omitted without following it.'); return;
      }
      const label = $(e).attr('title')?.trim() ?? '';
      const name = $(e).find('h3').text().trim() || label.split(',')[0];
      if (!name) { c.partial = true; warn(`Cinex venue without a recognizable name: ${href}.`); return; }
      const venue = { href, name, city: label.split(',').slice(1).join(',').trim(), image: $(e).find('img').attr('src') };
      listed.set(href, venue);
      if (this.known.has(href) || this.known.size < 100) this.known.set(href, venue);
    });
    // An invalid directory must not trigger unrelated detail reads.
    if (!listed.size) { finishWarnings(); return []; }
    const candidates = new Map(this.known);
    for (const seed of seedVenues) if (!candidates.has(seed.href)) candidates.set(seed.href, seed);
    for (const [href, venue] of listed) candidates.set(href, venue);
    const items: DataItem[] = [];
    const venues = [...candidates.values()].filter(v =>
      (!q.city || inCinexCity(v.city, q.city)) &&
      (!q.query || folded(v.name).includes(folded(q.query))));
    // A city from list_cities that no directory label maps to would otherwise
    // look like a city without cinemas.
    if (q.city && !venues.length) warn('No venue in the Cinex directory matches this city; list_cinemas without city returns every venue with its town.');
    const work = venues.slice(0, maxDiscoveryVenues);
    if (venues.length > work.length) {
      c.partial = true;
      warn(`Venue checks were limited to ${maxDiscoveryVenues}; ${venues.length - work.length} candidates were omitted. The result is partial.`);
    }
    // Limit fan-out so one discovery call has a real, explicit work bound.
    const deadline = c.budget(this.discoveryBudgetMs);
    for (let i = 0; i < work.length; i += 4) {
      if (Date.now() >= deadline) {
        // Keep the remaining directory venues visible, without unverifiable codes.
        const remaining = work.slice(i).filter(v => listed.has(v.href));
        c.partial = true;
        warn(`Venue checks timed out; ${remaining.length} directory venues are returned without a verified code. Repeat the query to complete them. This does not indicate a closure.`);
        items.push(...remaining.map(venue => ({ kind: 'cinema' as const, id: `directory-${venue.href.slice(6, -5)}`, name: venue.name, city: venue.city,
          url: `${base}/${venue.href}`, code_status: 'unverified' as const, directory_status: 'listed' as const })));
        break;
      }
      const batch = await Promise.all(work.slice(i, i + 4).map(async venue => {
        const present = listed.has(venue.href), url = `${base}/${venue.href}`;
        let code: string | undefined, address: string | undefined, detailVerifiedUrl: string | undefined, metadataConfirmed = false;
        const mapped = this.mappedCode(url, venue.name);
        const mappedCode = mapped?.code;
        if (present) {
          ({ code, address } = await this.verifyImage(venue.image, venue.name, c) ?? {});
          metadataConfirmed = !!code;
        }
        if (code) this.rememberDirectoryVerified(code, url, venue.name, metadataConfirmed);
        // A current directory image is sufficient only when its metadata
        // matches now. A remembered association remains a hint for the detail
        // URL, and never suppresses current identity verification.
        const needsDetail = present ? !code : !mapped;
        // The budget is checked before every follow-up read, not only when a
        // batch starts: one venue can need metadata, detail and metadata again.
        if (needsDetail && Date.now() >= deadline) {
          c.partial = true;
          warn(`The check of ${venue.name} timed out; repeat the query to complete it. This does not indicate a closure.`);
          if (!present && !this.known.has(venue.href)) return undefined;
        } else if (needsDetail) {
          try {
            const page = await c.page(mapped?.url ?? url, cinemaPageTtl);
            const detail = load(page.body);
            const title = detail('h3.title').first().text().trim();
            const titleMatches = !!title && normalizedName(title) === normalizedName(venue.name);
            // A detail-derived code is trusted only after the page identifies
            // the venue. Metadata-confirmed codes may survive an absent title,
            // but a wrong title always rejects the page.
            if (title && !titleMatches) throw new DataError('unavailable', 'The page does not confirm the venue\'s identity.');
            // A seed may enter discovery history only after this page names
            // the expected venue. A generic 200 or a code alone is not enough.
            if (!present && !titleMatches) throw new DataError('unavailable', 'The page does not confirm the venue\'s identity.');
            if (!present && !this.known.has(venue.href) && this.known.size < 100) this.known.set(venue.href, venue);
            const codes = new Set<string>();
            detail('[onclick]').each((_, e) => {
              const found = detail(e).attr('onclick')?.match(/checkLogin\(\s*['"][^'"]+['"]\s*,\s*['"]([A-Za-z0-9_-]{1,100})['"]\s*\)/)?.[1];
              if (found) codes.add(found);
            });
            if (codes.size === 1) {
              if (!titleMatches) throw new DataError('unavailable', 'The page does not confirm the venue\'s identity.');
              code = [...codes][0]; metadataConfirmed = false;
            } else if (codes.size === 0 && !code && Date.now() < deadline) {
              ({ code, address } = await this.verifyImage(detail('img[src*="cinemas/"]').first().attr('src'), venue.name, c) ?? {});
              metadataConfirmed = !!code;
            }
            if (!code || (!titleMatches && !metadataConfirmed)) throw new DataError('unavailable', 'The page does not confirm the venue\'s identity.');
            detailVerifiedUrl = page.source.url;
            if (mappedCode && mappedCode !== code) this.dropMappingsFor(url, venue.name);
            this.rememberVerified(code, page.source.url, venue.name, url, metadataConfirmed);
          } catch (error) {
            // A cancelled or expired call says nothing about the venue: it must
            // not drop the shared catalog's verified mappings.
            if (error instanceof CallStopped) throw error;
            if (mappedCode) this.dropMappingsFor(url, venue.name);
            c.partial = true;
            warn(error instanceof DataError && error.status === 'unavailable' && error.message.startsWith('The page does not confirm')
              ? `The official page of ${venue.name} confirms neither its identity nor a query code: ${url}.`
              : `Could not read the official page of ${venue.name}: ${url}.`);
            if (!present && !this.known.has(venue.href)) return undefined;
          }
        }
        if (code && !detailVerifiedUrl) this.rememberDirectoryVerified(code, url, venue.name, metadataConfirmed);
        if (!present) {
          c.partial = true;
          warn(`${venue.name} does not appear in the received directory; it is kept as pending verification. This does not indicate a closure.`);
        }
        if (!code) {
          c.partial = true;
          warn(`Query code not verified for ${venue.name}; venue kept. Check its official website: ${url}. This does not indicate a closure.`);
        }
        return { kind: 'cinema' as const, id: code ?? `directory-${venue.href.slice(6, -5)}`, name: venue.name, city: venue.city, url,
          ...(code && address ? { address } : {}),
          ...(code ? { cinema_id: code } : {}), code_status: code ? 'verified' as const : 'unverified' as const,
          directory_status: present ? 'listed' as const : 'not_listed' as const };
      }));
      items.push(...batch.filter((v): v is NonNullable<typeof v> => v !== undefined));
      c.progress(`Cinex: ${Math.min(i + 4, work.length)} of ${work.length} venues checked.`);
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
    if (!Id.safeParse(cinemaId).success) throw new DataError('unavailable', 'The Cinex venue code is not valid.');
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
    let located: Located;
    try { located = await this.locate(cinemaId, c); }
    catch (error) {
      if (!(error instanceof DataError) || error.status !== 'unavailable') throw error;
      // list_cinemas may verify a seeded venue that the directory omits. A
      // fresh instance (another serverless worker, a restart) has no memory of
      // that, so apply the same detail-page proof here instead of failing.
      const seeded = await this.resolveSeed(cinemaId, c);
      if (seeded) return seeded;
      throw error;
    }
    const venue = located.venue, requested = `${base}/${venue.href}`;
    const page = await c.page(requested, cinemaPageTtl);
    await this.validatePage(page.body, cinemaId, venue.name, c, located.metadataConfirmed);
    this.rememberVerified(cinemaId, page.source.url, venue.name, requested, located.metadataConfirmed);
    return { url: page.source.url, name: venue.name, city: venue.city, body: page.body };
  }

  private async resolveSeed(cinemaId: string, c: ReadContext): Promise<{ url: string; name: string; city: string; body: string } | undefined> {
    for (const seed of seedVenues) {
      const requested = `${base}/${seed.href}`;
      try {
        const page = await c.page(requested, cinemaPageTtl);
        // validatePage accepts a missing title only with metadata proof; a
        // seed has none, so also require the page to name the seeded venue.
        const title = load(page.body)('h3.title').first().text().trim();
        if (!title || normalizedName(title) !== normalizedName(seed.name)) continue;
        await this.validatePage(page.body, cinemaId, seed.name, c, false);
        this.rememberVerified(cinemaId, page.source.url, seed.name, requested, false);
        return { url: page.source.url, name: seed.name, city: seed.city, body: page.body };
      } catch (error) {
        if (!(error instanceof DataError) || error.status !== 'unavailable') throw error;
      }
    }
    return undefined;
  }

  private async locate(cinemaId: string, c: ReadContext): Promise<Located> {
    const $ = load(await c.get(`${base}/cines.html`, directoryTtl, directoryPage));
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
    if (matches.length > 1) throw new DataError('unavailable', 'The Cinex venue code matches several directory entries.');
    const [listed] = matches;
    if (listed) {
      // The image filename narrows the directory candidate but is not itself
      // enough to skip the requested detail-page identity check.
      return { venue: listed, metadataConfirmed: false };
    }
    // A code can be confirmed by a detail page even when the directory image
    // uses a different asset code. Ask metadata for this one requested ID,
    // then use the returned name to select one official directory link.
    const metadataName = await this.metadataName(cinemaId, c);
    if (!metadataName) throw new DataError('unavailable', 'The Cinex venue was not found in the official directory; call list_cinemas to get a current ID.');
    $('a[href^="cinex-"]').each((_, e) => {
      const href = $(e).attr('href') ?? '';
      if (!detailPath.test(href)) return;
      const label = $(e).attr('title')?.trim() ?? '';
      const name = $(e).find('h3').text().trim() || label.split(',')[0];
      if (name && normalizedName(name) === normalizedName(metadataName)) matches.push({ href, name, city: label.split(',').slice(1).join(',').trim(), image: $(e).find('img').attr('src') });
    });
    const [named] = matches;
    if (!named || matches.length !== 1) throw new DataError('unavailable', matches.length ? 'The Cinex venue name matches several directory entries.' : 'The Cinex venue code does not match an identifiable directory venue.');
    return { venue: named, metadataConfirmed: true };
  }

  private async validatePage(html: string, cinemaId: string, venueName: string, c: ReadContext, metadataConfirmed = false) {
    const detail = load(html), title = detail('h3.title').first().text().trim();
    if (title && normalizedName(title) !== normalizedName(venueName)) {
      throw new DataError('unavailable', 'The official page does not confirm the identity of the Cinex venue.');
    }
    const codes = new Set<string>();
    detail('[onclick]').each((_, e) => {
      const found = detail(e).attr('onclick')?.match(/checkLogin\(\s*['"][^'"]+['"]\s*,\s*['"]([A-Za-z0-9_-]{1,100})['"]\s*\)/)?.[1];
      if (found) codes.add(found);
    });
    if (codes.size) {
      if (!codes.has(cinemaId) || (!title && !metadataConfirmed)) throw new DataError('unavailable', 'The official page does not confirm the code of the Cinex venue.');
      return;
    }
    if (metadataConfirmed) return;
    // An empty schedule has no checkLogin() code to prove the association.
    // Verify the requested code against Cinex metadata instead of trusting the
    // directory image filename alone.
    let data: unknown;
    try { data = await c.json(metadataUrl(cinemaId), metadataTtl); } catch (error) {
      // As 'unavailable', a stopped call would make resolve() forget a verified URL.
      if (error instanceof CallStopped) throw error;
      throw new DataError('unavailable', 'Cinex did not confirm the code of the venue without visible showtimes.');
    }
    const rows = metadataRows(data, true);
    if (!rows) throw new DataError('unavailable', 'Cinex did not confirm the code of the venue without visible showtimes.');
    const verified = rows.some(row => row.siglas.toUpperCase() === cinemaId && normalizedName(row.name) === normalizedName(venueName));
    if (!verified) throw new DataError('unavailable', 'Cinex did not confirm the code of the venue without visible showtimes.');
  }

  private async metadataName(cinemaId: string, c: ReadContext): Promise<string | undefined> {
    try {
      const rows = metadataRows(await c.json(metadataUrl(cinemaId), metadataTtl), true);
      return rows?.find(row => row.siglas.toUpperCase() === cinemaId)?.name;
    } catch (error) { if (error instanceof CallStopped) throw error; return undefined; }
  }
}
