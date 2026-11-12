import { getSeatMap } from './seats/seat-map.js';
import { CinexCinemaCatalog } from './providers/cinex/venues.js';
import { DataError, folded, operationItemSchema, PublicUrl, Result, today, Id } from './core.js';
import type { DataItem, Operation, ProviderId, Query, QueryResult } from './core.js';
import { distanceKm, nearestCity, resolvePlace, venueLocation } from './locations.js';
import type { Point } from './locations.js';
import { warningLabel } from './providers/diagnostics.js';
import { HttpClient } from './http/client.js';
import { ReadContext } from './http/read-context.js';
import type { CallOptions } from './http/read-context.js';
import { cinex } from './providers/cinex/adapter.js';
import { cinesunidos } from './providers/cinesunidos/adapter.js';
import { cinepic } from './providers/cinepic/adapter.js';
import { supercines } from './providers/supercines/adapter.js';
import { grancine } from './providers/grancine/adapter.js';
import { AuthProvider } from './auth/sessions.js';

const resultWarningLimit = 64;
const resultWarningCharacters = 8192;
const resultWarningItemLength = 512;

function boundedWarnings(warnings: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  let characters = 0, omitted = 0;
  for (const warning of warnings) {
    const value = typeof warning === 'string' ? warning : String(warning);
    const bounded = value.length > resultWarningItemLength ? `${value.slice(0, resultWarningItemLength - 1)}…` : value;
    if (seen.has(bounded)) { omitted++; continue; }
    seen.add(bounded);
    const reserve = 160;
    if (output.length >= resultWarningLimit - 1 || characters + bounded.length > resultWarningCharacters - reserve) {
      omitted++;
      continue;
    }
    output.push(bounded);
    characters += bounded.length;
  }
  if (omitted) {
    const aggregate = `${omitted} repeated or excess warnings were omitted; check partial and the source data.`;
    while (output.length >= resultWarningLimit || characters + aggregate.length > resultWarningCharacters) {
      const dropped = output.pop();
      if (dropped === undefined) break;
      characters -= dropped.length;
      omitted++;
    }
    output.push(aggregate);
  }
  return output;
}

const resultSourceLimit = 10;

/**
 * Fan-out reads (one search per film title, one metadata read per venue) can
 * cite dozens of URLs, which costs the model more tokens than the data itself.
 * Keep the first sources in read order (directory and catalog pages first)
 * and always the oldest one, so data age stays visible, and count the rest.
 */
function boundedSources(sources: QueryResult['sources'], warnings: string[]): QueryResult['sources'] {
  if (sources.length <= resultSourceLimit) return sources;
  const oldest = sources.reduce((a, b) => (Date.parse(b.fetched_at) < Date.parse(a.fetched_at) ? b : a));
  const kept = sources.slice(0, resultSourceLimit);
  if (!kept.includes(oldest)) kept[kept.length - 1] = oldest;
  warnings.push(`${sources.length} sources were queried; ${kept.length} are listed, including the oldest (${oldest.fetched_at}).`);
  return kept;
}

export const capabilities = {
  cinepic: { seats: 'public_page_data_ascii', cities: 'public', cinemas: 'public', movies: 'public_api', showtimes: 'public_api', prices: 'page_data_ves_and_derived_usd', concessions: 'public_api_empty_in_samples' },
  cinesunidos: { seats: 'authenticated_api_ascii', cities: 'public_api', cinemas: 'page_data', movies: 'page_data', showtimes: 'page_data', prices: 'authenticated_api', concessions: 'public_api' },
  supercines: { seats: 'account_opens_and_cancels_a_one_ticket_purchase_without_picking_seats', cities: 'public_form_api', cinemas: 'public_form_api', movies: 'public_api_billboard_by_cinema', showtimes: 'public_form_html_per_title', prices: 'public_form_html_ves_and_derived_usd_requires_movie_and_date_account_optional', concessions: 'public_form_html_ves' },
  grancine: { seats: 'not_published', cities: 'html_directory_with_known_cities', cinemas: 'html', movies: 'html_titles_with_functions', showtimes: 'html_per_venue_and_date_no_upstream_ids', prices: 'not_published', concessions: 'not_published' },
  cinex: { seats: 'authenticated_html_ascii', cities: 'public_api', cinemas: 'html', movies: 'html_general_catalog', showtimes: 'html_requires_cinema_or_movie', prices: 'authenticated_html_requires_session', concessions: 'authenticated_html' },
};
/**
 * Each venue's area and, from a place, its distance; nearest first. Venues
 * Cinve has not located keep their order after the located ones.
 */
function locateVenues(provider: ProviderId, items: DataItem[], place: { point: Point } | undefined): DataItem[] {
  const located = items.map(item => {
    const where = venueLocation(provider, item.id);
    if (!where) return { item, km: Infinity };
    const km = place ? Math.round(distanceKm(place.point, where) * 10) / 10 : Infinity;
    return { item: { ...item, area: where.area, ...(place ? { distance_km: km } : {}) }, km };
  });
  return (place ? located.sort((a, b) => a.km - b.km) : located).map(l => l.item);
}
const farKm = 30;
/** What a reader of the returned venues must know about their distances; nothing for an empty page. */
function distanceWarnings(provider: ProviderId, page: DataItem[], nearest: number | undefined, place: { name: string }): string[] {
  const warnings: string[] = [];
  if (!page.length) return warnings;
  warnings.push(`distance_km is the straight line from ${place.name}, not the travel distance or time.`);
  // A chain with no venue in the user's region still sorts one first: it is not "near".
  if (nearest !== undefined && nearest > farKm) warnings.push(`No ${provider} venue is within ${farKm} km of ${place.name}: the nearest is ${nearest} km away.`);
  const rough = page.filter(i => venueLocation(provider, i.id)?.approximate).map(i => warningLabel(i.name, 60));
  if (rough.length) warnings.push(`Only the area of ${rough.join(', ')} is known, so its distance is approximate.`);
  const unknown = page.filter(i => i.distance_km === undefined).length;
  if (unknown) warnings.push(`${unknown} venues have no known location and are listed last, without distance_km.`);
  return warnings;
}

export class CinemaService {
  constructor(private http = new HttpClient(), private cinexCatalog = new CinexCinemaCatalog()) {}
  async seats(q: Query, call?: CallOptions) { return getSeatMap(this.http, q, call); }
  async authStatus() { return Promise.all(AuthProvider.options.map(p => this.http.sessions.status(p))); }
  async query(op: Operation, q: Query, call?: CallOptions): Promise<QueryResult> {
    // One commercial date for the entire operation, including midnight boundaries.
    if (!q.date && (op === 'showtimes' || (op === 'movies' && q.provider !== 'cinex' && q.provider !== 'supercines'))) q = { ...q, date: today() };
    const c = new ReadContext(this.http, q.refresh, call);
    const result: QueryResult = { provider: q.provider, status: 'empty', queried_at: new Date().toISOString(), timezone: 'America/Caracas', sources: [], items: [], warnings: [], total: 0, next_offset: null, partial: false };
    try {
      if (q.cinema_id?.startsWith('directory-')) throw new DataError('unavailable', 'This venue has no verified query code. Check the official link returned by list_cinemas; the directory- ID only identifies the known venue.');
      // "Near Chacao": the place is resolved before the read, because Cines
      // Unidos lists venues only by city and the place decides which one.
      const place = op === 'cinemas' && q.near ? resolvePlace(q.near) : undefined;
      if (op === 'cinemas' && q.near && !place) {
        if (q.provider === 'cinesunidos' && !q.city) throw new DataError('unavailable', `Cinve does not know the place "${warningLabel(q.near, 120)}". Pass city (list_cities), or near as a neighbourhood or town (Chacao, Las Mercedes, Naguanagua) or "lat,lng".`);
        c.warnings.push(`Cinve does not know the place "${warningLabel(q.near, 120)}", so venues are not sorted by distance. Use a neighbourhood or town (Chacao, Las Mercedes, Naguanagua) or "lat,lng".`);
      }
      if (place && q.provider === 'cinesunidos' && !q.city) {
        const city = nearestCity('cinesunidos', place.point);
        if (!city) throw new DataError('unavailable', 'Cines Unidos lists venues by city; pass city (list_cities).');
        q = { ...q, city };
        c.warnings.push(`Cines Unidos lists venues by city: ${city}, the one nearest to ${place.name}, was used.`);
      }
      const data = q.provider === 'cinex' ? await cinex(op, q, c, this.cinexCatalog)
        : await ({ cinepic, cinesunidos, supercines, grancine })[q.provider](op, q, c);
      const unique = new Map<string, DataItem>();
      // A function ID drives price and seat lookups. If the provider reports the
      // same ID with a different film, date, time or room, neither copy is
      // trustworthy: suppress the ID instead of letting response order decide.
      const showtimes = new Map<string, DataItem>(), conflicted = new Set<string>();
      const showtimeIdentity = (item: DataItem) => JSON.stringify([item.movie_id, item.date, item.time, item.screen ?? null]);
      for (const raw of data) {
        const candidate = { ...raw };
        for (const key of ['url', 'image_url'] as const) {
          if (candidate[key] !== undefined && !PublicUrl.safeParse(candidate[key]).success) {
            if (candidate[key]) c.warnings.push('A provider link was omitted because it was not a valid HTTPS URL without credentials.');
            delete candidate[key];
          }
        }
        // Validate inside the guarded path, before filtering/pagination can hide a bad record.
        const item: DataItem = operationItemSchema(op).parse(candidate);
        if (['movie', 'showtime', 'cinema'].includes(item.kind)) Id.parse(item.id);
        const key = `${item.kind}:${item.cinema_id ?? ''}:${item.id}`;
        if (item.kind === 'showtime') {
          if (conflicted.has(key)) continue;
          const previous = showtimes.get(key);
          if (previous && showtimeIdentity(previous) !== showtimeIdentity(item)) {
            conflicted.add(key); showtimes.delete(key); unique.delete(key); c.partial = true;
            c.warnings.push(`The provider returned contradictory data for showtime ${item.id}; it was omitted because its movie or time cannot be confirmed.`);
            continue;
          }
          showtimes.set(key, item);
        }
        if (op === 'movies' && q.movie_id && item.id !== q.movie_id) continue;
        if (!q.query || folded(item.name).includes(folded(q.query))) unique.set(key, item);
      }
      let items = [...unique.values()].sort((a, b) => (a.starts_at ?? a.name).localeCompare(b.starts_at ?? b.name) || a.id.localeCompare(b.id));
      if (op === 'cinemas') items = locateVenues(q.provider, items, place);
      const offset = q.offset ?? 0, limit = q.limit ?? 50;
      result.total = items.length;
      result.items = items.slice(offset, offset + limit);
      result.next_offset = offset + limit < items.length ? offset + limit : null;
      // First, so that the provider's own warnings cannot crowd them out of the bounded list.
      if (place) c.warnings.unshift(...distanceWarnings(q.provider, result.items, items[0]?.distance_km, place));
      result.status = items.length ? 'available' : 'empty';
    } catch (error) {
      result.items = []; result.total = 0; result.next_offset = null;
      result.status = error instanceof DataError ? error.status : 'error';
      c.warnings.push(error instanceof DataError ? error.message : 'Interpreting the provider\'s response failed.');
    }
    result.sources = boundedSources(c.sources, c.warnings);
    result.partial = c.partial;
    result.warnings = boundedWarnings(c.warnings);
    return Result.parse(result);
  }
}
