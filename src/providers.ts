import { parseCinemaDirectory } from './cinema-directory.js';
import { CinexCinemaCatalog } from './cinex-cinemas.js';
import { load } from 'cheerio';
import { DataError, DateInput, folded, Id, number, operationItemSchema, requireArg, text, today } from './core.js';
import type { DataItem, Operation, Query } from './core.js';
import { CallStopped, ReadContext } from './http.js';
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
/** The configured name of a Cinepic venue, if it is one. */
export const cinepicVenueName = (id: string): string | undefined => (CP as Record<string, { name: string }>)[id]?.name;
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
/**
 * Tickets the purchase page still offers with a tariff, as its own JS counts
 * them: cupo (tot) minus sold (vend) minus held in open checkouts (temp).
 */
export function cinepicTicketsLeft(tariff: Record<string, unknown>): number | undefined {
  const [tot, vend, temp] = [tariff.tot, tariff.vend, tariff.temp].map(v => /^\d+$/.test(text(v)) ? Number(text(v)) : NaN);
  return [tot, vend, temp].every(Number.isFinite) ? Math.max(0, tot - vend - temp) : undefined;
}

export async function cpBuy(q: Query, c: ReadContext) {
  const site = cpSite(q);
  const url = `${site.host}/es-AR/compra?${new URLSearchParams({ cid: requireArg(q, 'cinema_id'), fid: requireArg(q, 'session_id'), pid: requireArg(q, 'movie_id') })}`;
  const html = await c.get(url, 60000), records = flight(html);
  const functionData = findField(records, 'functionData');
  if (functionData === undefined) {
    const $ = load(html); $('script,style').remove();
    if (/No pudimos mostrar la función/.test($.text()) && /\bAC-001\b/.test($.text())) throw new DataError('unavailable', 'Cinepic informa que no pudo cargar la función (AC-001). Inténtalo nuevamente más tarde.');
    // A movie_id from another film renders the page without function data;
    // that is a mismatched pair, not a provider format change.
    throw new DataError('unavailable', 'Cinepic no devolvió esa función; usa session_id y movie_id de una misma función de get_showtimes.');
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
      const site = cpSite(q), api = `https://api.cinexo.com.ar/api/complejo/${encodeURIComponent(q.cinema_id!)}`;
      // The purchase page embeds this same catalog as candyData, so an empty one
      // means Cinepic's own checkout offers no products either (seen 2026-11-05).
      const units = rows(object(await c.json(`${api}/candy`)).unidades_negocios, 'candy.unidades_negocios');
      if (!units.length) {
        c.warnings.push('El catálogo de caramelería que Cinepic publica para esta sede está vacío; su web de compra usa ese mismo catálogo y tampoco ofrece productos. No implica que no venda en taquilla.');
        return [];
      }
      let rate: number | undefined;
      try { rate = number(object(object(await c.json(`${api}/configuration`)).datos).tasaConversion); } catch (e) { if (e instanceof CallStopped) throw e; }
      if (rate === undefined || rate <= 0) { rate = undefined; c.warnings.push('Sin tasa de conversión de Cinepic; se omite la equivalencia USD.'); }
      c.warnings.push('Precios en VES del catálogo en línea de Cinepic (su web los muestra en Bs.); USD con su tasa de conversión, no una tasa BCV verificada. Cinepic no publica stock; cargos finales no verificados.');
      const items: DataItem[] = [], seen = new Set<string>();
      for (const unit of units) {
        // The purchase JS reads unidades_negocios[].categorias[].items[] and adds a
        // client-side "TODOS" category holding every item; a server copy is skipped.
        for (const category of rows(unit.categorias, 'candy.categorias')) {
          if (folded(text(category.nombre)) === 'todos') continue;
          for (const r of rows(category.items, 'candy.items')) {
            const id = requiredText(r, 'id');
            if (seen.has(id)) continue;
            seen.add(id);
            const amount = number(r.precio);
            const prices: NonNullable<DataItem['prices']> = amount !== undefined && amount >= 0 ? [{ currency: 'VES', amount, basis: 'provider' }] : [];
            if (amount !== undefined && amount >= 0 && rate) prices.push({ currency: 'USD', amount: Number((amount / rate).toFixed(2)), basis: 'provider_conversion' });
            if (!prices.length) c.warnings.push(`Producto ${warningLabel(r.id)} sin precio verificable.`);
            const contents = text(r.descripcion), image = text(r.imagen);
            items.push({ kind: 'concession', id, name: contents && contents !== requiredText(r, 'nombre') ? `${requiredText(r, 'nombre')} (${contents})` : requiredText(r, 'nombre'),
              cinema_id: q.cinema_id, category: [units.length > 1 ? text(unit.nombre_empresa) : '', text(category.nombre)].filter(Boolean).join(' · ') || undefined,
              prices, final_total_verified: false, url: `${site.host}/es-AR`,
              // "dinamico" items and items with productos ask the buyer to pick options.
              options_required: text(r.formato) === 'dinamico' || (Array.isArray(r.productos) && r.productos.length > 0),
              ...(/^https:\/\/[^\s]+$/.test(image) ? { image_url: image } : {}) });
          }
        }
      }
      return items;
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
        prices, provider_currency: text(cfg.moneda), provider_conversion_rate: rate, final_total_verified: false, tickets_available: cinepicTicketsLeft(r) };
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
    return { kind: 'showtime', id, name: text(movie?.peliculas_nombre) || `Película ${mid}`, cinema_id: q.cinema_id, cinema_name: site.name, movie_id: mid,
      date, time, starts_at: overnight === true ? undefined : overnight === false ? `${date}T${time}:00-04:00` : undefined,
      format: text(r.formato), language: subtitled === undefined ? undefined : subtitled ? 'subtitulada' : 'no_subtitulada',
      rating: text(movie?.peliculas_clasificacion) || undefined,
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

/**
 * Applies the service's result validation to one fan-out item, so an invalid
 * ID or an oversized title fails its own title or venue, not the response.
 */
function checkedShowtime(item: DataItem): DataItem {
  operationItemSchema('showtimes').parse(item); Id.parse(item.id);
  return item;
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
  if (op === 'cinemas') return parseCinemaDirectory([rows(await c.json(`${base}/theaters`), 'gateway theaters')], city, pageUrl('cines'), c);
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
    const data = object(await c.json(cxSource('getcinemacitieslist')));
    return rows(data.data, 'cities.data').map(r => ({ kind: 'city', id: decodeLabel(r.cinema_city), name: decodeLabel(r.cinema_city) }));
  }
  if (op === 'cinemas') return catalog.list(q, c);
  if (op === 'prices') {
    // Cinex publishes ticket prices only on the authenticated function page.
    const sessionId = requireArg(q, 'session_id');
    if ((await c.authenticated('cinex', `${CX}/checklogin.php`)).trim() !== 'on') throw new DataError('auth_required', 'La sesión Cinex expiró. Ejecuta npm run login -- cinex en una terminal local.');
    const url = `${CX}/boletos.php?${new URLSearchParams({ sessionid: sessionId, cinemaid: requireArg(q, 'cinema_id') })}`;
    c.warnings.push('Importe VES de la función, con boleto y otros cargos desglosados; no es un total final de compra.');
    // Opening a function page selects it in Cinex's PHP session, which a seat read in progress depends on.
    return parseCinexPrices(await c.exclusive('cinex', () => c.authenticated('cinex', url)), q, url);
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
  const venue = await catalog.resolve(cinemaId, c);
  const page = venue.body === undefined ? await c.page(venue.url, 120000) : { body: venue.body };
  const movies = parseCinexMovies(await c.get(`${CX}/cartelera.html`, 120000));
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
