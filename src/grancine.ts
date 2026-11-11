import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { DataError, folded, isPastDate, requireArg, today } from './core.js';
import type { DataItem, Operation, Query } from './core.js';
import type { ReadContext } from './http.js';
import { clock, titled } from './parsers.js';
import { fanOut } from './fanout.js';

/**
 * Gran Cine (grancine.net), the art-house circuit that programmes the
 * C. C. Paseo Las Mercedes screens (home of Trasnocho Cultural, whose own
 * site refuses automated reads), Cine Ávila, Villa Planchart, Cinética and
 * open-air screenings, plus its titles at partner multiplexes. Plain
 * server-rendered PHP pages read with GET: one per venue and date. It
 * publishes title, rating, time and room only: no function IDs, fares,
 * concessions or seats.
 */
const GC = 'https://www.grancine.net';
const slugPattern = /^[a-z0-9-]{1,80}$/;

/**
 * The directory names venues without a city. Cities of the venues observed
 * in November 2026; a new venue gets a city only from its own parenthetical.
 */
const knownCities: Record<string, string> = {
  'lder': 'Caracas', 'paseo-las-mercedes': 'Caracas', 'cinevilalder': 'Caracas', 'villaplanchartelcerrito': 'Caracas',
  'cinticaculturallosruices': 'Caracas', 'plazalospalosgrandescaracas': 'Caracas',
  'supercineslagranjavalencia': 'Valencia', 'supercineslosaviadoresmaracay': 'Maracay', 'supercineslacascadalosteques': 'Los Teques',
};
const cityNames = ['Caracas', 'Valencia', 'Maracay', 'Los Teques', 'Barquisimeto', 'Maracaibo', 'Mérida', 'Barcelona', 'Puerto La Cruz', 'Lechería', 'Puerto Ordaz', 'San Cristóbal', 'Maturín', 'Porlamar'];
/** Partner multiplexes: there Gran Cine lists only its own titles. */
const hostedBy: Record<string, string> = {
  'lder': 'Cines Unidos', 'supercineslagranjavalencia': 'Supercines', 'supercineslosaviadoresmaracay': 'Supercines', 'supercineslacascadalosteques': 'Supercines',
};

type Venue = { id: string; name: string; city?: string };
export function parseGranCineVenues(html: string): Venue[] {
  const $ = load(html), venues = new Map<string, Venue>();
  $('a[href^="sedes/sede.php?slug="]').each((_, a) => {
    const slug = new URLSearchParams(($(a).attr('href') ?? '').split('?')[1] ?? '').get('slug') ?? '';
    const name = $(a).closest('.card').find('.card-title').first().text().replace(/\s+/g, ' ').trim();
    if (!slugPattern.test(slug) || !name || name.length > 120 || venues.has(slug)) return;
    const display = titled(name);
    const hint = display.match(/\(([^)]+)\)\s*$/)?.[1];
    const city = knownCities[slug] ?? cityNames.find(c => hint && folded(c) === folded(hint));
    venues.set(slug, { id: slug, name: display, city });
  });
  if (!venues.size) throw new DataError('error', 'No se reconoció el directorio de salas de Gran Cine.');
  return [...venues.values()];
}
async function venues(c: ReadContext): Promise<Venue[]> {
  return parseGranCineVenues(await c.get(`${GC}/salas`, 3600000));
}

/** "Cosas de casa (Estreno Nacional)", "Caballo salvaje nueve (2da. Semana)" → the title. */
export function granCineTitle(value: string): string {
  const name = value.replace(/\s+/g, ' ').trim();
  return name.replace(/\s*\((?:[^)]*\bsemana|(?:pre)?e[sx]treno[^)]*|re-?estreno[^)]*)\)\s*$/i, '').trim() || name;
}

type Showtime = DataItem & { kind: 'showtime'; cinema_id: string; movie_id: string; date: string; time: string };
/**
 * One venue's page for one date. The date strip marks the date the page
 * shows; a date outside the published window shows no marker and no
 * functions, which is reported as such rather than as an empty schedule.
 */
export function parseGranCineVenuePage(html: string, venue: Venue, date: string, c: ReadContext): { items: Showtime[]; published: boolean; address?: string } {
  const $ = load(html);
  const strip = $('a.caja-fecha-roja').map((_, a) => new URLSearchParams(($(a).attr('href') ?? '').split('?')[1] ?? '').get('fecha') ?? '').get();
  const shown = $('a.caja-fecha-roja.hoy').map((_, a) => new URLSearchParams(($(a).attr('href') ?? '').split('?')[1] ?? '').get('fecha') ?? '').get();
  if (!strip.length) throw new DataError('error', 'No se reconoció la página de sala de Gran Cine.');
  if (!strip.includes(date)) return { items: [], published: false };
  if (shown.length !== 1 || shown[0] !== date) throw new DataError('error', 'La página de Gran Cine no corresponde a la fecha solicitada.');
  const address = $('.btn-ubicacion-estilo').first().text().replace(/\s+/g, ' ').trim() || undefined;
  const items: Showtime[] = [];
  let skipped = 0, lateNight = 0;
  $('.tarjeta-container-horizontal').each((_, card) => {
    const raw = $(card).find('.titulo-card-horiz').first().text();
    const name = granCineTitle(raw);
    const movieId = ($(card).find('a[href*="detalle_sinopsis.php?id="]').attr('href') ?? '').match(/detalle_sinopsis\.php\?id=(\d{1,9})$/)?.[1];
    const badge = $(card).find('.badge').first().text().replace(/\s+/g, ' ').trim();
    const rating = badge && badge.length <= 10 ? badge : undefined;
    if (!name || name.length > 300 || !movieId) { skipped++; return; }
    $(card).find('.caja-hora-sala').each((_, slot) => {
      const room = $(slot).find('small').first().text().replace(/\s+/g, ' ').trim();
      const time = clock($(slot).clone().children().remove().end().text());
      if (!time) { skipped++; return; }
      const overnight = Number(time.slice(0, 2)) < 5;
      if (overnight) lateNight++;
      // Gran Cine publishes no function IDs. This one identifies the listing
      // (venue, date, time, room, title) so repeated reads agree; it does not
      // exist upstream and cannot be used to buy or look up seats.
      const id = `gc-${createHash('sha256').update(JSON.stringify([venue.id, date, time, room, movieId])).digest('hex').slice(0, 20)}`;
      items.push({ kind: 'showtime', id, name, cinema_id: venue.id, cinema_name: venue.name.slice(0, 200), movie_id: movieId, rating,
        date, time, starts_at: overnight ? undefined : `${date}T${time}:00-04:00`, screen: room && room.length <= 60 ? room : undefined,
        url: `${GC}/sedes/sede.php?${new URLSearchParams({ slug: venue.id, fecha: date })}` });
    });
  });
  if (skipped) {
    c.partial = true;
    c.warnings.push(`Gran Cine (${venue.name}): se omitieron ${skipped} funciones o títulos sin hora, título o ficha reconocibles.`);
  }
  if (lateNight) c.warnings.push('Gran Cine: en funciones de madrugada se omite starts_at porque la fecha calendario no está confirmada.');
  return { items, published: true, address };
}

// Budget counted from the start of the call (directory read included); a
// venue page starts only while one read (15 s) still fits.
const venueLimit = 12, budgetMs = 60000, readMs = 15000, workers = 2;
async function showtimes(q: Query, c: ReadContext, listing = false): Promise<Showtime[]> {
  const deadline = Date.now() + budgetMs;
  const date = q.date ?? today();
  if (isPastDate(date)) {
    c.warnings.push('Esa fecha ya pasó: Gran Cine solo publica la programación de hoy en adelante.');
    return [];
  }
  const all = await venues(c);
  let work: Venue[];
  if (q.cinema_id) {
    const venue = all.find(v => v.id === q.cinema_id);
    if (!venue) throw new DataError('unavailable', 'Sala Gran Cine no reconocida; consulta list_cinemas.');
    work = [venue];
  } else if (q.city) {
    work = all.filter(v => v.city && folded(v.city) === folded(q.city!));
    if (!work.length) { c.warnings.push('Gran Cine no tiene salas en esta ciudad; consulta list_cities.'); return []; }
  } else work = all;
  if (work.length > venueLimit) {
    c.partial = true;
    c.warnings.push(`Se consultaron ${venueLimit} de ${work.length} salas de Gran Cine; usa cinema_id para las demás.`);
    work = work.slice(0, venueLimit);
  }
  const items: Showtime[] = [], failed: string[] = [], unpublished: string[] = [];
  let steps = 0;
  const { done, failures, skipped: left, stopped } = await fanOut(work, async venue => {
    try {
      const page = parseGranCineVenuePage(await c.get(`${GC}/sedes/sede.php?${new URLSearchParams({ slug: venue.id, fecha: date })}`, 600000), venue, date, c);
      if (!page.published) unpublished.push(venue.name);
      items.push(...page.items.filter(s => !q.movie_id || s.movie_id === q.movie_id));
    } catch (error) { failed.push(venue.name); throw error; }
  }, { deadline, minRemainingMs: readMs, workers, onStep: () => c.progress(`Gran Cine: ${++steps} de ${work.length} salas leídas.`) });
  const skipped = left.map(v => v.name);
  const firstError = stopped ?? failures[0];
  if (unpublished.length) c.warnings.push(`Gran Cine aún no publica la programación de esa fecha (publica unos 20 días desde hoy) para: ${unpublished.join(', ')}.`);
  if (failed.length) { c.partial = true; c.warnings.push(`No se pudo leer la programación de Gran Cine en: ${failed.join(', ')}.`); }
  if (skipped.length) { c.partial = true; c.warnings.push(stopped ? `Gran Cine rechazó o no respondió a varias consultas seguidas; no se leyó: ${skipped.join(', ')}.` : `Se agotó el tiempo antes de leer: ${skipped.join(', ')}; consulta su cinema_id.`); }
  if (!done) throw firstError ?? new DataError('unavailable', 'Se agotó el tiempo de consulta de Gran Cine.');
  const partners = [...new Set(work.filter(v => hostedBy[v.id] && items.some(s => s.cinema_id === v.id)).map(v => hostedBy[v.id]))];
  if (partners.length) c.warnings.push(`En salas de ${partners.join(' y ')}, Gran Cine lista solo los títulos de su circuito; la programación completa de esas salas está en ese proveedor.`);
  if (!listing) c.warnings.push('Gran Cine no publica identificadores de función: el id de cada función lo calcula Cinve y no sirve para tarifas ni asientos. Confirma horarios en la sala antes de ir.');
  return items;
}

export async function grancine(op: Operation, q: Query, c: ReadContext): Promise<DataItem[]> {
  if (op === 'cities') return [...new Set((await venues(c)).map(v => v.city).filter((v): v is string => !!v))].map(city => ({ kind: 'city', id: city, name: city }));
  if (op === 'cinemas') {
    const list = await venues(c);
    const unknown = list.filter(v => !v.city);
    if (unknown.length) c.warnings.push(`Gran Cine no indica la ciudad de: ${unknown.map(v => v.name).join(', ')}.`);
    return list.filter(v => !q.city || (v.city && folded(v.city) === folded(q.city)))
      .map(v => ({ kind: 'cinema', id: v.id, cinema_id: v.id, code_status: 'verified', name: v.name, city: v.city, url: `${GC}/sedes/sede.php?slug=${v.id}` }));
  }
  if (op === 'movies') {
    // Titles with functions on that date: the circuit has no billboard API,
    // and its synopsis catalog also lists past titles.
    const movies = new Map<string, DataItem>();
    for (const s of await showtimes(q, c, true)) if (!movies.has(s.movie_id)) movies.set(s.movie_id, { kind: 'movie', id: s.movie_id, name: s.name, rating: s.rating, ...(q.cinema_id ? { cinema_id: q.cinema_id } : {}), city: q.city, url: `${GC}/detalle_sinopsis.php?id=${s.movie_id}` });
    return [...movies.values()];
  }
  if (op === 'prices' || op === 'concessions') {
    requireArg(q, 'cinema_id');
    throw new DataError('unavailable', 'Gran Cine solo publica la programación: no publica tarifas ni caramelería. Consulta la sala (o Supercines/Cines Unidos en sus salas asociadas).');
  }
  return showtimes(q, c);
}
