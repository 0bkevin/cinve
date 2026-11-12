import { load } from 'cheerio';
import { DataError, folded, group, isPastDate, nowTime, number, requireArg, text, today } from '../../core.js';
import type { DataItem, Operation, Query } from '../../core.js';
import type { ReadContext } from '../../http/read-context.js';
import { clock, object, rows, titled } from '../parsing.js';
import { fanOut } from '../fanout.js';

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
    c.warnings.push(`Supercines returned ${skipped} venues without a recognizable identifier, name or city; they were omitted.`);
  }
  if (new Set(venues.map(v => v.id)).size !== venues.length) throw new DataError('error', 'The Supercines directory repeats venue identifiers.');
  if (!venues.length) throw new DataError('error', 'No active venue was recognized in the Supercines directory.');
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
  if (!Array.isArray(payload.cartelera)) throw new DataError('error', 'Unrecognized Supercines listings.');
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
    c.warnings.push(`Supercines returned ${skipped} listing titles without a recognizable identifier or name; they were omitted.`);
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
  if (!$('.st_calender_row_cont').length) throw new DataError('error', 'Unrecognized Supercines schedule (the page structure changed).');
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
      items.push({ kind: 'showtime', id: group(m, 2), name: movie.name, cinema_id: group(m, 1), cinema_name: `Supercines ${titled(venueName)}`.slice(0, 200), movie_id: movie.id,
        date, time, starts_at: overnight ? undefined : `${date}T${time}:00-04:00`,
        format: /\(3D\)/i.test(movie.name) ? '3D' : undefined, language: /\(SUB\)/i.test(movie.name) ? 'subtitulada' : undefined,
        url: `${SC}/booking/${movie.id}` });
    });
  });
  if (malformed) {
    c.partial = true;
    c.warnings.push(`Supercines returned ${malformed} showtimes of ${movie.name} with an unrecognized identifier or time; they were omitted.`);
  }
  if (lateNight) c.warnings.push('Supercines groups showtimes by business date; for after-midnight ones starts_at is omitted because the calendar date is not confirmed.');
  return items;
}

/**
 * How long a schedule answer stays cached. Supercines sends no validators
 * (no ETag or Last-Modified), so freshness costs a full re-read; spend it
 * where answers change. Observed November 2026: the next day's schedule is
 * loaded during the day, venue by venue, so "no functions yet" and
 * tomorrow's partial schedules go stale within minutes; today's and
 * presale dates' schedules rarely change.
 */
export function scheduleTtl(date: string, page: { empty?: true }): number {
  if (page.empty) return 60000;
  const current = today();
  const tomorrow = new Date(Date.parse(`${current}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return date === tomorrow ? 120000 : 600000;
}

/** One title's functions on one date; undefined when it has none (e.g. a presale before its release). */
async function schedule(c: ReadContext, movieId: string, date: string): Promise<string | undefined> {
  const page = await c.formPage(`${SC}/listCartelerafecha`, { fecha: date, id: movieId }, answer => scheduleTtl(date, answer));
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
    c.warnings.push('That date has passed: Supercines only shows showtimes from today onward.');
    return [];
  }
  const all = await venues(c);
  let allowed: Set<string> | undefined;
  if (q.cinema_id) {
    if (!all.some(v => v.id === q.cinema_id)) throw new DataError('unavailable', 'Supercines venue not recognized; check list_cinemas.');
    allowed = new Set([q.cinema_id]);
  } else if (q.city) {
    allowed = new Set(all.filter(v => folded(v.city) === folded(q.city!)).map(v => v.id));
    if (!allowed.size) {
      c.warnings.push('Supercines has no venues in this city; check list_cities.');
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
      c.warnings.push('This movie does not appear in the current Supercines listings for the query.');
      return [];
    }
    work = [{ id: q.movie_id, name }];
  } else {
    work = catalog.filter(m => !q.query || folded(m.name).includes(folded(q.query))).map(m => ({ id: m.id, name: m.name }));
  }
  if (work.length > titlesLimit) {
    c.partial = true;
    c.warnings.push(`${titlesLimit} of ${work.length} Supercines titles were queried; use movie_id or query for the rest.`);
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
  }, { deadline, minRemainingMs: readMs, workers, onStep: () => c.progress(`Supercines: ${++steps} of ${work.length} titles queried.`) });
  const boxOffice = offlineWarning(offline, all, allowed, date, c);
  if (done && !items.length && !boxOffice) {
    const scope = [q.movie_id ? 'for that title' : '', q.cinema_id ? 'at this venue' : q.city ? 'in this city' : ''].filter(Boolean).join(' ');
    const others = all.filter(v => elsewhere.has(v.id)).map(v => `${v.name} (${v.city})`);
    // The date is published, just not here: say where it is on instead.
    if (others.length) c.warnings.push(`Supercines has no showtimes${scope ? ` ${scope}` : ''} for ${date}; it does have them at: ${others.join(', ')}.`);
    // Observed November 2026: the next day's schedule is loaded during the
    // day, venue by venue; later days only for presales.
    else if (!published && date > today()) c.warnings.push(`Supercines has not yet published showtimes${scope ? ` ${scope}` : ''} for ${date}: it loads the schedule shortly before (the next day\'s, venue by venue during the day) and presales on their own dates. Check again in a few minutes (Cinve keeps this response for 1 minute; refresh=true reads it again).`);
    else c.warnings.push(`Supercines has no showtimes${scope ? ` ${scope}` : ''} for ${date}.`);
    // One title: its page lists the dates it has functions on (any venue).
    if (q.movie_id && work.length === 1) {
      // A hint only: a failed read leaves the answer as it is.
      const page = await c.get(`${SC}/booking/${q.movie_id}`, 600000).catch(() => undefined);
      const dates = page === undefined ? [] : parseSupercinesDates(page).filter(d => d !== date && !isPastDate(d));
      if (dates.length) c.warnings.push(`Dates with published showtimes for this title at Supercines (at some venue): ${dates.join(', ')}. Call get_showtimes with date.`);
    }
  }
  const skipped = left.length;
  if (stopped) {
    c.partial = true;
    c.warnings.push('Supercines rejected or did not answer several queries in a row; Cinve stopped querying the remaining titles to avoid overloading it.');
  }
  if (failures.length) {
    c.partial = true;
    c.warnings.push(`Showtimes could not be queried for ${failures.length} of ${work.length} Supercines titles; the result is partial.`);
  }
  if (skipped && !stopped) {
    c.partial = true;
    c.warnings.push(`The query timed out before reading ${skipped} of ${work.length} Supercines titles; use movie_id to look them up.`);
  }
  if (work.length && !done) throw stopped ?? failures[0] ?? new DataError('unavailable', 'The Supercines query timed out; use movie_id.');
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
    const shown = list.slice(0, 20).join(', ') + (list.length > 20 ? ` and ${list.length - 20} more` : '');
    c.warnings.push(`${venue} lists ${list.length} showtimes without online sales (no identifier; bought at the box office): ${shown}.`);
  }
  return byVenue.size;
}

/** The dates a title's page offers (its date strip), in order. */
export function parseSupercinesDates(html: string): string[] {
  return [...new Set([...html.matchAll(/listCartelerafecha\(\s*'(\d{4}-\d{2}-\d{2})'/g)].map(m => group(m, 1)))].sort().slice(0, 60);
}

/** The booking page publishes the exchange rate and whether the title is 3D. */
export function parseSupercinesBooking(html: string): { rate?: number | undefined; threeD: '0' | '1' } {
  const threeD = html.match(/listBoletos["'`]\s*,\s*`[^`]*?&tresD=([01])&/)?.[1];
  if (threeD !== '0' && threeD !== '1') throw new DataError('error', 'Unrecognized Supercines purchase page.');
  const rate = number(html.match(/const\s+tasa\s*=\s*'([0-9]+(?:\.[0-9]+)?)'/)?.[1]);
  return { rate: rate !== undefined && rate > 0 ? rate : undefined, threeD };
}
/** "Bs. 2,254.05" → 2254.05. */
const amount = (value: string) => { const m = value.match(/(\d{1,3}(?:,\d{3})*|\d+)(\.\d{1,2})?/); return m ? number(group(m, 1).replace(/,/g, '') + (m[2] ?? '')) : undefined; };

export function parseSupercinesPrices(html: string, q: Query, rate: number | undefined, url: string, c: ReadContext): DataItem[] {
  const $ = load(html), items: DataItem[] = [];
  if (!$('#seleccionboletos').length) throw new DataError('error', 'Unrecognized Supercines price list (the page structure changed).');
  let unrecognized = 0;
  $('#seleccionboletos > .row').each((_, row) => {
    // Signed in, the list ends with the account's courtesy tickets ("Mis
    // Cortesías Super Friends"), an empty container the site fills from
    // another request: not a fare, and never read.
    if ($(row).is('#superfriends-cortesias-div') || $(row).find('#cortesias-usuario-container').length) return;
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
      c.warnings.push(`Supercines showed an inconsistent amount for the ${name} ticket type; it was omitted.`);
      return;
    }
    const prices: NonNullable<DataItem['prices']> = [{ currency: 'VES', amount: shown, basis: 'provider' }];
    if (rate) prices.push({ currency: 'USD', amount: Math.round((shown / rate) * 100) / 100, basis: 'provider_conversion' });
    items.push({ kind: 'ticket_price', id: group(m, 1), name, cinema_id: q.cinema_id, movie_id: q.movie_id, session_id: q.session_id,
      prices, provider_currency: 'VES', provider_conversion_rate: rate, final_total_verified: false, url });
  });
  if (unrecognized) {
    c.partial = true;
    c.warnings.push(`Supercines showed ${unrecognized} prices in an unrecognized format; they were omitted.`);
  }
  return items;
}

export function parseSupercinesConcessions(html: string, cinemaId: string, c: ReadContext): DataItem[] {
  // A venue without online concessions answers with an empty body, and its
  // page shows no products.
  if (!html.trim()) {
    c.warnings.push('Supercines offers no online concessions for this venue: its website shows no products.');
    return [];
  }
  const $ = load(html), categories = new Map<string, string>(), items: DataItem[] = [];
  if (!$('#carameleria-products').length) throw new DataError('error', 'Unrecognized Supercines concessions catalog (the page structure changed).');
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
    c.warnings.push(`Supercines returned ${skipped} products without a recognizable identifier, name or price; they were omitted.`);
  }
  return items;
}

/**
 * Supercines draws a function's seat map only inside a purchase: its booking
 * form submits a ticket count to /bookSeat, which answers with the seat page
 * and starts a countdown (about 10 minutes). Cinve opens that purchase with
 * one ticket of the first type listed, never picks a seat, reads the page and
 * always closes the purchase with /cancelaCompra, the route the site itself
 * uses when the countdown ends. It needs the user's account, as the website
 * does, and runs one purchase at a time per account.
 */
export async function supercinesSeatPage(q: Query, c: ReadContext): Promise<{ html: string; date: string; time: string; cancelled: boolean; movie: string | undefined; venue: string | undefined }> {
  const cinemaId = requireArg(q, 'cinema_id'), sessionId = requireArg(q, 'session_id'), movieId = requireArg(q, 'movie_id');
  const date = q.date ?? today();
  if (isPastDate(date)) throw new DataError('unavailable', 'That date has passed: Supercines only sells showtimes from today onward.');
  if (!await c.hasSession('supercines')) throw new DataError('auth_required', 'Supercines shows its seat map only to a signed-in account: connect your Supercines account.');
  // Confirm the function first, as for fares, so a mismatched ID never opens another function's purchase.
  const page = await schedule(c, movieId, date);
  const functions = page === undefined ? [] : parseSupercinesShowtimes(page, { id: movieId, name: `Movie ${movieId}` }, date, { partial: false, warnings: [] });
  const fn = functions.find(s => s.id === sessionId && s.cinema_id === cinemaId);
  if (!fn?.time) throw new DataError('unavailable', 'The showtime does not appear in the Supercines schedule for that venue, movie and date; call get_showtimes (and pass date if it is not today).');
  const time = fn.time;
  const { threeD } = parseSupercinesBooking(await c.get(`${SC}/booking/${movieId}`, 600000));
  // The film's name as Supercines lists it, to check the seat page against (it names the film, not its ID).
  const movie = (await movies(c)).find(m => m.id === movieId)?.name;
  return c.exclusive('supercines', async () => {
    const fares = load(await c.authenticatedForm('supercines', `${SC}/listBoletos`, { idFuncion: sessionId, fecha: date, unico: movieId, tresD: threeD, idEmpresa: cinemaId }));
    const types = fares('input[name^="quantityBoleto["]').map((_, el) => fares(el).attr('name')?.match(/^quantityBoleto\[(\d{1,12})\]$/)?.[1]).get();
    if (!types.length) throw new DataError('unavailable', 'Supercines sells no tickets online for this showtime, so its website shows no seat map.');
    const fields: Array<[string, string]> = [['id', movieId], ['cartelera', sessionId], ['flagForm', '1']];
    const show = fares('#espectaculo').attr('value');
    if (show && scId.test(show)) fields.push(['espectaculo', show]);
    types.forEach((type, i) => fields.push([`quantityBoleto[${type}]`, i === 0 ? '1' : '0'], ['idBoleto[]', type], ['promoCombinada[]', '']));
    fields.push(['cortesia_boleto', ''], ['quantityBoletoCortesia[]', '0']);
    let html = '', cancelled = false;
    try { html = await c.authenticatedForm('supercines', `${SC}/bookSeat`, fields); }
    finally {
      // Always close the purchase, even when opening it failed half way or the client cancelled the call.
      cancelled = await c.closeAuthenticated('supercines', `${SC}/cancelaCompra`);
    }
    return { html, date, time, cancelled, movie, venue: fn.cinema_name };
  });
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
    if (q.cinema_id && !(await venues(c)).some(v => v.id === q.cinema_id)) throw new DataError('unavailable', 'Supercines venue not recognized; check list_cinemas.');
    c.warnings.push('Current Supercines listings (including presales), without a date; confirm date and venue with get_showtimes.');
    return movies(c, q.cinema_id);
  }
  if (op === 'showtimes') return showtimes(q, c);
  if (op === 'prices') {
    const cinemaId = requireArg(q, 'cinema_id'), sessionId = requireArg(q, 'session_id'), movieId = requireArg(q, 'movie_id');
    const date = q.date ?? today();
    if (isPastDate(date)) throw new DataError('unavailable', 'That date has passed: Supercines only sells showtimes from today onward.');
    // Fares depend on the date and the venue: confirm the function first, so
    // a mismatched ID never returns another function's fares.
    // Only the function's identity matters here: no title lookup, and the
    // schedule's own warnings (late night, disabled sales) stay out of fares.
    const html0 = await schedule(c, movieId, date);
    const functions = html0 === undefined ? [] : parseSupercinesShowtimes(html0, { id: movieId, name: `Movie ${movieId}` }, date, { partial: false, warnings: [] });
    if (!functions.some(s => s.id === sessionId && s.cinema_id === cinemaId)) throw new DataError('unavailable', 'The showtime does not appear in the Supercines schedule for that venue, movie and date; call get_showtimes (and pass date if it is not today).');
    const booking = `${SC}/booking/${movieId}`;
    const { rate, threeD } = parseSupercinesBooking(await c.get(booking, 600000));
    const fields = { idFuncion: sessionId, fecha: date, unico: movieId, tresD: threeD, idEmpresa: cinemaId };
    // Fares are public; with a connected account they are read as that
    // account (its page may add member fares or point redemptions), never
    // cached or shared. An ended session falls back to the public fares.
    let html: string | undefined, account = false;
    if (await c.hasSession('supercines')) {
      try { html = await c.authenticatedForm('supercines', `${SC}/listBoletos`, fields); account = true; }
      catch (error) {
        if (!(error instanceof DataError && error.status === 'auth_required')) throw error;
        c.warnings.push('Supercines did not recognize your account\'s session (it expired or was closed): public prices are shown. Connect the account again to see your account\'s prices.');
      }
    }
    html ??= await c.form(`${SC}/listBoletos`, fields, 60000);
    c.warnings.push(account
      ? 'Prices read with your Supercines account: they may include prices or redemptions specific to the account.'
      : 'Public Supercines prices, without an account (the same ones its website shows after signing in, except prices or redemptions specific to an account).');
    c.warnings.push('Supercines VES prices for the queried date (they vary by day and format). They include the per-ticket charge shown on the website; taxes and final purchase total not verified.');
    if (rate) c.warnings.push('USD calculated with the rate published on the Supercines purchase page, not with a verified BCV rate.');
    else c.warnings.push('Supercines did not publish a positive exchange rate; the USD equivalent is omitted.');
    return parseSupercinesPrices(html, { ...q, date }, rate, booking, c);
  }
  const cinemaId = requireArg(q, 'cinema_id');
  if (!(await venues(c)).some(v => v.id === cinemaId)) throw new DataError('unavailable', 'Supercines venue not recognized; check list_cinemas.');
  const products = parseSupercinesConcessions(await c.form(`${SC}/listCarameleria`, { idEmpresa: cinemaId }, 600000), cinemaId, c);
  if (products.length) c.warnings.push('VES prices from the venue\'s concessions catalog; per-product stock and final charges are not verified.');
  return products;
}
