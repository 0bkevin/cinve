import { load } from 'cheerio';
import { DataError, folded, isPastDate, nowTime, number, requireArg, text, today } from './core.js';
import type { DataItem, Operation, Query } from './core.js';
import type { ReadContext } from './http.js';
import { clock, object, rows, titled } from './parsers.js';
import { fanOut } from './fanout.js';

/**
 * Supercines (supercines.com.ve): a Laravel site with six themed venues in
 * Carabobo, Aragua, Miranda and Anzoátegui. Its directory and billboard are
 * JSON; schedules, fares and concessions are HTML fragments its own pages
 * request with form POSTs. Every value below is one those pages display.
 */
const SC = 'https://supercines.com.ve';
const scId = /^\d{1,12}$/;

const label = (value: unknown) => text(value).replace(/\s+/g, ' ').trim();

type Venue = { id: string; name: string; city: string };
export function parseSupercinesVenues(data: unknown, c: ReadContext): Venue[] {
  const venues: Venue[] = [];
  let skipped = 0;
  for (const raw of rows(data, 'dame_empresas')) {
    const r = object(raw), id = text(r.id), name = label(r.nombre), city = label(r.ciudad);
    if (!scId.test(id) || !name || name.length > 120 || !city || city.length > 80) { skipped++; continue; }
    // Only venues the provider marks active; the registry also lists retired ones.
    if (number(r.estatus) !== 1) continue;
    venues.push({ id, name: `Supercines ${titled(name)}`, city: titled(city) });
  }
  if (skipped) {
    c.partial = true;
    c.warnings.push(`Supercines devolvió ${skipped} sedes sin identificador, nombre o ciudad reconocibles; se omitieron.`);
  }
  if (new Set(venues.map(v => v.id)).size !== venues.length) throw new DataError('error', 'El directorio de Supercines repite identificadores de sede.');
  if (!venues.length) throw new DataError('error', 'No se reconoció ninguna sede activa en el directorio de Supercines.');
  return venues;
}
async function venues(c: ReadContext): Promise<Venue[]> {
  return parseSupercinesVenues(await c.formJson(`${SC}/dame_empresas`, {}, 3600000), c);
}

type Movie = DataItem & { kind: 'movie' };
export function parseSupercinesMovies(data: unknown, cinemaId?: string, c?: Pick<ReadContext, 'partial' | 'warnings'>): Movie[] {
  const payload = object(data);
  // Presale titles already have bookable functions; "proximamente" do not.
  const list = [...rows(payload.cartelera ?? [], 'cartelera'), ...rows(payload.preventa ?? [], 'preventa')];
  if (!Array.isArray(payload.cartelera)) throw new DataError('error', 'No se reconoció la cartelera de Supercines.');
  const movies = new Map<string, Movie>();
  let skipped = 0;
  for (const r of list) {
    const id = text(r.unico), name = label(r.pelicula);
    if (!scId.test(id) || !name || name.length > 300) { skipped++; continue; }
    const image = text(r.imagenPelicula);
    const rating = label(r.generos).replace(/^censura\s*/i, '').trim();
    movies.set(id, {
      kind: 'movie', id, name, ...(cinemaId ? { cinema_id: cinemaId } : {}),
      rating: rating && rating.length <= 20 ? rating : undefined,
      format: /\(3D\)/i.test(name) ? '3D' : undefined,
      image_url: /^[A-Za-z0-9._-]{1,200}$/.test(image) ? `${SC}/storage/image/${image}` : undefined,
      url: `${SC}/booking/${id}`,
    });
  }
  if (skipped && c) {
    c.partial = true;
    c.warnings.push(`Supercines devolvió ${skipped} títulos de cartelera sin identificador o nombre reconocibles; se omitieron.`);
  }
  return [...movies.values()];
}
async function movies(c: ReadContext, cinemaId?: string): Promise<Movie[]> {
  return parseSupercinesMovies(await c.formJson(`${SC}/api/app/cartelera/list`, { type: 'all', ...(cinemaId ? { idEmpresa: cinemaId } : {}) }, 600000), cinemaId, c);
}

type Showtime = DataItem & { kind: 'showtime'; cinema_id: string; movie_id: string; date: string; time: string };
/** Functions of one title on one date, grouped by venue, from listCartelerafecha. */
/** A function the page lists without online sales: no identifier, only venue and time. */
export type OfflineFunction = { movie: string; venue: string; time: string };
export function parseSupercinesShowtimes(html: string, movie: { id: string; name: string }, date: string, c: Pick<ReadContext, 'partial' | 'warnings'>, offline?: OfflineFunction[]): Showtime[] {
  const $ = load(html), items: Showtime[] = [];
  // A day without functions is a redirect (see schedule()); a page without
  // any venue block means the markup changed, not that nothing is on.
  if (!$('.st_calender_row_cont').length) throw new DataError('error', 'No se reconoció la programación de Supercines (cambió la estructura de la página).');
  let malformed = 0, lateNight = 0;
  // The fragment also carries an older layout inside HTML comments, which the
  // parser ignores: only the live blocks are read.
  $('.st_calender_row_cont').each((_, block) => {
    const venueName = label($(block).find('h6').first().text());
    $(block).find('a[id^="hora_"], a.disabledFunction, a[onclick*="ventasDesactivadas"]').each((_, a) => {
      const onclick = $(a).attr('onclick') ?? '';
      // The page greys these out (past functions, or a venue without online
      // sales) and gives them no identifier: report venue and time only.
      if (/ventasDesactivadas/.test(onclick) || $(a).hasClass('disabledFunction')) {
        const time = clock($(a).text());
        if (time && venueName) offline?.push({ movie: movie.name, venue: venueName, time });
        return;
      }
      const m = onclick.match(/getDetailsNoauth\(\s*(\d{1,12})\s*,\s*'hora_(\d{1,12})'\s*,\s*'(\d{1,12})'\s*,\s*'(\d{1,12})'\s*,\s*'(\d{4}-\d{2}-\d{2})'\s*\)/);
      const time = clock($(a).text());
      if (!m || m[2] !== m[3] || $(a).attr('id') !== `hora_${m[2]}` || m[4] !== movie.id || !time || !venueName) { malformed++; return; }
      if (m[5] !== date) return;
      // The schedule is grouped by commercial date: a function at 00:30 may
      // belong to the next calendar day. Keep the time, omit the timestamp.
      const overnight = Number(time.slice(0, 2)) < 5;
      if (overnight) lateNight++;
      items.push({ kind: 'showtime', id: m[2], name: movie.name, cinema_id: m[1], cinema_name: `Supercines ${titled(venueName)}`.slice(0, 200), movie_id: movie.id,
        date, time, starts_at: overnight ? undefined : `${date}T${time}:00-04:00`,
        format: /\(3D\)/i.test(movie.name) ? '3D' : undefined, language: /\(SUB\)/i.test(movie.name) ? 'subtitulada' : undefined,
        url: `${SC}/booking/${movie.id}` });
    });
  });
  if (malformed) {
    c.partial = true;
    c.warnings.push(`Supercines devolvió ${malformed} funciones de ${movie.name} con identificador u hora no reconocibles; se omitieron.`);
  }
  if (lateNight) c.warnings.push('Supercines agrupa las funciones por fecha comercial; en las de madrugada se omite starts_at porque la fecha calendario no está confirmada.');
  return items;
}

/** One title's functions on one date; undefined when it has none (e.g. a presale before its release). */
async function schedule(c: ReadContext, movieId: string, date: string): Promise<string | undefined> {
  // Ten minutes: a city or venue call reads one schedule per title, and
  // "no functions" answers are cached for as long as schedules.
  const page = await c.formPage(`${SC}/listCartelerafecha`, { fecha: date, id: movieId }, 600000);
  return page.empty ? undefined : page.body;
}

const titlesLimit = 40;
// Counted from the start of the call, so the directory and billboard reads
// spend the same budget. A title starts only if one read's worst case (a
// session renewal plus the read) still fits: a call stays under ~75 s, below
// the hosted 90 s limit.
const budgetMs = 60000;
const readMs = 15000;
const workers = 2;
async function showtimes(q: Query, c: ReadContext): Promise<DataItem[]> {
  const deadline = Date.now() + budgetMs;
  const date = q.date ?? today();
  if (isPastDate(date)) {
    // The upstream still answers for past dates; its pages never show them.
    c.warnings.push('Esa fecha ya pasó: Supercines solo muestra funciones de hoy en adelante.');
    return [];
  }
  const all = await venues(c);
  let allowed: Set<string> | undefined;
  if (q.cinema_id) {
    if (!all.some(v => v.id === q.cinema_id)) throw new DataError('unavailable', 'Sede Supercines no reconocida; consulta list_cinemas.');
    allowed = new Set([q.cinema_id]);
  } else if (q.city) {
    allowed = new Set(all.filter(v => folded(v.city) === folded(q.city!)).map(v => v.id));
    if (!allowed.size) {
      c.warnings.push('Supercines no tiene sedes en esta ciudad; consulta list_cities.');
      return [];
    }
  }
  // Titles come from the venue's own billboard when there is one venue, so
  // a title it does not show is not queried at all.
  const catalog = await movies(c, q.cinema_id);
  const names = new Map(catalog.map(m => [m.id, m.name]));
  let work: { id: string; name: string }[];
  if (q.movie_id) {
    const name = names.get(q.movie_id) ?? (q.cinema_id ? undefined : (await movies(c)).find(m => m.id === q.movie_id)?.name);
    if (!name) {
      c.warnings.push('Esta película no aparece en la cartelera vigente de Supercines para la consulta.');
      return [];
    }
    work = [{ id: q.movie_id, name }];
  } else {
    work = catalog.filter(m => !q.query || folded(m.name).includes(folded(q.query))).map(m => ({ id: m.id, name: m.name }));
  }
  if (work.length > titlesLimit) {
    c.partial = true;
    c.warnings.push(`Se consultaron ${titlesLimit} de ${work.length} títulos de Supercines; usa movie_id o query para los demás.`);
    work = work.slice(0, titlesLimit);
  }
  const items: DataItem[] = [], offline: OfflineFunction[] = [], elsewhere = new Set<string>();
  let steps = 0, published = 0;
  const { done, failures, skipped: left, stopped } = await fanOut(work, async movie => {
    const html = await schedule(c, movie.id, date);
    if (html === undefined) return;
    published++;
    for (const s of parseSupercinesShowtimes(html, movie, date, c, offline)) {
      if (!allowed || allowed.has(s.cinema_id)) items.push(s);
      else elsewhere.add(s.cinema_id);
    }
  }, { deadline, minRemainingMs: readMs, workers, onStep: () => c.progress(`Supercines: ${++steps} de ${work.length} títulos consultados.`) });
  const boxOffice = offlineWarning(offline, all, allowed, date, c);
  if (done && !items.length && !boxOffice) {
    const scope = [q.movie_id ? 'de ese título' : '', q.cinema_id ? 'en esta sede' : q.city ? 'en esta ciudad' : ''].filter(Boolean).join(' ');
    const others = all.filter(v => elsewhere.has(v.id)).map(v => `${v.name} (${v.city})`);
    // The date is published, just not here: say where it is on instead.
    if (others.length) c.warnings.push(`Supercines no tiene funciones${scope ? ` ${scope}` : ''} para ${date}; sí las tiene en: ${others.join(', ')}.`);
    // Observed November 2026: the next day's schedule is loaded during the
    // day, venue by venue; later days only for presales.
    else if (!published && date > today()) c.warnings.push(`Supercines aún no publica funciones${scope ? ` ${scope}` : ''} para ${date}: carga la programación poco antes (la del día siguiente, sede por sede durante el día) y las preventas en sus propias fechas. Vuelve a consultar más tarde.`);
    else c.warnings.push(`Supercines no tiene funciones${scope ? ` ${scope}` : ''} para ${date}.`);
    // One title: its page lists the dates it has functions on (any venue).
    if (q.movie_id && work.length === 1) {
      // A hint only: a failed read leaves the answer as it is.
      const page = await c.get(`${SC}/booking/${q.movie_id}`, 600000).catch(() => undefined);
      const dates = page === undefined ? [] : parseSupercinesDates(page).filter(d => d !== date && !isPastDate(d));
      if (dates.length) c.warnings.push(`Fechas con funciones publicadas de este título en Supercines (en alguna sede): ${dates.join(', ')}. Consulta get_showtimes con date.`);
    }
  }
  const skipped = left.length;
  if (stopped) {
    c.partial = true;
    c.warnings.push('Supercines rechazó o no respondió a varias consultas seguidas; Cinve dejó de consultar los títulos restantes para no sobrecargarlo.');
  }
  if (failures.length) {
    c.partial = true;
    c.warnings.push(`No se pudieron consultar las funciones de ${failures.length} de ${work.length} títulos de Supercines; el resultado es parcial.`);
  }
  if (skipped && !stopped) {
    c.partial = true;
    c.warnings.push(`Se agotó el tiempo de consulta antes de leer ${skipped} de ${work.length} títulos de Supercines; usa movie_id para consultarlos.`);
  }
  if (work.length && !done) throw stopped ?? failures[0] ?? new DataError('unavailable', 'Se agotó el tiempo de consulta de Supercines; usa movie_id.');
  return items;
}

/**
 * Functions the page lists greyed out, without online sales or identifier
 * (a venue that only sells at the box office). Past ones today are just
 * closed and are not reported.
 */
function offlineWarning(offline: OfflineFunction[], all: Venue[], allowed: Set<string> | undefined, date: string, c: ReadContext): number {
  const now = date === today() ? nowTime() : undefined;
  const byVenue = new Map<string, string[]>();
  for (const f of offline) {
    const venue = all.find(v => v.name === `Supercines ${titled(f.venue)}`);
    if (!venue || (allowed && !allowed.has(venue.id))) continue;
    // Before 05:00 a time belongs to the night after the date: still ahead.
    if (now && f.time >= '05:00' && f.time < now) continue;
    const list = byVenue.get(venue.name) ?? [];
    list.push(`${f.movie} ${f.time}`);
    byVenue.set(venue.name, list);
  }
  for (const [venue, list] of byVenue) {
    const shown = list.slice(0, 20).join(', ') + (list.length > 20 ? ` y ${list.length - 20} más` : '');
    c.warnings.push(`${venue} lista ${list.length} funciones sin venta en línea (sin identificador; se compran en taquilla): ${shown}.`);
  }
  return byVenue.size;
}

/** The dates a title's page offers (its date strip), in order. */
export function parseSupercinesDates(html: string): string[] {
  return [...new Set([...html.matchAll(/listCartelerafecha\(\s*'(\d{4}-\d{2}-\d{2})'/g)].map(m => m[1]))].sort().slice(0, 60);
}

/** The booking page publishes the exchange rate and whether the title is 3D. */
export function parseSupercinesBooking(html: string): { rate?: number; threeD: '0' | '1' } {
  const threeD = html.match(/listBoletos["'`]\s*,\s*`[^`]*?&tresD=([01])&/)?.[1];
  if (threeD !== '0' && threeD !== '1') throw new DataError('error', 'No se reconoció la página de compra de Supercines.');
  const rate = number(html.match(/const\s+tasa\s*=\s*'([0-9]+(?:\.[0-9]+)?)'/)?.[1]);
  return { rate: rate !== undefined && rate > 0 ? rate : undefined, threeD };
}
/** "Bs. 2,254.05" → 2254.05. */
const amount = (value: string) => { const m = value.match(/(\d{1,3}(?:,\d{3})*|\d+)(\.\d{1,2})?/); return m ? number(m[1].replace(/,/g, '') + (m[2] ?? '')) : undefined; };

export function parseSupercinesPrices(html: string, q: Query, rate: number | undefined, url: string, c: ReadContext): DataItem[] {
  const $ = load(html), items: DataItem[] = [];
  if (!$('#seleccionboletos').length) throw new DataError('error', 'No se reconoció la lista de tarifas de Supercines (cambió la estructura de la página).');
  let unrecognized = 0;
  $('#seleccionboletos > .row').each((_, row) => {
    const plus = $(row).find('button[onclick^="changeQtyBoleto(1,"]').attr('onclick') ?? '';
    const m = plus.match(/^changeQtyBoleto\(1,(\d{1,12}),'([^']{1,200})','(\d+(?:\.\d+)?)','(\d+(?:\.\d+)?)'\)/);
    if (!m) { if ($(row).find('h6').length) unrecognized++; return; }
    const name = label(m[2]);
    // The row shows the sum of the two amounts passed to the cart; read the
    // displayed price and check it against them.
    const shown = amount($(row).find('.col-md-3 h6').first().text());
    const sum = Math.round((Number(m[3]) + Number(m[4])) * 100) / 100;
    if (shown === undefined || Math.abs(shown - sum) > 0.011) {
      c.partial = true;
      c.warnings.push(`Supercines mostró un importe inconsistente para la tarifa ${name}; se omitió.`);
      return;
    }
    const prices: NonNullable<DataItem['prices']> = [{ currency: 'VES', amount: shown, basis: 'provider' }];
    if (rate) prices.push({ currency: 'USD', amount: Math.round((shown / rate) * 100) / 100, basis: 'provider_conversion' });
    items.push({ kind: 'ticket_price', id: m[1], name, cinema_id: q.cinema_id, movie_id: q.movie_id, session_id: q.session_id,
      prices, provider_currency: 'VES', provider_conversion_rate: rate, final_total_verified: false, url });
  });
  if (unrecognized) {
    c.partial = true;
    c.warnings.push(`Supercines mostró ${unrecognized} tarifas con un formato no reconocido; se omitieron.`);
  }
  return items;
}

export function parseSupercinesConcessions(html: string, cinemaId: string, c: ReadContext): DataItem[] {
  // A venue without online concessions answers with an empty body, and its
  // page shows no products.
  if (!html.trim()) {
    c.warnings.push('Supercines no ofrece caramelería en línea para esta sede: su web no muestra productos.');
    return [];
  }
  const $ = load(html), categories = new Map<string, string>(), items: DataItem[] = [];
  if (!$('#carameleria-products').length) throw new DataError('error', 'No se reconoció el catálogo de caramelería de Supercines (cambió la estructura de la página).');
  $('button[data-filtro]').each((_, b) => { const id = $(b).attr('data-filtro') ?? '', name = label($(b).text()); if (/^\d{1,6}$/.test(id) && name) categories.set(id, name); });
  let skipped = 0;
  $('.card-body[data-id]').each((_, card) => {
    const id = $(card).attr('data-id') ?? '', name = label($(card).attr('data-nombre')), price = number($(card).attr('data-precio'));
    if (!scId.test(id) || !name || price === undefined || price < 0) { skipped++; return; }
    const category = ($(card).closest('.categos').attr('class') ?? '').match(/\bcat_(\d{1,6})\b/)?.[1];
    const image = $(card).parent().find('img').first().attr('src') ?? '';
    // data-stock caps the quantity selector; it is not reported as stock.
    items.push({ kind: 'concession', id, name, cinema_id: cinemaId, category: category ? categories.get(category) : undefined,
      prices: [{ currency: 'VES', amount: price, basis: 'provider' }], final_total_verified: false,
      image_url: /^storage\/image\/productos\/[A-Za-z0-9._-]{1,200}$/.test(image) ? `${SC}/${image}` : undefined, url: `${SC}/carameleria` });
  });
  if (skipped) {
    c.partial = true;
    c.warnings.push(`Supercines devolvió ${skipped} productos sin identificador, nombre o precio reconocibles; se omitieron.`);
  }
  return items;
}

export async function supercines(op: Operation, q: Query, c: ReadContext): Promise<DataItem[]> {
  if (op === 'cities') {
    const cities = [...new Set((await venues(c)).map(v => v.city))];
    return cities.map(city => ({ kind: 'city', id: city, name: city }));
  }
  if (op === 'cinemas') {
    return (await venues(c)).filter(v => !q.city || folded(v.city) === folded(q.city))
      .map(v => ({ kind: 'cinema', id: v.id, cinema_id: v.id, code_status: 'verified', name: v.name, city: v.city, url: `${SC}/cines` }));
  }
  if (op === 'movies') {
    if (q.cinema_id && !(await venues(c)).some(v => v.id === q.cinema_id)) throw new DataError('unavailable', 'Sede Supercines no reconocida; consulta list_cinemas.');
    c.warnings.push('Cartelera vigente de Supercines (incluye preventa), sin fecha; confirma fecha y sede con get_showtimes.');
    return movies(c, q.cinema_id);
  }
  if (op === 'showtimes') return showtimes(q, c);
  if (op === 'prices') {
    const cinemaId = requireArg(q, 'cinema_id'), sessionId = requireArg(q, 'session_id'), movieId = requireArg(q, 'movie_id');
    const date = q.date ?? today();
    if (isPastDate(date)) throw new DataError('unavailable', 'Esa fecha ya pasó: Supercines solo vende funciones de hoy en adelante.');
    // Fares depend on the date and the venue: confirm the function first, so
    // a mismatched ID never returns another function's fares.
    // Only the function's identity matters here: no title lookup, and the
    // schedule's own warnings (late night, disabled sales) stay out of fares.
    const html0 = await schedule(c, movieId, date);
    const functions = html0 === undefined ? [] : parseSupercinesShowtimes(html0, { id: movieId, name: `Película ${movieId}` }, date, { partial: false, warnings: [] });
    if (!functions.some(s => s.id === sessionId && s.cinema_id === cinemaId)) throw new DataError('unavailable', 'La función no aparece en la programación de Supercines para esa sede, película y fecha; consulta get_showtimes (y pasa date si no es hoy).');
    const booking = `${SC}/booking/${movieId}`;
    const { rate, threeD } = parseSupercinesBooking(await c.get(booking, 600000));
    const html = await c.form(`${SC}/listBoletos`, { idFuncion: sessionId, fecha: date, unico: movieId, tresD: threeD, idEmpresa: cinemaId }, 60000);
    c.warnings.push('Tarifas VES de Supercines para la fecha consultada (varían por día y formato). Incluyen el cargo por boleto mostrado en la web; impuestos y total final de compra no verificados.');
    if (rate) c.warnings.push('USD calculado con la tasa publicada en la página de compra de Supercines, no con una tasa BCV verificada.');
    else c.warnings.push('Supercines no publicó una tasa de cambio positiva; se omite la equivalencia USD.');
    return parseSupercinesPrices(html, { ...q, date }, rate, booking, c);
  }
  const cinemaId = requireArg(q, 'cinema_id');
  if (!(await venues(c)).some(v => v.id === cinemaId)) throw new DataError('unavailable', 'Sede Supercines no reconocida; consulta list_cinemas.');
  const products = parseSupercinesConcessions(await c.form(`${SC}/listCarameleria`, { idEmpresa: cinemaId }, 600000), cinemaId, c);
  if (products.length) c.warnings.push('Precios VES del catálogo de caramelería de la sede; la existencia por producto y los cargos finales no se verifican.');
  return products;
}
