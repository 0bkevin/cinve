import { parseCinemaDirectory } from './cinema-directory.js';
import { CinexCinemaCatalog } from './cinex-cinemas.js';
import { load } from 'cheerio';
import { DataError, DateInput, folded, Id, number, operationItemSchema, requireArg, text, today } from './core.js';
import type { DataItem, Operation, Query } from './core.js';
import { ReadContext } from './http.js';
import { decodeLabel, findField, pageFields, flight, object, objects, requiredText, rows } from './parsers.js';
import type { Obj } from './parsers.js';
import { parseCinesUnidosPrices, parseCinexPrices, parseCinexConcessions } from './authenticated-parsers.js';

const providerWarningKinds = 32;
const providerWarningLabelLength = 120;
type ProviderWarningState = { entries: Map<string, { index: number; count: number; base: string }>; suppressed: number; aggregateIndex?: number };
const providerWarningStates = new WeakMap<ReadContext, ProviderWarningState>();

function warningLabel(value: unknown, max = providerWarningLabelLength): string {
  const textValue = typeof value === 'string' ? value : String(value ?? '');
  const compact = textValue.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

/** Keep parser diagnostics bounded before they enter the request-scoped context. */
function providerWarning(c: ReadContext, key: string, message: string | (() => string)) {
  const state: ProviderWarningState = providerWarningStates.get(c) ?? { entries: new Map(), suppressed: 0 };
  providerWarningStates.set(c, state);
  const existing = state.entries.get(key);
  if (existing) {
    existing.count++;
    return;
  }
  if (state.entries.size < providerWarningKinds) {
    const bounded = warningLabel(typeof message === 'function' ? message() : message, 512);
    const index = c.warnings.length;
    c.warnings.push(bounded);
    state.entries.set(key, { index, count: 1, base: bounded.replace(/ \(repetido \d+ veces\)\.$/, '') });
    return;
  }
  state.suppressed++;
  if (state.aggregateIndex === undefined) {
    state.aggregateIndex = c.warnings.length;
    c.warnings.push('Repeated or excess provider diagnostics were omitted; the response may be partial.');
  }
}

function providerWarningSummary(c: ReadContext) {
  const state = providerWarningStates.get(c);
  if (!state) return;
  for (const entry of state.entries.values()) {
    if (entry.count > 1) c.warnings[entry.index] = `${entry.base} (repeated ${entry.count} times).`;
  }
  if (state.aggregateIndex !== undefined && state.suppressed > 1) c.warnings[state.aggregateIndex] = `${state.suppressed} repeated or excess provider diagnostics were omitted; the response may be partial.`;
}

const CP = {
  '123300': { name: 'Cinepic Candelaria', host: 'https://cinepiccandelaria.com' },
  '123301': { name: 'Cinepic VVIP', host: 'https://cinepicvip.com' },
} as const;
function cpSite(q: Query) {
  const id = requireArg(q, 'cinema_id');
  if (!(id in CP)) throw new DataError('unavailable', 'Cinepic supports the venues 123300 (Candelaria) and 123301 (VVIP Lido).');
  return CP[id as keyof typeof CP];
}
function isoDate(q: Query) { return q.date ?? today(); }
function flagValue(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return undefined;
}
function movieCP(r: Obj, site: string): DataItem {
  return { kind: 'movie', id: requiredText(r, 'peliculas_codigo'), name: requiredText(r, 'peliculas_nombre'),
    duration_minutes: number(r.peliculas_duracion), genre: text(r.peliculas_genero), rating: text(r.peliculas_clasificacion),
    format: text(r.peliculas_tipo), image_url: text(r.imagen), url: `${site}/es-AR/programacion/${encodeURIComponent(text(r.peliculas_codigo))}` };
}
export async function cpBuy(q: Query, c: ReadContext) {
  const site = cpSite(q);
  const url = `${site.host}/es-AR/compra?${new URLSearchParams({ cid: requireArg(q, 'cinema_id'), fid: requireArg(q, 'session_id'), pid: requireArg(q, 'movie_id') })}`;
  const html = await c.get(url, 60000), records = flight(html);
  const functionData = findField(records, 'functionData');
  if (functionData === undefined) {
    const $ = load(html); $('script,style').remove();
    if (/No pudimos mostrar la función/.test($.text()) && /\bAC-001\b/.test($.text())) throw new DataError('unavailable', 'Cinepic reports that it could not load the showtime (AC-001). Try again later.');
  }
  const f = object(functionData);
  const functions = rows(f.datos, 'functionData.datos');
  if (text(functions[0]?.id) !== q.session_id || text(functions[0]?.codigo) !== q.movie_id) throw new DataError('unavailable', 'The page does not match the requested showtime and movie.');
  return { records, f, url };
}
export async function cinepic(op: Operation, q: Query, c: ReadContext): Promise<DataItem[]> {
  if (op === 'cities') {
    c.warnings.push('Configured Cinepic coverage: Caracas only; list_cities does not query the two venue sites.');
    return [{ kind: 'city', id: 'Caracas', name: 'Caracas' }];
  }
  if (op === 'cinemas') {
    if (q.city && folded(q.city) !== 'caracas') return [];
    c.warnings.push('Cinepic coverage: two configured venues, Candelaria and VVIP; new venues are not discovered automatically.');
    return Promise.all(Object.entries(CP).map(async ([id, site]) => {
      const url = `${site.host}/es-AR`;
      try {
        const records = flight(await c.get(url, 3600000));
        const configs = [...objects(records)].filter(r => text(r.idUltracine) === id && text(r.nombre));
        const config = configs[0];
        if (!config || text(config.nombre).length > 512 || configs.some(r => text(r.nombre) !== text(config.nombre))) {
          throw new DataError('error', 'Public venue configuration missing or contradictory.');
        }
        return { kind: 'cinema' as const, id, cinema_id: id, code_status: 'verified' as const,
          name: text(config.nombre), city: 'Caracas', address: text(config.direccion), url };
      } catch (error) {
        c.partial = true;
        c.warnings.push(`${site.name}: the current configuration could not be verified; the known venue and its link are kept. This does not indicate a closure. ${error instanceof DataError ? error.message : ''}`);
        return { kind: 'cinema' as const, id: `directory-cinepic-${id}`, code_status: 'unverified' as const, name: site.name, city: 'Caracas', url };
      }
    }));
  }
  if (op === 'concessions') {
      cpSite(q);
      const url = `https://api.cinexo.com.ar/api/complejo/${encodeURIComponent(q.cinema_id!)}/candy`;
      const candy = object(await c.json(url));
      const units = rows(candy.unidades_negocios, 'candy.unidades_negocios');
      if (units.length) throw new DataError('unavailable', 'The Cinepic catalog is no longer empty; its product and currency schema needs validation before prices are shown.');
      c.warnings.push('The public API returned no concessions for this venue; this does not mean it sells no products at the box office.');
      return [];
  }
  if (op === 'prices') {
    const { records, f, url } = await cpBuy(q, c);
    const cfg = object(findField(records, 'configData'));
    const rate = number(cfg.tasaConversion);
    // Verified in the current purchase JS: tarifa.precio is labeled '(Bs.)';
    // checkout divides SubtotalTarifas by tasaConversion and sets currency:'USD'.
    c.warnings.push('Prices in VES according to the provider\'s interface. USD calculated with its conversion rate, not a verified BCV rate; final charges not verified.');
    if (rate === undefined || rate <= 0) c.warnings.push('No positive conversion rate; the USD equivalent is omitted.');
    return rows(f.tarifas, 'functionData.tarifas').map(r => {
      const amount = number(r.precio);
      if (amount === undefined || amount < 0) throw new DataError('error', 'Price without a valid amount.');
      const prices: NonNullable<DataItem['prices']> = [{ currency: 'VES', amount, basis: 'provider' }];
      if (rate !== undefined && rate > 0) prices.push({ currency: 'USD', amount: Number((amount / rate).toFixed(2)), basis: 'provider_conversion' });
      return { kind: 'ticket_price', id: requiredText(r, '_id'), name: requiredText(r, 'descripcion'),
        cinema_id: q.cinema_id, movie_id: q.movie_id, session_id: q.session_id, url,
        prices, provider_currency: text(cfg.moneda), provider_conversion_rate: rate, final_total_verified: false };
    });
  }
  const site = cpSite(q), date = isoDate(q);
  const [year, month, day] = date.split('-');
  const url = `https://apifront.cinexo.com.ar/mobile/consultas/peliculas/PeliculasConFuncionesYHorarios?${new URLSearchParams({ idComplejo: q.cinema_id!, fecha: `${day}/${month}/${year}` })}`;
  const payload = object(await c.json(url));
  if (payload.success !== true) throw new DataError('error', 'Cinepic did not confirm that the query succeeded.');
  const data = object(payload.data);
  const movies = rows(data.datos, 'data.datos'), sessions = rows(data.funciones, 'data.funciones');
  const names = new Map(movies.map(r => [text(r.peliculas_codigo), r]));
  if (op === 'movies') {
    const scheduled = new Set(sessions.map(r => Id.parse(requiredText(r, 'codPelicula'))));
    return [...scheduled].map(mid => {
      const movie = names.get(mid);
      if (movie && text(movie.peliculas_nombre)) return { ...movieCP(movie, site.host), cinema_id: q.cinema_id };
      c.partial = true;
      c.warnings.push(`Movie ${mid}: there are showtimes but no movie record with a title was received; the reference is kept.`);
      return { kind: 'movie', id: mid, name: `Movie ${mid}`, cinema_id: q.cinema_id,
        url: `${site.host}/es-AR/programacion/${encodeURIComponent(mid)}` };
    });
  }
  return sessions.filter(r => !q.movie_id || text(r.codPelicula) === q.movie_id).map(r => {
    const id = requiredText(r, '_id'), mid = requiredText(r, 'codPelicula'), movie = names.get(mid);
    const time = requiredText(r, 'hora');
    if (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new DataError('error', 'Invalid Cinepic showtime.');
    const overnight = flagValue(r.trasnoche);
    if (overnight === undefined) {
      c.partial = true;
      providerWarning(c, 'cinepic-unknown-trasnoche', () => `Showtime ${warningLabel(id)}: Cinepic did not confirm whether it is a late-night showing; the calendar date marker is omitted.`);
    } else if (overnight) {
      providerWarning(c, 'cinepic-trasnoche', () => `Showtime ${warningLabel(id)}: late-night showing; business date received, calendar date unconfirmed.`);
    }
    if (!movie || !text(movie.peliculas_nombre)) {
      c.partial = true;
      providerWarning(c, 'cinepic-missing-movie-title', () => `Showtime ${warningLabel(id)}: no record with a title was received for movie ${warningLabel(mid)}.`);
    }
    const subtitled = flagValue(r.subtitulada);
    if (subtitled === undefined) {
      c.partial = true;
      providerWarning(c, 'cinepic-unknown-subtitle', () => `Showtime ${warningLabel(id)}: Cinepic did not confirm the subtitle status; language is omitted.`);
    }
    return { kind: 'showtime', id, name: text(movie?.peliculas_nombre) || `Movie ${mid}`, cinema_id: q.cinema_id, cinema_name: site.name, movie_id: mid,
      date, time, starts_at: overnight === true ? undefined : overnight === false ? `${date}T${time}:00-04:00` : undefined,
      format: text(r.formato), language: subtitled === undefined ? undefined : subtitled ? 'subtitulada' : 'no_subtitulada',
      url: `${site.host}/es-AR/compra?${new URLSearchParams({ cid: q.cinema_id!, fid: id, pid: mid })}` };
  });
}

const CU = 'https://www.cinesunidos.com';
export async function cinesunidos(op: Operation, q: Query, c: ReadContext): Promise<DataItem[]> {
  if (op === 'cities') {
    const data = await c.json('https://gateway.cinesunidos.com/search/cities');
    if (!Array.isArray(data) || data.some(r => typeof r !== 'string')) throw new DataError('error', 'Unrecognized city list.');
    return data.map(r => ({ kind: 'city', id: r, name: r }));
  }
  if (op === 'prices') {
    const url = `https://gateway.cinesunidos.com/tickets/www/theaters/${encodeURIComponent(requireArg(q, 'cinema_id'))}/sessions/${encodeURIComponent(requireArg(q, 'session_id'))}/`;
    const body = await c.authenticated('cinesunidos', url);
    let data: unknown; try { data = JSON.parse(body); } catch { throw new DataError('error', 'The provider did not return valid price JSON.'); }
    c.warnings.push('Prices for the authenticated showtime; check redemption/age restrictions. Not a final purchase total.');
    return parseCinesUnidosPrices(data, q, url);
  }
  if (op === 'concessions') {
    const id = requireArg(q, 'cinema_id');
    const url = `https://gateway.cinesunidos.com/concessions/www/cinemas/${encodeURIComponent(id)}/concessions`;
    c.warnings.push('Prices and stock from this venue\'s catalog; taxes included and final charges not verified.');
    return rows(await c.json(url), 'concessions').map(r => {
      const prices: NonNullable<DataItem['prices']> = [];
      for (const [key, currency] of [['itemPriceUSD', 'USD'], ['itemPriceVE', 'VES']] as const) {
        const amount = number(r[key]); if (amount !== undefined && amount >= 0) prices.push({ currency, amount, basis: 'provider' });
      }
      if (!prices.length) c.warnings.push(`Product ${warningLabel(r.itemId)} without a verifiable price.`);
      return { kind: 'concession', id: requiredText(r, 'itemId'), name: requiredText(r, 'itemDescription'), cinema_id: id,
        category: text(r.itemClassDescription), stock: number(r.itemStock), prices, final_total_verified: false, image_url: text(r.itemImageUrl), url: `${CU}/carameleria` };
    });
  }
  let city = requireArg(q, 'city');
  const key = op === 'cinemas' ? 'theaters' : 'movies';
  let url = `${CU}/${op === 'cinemas' ? 'cines' : 'cartelera'}?${new URLSearchParams({ city })}`;
  let fields: unknown[];
  try {
    fields = pageFields(flight(await c.get(url, op === 'cinemas' ? 3600000 : 120000)), key);
    if (!fields.length) {
      // The provider's city filter is accent-sensitive. Retry only with a name
      // actually returned by its official city registry, never guess a city.
      const canonical = await cinesUnidosCity(city, q, c);
      if (canonical !== city) {
        city = canonical;
        url = `${CU}/${op === 'cinemas' ? 'cines' : 'cartelera'}?${new URLSearchParams({ city })}`;
        fields = pageFields(flight(await c.get(url, op === 'cinemas' ? 3600000 : 120000)), key);
      }
    }
  } catch (error) {
    // www.cinesunidos.com challenges some datacenter networks (including the
    // hosted service's). Its public search API is not challenged; use it
    // instead of the page, never a way around the challenge itself.
    if (!(error instanceof DataError) || error.status !== 'blocked') throw error;
    return cinesUnidosGateway(op, q, c, city);
  }
  if (!fields.length) throw new DataError('error', `Unrecognized Cines Unidos catalog: ${key}.`);
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
        if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(raw) || !DateInput.safeParse(raw.slice(0, 10)).success) throw new DataError('error', 'Cines Unidos date in an unrecognized format.');
        if (raw.slice(0, 10) !== isoDate(q)) continue;
        sessions.push({ kind: 'showtime', id: requiredText(s, 'id'), name: requiredText(m, 'title'), cinema_id: cid, cinema_name: warningLabel(text(cinema.name), 200) || undefined, movie_id: mid,
          date: raw.slice(0, 10), time: raw.slice(11, 16), starts_at: `${raw}-04:00`, screen: text(s.screen), format: text(s.format),
          url: `${CU}/pelicula/${encodeURIComponent(mid)}?${new URLSearchParams({ city })}` });
      }
    }
    if (op === 'showtimes') items.push(...sessions);
    else if (sessions.length) items.push({ kind: 'movie', id: mid, name: requiredText(m, 'title'), city,
      url: `${CU}/pelicula/${encodeURIComponent(mid)}?${new URLSearchParams({ city })}` });
  }
  return items;
}

async function cinesUnidosCity(city: string, q: Query, c: ReadContext): Promise<string> {
  const cities = await cinesunidos('cities', q, c);
  const canonical = cities.find(r => folded(r.name) === folded(city))?.name;
  if (!canonical) throw new DataError('unavailable', 'City not recognized by Cines Unidos; check list_cities.');
  return canonical;
}

const cuGatewayTitles = 80;
// One deadline for the whole fan-out: forty slow titles at two reads at a
// time could otherwise run past the hosted 90 s limit while every single read
// stays within its own 15 s.
const cuGatewayBudgetMs = 45000;
const cuGatewayWorkers = 2;
/** Cines Unidos public search API: directory, billboard titles and sessions by title. */
async function cinesUnidosGateway(op: Operation, q: Query, c: ReadContext, requestedCity: string): Promise<DataItem[]> {
  const city = await cinesUnidosCity(requestedCity, q, c);
  const base = `https://gateway.cinesunidos.com/search/cities/${encodeURIComponent(city)}`;
  const pageUrl = (path: string) => `${CU}/${path}?${new URLSearchParams({ city })}`;
  c.warnings.push('The Cines Unidos website rejected the automated query; the data comes from its public search API.');
  if (op === 'cinemas') return parseCinemaDirectory([rows(await c.json(`${base}/theaters`), 'gateway theaters')], city, pageUrl('cines'), c);
  const films = await c.json(`${base}/films`);
  if (!Array.isArray(films) || films.some(t => typeof t !== 'string')) throw new DataError('error', 'Unrecognized Cines Unidos movie list.');
  // The service filters results by name; the session title is the searched
  // film title, so a name filter can skip the searches it would discard.
  const titles = [...new Set((films as string[]).map(t => t.trim()).filter(t => t && t.length <= 200))]
    .filter(t => !q.query || folded(t).includes(folded(q.query)));
  if (titles.length > cuGatewayTitles) {
    c.partial = true;
    c.warnings.push(`${cuGatewayTitles} of ${titles.length} Cines Unidos titles were queried; the result is partial.`);
  }
  const date = isoDate(q);
  // Normalize each title's sessions inside its own settled task: a title
  // whose records are malformed fails alone instead of taking the others along.
  const normalize = (s: Obj): DataItem | undefined => {
    const raw = requiredText(s, 'showtime');
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(raw) || !DateInput.safeParse(raw.slice(0, 10)).success) throw new DataError('error', 'Cines Unidos date in an unrecognized format.');
    const mid = requiredText(s, 'ho'), cid = requiredText(s, 'cinemaId'), name = requiredText(s, 'title');
    if (raw.slice(0, 10) !== date || (q.cinema_id && cid !== q.cinema_id) || (q.movie_id && mid !== q.movie_id)) return undefined;
    const item: DataItem = { kind: 'showtime', id: requiredText(s, 'sessionId'), name, cinema_id: cid, movie_id: mid,
      date, time: raw.slice(11, 16), starts_at: `${raw}-04:00`, screen: text(s.screenNumber), format: text(s.format),
      language: text(s.language), url: `${CU}/pelicula/${encodeURIComponent(mid)}?${new URLSearchParams({ city })}` };
    // Apply the service's result validation here, so an invalid ID or an
    // oversized title fails this title only, not the whole response.
    operationItemSchema('showtimes').parse(item); Id.parse(item.id);
    return item;
  };
  const showtimes: DataItem[] = [];
  const failures: unknown[] = [];
  const work = titles.slice(0, cuGatewayTitles);
  const deadline = Date.now() + cuGatewayBudgetMs;
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
      c.progress(`Cines Unidos: ${succeeded + failures.length} of ${work.length} titles queried.`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cuGatewayWorkers, work.length) }, worker));
  const skipped = work.length - next;
  // One failed title must not discard every other title's schedule.
  if (failures.length) {
    c.partial = true;
    c.warnings.push(`Showtimes could not be queried for ${failures.length} of ${work.length} Cines Unidos titles; the result is partial.`);
  }
  if (skipped) {
    c.partial = true;
    c.warnings.push(`The query timed out before reading ${skipped} of ${work.length} Cines Unidos titles; use query with the title to look them up.`);
  }
  if (work.length && !succeeded) throw failures[0] ?? new DataError('unavailable', 'The Cines Unidos query timed out; use query with the movie title.');
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
  if (!items.size) throw new DataError('error', 'Unrecognized Cinex HTML listings.');
  return [...items.values()];
}
export function parseCinexShowtimes(html: string, movieId: string, date: string, c?: ReadContext): DataItem[] {
  const $ = load(html);
  const title = decodeLabel($('h1').first().text() || movieId);
  const nodes = $('[onclick*="checkLogin("]');
  if (!nodes.length) throw new DataError('unavailable', 'The Cinex movie page contains no recognizable showtimes.');
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
    // Same room syntax as the venue page (Sala 3, Sala VIP).
    const body = readable.text(), screen = body.match(/Sala\s+([A-Za-z0-9_-]+)/i)?.[1];
    const key = `${match[2]}:${match[1]}`;
    const list = occurrences.get(key) ?? []; occurrences.set(key, list);
    list.push({ kind: 'showtime', id: match[1], name: title,
      movie_id: movieId, cinema_id: match[2], date: local.slice(0, 10), time: local.slice(11, 16), starts_at: `${local}-04:00`, screen,
      language: cinexLanguage($(e).find('img.icoIdioma').attr('src')),
      url: `${CX}/sinopsis-${movieId}.html` });
  });
  const items: DataItem[] = [];
  for (const list of occurrences.values()) {
    if (!list.some(item => item.date === date)) continue;
    if (list.some(item => cinexSessionConflict(list[0], item))) {
      if (c) { c.partial = true; providerWarning(c, 'cinex-movie-conflict', () => `Cinex returned contradictory times for showtime ${warningLabel(list[0].id)}; it was omitted.`); }
      continue;
    }
    items.push(list[0]);
  }
  if (malformed && c) {
    c.partial = true;
    providerWarning(c, 'cinex-movie-malformed-session', 'Cinex returned one or more movie showtimes with a malformed epoch or identifier; they were omitted.');
  }
  if (c) providerWarningSummary(c);
  return items;
}

/** The same session ID with another film, date, time or room cannot drive a price or seat lookup. */
function cinexSessionConflict(a: DataItem, b: DataItem) {
  // starts_at keeps the provider's seconds; time is rounded to the minute.
  return a.movie_id !== b.movie_id || a.date !== b.date || a.time !== b.time || a.starts_at !== b.starts_at || (a.screen ?? null) !== (b.screen ?? null);
}

function cinexLanguage(src?: string): string | undefined {
  const file = src?.split(/[/?#]/).pop()?.toLowerCase() ?? '';
  return file.match(/^x?(es|en)(?:[._-]|$)/)?.[1];
}

const cinexMovieTitle = (name: string) => folded(name).replace(/[^a-z0-9]/g, '');

/** Parse the calendar-style cinema page, whose blocks have titles but no movie slugs. */
export function parseCinexCinemaShowtimes(html: string, movies: DataItem[], cinemaId: string, date: string, c: ReadContext, url: string, cinemaName?: string): DataItem[] {
  if (!Id.safeParse(cinemaId).success) throw new DataError('error', 'Invalid Cinex venue code.');
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
    const sessionNodes = $(block).find('[onclick*="checkLogin("]');
    nodes += sessionNodes.length;
    if (!sessionNodes.length) return;
    const validEpochNodes = sessionNodes.filter((_, e) => {
      const epoch = number($(e).attr('alt'));
      return epoch !== undefined && Number.isInteger(epoch) && epoch >= 1e9 && epoch <= 1e11;
    });
    if (validEpochNodes.length !== sessionNodes.length) {
      c.partial = true;
      providerWarning(c, 'cinex-cinema-malformed-epoch', 'Cinex returned one or more venue showtimes with a missing or malformed epoch time; they were omitted.');
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
        ? 'Cinex returned a showtime without a movie title; it was omitted because its movie_id cannot be confirmed.'
        : matches.length > 1
          ? `Cinex returned a showtime with an ambiguous title (${warningLabel(title)}); it was omitted because its movie_id cannot be confirmed.`
          : `Cinex did not find the showtime title in its catalog (${warningLabel(title)}); it was omitted because its movie_id cannot be confirmed.`);
      return;
    }
    const movie = matches[0];
    datedNodes.each((_, e) => {
      const raw = $(e).attr('onclick') ?? '';
      const match = raw.match(/checkLogin\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i);
      const epoch = number($(e).attr('alt'));
      if (!match || epoch === undefined || !Number.isInteger(epoch) || epoch < 1e9 || epoch > 1e11) {
        c.partial = true; providerWarning(c, 'cinex-cinema-malformed-session', () => `Cinex omitted a malformed showtime of ${warningLabel(title || 'untitled movie')}.`); return;
      }
      const sessionId = match[1], sourceCinema = match[2];
      if (!Id.safeParse(sessionId).success || sourceCinema !== cinemaId) {
        c.partial = true; providerWarning(c, 'cinex-cinema-invalid-id', () => `Cinex omitted a showtime with an unverifiable venue or session identifier (${warningLabel(sessionId)}).`); return;
      }
      const local = new Date(epoch * 1000 - 4 * 3600000).toISOString().slice(0, 19);
      if (local.slice(0, 10) !== date) return;
      const readable = $(e).clone(); readable.find('br').replaceWith('\n');
      const body = readable.text(), screen = body.match(/Sala\s+([A-Za-z0-9_-]+)/i)?.[1];
      const item: DataItem = { kind: 'showtime', id: sessionId, name: movie.name, cinema_id: cinemaId, cinema_name: cinemaName, movie_id: movie.id,
        date, time: local.slice(11, 16), starts_at: `${local}-04:00`, screen,
        language: cinexLanguage($(e).find('img.icoIdioma').attr('src')), url };
      const key = `${cinemaId}:${sessionId}`;
      if (suppressed.has(key)) return;
      const previous = items.get(key);
      if (contradictory.has(key) || (previous && cinexSessionConflict(previous, item))) {
        c.partial = true; providerWarning(c, 'cinex-cinema-conflict', () => `Cinex returned contradictory times for showtime ${warningLabel(sessionId)}; it was omitted.`); items.delete(key); suppressed.add(key); return;
      }
      items.set(key, item);
    });
  });
  if (!blocks) throw new DataError('error', 'Unrecognized Cinex showtime structure.');
  if (!nodes) providerWarning(c, 'cinex-cinema-no-sessions', 'Cinex returned no showtimes for the requested date.');
  providerWarningSummary(c);
  return [...items.values()];
}
export async function cinex(op: Operation, q: Query, c: ReadContext, catalog = new CinexCinemaCatalog()): Promise<DataItem[]> {
  if (op === 'cities') {
    const data = object(await c.json(cxSource('getcinemacitieslist')));
    return rows(data.data, 'cities.data').map(r => ({ kind: 'city', id: decodeLabel(r.cinema_city), name: decodeLabel(r.cinema_city) }));
  }
  if (op === 'cinemas') return catalog.list(q, c);
  if (op === 'prices') {
    // Cinex publishes ticket prices only on the authenticated function page.
    const sessionId = requireArg(q, 'session_id');
    if ((await c.authenticated('cinex', `${CX}/checklogin.php`)).trim() !== 'on') throw new DataError('auth_required', 'The Cinex session expired. Run npm run login -- cinex in a local terminal.');
    const url = `${CX}/boletos.php?${new URLSearchParams({ sessionid: sessionId, cinemaid: requireArg(q, 'cinema_id') })}`;
    c.warnings.push('VES amount for the showtime, with the ticket and other charges itemized; not a final purchase total.');
    return parseCinexPrices(await c.authenticated('cinex', url), q, url);
  }
  if (op === 'concessions') {
    if ((await c.authenticated('cinex', `${CX}/checklogin.php`)).trim() !== 'on') throw new DataError('auth_required', 'The Cinex session expired. Run npm run login -- cinex in a local terminal.');
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
    try {
      return parseCinexShowtimes(await c.get(`${CX}/sinopsis-${encodeURIComponent(mid)}.html`), mid, date, c);
    } catch (error) {
      if (error instanceof DataError && error.status === 'unavailable') throw new DataError('unavailable', 'The Cinex page for this movie lists no showtimes. Call get_showtimes with the cinema_id of each venue (list_cinemas), which reads the venue\'s schedule.');
      throw error;
    }
  }
  if (q.city && !q.cinema_id) return cinexCityShowtimes(q, c, catalog, date);
  const cinemaId = requireArg(q, 'cinema_id');
  const venue = await catalog.resolve(cinemaId, c);
  const page = venue.body === undefined ? await c.page(venue.url, 120000) : { body: venue.body };
  const movies = parseCinexMovies(await c.get(`${CX}/cartelera.html`, 120000));
  const items = parseCinexCinemaShowtimes(page.body, movies, cinemaId, date, c, venue.url, venue.name ? warningLabel(decodeLabel(venue.name), 200) || undefined : undefined);
  return q.movie_id ? items.filter(r => r.movie_id === q.movie_id) : items;
}

const cinexCityVenues = 16;
// One deadline for discovery, catalog and venue reads; with at most one read
// in flight per worker past it (15 s), a call stays well under the hosted 90 s.
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
  const deadline = Date.now() + cinexCityBudgetMs;
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
    while (next < work.length && Date.now() < deadline) {
      const v = work[next++];
      try {
        const venue = await catalog.resolve(v.cinema_id, c);
        const page = venue.body === undefined ? await c.page(venue.url, 120000) : { body: venue.body };
        items.push(...parseCinexCinemaShowtimes(page.body, movies, v.cinema_id, date, c, venue.url, warningLabel(decodeLabel(v.name), 200) || undefined));
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
