import { CinexCinemaCatalog } from './venues.js';
import { DataError, isoDate, requireArg } from '../../core.js';
import type { DataItem, Operation, Query } from '../../core.js';
import { ReadContext } from '../../http/read-context.js';
import { checkedShowtime, decodeLabel, object, rows } from '../parsing.js';
import { warningLabel } from '../diagnostics.js';
import { catalogTtl, hourTtl } from '../read-policy.js';
import { parseCinexPrices, parseCinexConcessions } from './account-pages.js';
import { CX, cinexBoxOfficeError, cinexBoxOfficePrefix, parseCinexCinemaShowtimes, parseCinexMovies, parseCinexShowtimes } from './public-pages.js';

const cxSource = (method: string, id?: string) => `${CX}/assets/php/datasource.php?${new URLSearchParams({ method, ...(id ? { cinemaid: id } : {}) })}`;
export async function cinex(op: Operation, q: Query, c: ReadContext, catalog = new CinexCinemaCatalog()): Promise<DataItem[]> {
  if (op === 'cities') {
    const data = object(await c.json(cxSource('getcinemacitieslist'), hourTtl));
    return rows(data.data, 'cities.data').map(r => ({ kind: 'city', id: decodeLabel(r.cinema_city), name: decodeLabel(r.cinema_city) }));
  }
  if (op === 'cinemas') return catalog.list(q, c);
  if (op === 'prices') {
    // Cinex publishes ticket prices only on the authenticated function page.
    const sessionId = requireArg(q, 'session_id');
    if (sessionId.startsWith(cinexBoxOfficePrefix)) throw cinexBoxOfficeError();
    if (!await c.cinexSessionActive()) throw new DataError('auth_required', 'The Cinex session expired. Run npm run login -- cinex in a local terminal.');
    const url = `${CX}/boletos.php?${new URLSearchParams({ sessionid: sessionId, cinemaid: requireArg(q, 'cinema_id') })}`;
    c.warnings.push('VES amount for the showtime, with the ticket and other charges itemized; not a final purchase total.');
    // Opening a function page selects it in Cinex's PHP session, which a seat read in progress depends on.
    return parseCinexPrices(await c.exclusive('cinex', () => c.authenticated('cinex', url)), q, url);
  }
  if (op === 'concessions') {
    if (!await c.cinexSessionActive()) throw new DataError('auth_required', 'The Cinex session expired. Run npm run login -- cinex in a local terminal.');
    const url = `${CX}/concesiones.php?${new URLSearchParams({ cinemaid: requireArg(q, 'cinema_id') })}`;
    c.warnings.push('VES prices from the venue catalog. The form\'s maximum quantity is not interpreted as stock; final charges not verified.');
    return parseCinexConcessions(await c.authenticated('cinex', url), q, url);
  }
  if (op === 'movies') {
    c.warnings.push('Cinex returns the general catalog; look up showtimes to confirm date and venue.');
    return parseCinexMovies(await c.get(`${CX}/cartelera.html`));
  }
  const date = isoDate(q);
  // With a venue, its page is authoritative: some synopsis pages list no
  // functions while the venue page shows that film. Filter it by movie.
  if (q.movie_id && !q.cinema_id) {
    const mid = q.movie_id;
    let html: string;
    try { html = await c.get(`${CX}/sinopsis-${encodeURIComponent(mid)}.html`); }
    catch (error) {
      // A missing or redirected synopsis page means the ID is wrong, not that
      // the film has no functions: send the model back to list_movies.
      if (error instanceof DataError && error.status === 'unavailable') throw new DataError('unavailable', 'Cinex has no page for that movie_id; get a current ID with list_movies.');
      throw error;
    }
    // Synopsis pages list only the functions sold online (seen 2026-11-12).
    c.warnings.push('The Cinex movie page lists only showtimes sold online; venues that sell only at the box office (most outside Caracas) appear only with city or cinema_id.');
    try { return parseCinexShowtimes(html, mid, date, c); }
    catch (error) {
      if (error instanceof DataError && error.status === 'unavailable') throw new DataError('unavailable', 'The Cinex page for this movie lists no showtimes. Call get_showtimes with the cinema_id of each venue (list_cinemas), which reads the venue\'s schedule.');
      throw error;
    }
  }
  if (q.city && !q.cinema_id) return cinexCityShowtimes(q, c, catalog, date);
  const cinemaId = requireArg(q, 'cinema_id');
  // The catalog read does not depend on the venue: run it beside the venue's
  // chain (directory, page, metadata) instead of after it. It is cached and
  // shared by every Cinex showtimes call, even when this venue fails.
  const catalogPage = c.get(`${CX}/cartelera.html`, catalogTtl);
  catalogPage.catch(() => { /* awaited below; a failed venue must not leave it unhandled */ });
  const venue = await catalog.resolve(cinemaId, c);
  const page = venue.body === undefined ? await c.page(venue.url, catalogTtl) : { body: venue.body };
  const movies = parseCinexMovies(await catalogPage);
  const items = parseCinexCinemaShowtimes(page.body, movies, cinemaId, date, c, venue.url, venue.name ? warningLabel(decodeLabel(venue.name), 200) || undefined : undefined);
  return q.movie_id ? items.filter(r => r.movie_id === q.movie_id) : items;
}

const cinexCityVenues = 16;
// One deadline for discovery, catalog and venue reads, capped by the call's
// own deadline (ReadContext), which also stops the follow-up reads a venue's
// resolution may chain; the call stays under the hosted 90 s.
const cinexCityBudgetMs = 45000;
// The HTTP client admits two reads per origin and each read's 15 s deadline
// includes its queue time, so more workers would only time out in the queue.
const cinexCityWorkers = 2;
/**
 * All verified venues of one city in one call. A model would otherwise list
 * the city's venues and query each one: ten round trips for Caracas. The
 * upstream reads are the same ones (directory, one page per venue, catalog),
 * served from the same cache.
 */
async function cinexCityShowtimes(q: Query, c: ReadContext, catalog: CinexCinemaCatalog, date: string): Promise<DataItem[]> {
  const deadline = c.budget(cinexCityBudgetMs);
  const listed = await catalog.list({ provider: 'cinex', city: q.city }, c);
  const venues = listed.filter((v): v is DataItem & { cinema_id: string } => v.code_status === 'verified' && !!v.cinema_id);
  // Known venues without a verified code are unread schedules, not an empty
  // city: report a failure. Only a city with no Cinex venue at all is empty.
  if (listed.length && !venues.length) throw new DataError('unavailable', 'No Cinex venue code in this city could be verified, so their schedules were not read; check list_cinemas and its official links.');
  if (!venues.length) {
    c.warnings.push('No Cinex venues were found in this city; check list_cities for the available names.');
    return [];
  }
  const work = venues.slice(0, cinexCityVenues);
  if (venues.length > work.length) {
    c.partial = true;
    c.warnings.push(`${work.length} of ${venues.length} Cinex venues in the city were queried; use cinema_id for the rest.`);
  }
  const timedOut = () => new DataError('unavailable', 'The query of the city\'s Cinex venues timed out; call get_showtimes with the cinema_id of each venue (list_cinemas).');
  if (Date.now() >= deadline) throw timedOut();
  const movies = parseCinexMovies(await c.get(`${CX}/cartelera.html`, 120000));
  const items: DataItem[] = [], failed: string[] = [];
  let next = 0, succeeded = 0, firstError: unknown;
  const worker = async () => {
    while (Date.now() < deadline) {
      const v = work[next];
      if (v === undefined) break;
      next++;
      try {
        const venue = await catalog.resolve(v.cinema_id, c);
        const page = venue.body === undefined ? await c.page(venue.url, 120000) : { body: venue.body };
        items.push(...parseCinexCinemaShowtimes(page.body, movies, v.cinema_id, date, c, venue.url, warningLabel(decodeLabel(v.name), 200) || undefined).map(checkedShowtime));
        succeeded++;
      } catch (error) {
        failed.push(v.name); firstError ??= error;
      }
      c.progress(`Cinex: ${succeeded + failed.length} of ${work.length} venues read.`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cinexCityWorkers, work.length) }, worker));
  const skipped = work.slice(next).map(v => v.name);
  const names = (list: string[]) => list.map(n => warningLabel(n, 60)).join(', ');
  if (failed.length) {
    c.partial = true;
    c.warnings.push(`Showtimes could not be read for ${failed.length} Cinex venues (${names(failed)}); query their cinema_id separately.`);
  }
  if (skipped.length) {
    c.partial = true;
    c.warnings.push(`The query timed out before reading ${skipped.length} Cinex venues (${names(skipped)}); query their cinema_id separately.`);
  }
  // No venue read means no schedule was observed: that is a failure, not "empty".
  if (!succeeded) throw firstError ?? timedOut();
  return items;
}
