import * as z from 'zod';

export const Provider = z.enum(['cinepic', 'cinesunidos', 'cinex', 'supercines', 'grancine']);
export type ProviderId = z.infer<typeof Provider>;
export const Status = z.enum(['available', 'empty', 'unavailable', 'auth_required', 'blocked', 'rate_limited', 'error']);
export type StatusId = z.infer<typeof Status>;
export const DateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === s;
}, 'Valid calendar date YYYY-MM-DD');
// Provider identifiers. Interior dots are allowed because Cinex publishes movie
// slugs such as seres.parte1lainvasion; leading/trailing dots and '..' are not,
// so an ID can never form a relative path segment. The published pattern is a
// plain character class: no lookaround (rejected by RE2-based validators) and
// no large bounded group (limited in strict function-calling modes). The dot
// rules are a server-side refinement, so accepted IDs are unchanged.
export const idString = (params?: Parameters<typeof z.string>[0]) => z.string(params).regex(/^[a-zA-Z0-9._-]{1,100}$/)
  .refine(value => !value.startsWith('.') && !value.endsWith('.') && !value.includes('..'), 'Invalid identifier.');
export const Id = idString();
export const PublicUrl = z.string().max(4096).refine(value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port; } catch { return false; }
}, 'HTTPS URL without credentials');
export const Source = z.object({ url: PublicUrl, fetched_at: z.string(), cached: z.boolean() });
export type Operation = 'cities' | 'cinemas' | 'movies' | 'showtimes' | 'prices' | 'concessions';
const Item = z.object({
  kind: z.enum(['provider', 'city', 'cinema', 'movie', 'showtime', 'ticket_price', 'concession']),
  id: z.string().min(1).max(200), name: z.string().min(1).max(512),
  cinema_id: Id.optional(), cinema_name: z.string().min(1).max(200).optional(), movie_id: Id.optional(), session_id: Id.optional(),
  code_status: z.enum(['verified', 'unverified']).optional().describe('Code confirmed by the current official data; unverified does not imply a closure.'),
  directory_status: z.enum(['listed', 'not_listed']).optional().describe('Presence in the directory received in this query; not_listed does not imply a closure.'),
  city: z.string().optional(), address: z.string().optional(),
  date: z.string().optional(), time: z.string().optional(), starts_at: z.string().optional(),
  format: z.string().optional(),
  language: z.string().optional().describe('Version: es or en (dubbed) and subtitulada at Cinex and Cines Unidos (which also marks it in the title, (Esp) or (Sub)); subtitulada or no_subtitulada at Cinepic. Absent when not confirmed.'),
  screen: z.string().optional().describe('Room as the provider names it (3, VIP, VIP (Piso 5), 4DX).'),
  duration_minutes: z.number().optional(), genre: z.string().optional(), rating: z.string().optional(),
  url: PublicUrl.optional(), image_url: PublicUrl.optional(),
  category: z.string().optional(), stock: z.number().optional(),
  prices: z.array(z.object({ currency: z.enum(['USD', 'VES', 'unknown']), amount: z.number().nonnegative(), basis: z.enum(['provider', 'provider_conversion', 'unverified_currency']) })).optional(),
  provider_currency: z.string().optional(), provider_conversion_rate: z.number().optional(),
  final_total_verified: z.boolean().optional(),
  price_components: z.array(z.object({ name: z.string(), currency: z.enum(['USD', 'VES']), amount: z.number().nonnegative() })).optional(),
  redemption_only: z.boolean().optional(), child_only: z.boolean().optional(), sales_allowed: z.boolean().optional(), area_category_code: z.string().optional(),
  tickets_available: z.number().int().nonnegative().optional().describe('Tickets the provider\'s website still offers online with this fare (Cinepic: its quota minus tickets sold and held in purchases in progress). It can be lower than the free seats.'),
  options_required: z.boolean().optional(),
  capabilities: z.record(z.string(), z.string()).optional(),
});
export type DataItem = z.infer<typeof Item>;

// Result items are deliberately narrower than the backwards-compatible Item
// union. Providers emit these fields today; keeping the operation schemas
// small makes the contract useful for discovery while still leaving fields
// that are genuinely optional optional.
const operationItemSchemas = {
  cities: Item.pick({ kind: true, id: true, name: true }).extend({
    kind: z.literal('city'),
  }),
  cinemas: Item.pick({ kind: true, id: true, cinema_id: true, code_status: true, directory_status: true, name: true, city: true, address: true, url: true }).extend({
    kind: z.literal('cinema'),
    id: Id.describe('Venue ID. directory-* identifies an entry without a queryable code; if code_status is present, use cinema_id only when it is verified.'),
  }),
  movies: Item.pick({
    kind: true, id: true, name: true, cinema_id: true, city: true,
    duration_minutes: true, genre: true, rating: true, format: true,
    image_url: true, url: true,
  }).extend({
    kind: z.literal('movie'),
    id: Id.describe('Movie ID returned by list_movies.'),
  }),
  showtimes: Item.pick({
    kind: true, id: true, name: true, cinema_id: true, cinema_name: true, movie_id: true,
    date: true, time: true, starts_at: true, format: true, language: true,
    screen: true, rating: true, url: true,
  }).extend({
    kind: z.literal('showtime'),
    rating: Item.shape.rating.describe('Age rating the provider publishes (A, B, C; Cines Unidos may vary it by venue, such as B+12).'),
    id: Id.describe('Showtime identifier; use it as session_id when looking up prices.'),
    cinema_id: Item.shape.cinema_id.unwrap().describe('Venue ID returned by list_cinemas.'),
    cinema_name: Item.shape.cinema_name.describe('Venue name when the source publishes it with the showtime.'),
    movie_id: Item.shape.movie_id.unwrap().describe('Movie ID confirmed by list_movies or by the Cinex catalog when querying a whole venue.'),
    date: Item.shape.date.unwrap().describe('Business date of the showtime in America/Caracas (YYYY-MM-DD).'),
    time: Item.shape.time.unwrap().describe('Local start time (HH:mm).'),
    starts_at: Item.shape.starts_at.describe('Timestamp with time zone; may be missing for late-night showtimes.'),
  }),
  prices: Item.pick({
    kind: true, id: true, name: true, cinema_id: true, movie_id: true,
    session_id: true, prices: true, provider_currency: true,
    provider_conversion_rate: true, final_total_verified: true,
    price_components: true, redemption_only: true, child_only: true,
    sales_allowed: true, area_category_code: true, screen: true,
    format: true, language: true, url: true, tickets_available: true,
  }).extend({
    kind: z.literal('ticket_price'),
    id: Item.shape.id.describe('Ticket type identifier.'),
    cinema_id: Item.shape.cinema_id.unwrap().describe('ID of the queried venue.'),
    session_id: Item.shape.session_id.unwrap().describe('Showtime ID; comes from showtimes.'),
    prices: Item.shape.prices.unwrap().describe('Verifiable amounts from the provider; [] means there was no usable amount.'),
  }),
  concessions: Item.pick({
    kind: true, id: true, name: true, cinema_id: true, category: true,
    stock: true, prices: true, final_total_verified: true,
    options_required: true, image_url: true, url: true,
  }).extend({
    kind: z.literal('concession'),
    id: Item.shape.id.describe('Concession product identifier.'),
    cinema_id: Item.shape.cinema_id.unwrap().describe('ID of the queried venue.'),
    prices: Item.shape.prices.unwrap().describe('Verifiable amounts from the provider; [] means there was no usable amount.'),
  }),
} as const;

export function operationItemSchema<Op extends Operation>(op: Op): (typeof operationItemSchemas)[Op];
export function operationItemSchema(op: Operation) {
  return operationItemSchemas[op];
}

const resultFields = {
  provider: Provider,
  status: Status,
  queried_at: z.string(),
  timezone: z.literal('America/Caracas'),
  sources: z.array(Source),
  warnings: z.array(z.string()),
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nullable(),
  partial: z.boolean(),
};
export const Result = z.object({
  ...resultFields,
  items: z.array(Item),
});
export type QueryResult = z.infer<typeof Result>;
export function outputSchema<Op extends Operation>(op: Op) {
  return z.object({ ...resultFields, items: z.array(operationItemSchema(op)) });
}
// Optional fields admit undefined: zod's inferred .optional() output does,
// and callers forward a field they may not have (city: q.city).
export type Query = {
  provider: ProviderId; city?: string | undefined; cinema_id?: string | undefined; movie_id?: string | undefined; session_id?: string | undefined;
  date?: string | undefined; query?: string | undefined; offset?: number | undefined; limit?: number | undefined; refresh?: boolean | undefined;
};
export class DataError extends Error {
  constructor(public status: StatusId, message: string) { super(message); }
}
export type Obj = Record<string, unknown>;
/** A JSON object: not null, not an array. Its keys are unchecked, so each value is unknown. */
export const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): string => typeof v === 'string' && !v.startsWith('$') ? v.trim() : typeof v === 'number' ? String(v) : '';
export const number = (v: unknown): number | undefined => (typeof v === 'number' || (typeof v === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim()))) && Number.isFinite(Number(v)) ? Number(v) : undefined;
export const folded = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/** The commercial date a query reads: the requested one, else today in Caracas. */
export function isoDate(q: Query) { return q.date ?? today(); }
/** Caracas wall-clock time, "HH:MM" (24 h). */
export const nowTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
/**
 * A calendar date whose functions are over. Schedules are grouped by
 * commercial date, so yesterday still counts until 05:00 (late-night
 * functions belong to it).
 */
export function isPastDate(date: string): boolean {
  const current = today();
  if (date >= current) return false;
  const yesterday = new Date(Date.parse(`${current}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return !(date === yesterday && nowTime() < '05:00');
}
export function requireArg(q: Query, field: keyof Query): string {
  const value = q[field];
  if (typeof value !== 'string' || !value) throw new DataError('unavailable', `${field} is required; get the identifier with the catalog tools.`);
  return value;
}
/**
 * Capture group `index` of a match that succeeded, for a group the pattern
 * does not make optional, so the match always fills it. Read an optional
 * group with `match[index]` instead and handle its absence.
 */
export function group(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error(`Regex group ${index} is optional in this pattern; read it with match[${index}].`);
  return value;
}
/** The text before the first `separator`, or all of it: `split(separator)[0]`, which always exists. */
export function beforeFirst(value: string, separator: string): string {
  const at = value.indexOf(separator);
  return at < 0 ? value : value.slice(0, at);
}
