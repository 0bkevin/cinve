import { parseCinemaDirectory } from './cinema-directory.js';
import { CinexCinemaCatalog } from './cinex-cinemas.js';
import { load } from 'cheerio';
import { DataError, DateInput, folded, Id, isoDate, number, requireArg, text } from './core.js';
import type { DataItem, Operation, Query } from './core.js';
import { ReadContext } from './http.js';
import { checkedShowtime, decodeLabel, pageFields, flight, object, requiredText, rows } from './providers/parsing.js';
import { providerWarning, providerWarningSummary, warningLabel } from './providers/diagnostics.js';
import { catalogTtl, flightPage, hourTtl } from './providers/read-policy.js';
import type { Obj } from './providers/parsing.js';
import { parseCinesUnidosPrices, parseCinexPrices, parseCinexConcessions } from './authenticated-parsers.js';

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

const CX = 'https://www.cinex.com.ve';
const cxSource = (method: string, id?: string) => `${CX}/assets/php/datasource.php?${new URLSearchParams({ method, ...(id ? { cinemaid: id } : {}) })}`;
export function parseCinexMovies(html: string): DataItem[] {
  const $ = load(html), items = new Map<string, DataItem>();
  $('.poster[onclick]').each((_, e) => {
    const match = ($(e).attr('onclick') ?? '').match(/sinopsis-([a-zA-Z0-9._-]+)\.html/);
    if (!match || !Id.safeParse(match[1]).success) return;
    const name = decodeLabel($(e).attr('title') || $(e).attr('alt'));
    if (name) items.set(match[1], { kind: 'movie', id: match[1], name, url: `${CX}/sinopsis-${match[1]}.html` });
  });
  if (!items.size) throw new DataError('error', 'No se reconoció la cartelera HTML de Cinex.');
  return [...items.values()];
}
export function parseCinexShowtimes(html: string, movieId: string, date: string, c?: ReadContext): DataItem[] {
  const $ = load(html);
  const title = decodeLabel($('h1').first().text() || movieId);
  // "<strong>Censura: </strong>C", the film's age rating.
  const ratingItem = $('li').filter((_, li) => /^Censura:/i.test($(li).find('strong').first().text().trim())).first();
  const rating = decodeLabel(ratingItem.text().replace(/^\s*Censura:\s*/i, '')).slice(0, 20) || undefined;
  const nodes = $('[onclick*="checkLogin("]');
  if (!nodes.length) throw new DataError('unavailable', 'La ficha Cinex no contiene funciones reconocibles.');
  let malformed = 0;
  // Read every date on the page first: a session ID reported on two dates is
  // as contradictory as one reported at two times, and filtering by the
  // requested date first would hide the other occurrence.
  const occurrences = new Map<string, DataItem[]>();
  nodes.each((_, e) => {
    const match = ($(e).attr('onclick') ?? '').match(/checkLogin\('([^']+)','([^']+)'\)/);
    const epoch = number($(e).attr('alt'));
    if (!match || epoch === undefined || !Number.isInteger(epoch) || epoch < 1e9 || epoch > 1e11) { malformed++; return; }
    const local = new Date(epoch * 1000 - 4 * 3600000).toISOString().slice(0, 19);
    const readable = $(e).clone(); readable.find('br').replaceWith('\n');
    // Same button layout as the venue page.
    const details = cinexSessionDetails(readable.text(), $(e).find('img.icoIdioma').attr('src'));
    const key = `${match[2]}:${match[1]}`;
    const list = occurrences.get(key) ?? []; occurrences.set(key, list);
    list.push({ kind: 'showtime', id: match[1], name: title,
      movie_id: movieId, cinema_id: match[2], date: local.slice(0, 10), time: local.slice(11, 16), starts_at: `${local}-04:00`, rating, ...details,
      url: `${CX}/sinopsis-${movieId}.html` });
  });
  const items: DataItem[] = [];
  for (const list of occurrences.values()) {
    if (!list.some(item => item.date === date)) continue;
    if (list.some(item => cinexSessionConflict(list[0], item))) {
      if (c) { c.partial = true; providerWarning(c, 'cinex-movie-conflict', () => `Cinex devolvió horarios contradictorios para la función ${warningLabel(list[0].id)}; se omitió.`); }
      continue;
    }
    items.push(list[0]);
  }
  if (malformed && c) {
    c.partial = true;
    providerWarning(c, 'cinex-movie-malformed-session', 'Cinex devolvió una o más funciones de película con epoch o identificador malformado; se omitieron.');
  }
  if (c) providerWarningSummary(c);
  return items;
}

/** The same session ID with another film, date, time or room cannot drive a price or seat lookup. */
function cinexSessionConflict(a: DataItem, b: DataItem) {
  // starts_at keeps the provider's seconds; time is rounded to the minute.
  return a.movie_id !== b.movie_id || a.date !== b.date || a.time !== b.time || a.starts_at !== b.starts_at || (a.screen ?? null) !== (b.screen ?? null);
}

/**
 * Room, version and format of one Cinex session button. Its text is the room
 * line ("Sala 3", "Sala VIP", "VIP (Piso 5)") then the time; its icon gives
 * the version: xes (Spanish, dubbed), xen, xsub (subtitled) or a format such
 * as x4DX, which then says nothing about the language.
 */
export function cinexSessionDetails(text: string, icon?: string): Pick<DataItem, 'screen' | 'language' | 'format'> {
  const lines = text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const at = lines.findIndex(line => /^\d{1,2}:\d{2}\s*(?:am|pm)?$/i.test(line));
  // The line before the time; without a time line, only an explicit "Sala ...".
  const line = at > 0 ? lines[at - 1] : lines.find(l => /^Sala\s+\S/i.test(l));
  const room = line?.replace(/^Sala\s+/i, '');
  const screen = room && room.length <= 40 ? room : undefined;
  const code = icon?.split(/[/?#]/).pop()?.toLowerCase().match(/^x?([a-z0-9]+)(?:[._-]|$)/)?.[1];
  if (code === 'es' || code === 'en') return { screen, language: code };
  if (code === 'sub') return { screen, language: 'subtitulada' };
  if (code && /^(?:2d|3d|4dx|imax|screenx)$/.test(code)) return { screen, format: code.toUpperCase() };
  return { screen };
}

const cinexMovieTitle = (name: string) => folded(name).replace(/[^a-z0-9]/g, '');

/** Parse the calendar-style cinema page, whose blocks have titles but no movie slugs. */
export function parseCinexCinemaShowtimes(html: string, movies: DataItem[], cinemaId: string, date: string, c: ReadContext, url: string, cinemaName?: string): DataItem[] {
  if (!Id.safeParse(cinemaId).success) throw new DataError('error', 'Código de sede Cinex inválido.');
  const byTitle = new Map<string, DataItem[]>();
  for (const movie of movies) {
    const key = cinexMovieTitle(movie.name);
    const list = byTitle.get(key) ?? []; list.push(movie); byTitle.set(key, list);
  }
  const $ = load(html), items = new Map<string, DataItem>();
  const suppressed = new Set<string>();
  let blocks = 0, nodes = 0;
  const sessionCall = /checkLogin\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i;
  // A session ID must have one film, start and room across the whole page,
  // not only within the requested date: compare every occurrence first.
  const identities = new Map<string, string>(), contradictory = new Set<string>();
  $('.sessionslist').each((_, block) => {
    const blockTitle = cinexMovieTitle(decodeLabel($(block).find('h5.title').first().text()));
    $(block).find('[onclick*="checkLogin("]').each((_, e) => {
      const match = ($(e).attr('onclick') ?? '').match(sessionCall), epoch = number($(e).attr('alt'));
      if (!match || match[2] !== cinemaId || epoch === undefined || !Number.isInteger(epoch)) return;
      const readable = $(e).clone(); readable.find('br').replaceWith('\n');
      const identity = JSON.stringify([blockTitle, epoch, readable.text().match(/Sala\s+([A-Za-z0-9_-]+)/i)?.[1] ?? null]);
      const key = `${cinemaId}:${match[1]}`, previous = identities.get(key);
      if (previous === undefined) identities.set(key, identity); else if (previous !== identity) contradictory.add(key);
    });
  });
  $('.sessionslist').each((_, block) => {
    blocks++;
    const title = decodeLabel($(block).find('h5.title').first().text());
    // "Censura: <b>B</b>", the venue's age rating for this film.
    const rating = decodeLabel($(block).find('.movieinforow3 b').first().text()).slice(0, 20) || undefined;
    const sessionNodes = $(block).find('[onclick*="checkLogin("]');
    nodes += sessionNodes.length;
    if (!sessionNodes.length) return;
    const validEpochNodes = sessionNodes.filter((_, e) => {
      const epoch = number($(e).attr('alt'));
      return epoch !== undefined && Number.isInteger(epoch) && epoch >= 1e9 && epoch <= 1e11;
    });
    if (validEpochNodes.length !== sessionNodes.length) {
      c.partial = true;
      providerWarning(c, 'cinex-cinema-malformed-epoch', 'Cinex devolvió una o más funciones de sede con hora epoch ausente o malformada; se omitieron.');
    }
    const datedNodes = validEpochNodes.filter((_, e) => new Date(number($(e).attr('alt'))! * 1000 - 4 * 3600000).toISOString().slice(0, 10) === date);
    // Do not report a missing catalog match for a different commercial date
    // present in the same multi-day cinema page.
    if (!datedNodes.length) {
      return;
    }
    const matches = title ? (byTitle.get(cinexMovieTitle(title)) ?? []) : [];
    if (matches.length !== 1) {
      c.partial = true;
      providerWarning(c, !title ? 'cinex-cinema-missing-title' : matches.length > 1 ? 'cinex-cinema-ambiguous-title' : 'cinex-cinema-unknown-title', () => !title
        ? 'Cinex devolvió una función sin título de película; se omitió porque no se puede confirmar su movie_id.'
        : matches.length > 1
          ? `Cinex devolvió una función con título ambiguo (${warningLabel(title)}); se omitió porque no se puede confirmar su movie_id.`
          : `Cinex no encontró el título de función en su catálogo (${warningLabel(title)}); se omitió porque no se puede confirmar su movie_id.`);
      return;
    }
    const movie = matches[0];
    datedNodes.each((_, e) => {
      const raw = $(e).attr('onclick') ?? '';
      const match = raw.match(/checkLogin\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i);
      const epoch = number($(e).attr('alt'));
      if (!match || epoch === undefined || !Number.isInteger(epoch) || epoch < 1e9 || epoch > 1e11) {
        c.partial = true; providerWarning(c, 'cinex-cinema-malformed-session', () => `Cinex omitió una función malformada de ${warningLabel(title || 'película sin título')}.`); return;
      }
      const sessionId = match[1], sourceCinema = match[2];
      if (!Id.safeParse(sessionId).success || sourceCinema !== cinemaId) {
        c.partial = true; providerWarning(c, 'cinex-cinema-invalid-id', () => `Cinex omitió una función con identificador de sede o sesión no verificable (${warningLabel(sessionId)}).`); return;
      }
      const local = new Date(epoch * 1000 - 4 * 3600000).toISOString().slice(0, 19);
      if (local.slice(0, 10) !== date) return;
      const readable = $(e).clone(); readable.find('br').replaceWith('\n');
      const item: DataItem = { kind: 'showtime', id: sessionId, name: movie.name, cinema_id: cinemaId, cinema_name: cinemaName, movie_id: movie.id,
        date, time: local.slice(11, 16), starts_at: `${local}-04:00`, rating,
        ...cinexSessionDetails(readable.text(), $(e).find('img.icoIdioma').attr('src')), url };
      const key = `${cinemaId}:${sessionId}`;
      if (suppressed.has(key)) return;
      const previous = items.get(key);
      if (contradictory.has(key) || (previous && cinexSessionConflict(previous, item))) {
        c.partial = true; providerWarning(c, 'cinex-cinema-conflict', () => `Cinex devolvió horarios contradictorios para la función ${warningLabel(sessionId)}; se omitió.`); items.delete(key); suppressed.add(key); return;
      }
      items.set(key, item);
    });
  });
  if (!blocks) throw new DataError('error', 'No se reconoció la estructura de funciones de Cinex.');
  if (!nodes) providerWarning(c, 'cinex-cinema-no-sessions', 'Cinex no devolvió funciones para la fecha solicitada.');
  providerWarningSummary(c);
  return [...items.values()];
}
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
    while (next < work.length && Date.now() < deadline) {
      const v = work[next++];
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
