import { getSeatMap } from './seats.js';
import { CinexCinemaCatalog } from './cinex-cinemas.js';
import { DataError, folded, operationItemSchema, PublicUrl, Result, today, Id } from './core.js';
import type { DataItem, Operation, Query, QueryResult } from './core.js';
import { HttpClient, ReadContext } from './http.js';
import type { CallOptions } from './http.js';
import { cinex } from './providers.js';
import { cinesunidos } from './providers/cinesunidos/adapter.js';
import { cinepic } from './providers/cinepic/adapter.js';

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
    const aggregate = `Se omitieron ${omitted} advertencias repetidas o excedentes; consulta partial y los datos fuente.`;
    while (output.length && (output.length >= resultWarningLimit || characters + aggregate.length > resultWarningCharacters)) {
      characters -= output.pop()!.length;
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
  const kept = sources.slice(0, resultSourceLimit - 1);
  kept.push(kept.includes(oldest) ? sources[resultSourceLimit - 1] : oldest);
  warnings.push(`Se consultaron ${sources.length} fuentes; se listan ${kept.length}, incluida la más antigua (${oldest.fetched_at}).`);
  return kept;
}

export const capabilities = {
  cinepic: { seats: 'public_page_data_ascii', cities: 'public', cinemas: 'public', movies: 'public_api', showtimes: 'public_api', prices: 'page_data_ves_and_derived_usd', concessions: 'public_api_empty_in_samples' },
  cinesunidos: { seats: 'authenticated_api_ascii', cities: 'public_api', cinemas: 'page_data', movies: 'page_data', showtimes: 'page_data', prices: 'authenticated_api', concessions: 'public_api' },
  cinex: { seats: 'authenticated_html_ascii', cities: 'public_api', cinemas: 'html', movies: 'html_general_catalog', showtimes: 'html_requires_cinema_or_movie', prices: 'authenticated_html_requires_session', concessions: 'authenticated_html' },
};
export class CinemaService {
  constructor(private http = new HttpClient(), private cinexCatalog = new CinexCinemaCatalog()) {}
  async seats(q: Query, call?: CallOptions) { return getSeatMap(this.http, q, call); }
  async authStatus() { return Promise.all((['cinex', 'cinesunidos'] as const).map(p => this.http.sessions.status(p))); }
  async query(op: Operation, q: Query, call?: CallOptions): Promise<QueryResult> {
    // One commercial date for the entire operation, including midnight boundaries.
    if (!q.date && (op === 'showtimes' || (op === 'movies' && q.provider !== 'cinex'))) q = { ...q, date: today() };
    const c = new ReadContext(this.http, q.refresh, call);
    const result: QueryResult = { provider: q.provider, status: 'empty', queried_at: new Date().toISOString(), timezone: 'America/Caracas', sources: [], items: [], warnings: [], total: 0, next_offset: null, partial: false };
    try {
      if (q.cinema_id?.startsWith('directory-')) throw new DataError('unavailable', 'Esta sede no tiene código de consulta verificado. Consulta el enlace oficial devuelto por list_cinemas; el ID directory- solo identifica la sede conocida.');
      const data = q.provider === 'cinex' ? await cinex(op, q, c, this.cinexCatalog)
        : await ({ cinepic, cinesunidos })[q.provider](op, q, c);
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
            if (candidate[key]) c.warnings.push('Se omitió un enlace del proveedor porque no era una URL HTTPS válida sin credenciales.');
            delete candidate[key];
          }
        }
        // Validate inside the guarded path, before filtering/pagination can hide a bad record.
        const item = operationItemSchema(op).parse(candidate) as DataItem;
        if (['movie', 'showtime', 'cinema'].includes(item.kind)) Id.parse(item.id);
        const key = `${item.kind}:${item.cinema_id ?? ''}:${item.id}`;
        if (item.kind === 'showtime') {
          if (conflicted.has(key)) continue;
          const previous = showtimes.get(key);
          if (previous && showtimeIdentity(previous) !== showtimeIdentity(item)) {
            conflicted.add(key); showtimes.delete(key); unique.delete(key); c.partial = true;
            c.warnings.push(`El proveedor devolvió datos contradictorios para la función ${item.id}; se omitió porque no se puede confirmar su película u horario.`);
            continue;
          }
          showtimes.set(key, item);
        }
        if (op === 'movies' && q.movie_id && item.id !== q.movie_id) continue;
        if (!q.query || folded(item.name).includes(folded(q.query))) unique.set(key, item);
      }
      const items = [...unique.values()].sort((a, b) => (a.starts_at ?? a.name).localeCompare(b.starts_at ?? b.name) || a.id.localeCompare(b.id));
      const offset = q.offset ?? 0, limit = q.limit ?? 50;
      result.total = items.length;
      result.items = items.slice(offset, offset + limit);
      result.next_offset = offset + limit < items.length ? offset + limit : null;
      result.status = items.length ? 'available' : 'empty';
    } catch (error) {
      result.items = []; result.total = 0; result.next_offset = null;
      result.status = error instanceof DataError ? error.status : 'error';
      c.warnings.push(error instanceof DataError ? error.message : 'Falló la interpretación de la respuesta del proveedor.');
    }
    result.sources = boundedSources(c.sources, c.warnings);
    result.partial = c.partial;
    result.warnings = boundedWarnings(c.warnings);
    return Result.parse(result);
  }
}
