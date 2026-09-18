import { parseCinemaDirectory } from './cinema-directory.js';
import { CinexCinemaCatalog } from './cinex-cinemas.js';
import { load } from 'cheerio';
import { DataError, DateInput, folded, Id, number, requireArg, text, today } from './core.js';
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
    c.warnings.push('Se omitieron diagnósticos repetidos o excedentes del proveedor; la respuesta puede ser parcial.');
  }
}

function providerWarningSummary(c: ReadContext) {
  const state = providerWarningStates.get(c);
  if (!state) return;
  for (const entry of state.entries.values()) {
    if (entry.count > 1) c.warnings[entry.index] = `${entry.base} (repetido ${entry.count} veces).`;
  }
  if (state.aggregateIndex !== undefined && state.suppressed > 1) c.warnings[state.aggregateIndex] = `Se omitieron ${state.suppressed} diagnósticos repetidos o excedentes del proveedor; la respuesta puede ser parcial.`;
}

const CP = {
  '123300': { name: 'Cinepic Candelaria', host: 'https://cinepiccandelaria.com' },
  '123301': { name: 'Cinepic VVIP', host: 'https://cinepicvip.com' },
} as const;
function cpSite(q: Query) {
  const id = requireArg(q, 'cinema_id');
  if (!(id in CP)) throw new DataError('unavailable', 'Cinepic admite las sedes 123300 (Candelaria) y 123301 (VVIP Lido).');
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
    if (/No pudimos mostrar la función/.test($.text()) && /\bAC-001\b/.test($.text())) throw new DataError('unavailable', 'Cinepic informa que no pudo cargar la función (AC-001). Inténtalo nuevamente más tarde.');
  }
  const f = object(functionData);
  const functions = rows(f.datos, 'functionData.datos');
  if (text(functions[0]?.id) !== q.session_id || text(functions[0]?.codigo) !== q.movie_id) throw new DataError('unavailable', 'La página no corresponde a la función y película solicitadas.');
  return { records, f, url };
}
export async function cinepic(op: Operation, q: Query, c: ReadContext): Promise<DataItem[]> {
  if (op === 'cities') {
    c.warnings.push('Cobertura Cinepic configurada: solo Caracas; list_cities no consulta los dos sitios de sede.');
    return [{ kind: 'city', id: 'Caracas', name: 'Caracas' }];
  }
  if (op === 'cinemas') {
    if (q.city && folded(q.city) !== 'caracas') return [];
    c.warnings.push('Cobertura Cinepic: dos sedes configuradas, Candelaria y VVIP; no hay descubrimiento automático de nuevas sedes.');
    return Promise.all(Object.entries(CP).map(async ([id, site]) => {
      const url = `${site.host}/es-AR`;
      try {
        const records = flight(await c.get(url, 3600000));
        const configs = [...objects(records)].filter(r => text(r.idUltracine) === id && text(r.nombre));
        const config = configs[0];
        if (!config || text(config.nombre).length > 512 || configs.some(r => text(r.nombre) !== text(config.nombre))) {
          throw new DataError('error', 'Configuración pública de sede ausente o contradictoria.');
        }
        return { kind: 'cinema' as const, id, cinema_id: id, code_status: 'verified' as const,
          name: text(config.nombre), city: 'Caracas', address: text(config.direccion), url };
      } catch (error) {
        c.partial = true;
        c.warnings.push(`${site.name}: no se pudo verificar la configuración actual; se conserva la sede conocida y su enlace. Esto no indica cierre. ${error instanceof DataError ? error.message : ''}`);
        return { kind: 'cinema' as const, id: `directory-cinepic-${id}`, code_status: 'unverified' as const, name: site.name, city: 'Caracas', url };
      }
    }));
  }
  if (op === 'concessions') {
      cpSite(q);
      const url = `https://api.cinexo.com.ar/api/complejo/${encodeURIComponent(q.cinema_id!)}/candy`;
      const candy = object(await c.json(url));
      const units = rows(candy.unidades_negocios, 'candy.unidades_negocios');
      if (units.length) throw new DataError('unavailable', 'El catálogo Cinepic dejó de estar vacío; su esquema de productos y moneda necesita validación antes de mostrar precios.');
      c.warnings.push('La API pública devolvió caramelería vacía para esta sede; no implica que no venda productos en taquilla.');
      return [];
  }
  if (op === 'prices') {
    const { records, f, url } = await cpBuy(q, c);
    const cfg = object(findField(records, 'configData'));
    const rate = number(cfg.tasaConversion);
    // Verified in the current purchase JS: tarifa.precio is labeled '(Bs.)';
    // checkout divides SubtotalTarifas by tasaConversion and sets currency:'USD'.
    c.warnings.push('Tarifas en VES según la interfaz del proveedor. USD calculado con su tasa de conversión, no una tasa BCV verificada; cargos finales no verificados.');
    if (rate === undefined || rate <= 0) c.warnings.push('Sin tasa de conversión positiva; se omite la equivalencia USD.');
    return rows(f.tarifas, 'functionData.tarifas').map(r => {
      const amount = number(r.precio);
      if (amount === undefined || amount < 0) throw new DataError('error', 'Tarifa sin importe válido.');
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
  if (payload.success !== true) throw new DataError('error', 'Cinepic no confirmó el éxito de la consulta.');
  const data = object(payload.data);
  const movies = rows(data.datos, 'data.datos'), sessions = rows(data.funciones, 'data.funciones');
  const names = new Map(movies.map(r => [text(r.peliculas_codigo), r]));
  if (op === 'movies') {
    const scheduled = new Set(sessions.map(r => Id.parse(requiredText(r, 'codPelicula'))));
    return [...scheduled].map(mid => {
      const movie = names.get(mid);
      if (movie && text(movie.peliculas_nombre)) return { ...movieCP(movie, site.host), cinema_id: q.cinema_id };
      c.partial = true;
      c.warnings.push(`Película ${mid}: hay funciones pero no se recibió una ficha con título; se conserva la referencia.`);
      return { kind: 'movie', id: mid, name: `Película ${mid}`, cinema_id: q.cinema_id,
        url: `${site.host}/es-AR/programacion/${encodeURIComponent(mid)}` };
    });
  }
  return sessions.filter(r => !q.movie_id || text(r.codPelicula) === q.movie_id).map(r => {
    const id = requiredText(r, '_id'), mid = requiredText(r, 'codPelicula'), movie = names.get(mid);
    const time = requiredText(r, 'hora');
    if (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new DataError('error', 'Horario Cinepic inválido.');
    const overnight = flagValue(r.trasnoche);
    if (overnight === undefined) {
      c.partial = true;
      providerWarning(c, 'cinepic-unknown-trasnoche', () => `Función ${warningLabel(id)}: Cinepic no confirmó si es trasnoche; se omite la marca de fecha calendario.`);
    } else if (overnight) {
      providerWarning(c, 'cinepic-trasnoche', () => `Función ${warningLabel(id)}: trasnoche; fecha comercial recibida, fecha calendario sin confirmar.`);
    }
    if (!movie || !text(movie.peliculas_nombre)) {
      c.partial = true;
      providerWarning(c, 'cinepic-missing-movie-title', () => `Función ${warningLabel(id)}: no se recibió ficha con título de la película ${warningLabel(mid)}.`);
    }
    const subtitled = flagValue(r.subtitulada);
    if (subtitled === undefined) {
      c.partial = true;
      providerWarning(c, 'cinepic-unknown-subtitle', () => `Función ${warningLabel(id)}: Cinepic no confirmó el estado de subtítulos; se omite language.`);
    }
    return { kind: 'showtime', id, name: text(movie?.peliculas_nombre) || `Película ${mid}`, cinema_id: q.cinema_id, movie_id: mid,
      date, time, starts_at: overnight === true ? undefined : overnight === false ? `${date}T${time}:00-04:00` : undefined,
      format: text(r.formato), language: subtitled === undefined ? undefined : subtitled ? 'subtitulada' : 'no_subtitulada',
      url: `${site.host}/es-AR/compra?${new URLSearchParams({ cid: q.cinema_id!, fid: id, pid: mid })}` };
  });
}

const CU = 'https://www.cinesunidos.com';
export async function cinesunidos(op: Operation, q: Query, c: ReadContext): Promise<DataItem[]> {
  if (op === 'cities') {
    const data = await c.json('https://gateway.cinesunidos.com/search/cities');
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
  let fields = pageFields(flight(await c.get(url, op === 'cinemas' ? 3600000 : 120000)), key);
  if (!fields.length) {
    // The provider's city filter is accent-sensitive. Retry only with a name
    // actually returned by its official city registry, never guess a city.
    const cities = await cinesunidos('cities', q, c);
    const canonical = cities.find(r => folded(r.name) === folded(city))?.name;
    if (!canonical) throw new DataError('unavailable', 'Ciudad no reconocida por Cines Unidos; consulta list_cities.');
    if (canonical !== city) {
      city = canonical;
      url = `${CU}/${op === 'cinemas' ? 'cines' : 'cartelera'}?${new URLSearchParams({ city })}`;
      fields = pageFields(flight(await c.get(url, op === 'cinemas' ? 3600000 : 120000)), key);
    }
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
        sessions.push({ kind: 'showtime', id: requiredText(s, 'id'), name: requiredText(m, 'title'), cinema_id: cid, movie_id: mid,
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

const CX = 'https://www.cinex.com.ve';
const cxSource = (method: string, id?: string) => `${CX}/assets/php/datasource.php?${new URLSearchParams({ method, ...(id ? { cinemaid: id } : {}) })}`;
export function parseCinexMovies(html: string): DataItem[] {
  const $ = load(html), items = new Map<string, DataItem>();
  $('.poster[onclick]').each((_, e) => {
    const match = ($(e).attr('onclick') ?? '').match(/sinopsis-([a-zA-Z0-9_-]+)\.html/);
    if (!match) return;
    const name = decodeLabel($(e).attr('title') || $(e).attr('alt'));
    if (name) items.set(match[1], { kind: 'movie', id: match[1], name, url: `${CX}/sinopsis-${match[1]}.html` });
  });
  if (!items.size) throw new DataError('error', 'No se reconoció la cartelera HTML de Cinex.');
  return [...items.values()];
}
export function parseCinexShowtimes(html: string, movieId: string, date: string, c?: ReadContext): DataItem[] {
  const $ = load(html), items = new Map<string, DataItem>();
  const title = decodeLabel($('h1').first().text() || movieId);
  const nodes = $('[onclick*="checkLogin("]');
  if (!nodes.length) throw new DataError('unavailable', 'La ficha Cinex no contiene funciones reconocibles.');
  let malformed = 0;
  nodes.each((_, e) => {
    const match = ($(e).attr('onclick') ?? '').match(/checkLogin\('([^']+)','([^']+)'\)/);
    const epoch = number($(e).attr('alt'));
    if (!match || epoch === undefined || !Number.isInteger(epoch) || epoch < 1e9 || epoch > 1e11) { malformed++; return; }
    const local = new Date(epoch * 1000 - 4 * 3600000).toISOString().slice(0, 19);
    if (local.slice(0, 10) !== date) return;
    const readable = $(e).clone(); readable.find('br').replaceWith('\n');
    const body = readable.text(), screen = body.match(/Sala\s+(\d+)/i)?.[1];
    items.set(`${match[2]}:${match[1]}`, { kind: 'showtime', id: match[1], name: title,
      movie_id: movieId, cinema_id: match[2], date, time: local.slice(11, 16), starts_at: `${local}-04:00`, screen,
      language: cinexLanguage($(e).find('img.icoIdioma').attr('src')),
      url: `${CX}/sinopsis-${movieId}.html` });
  });
  if (malformed && c) {
    c.partial = true;
    providerWarning(c, 'cinex-movie-malformed-session', 'Cinex devolvió una o más funciones de película con epoch o identificador malformado; se omitieron.');
    providerWarningSummary(c);
  }
  return [...items.values()];
}

function cinexLanguage(src?: string): string | undefined {
  const file = src?.split(/[/?#]/).pop()?.toLowerCase() ?? '';
  return file.match(/^x?(es|en)(?:[._-]|$)/)?.[1];
}

const cinexMovieTitle = (name: string) => folded(name).replace(/[^a-z0-9]/g, '');

/** Parse the calendar-style cinema page, whose blocks have titles but no movie slugs. */
export function parseCinexCinemaShowtimes(html: string, movies: DataItem[], cinemaId: string, date: string, c: ReadContext, url: string): DataItem[] {
  if (!Id.safeParse(cinemaId).success) throw new DataError('error', 'Código de sede Cinex inválido.');
  const byTitle = new Map<string, DataItem[]>();
  for (const movie of movies) {
    const key = cinexMovieTitle(movie.name);
    const list = byTitle.get(key) ?? []; list.push(movie); byTitle.set(key, list);
  }
  const $ = load(html), items = new Map<string, DataItem>();
  const suppressed = new Set<string>();
  let blocks = 0, nodes = 0;
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
      const body = readable.text(), screen = body.match(/Sala\s+([A-Za-z0-9_-]+)/i)?.[1];
      const item: DataItem = { kind: 'showtime', id: sessionId, name: movie.name, cinema_id: cinemaId, movie_id: movie.id,
        date, time: local.slice(11, 16), starts_at: `${local}-04:00`, screen,
        language: cinexLanguage($(e).find('img.icoIdioma').attr('src')), url };
      const key = `${cinemaId}:${sessionId}`;
      if (suppressed.has(key)) return;
      const previous = items.get(key);
      if (previous && (previous.movie_id !== item.movie_id || previous.time !== item.time || previous.date !== item.date)) {
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
    const data = object(await c.json(cxSource('getcinemacitieslist')));
    return rows(data.data, 'cities.data').map(r => ({ kind: 'city', id: decodeLabel(r.cinema_city), name: decodeLabel(r.cinema_city) }));
  }
  if (op === 'cinemas') return catalog.list(q, c);
  if (op === 'prices') {
    if (q.session_id) {
      if ((await c.authenticated('cinex', `${CX}/checklogin.php`)).trim() !== 'on') throw new DataError('auth_required', 'La sesión Cinex expiró. Ejecuta npm run login -- cinex en una terminal local.');
      const url = `${CX}/boletos.php?${new URLSearchParams({ sessionid: q.session_id, cinemaid: requireArg(q, 'cinema_id') })}`;
      c.warnings.push('Importe VES de la función, con boleto y otros cargos desglosados; no es un total final de compra.');
      return parseCinexPrices(await c.authenticated('cinex', url), q, url);
    }
    const body = (await c.get(cxSource('preparepricecinema', requireArg(q, 'cinema_id')), 60000)).trim();
    if (!body || body.includes('NO DISPONIBLE')) throw new DataError('unavailable', 'Cinex no devuelve un listado de tarifas para esta sede.');
    throw new DataError('unavailable', 'Cinex devolvió un listado cuyo formato de tarifas todavía no está validado.');
  }
  if (op === 'concessions') {
    if ((await c.authenticated('cinex', `${CX}/checklogin.php`)).trim() !== 'on') throw new DataError('auth_required', 'La sesión Cinex expiró. Ejecuta npm run login -- cinex en una terminal local.');
    const url = `${CX}/concesiones.php?${new URLSearchParams({ cinemaid: requireArg(q, 'cinema_id') })}`;
    c.warnings.push('Precios VES del catálogo de sede. La cantidad máxima del formulario no se interpreta como stock; cargos finales no verificados.');
    return parseCinexConcessions(await c.authenticated('cinex', url), q, url);
  }
  if (op === 'movies') {
    c.warnings.push('Cinex devuelve el catálogo general; consulta funciones para confirmar fecha y sede.');
    return parseCinexMovies(await c.get(`${CX}/cartelera.html`));
  }
  const date = isoDate(q);
  if (q.movie_id) {
    const mid = q.movie_id;
    const items = parseCinexShowtimes(await c.get(`${CX}/sinopsis-${encodeURIComponent(mid)}.html`), mid, date, c);
    return items.filter(r => !q.cinema_id || r.cinema_id === q.cinema_id);
  }
  const cinemaId = requireArg(q, 'cinema_id');
  const venue = await catalog.resolve(cinemaId, c);
  const page = venue.body === undefined ? await c.page(venue.url, 120000) : { body: venue.body };
  const movies = parseCinexMovies(await c.get(`${CX}/cartelera.html`, 120000));
  return parseCinexCinemaShowtimes(page.body, movies, cinemaId, date, c, venue.url);
}

export async function trasnocho(_op: Operation, _q: Query, c: ReadContext): Promise<DataItem[]> {
  await c.get('https://www.trasnochocultural.com/cine/');
  throw new DataError('unavailable', 'El sitio es accesible, pero aún no hay un parser de programación validado. No se usan fichas indexadas antiguas como datos actuales.');
}
