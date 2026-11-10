import { CinexCinemaCatalog } from './venues.js';
import { DataError, isoDate, requireArg } from '../../core.js';
import type { DataItem, Operation, Query } from '../../core.js';
import { ReadContext } from '../../http/read-context.js';
import { checkedShowtime, decodeLabel, object, rows } from '../parsing.js';
import { warningLabel } from '../diagnostics.js';
import { catalogTtl, hourTtl } from '../read-policy.js';
import { parseCinexPrices, parseCinexConcessions } from './account-pages.js';
import { CX, parseCinexCinemaShowtimes, parseCinexMovies, parseCinexShowtimes } from './public-pages.js';

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
    if (!await c.cinexSessionActive()) throw new DataError('auth_required', 'La sesión Cinex expiró. Ejecuta npm run login -- cinex en una terminal local.');
    const url = `${CX}/boletos.php?${new URLSearchParams({ sessionid: sessionId, cinemaid: requireArg(q, 'cinema_id') })}`;
    c.warnings.push('Importe VES de la función, con boleto y otros cargos desglosados; no es un total final de compra.');
    // Opening a function page selects it in Cinex's PHP session, which a seat read in progress depends on.
    return parseCinexPrices(await c.exclusive('cinex', () => c.authenticated('cinex', url)), q, url);
  }
  if (op === 'concessions') {
    if (!await c.cinexSessionActive()) throw new DataError('auth_required', 'La sesión Cinex expiró. Ejecuta npm run login -- cinex en una terminal local.');
    const url = `${CX}/concesiones.php?${new URLSearchParams({ cinemaid: requireArg(q, 'cinema_id') })}`;
    c.warnings.push('Precios VES del catálogo de sede. La cantidad máxima del formulario no se interpreta como stock; cargos finales no verificados.');
    return parseCinexConcessions(await c.authenticated('cinex', url), q, url);
  }
  if (op === 'movies') {
    c.warnings.push('Cinex devuelve el catálogo general; consulta funciones para confirmar fecha y sede.');
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
      if (error instanceof DataError && error.status === 'unavailable') throw new DataError('unavailable', 'Cinex no tiene una ficha para ese movie_id; obtén un ID vigente con list_movies.');
      throw error;
    }
    try { return parseCinexShowtimes(html, mid, date, c); }
    catch (error) {
      if (error instanceof DataError && error.status === 'unavailable') throw new DataError('unavailable', 'La ficha Cinex de esta película no lista funciones. Consulta get_showtimes con el cinema_id de cada sede (list_cinemas), que lee la programación de la sede.');
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
  if (listed.length && !venues.length) throw new DataError('unavailable', 'No se pudo verificar el código de ninguna sede Cinex de esta ciudad, así que no se leyó su programación; consulta list_cinemas y sus enlaces oficiales.');
  if (!venues.length) {
    c.warnings.push('No se encontraron sedes Cinex en esta ciudad; consulta list_cities para ver los nombres disponibles.');
    return [];
  }
  const work = venues.slice(0, cinexCityVenues);
  if (venues.length > work.length) {
    c.partial = true;
    c.warnings.push(`Se consultaron ${work.length} de ${venues.length} sedes Cinex de la ciudad; usa cinema_id para las demás.`);
  }
  const timedOut = () => new DataError('unavailable', 'Se agotó el tiempo de consulta de las sedes Cinex de la ciudad; consulta get_showtimes con el cinema_id de cada sede (list_cinemas).');
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
      c.progress(`Cinex: ${succeeded + failed.length} de ${work.length} sedes leídas.`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cinexCityWorkers, work.length) }, worker));
  const skipped = work.slice(next).map(v => v.name);
  const names = (list: string[]) => list.map(n => warningLabel(n, 60)).join(', ');
  if (failed.length) {
    c.partial = true;
    c.warnings.push(`No se pudieron leer las funciones de ${failed.length} sedes Cinex (${names(failed)}); consulta su cinema_id por separado.`);
  }
  if (skipped.length) {
    c.partial = true;
    c.warnings.push(`Se agotó el tiempo de consulta antes de leer ${skipped.length} sedes Cinex (${names(skipped)}); consulta su cinema_id por separado.`);
  }
  // No venue read means no schedule was observed: that is a failure, not "empty".
  if (!succeeded) throw firstError ?? timedOut();
  return items;
}
