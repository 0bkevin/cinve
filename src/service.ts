import { getSeatMap } from './seats.js';
import { CinexCinemaCatalog } from './cinex-cinemas.js';
import { DataError, folded, operationItemSchema, PublicUrl, Result, today, Id } from './core.js';
import type { DataItem, Operation, Query, QueryResult } from './core.js';
import { HttpClient, ReadContext } from './http.js';
import { cinepic, cinesunidos, cinex, trasnocho } from './providers.js';

export const capabilities = {
  cinepic: { seats: 'public_page_data_ascii', cities: 'public', cinemas: 'public', movies: 'public_api', showtimes: 'public_api', prices: 'page_data_ves_and_derived_usd', concessions: 'public_api_empty_in_samples' },
  cinesunidos: { seats: 'authenticated_api_ascii', cities: 'public_api', cinemas: 'page_data', movies: 'page_data', showtimes: 'page_data', prices: 'authenticated_api', concessions: 'public_api' },
  cinex: { seats: 'authenticated_html_ascii', cities: 'public_api', cinemas: 'html', movies: 'html_general_catalog', showtimes: 'html_requires_movie', prices: 'authenticated_html_requires_session', concessions: 'authenticated_html' },
  trasnocho: { cities: 'not_implemented', cinemas: 'not_implemented', movies: 'blocked_in_samples', showtimes: 'not_implemented', prices: 'not_implemented', concessions: 'not_implemented' },
};
export class CinemaService {
  private cinexCatalog = new CinexCinemaCatalog();
  constructor(private http = new HttpClient()) {}
  async seats(q: Query) { return getSeatMap(this.http, q); }
  async authStatus() { return Promise.all((['cinex', 'cinesunidos'] as const).map(p => this.http.sessions.status(p))); }
  async query(op: Operation, q: Query): Promise<QueryResult> {
    // One commercial date for the entire operation, including midnight boundaries.
    if (!q.date && (op === 'showtimes' || (op === 'movies' && q.provider !== 'cinex'))) q = { ...q, date: today() };
    const c = new ReadContext(this.http, q.refresh);
    const result: QueryResult = { provider: q.provider, status: 'empty', queried_at: new Date().toISOString(), timezone: 'America/Caracas', sources: [], items: [], warnings: [], total: 0, next_offset: null, partial: false };
    try {
      if (q.cinema_id?.startsWith('directory-')) throw new DataError('unavailable', 'Esta sede no tiene código de consulta verificado. Consulta el enlace oficial devuelto por list_cinemas; el ID directory- solo identifica la sede conocida.');
      const data = q.provider === 'cinex' ? await cinex(op, q, c, this.cinexCatalog)
        : await ({ cinepic, cinesunidos, trasnocho })[q.provider](op, q, c);
      const unique = new Map<string, DataItem>();
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
        if (op === 'movies' && q.movie_id && item.id !== q.movie_id) continue;
        if (!q.query || folded(item.name).includes(folded(q.query))) unique.set(`${item.kind}:${item.cinema_id ?? ''}:${item.id}`, item);
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
    result.sources = c.sources;
    result.partial = c.partial;
    result.warnings = [...new Set(c.warnings)];
    return Result.parse(result);
  }
}
