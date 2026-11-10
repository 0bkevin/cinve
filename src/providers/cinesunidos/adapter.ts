import { DataError, DateInput, folded, isoDate, number, requireArg, text } from '../../core.js';
import type { DataItem, Operation, Query } from '../../core.js';
import { ReadContext } from '../../http/client.js';
import { checkedShowtime, flight, object, pageFields, requiredText, rows } from '../parsing.js';
import type { Obj } from '../parsing.js';
import { warningLabel } from '../diagnostics.js';
import { catalogTtl, flightPage, hourTtl } from '../read-policy.js';
import { parseCinemaDirectory } from './directory.js';
import { parseCinesUnidosPrices } from './prices.js';

const CU = 'https://www.cinesunidos.com';
export async function cinesunidos(op: Operation, q: Query, c: ReadContext): Promise<DataItem[]> {
  if (op === 'cities') {
    const data = await c.json('https://gateway.cinesunidos.com/search/cities', hourTtl);
    if (!Array.isArray(data) || data.some(r => typeof r !== 'string')) throw new DataError('error', 'Lista de ciudades no reconocida.');
    return data.map(r => ({ kind: 'city', id: r, name: r }));
  }
  if (op === 'prices') {
    const url = `https://gateway.cinesunidos.com/tickets/www/theaters/${encodeURIComponent(requireArg(q, 'cinema_id'))}/sessions/${encodeURIComponent(requireArg(q, 'session_id'))}/`;
    const body = await c.authenticated('cinesunidos', url);
    let data: unknown; try { data = JSON.parse(body); } catch { throw new DataError('error', 'El proveedor no devolvió JSON de tarifas válido.'); }
    c.warnings.push('Tarifas de la función autenticada; revisa restricciones de canje/edad. No es un total final de compra.');
    return parseCinesUnidosPrices(data, q, url);
  }
  if (op === 'concessions') {
    const id = requireArg(q, 'cinema_id');
    const url = `https://gateway.cinesunidos.com/concessions/www/cinemas/${encodeURIComponent(id)}/concessions`;
    c.warnings.push('Precios y stock del catálogo de esta sede; impuestos incluidos y cargos finales no verificados.');
    return rows(await c.json(url), 'concessions').map(r => {
      const prices: NonNullable<DataItem['prices']> = [];
      for (const [key, currency] of [['itemPriceUSD', 'USD'], ['itemPriceVE', 'VES']] as const) {
        const amount = number(r[key]); if (amount !== undefined && amount >= 0) prices.push({ currency, amount, basis: 'provider' });
      }
      if (!prices.length) c.warnings.push(`Producto ${warningLabel(r.itemId)} sin precio verificable.`);
      return { kind: 'concession', id: requiredText(r, 'itemId'), name: requiredText(r, 'itemDescription'), cinema_id: id,
        category: text(r.itemClassDescription), stock: number(r.itemStock), prices, final_total_verified: false, image_url: text(r.itemImageUrl), url: `${CU}/carameleria` };
    });
  }
  let city = requireArg(q, 'city');
  const key = op === 'cinemas' ? 'theaters' : 'movies';
  let url = `${CU}/${op === 'cinemas' ? 'cines' : 'cartelera'}?${new URLSearchParams({ city })}`;
  let fields: unknown[];
  try {
    fields = pageFields(flight(await c.get(url, op === 'cinemas' ? hourTtl : catalogTtl, flightPage)), key);
    if (!fields.length) {
      // The provider's city filter is accent-sensitive. Retry only with a name
      // actually returned by its official city registry, never guess a city.
      const canonical = await cinesUnidosCity(city, q, c);
      if (canonical !== city) {
        city = canonical;
        url = `${CU}/${op === 'cinemas' ? 'cines' : 'cartelera'}?${new URLSearchParams({ city })}`;
        fields = pageFields(flight(await c.get(url, op === 'cinemas' ? hourTtl : catalogTtl, flightPage)), key);
      }
    }
  } catch (error) {
    // www.cinesunidos.com challenges some datacenter networks (including the
    // hosted service's). Its public search API is not challenged; use it
    // instead of the page, never a way around the challenge itself.
    if (!(error instanceof DataError) || error.status !== 'blocked') throw error;
    return cinesUnidosGateway(op, q, c, city);
  }
  if (!fields.length) throw new DataError('error', `No se reconoció el catálogo Cines Unidos: ${key}.`);
  if (op === 'cinemas') return parseCinemaDirectory(fields, city, url, c);
  const movies = fields.flatMap(field => rows(field, 'movies'));
  const items: DataItem[] = [];
  for (const m of movies) {
    const mid = requiredText(m, 'vistaId');
    if (q.movie_id && q.movie_id !== mid) continue;
    const sessions: DataItem[] = [];
    for (const cinema of rows(m.theaters, 'movie.theaters')) {
      const cid = requiredText(cinema, 'id');
      if (q.cinema_id && cid !== q.cinema_id) continue;
      for (const s of rows(cinema.showTimes, 'theater.showTimes')) {
        const raw = requiredText(s, 'date');
        if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(raw) || !DateInput.safeParse(raw.slice(0, 10)).success) throw new DataError('error', 'Fecha Cines Unidos con formato no reconocido.');
        if (raw.slice(0, 10) !== isoDate(q)) continue;
        sessions.push({ kind: 'showtime', id: requiredText(s, 'id'), name: requiredText(m, 'title'), cinema_id: cid, cinema_name: warningLabel(text(cinema.name), 200) || undefined, movie_id: mid,
          date: raw.slice(0, 10), time: raw.slice(11, 16), starts_at: `${raw}-04:00`, screen: text(s.screen), format: text(s.format),
          language: cuLanguage(object(m.features).Language), rating: text(cinema.rating) || undefined,
          url: `${CU}/pelicula/${encodeURIComponent(mid)}?${new URLSearchParams({ city })}` });
      }
    }
    if (op === 'showtimes') items.push(...sessions);
    else if (sessions.length) items.push({ kind: 'movie', id: mid, name: requiredText(m, 'title'), city,
      url: `${CU}/pelicula/${encodeURIComponent(mid)}?${new URLSearchParams({ city })}` });
  }
  return items;
}

/** Cines Unidos version ("Español", "Subtitulada") in the vocabulary of the other providers. */
export function cuLanguage(raw: unknown): string | undefined {
  const value = text(raw);
  if (!value) return undefined;
  const key = folded(value);
  return key === 'espanol' ? 'es' : key === 'subtitulada' ? 'subtitulada' : value;
}
/**
 * The website's title for a search-API session. The API drops the version
 * marker the website shows ("Clayface (Sub)") and leaves a double space where
 * it stood inside a title ("Clayface  Atmos" for "Clayface (Sub) Atmos").
 */
export function cuSiteTitle(title: string, language: unknown): string {
  const marker = ({ espanol: 'Esp', subtitulada: 'Sub' } as Record<string, string>)[folded(text(language))];
  const trimmed = title.trim();
  if (!marker || /\((?:esp|sub)\)/i.test(trimmed)) return trimmed.replace(/\s+/g, ' ');
  return /\s{2,}/.test(trimmed) ? trimmed.replace(/\s{2,}/, ` (${marker}) `).replace(/\s+/g, ' ') : `${trimmed} (${marker})`;
}

async function cinesUnidosCity(city: string, q: Query, c: ReadContext): Promise<string> {
  const cities = await cinesunidos('cities', q, c);
  const canonical = cities.find(r => folded(r.name) === folded(city))?.name;
  if (!canonical) throw new DataError('unavailable', 'Ciudad no reconocida por Cines Unidos; consulta list_cities.');
  return canonical;
}

const cuGatewayTitles = 80;
// One deadline for the whole fan-out: forty slow titles at two reads at a
// time could otherwise run past the hosted 90 s limit while every single read
// stays within its own 15 s. It never extends past the call's own deadline
// (ReadContext), which also counts the page, city and film reads before it.
const cuGatewayBudgetMs = 45000;
const cuGatewayWorkers = 2;
/** Cines Unidos public search API: directory, billboard titles and sessions by title. */
async function cinesUnidosGateway(op: Operation, q: Query, c: ReadContext, requestedCity: string): Promise<DataItem[]> {
  const city = await cinesUnidosCity(requestedCity, q, c);
  const base = `https://gateway.cinesunidos.com/search/cities/${encodeURIComponent(city)}`;
  const pageUrl = (path: string) => `${CU}/${path}?${new URLSearchParams({ city })}`;
  c.warnings.push('La web de Cines Unidos rechazó la consulta automatizada; los datos provienen de su API pública de búsqueda.');
  if (op === 'cinemas') return parseCinemaDirectory([rows(await c.json(`${base}/theaters`, hourTtl), 'gateway theaters')], city, pageUrl('cines'), c);
  const films = await c.json(`${base}/films`);
  if (!Array.isArray(films) || films.some(t => typeof t !== 'string')) throw new DataError('error', 'Lista de películas de Cines Unidos no reconocida.');
  // The service filters results by name; the session title is the searched
  // film title, so a name filter can skip the searches it would discard.
  const titles = [...new Set((films as string[]).map(t => t.trim()).filter(t => t && t.length <= 200))]
    .filter(t => !q.query || folded(t).includes(folded(q.query)));
  if (titles.length > cuGatewayTitles) {
    c.partial = true;
    c.warnings.push(`Se consultaron ${cuGatewayTitles} de ${titles.length} títulos de Cines Unidos; el resultado es parcial.`);
  }
  const date = isoDate(q);
  // Normalize each title's sessions inside its own settled task: a title
  // whose records are malformed fails alone instead of taking the others along.
  const normalize = (s: Obj): DataItem | undefined => {
    const raw = requiredText(s, 'showtime');
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(raw) || !DateInput.safeParse(raw.slice(0, 10)).success) throw new DataError('error', 'Fecha Cines Unidos con formato no reconocido.');
    const mid = requiredText(s, 'ho'), cid = requiredText(s, 'cinemaId'), name = cuSiteTitle(requiredText(s, 'title'), s.language);
    if (raw.slice(0, 10) !== date || (q.cinema_id && cid !== q.cinema_id) || (q.movie_id && mid !== q.movie_id)) return undefined;
    const item: DataItem = { kind: 'showtime', id: requiredText(s, 'sessionId'), name, cinema_id: cid, movie_id: mid,
      date, time: raw.slice(11, 16), starts_at: `${raw}-04:00`, screen: text(s.screenNumber), format: text(s.format),
      language: cuLanguage(s.language), rating: text(s.rating) || undefined, url: `${CU}/pelicula/${encodeURIComponent(mid)}?${new URLSearchParams({ city })}` };
    return checkedShowtime(item);
  };
  const showtimes: DataItem[] = [];
  const failures: unknown[] = [];
  const work = titles.slice(0, cuGatewayTitles);
  const deadline = c.budget(cuGatewayBudgetMs);
  let next = 0, succeeded = 0;
  // Two workers match the HTTP client's two reads per origin, whose 15 s
  // deadline includes queue time; more would only time out waiting.
  const worker = async () => {
    while (next < work.length && Date.now() < deadline) {
      const title = work[next++];
      try {
        showtimes.push(...rows(await c.json(`${base}/sessions?${new URLSearchParams({ Title: title })}`), 'gateway sessions')
          .map(normalize).filter((item): item is DataItem => item !== undefined));
        succeeded++;
      } catch (error) { failures.push(error); }
      c.progress(`Cines Unidos: ${succeeded + failures.length} de ${work.length} títulos consultados.`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cuGatewayWorkers, work.length) }, worker));
  const skipped = work.length - next;
  // One failed title must not discard every other title's schedule.
  if (failures.length) {
    c.partial = true;
    c.warnings.push(`No se pudieron consultar las funciones de ${failures.length} de ${work.length} títulos de Cines Unidos; el resultado es parcial.`);
  }
  if (skipped) {
    c.partial = true;
    c.warnings.push(`Se agotó el tiempo de consulta antes de leer ${skipped} de ${work.length} títulos de Cines Unidos; usa query con el título para consultarlos.`);
  }
  if (work.length && !succeeded) throw failures[0] ?? new DataError('unavailable', 'Se agotó el tiempo de consulta de Cines Unidos; usa query con el título de la película.');
  const movies = new Map<string, DataItem>();
  for (const s of showtimes) if (!movies.has(s.movie_id!)) movies.set(s.movie_id!, { kind: 'movie', id: s.movie_id!, name: s.name, city, url: s.url });
  return op === 'showtimes' ? showtimes : [...movies.values()];
}
