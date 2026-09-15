import { load } from 'cheerio';
import { DataError, DateInput, folded, number, requireArg, text, today } from './core.js';
import type { DataItem, Operation, Query } from './core.js';
import { ReadContext } from './http.js';
import { decodeLabel, findField, flight, object, objects, requiredText, rows } from './parsers.js';
import type { Obj } from './parsers.js';
import { parseCinesUnidosPrices, parseCinexPrices, parseCinexConcessions } from './authenticated-parsers.js';

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
function movieCP(r: Obj, site: string): DataItem {
  return { kind: 'movie', id: requiredText(r, 'peliculas_codigo'), name: requiredText(r, 'peliculas_nombre'),
    duration_minutes: number(r.peliculas_duracion), genre: text(r.peliculas_genero), rating: text(r.peliculas_clasificacion),
    format: text(r.peliculas_tipo), image_url: text(r.imagen), url: `${site}/es-AR/programacion/${encodeURIComponent(text(r.peliculas_codigo))}` };
}
async function cpBuy(q: Query, c: ReadContext) {
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
    await c.get(`${CP['123300'].host}/es-AR`, 3600000);
    return [{ kind: 'city', id: 'Caracas', name: 'Caracas' }];
  }
  if (op === 'cinemas') {
    if (q.city && folded(q.city) !== 'caracas') return [];
    return Promise.all(Object.entries(CP).map(async ([id, site]) => {
      const url = `${site.host}/es-AR`;
      const records = flight(await c.get(url, 3600000));
      // The same public configuration is nested in page props; select fields only.
      const configs = [...objects(records)].filter(r => text(r.idUltracine) === id && text(r.nombre));
      const config = configs[0];
      if (!config) throw new DataError('error', 'Cambió la configuración pública de sede Cinepic.');
      return { kind: 'cinema' as const, id, name: text(config.nombre), city: 'Caracas', address: text(config.direccion), url };
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
    const scheduled = new Set(sessions.map(r => text(r.codPelicula)));
    return movies.filter(r => scheduled.has(text(r.peliculas_codigo))).map(r => ({ ...movieCP(r, site.host), cinema_id: q.cinema_id }));
  }
  return sessions.filter(r => !q.movie_id || text(r.codPelicula) === q.movie_id).map(r => {
    const id = requiredText(r, '_id'), mid = requiredText(r, 'codPelicula'), movie = names.get(mid);
    const time = requiredText(r, 'hora');
    if (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new DataError('error', 'Horario Cinepic inválido.');
    const overnight = text(r.trasnoche) !== '0';
    if (overnight) c.warnings.push(`Función ${id}: trasnoche; fecha comercial recibida, fecha calendario sin confirmar.`);
    if (!movie) c.warnings.push(`Función ${id}: no se recibió ficha de la película ${mid}.`);
    return { kind: 'showtime', id, name: text(movie?.peliculas_nombre) || `Película ${mid}`, cinema_id: q.cinema_id, movie_id: mid,
      date, time, starts_at: overnight ? undefined : `${date}T${time}:00-04:00`,
      format: text(r.formato), language: text(r.subtitulada) === '1' ? 'subtitulada' : 'no_subtitulada',
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
      if (!prices.length) c.warnings.push(`Producto ${text(r.itemId)} sin precio verificable.`);
      return { kind: 'concession', id: requiredText(r, 'itemId'), name: requiredText(r, 'itemDescription'), cinema_id: id,
        category: text(r.itemClassDescription), stock: number(r.itemStock), prices, final_total_verified: false, image_url: text(r.itemImageUrl), url: `${CU}/carameleria` };
    });
  }
  const city = requireArg(q, 'city');
  const url = `${CU}/${op === 'cinemas' ? 'cines' : 'cartelera'}?${new URLSearchParams({ city })}`;
  const records = flight(await c.get(url, op === 'cinemas' ? 3600000 : 120000));
  if (op === 'cinemas') return rows(findField(records, 'theaters'), 'theaters').map(r => ({
    kind: 'cinema', id: requiredText(r, 'id'), name: requiredText(r, 'name'), city, address: text(r.address), url,
  }));
  const movies = rows(findField(records, 'movies'), 'movies');
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
export function parseCinexShowtimes(html: string, movieId: string, date: string): DataItem[] {
  const $ = load(html), items = new Map<string, DataItem>();
  const title = decodeLabel($('h1').first().text() || movieId);
  const nodes = $('[onclick*="checkLogin("]');
  if (!nodes.length) throw new DataError('unavailable', 'La ficha Cinex no contiene funciones reconocibles.');
  nodes.each((_, e) => {
    const match = ($(e).attr('onclick') ?? '').match(/checkLogin\('([^']+)','([^']+)'\)/);
    const epoch = number($(e).attr('alt'));
    if (!match || !epoch || !Number.isFinite(epoch) || epoch < 1e9 || epoch > 1e11) return;
    const local = new Date(epoch * 1000 - 4 * 3600000).toISOString().slice(0, 19);
    if (local.slice(0, 10) !== date) return;
    const readable = $(e).clone(); readable.find('br').replaceWith('\n');
    const body = readable.text(), screen = body.match(/Sala\s+(\d+)/i)?.[1];
    items.set(`${match[2]}:${match[1]}`, { kind: 'showtime', id: match[1], name: title,
      movie_id: movieId, cinema_id: match[2], date, time: local.slice(11, 16), starts_at: `${local}-04:00`, screen,
      language: $(e).find('img.icoIdioma').attr('src')?.includes('/es.') ? 'es' : undefined,
      url: `${CX}/sinopsis-${movieId}.html` });
  });
  return [...items.values()];
}
export async function cinex(op: Operation, q: Query, c: ReadContext): Promise<DataItem[]> {
  if (op === 'cities') {
    const data = object(await c.json(cxSource('getcinemacitieslist')));
    return rows(data.data, 'cities.data').map(r => ({ kind: 'city', id: decodeLabel(r.cinema_city), name: decodeLabel(r.cinema_city) }));
  }
  if (op === 'cinemas') {
    const url = `${CX}/cines.html`, $ = load(await c.get(url, 3600000));
    const tasks = $('a[href^="cinex-"]').toArray().map(async e => {
      const href = $(e).attr('href') ?? '', label = decodeLabel($(e).attr('title'));
      if (!/^cinex-[A-Za-z0-9_-]+\.html$/.test(href)) { c.partial = true; c.warnings.push('Enlace de sede Cinex no reconocido; se omitió sin seguirlo.'); return undefined; }
      const city = label.split(',').slice(1).join(',').trim();
      if (q.city && folded(city) !== folded(q.city)) return undefined;
      // Public image names encode the same short cinema code used by sessions.
      const image = $(e).find('img').attr('src') ?? '';
      let code = image.match(/\/cinemas\/(?:\d+x\d+x|x)?([a-z]{3})\.(?:jpg|png|webp)/i)?.[1]?.toUpperCase();
      if (!code) {
        try {
          const detail = await c.get(`${CX}/${href}`, 3600000);
          const codes = new Set([...detail.matchAll(/checkLogin\('[^']+','([^']+)'\)/g)].map(m => m[1]));
          if (codes.size === 1) code = [...codes][0];
        } catch (error) {
          c.warnings.push(error instanceof DataError ? error.message : `No se pudo leer ${label}.`);
        }
      }
      if (!code) { c.partial = true; c.warnings.push(`Sin código verificable para ${label || href}; sede omitida.`); return undefined; }
      return { kind: 'cinema' as const, id: code, name: decodeLabel($(e).find('h3').text()) || label, city, url: `${CX}/${href}` };
    });
    if (!$('a[href^="cinex-"]').length) throw new DataError('error', 'No se reconoció el listado de cines Cinex.');
    return (await Promise.all(tasks)).filter((r): r is NonNullable<typeof r> => r !== undefined);
  }
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
  const mid = requireArg(q, 'movie_id');
  const items = parseCinexShowtimes(await c.get(`${CX}/sinopsis-${encodeURIComponent(mid)}.html`), mid, isoDate(q));
  return items.filter(r => !q.cinema_id || r.cinema_id === q.cinema_id);
}

export async function trasnocho(_op: Operation, _q: Query, c: ReadContext): Promise<DataItem[]> {
  await c.get('https://www.trasnochocultural.com/cine/');
  throw new DataError('unavailable', 'El sitio es accesible, pero aún no hay un parser de programación validado. No se usan fichas indexadas antiguas como datos actuales.');
}
