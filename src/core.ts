import * as z from 'zod';

export const Provider = z.enum(['cinepic', 'cinesunidos', 'cinex', 'trasnocho']);
export type ProviderId = z.infer<typeof Provider>;
export const Status = z.enum(['available', 'empty', 'unavailable', 'auth_required', 'blocked', 'rate_limited', 'error']);
export type StatusId = z.infer<typeof Status>;
export const DateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === s;
}, 'Fecha calendario válida YYYY-MM-DD');
export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const PublicUrl = z.string().max(4096).refine(value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port; } catch { return false; }
}, 'URL HTTPS sin credenciales');
export const Source = z.object({ url: PublicUrl, fetched_at: z.string(), cached: z.boolean() });
export type Operation = 'cities' | 'cinemas' | 'movies' | 'showtimes' | 'prices' | 'concessions';
export const Item = z.object({
  kind: z.enum(['provider', 'city', 'cinema', 'movie', 'showtime', 'ticket_price', 'concession']),
  id: z.string().min(1).max(200), name: z.string().min(1).max(512),
  cinema_id: Id.optional(), movie_id: Id.optional(), session_id: Id.optional(),
  code_status: z.enum(['verified', 'unverified']).optional().describe('Código confirmado por los datos oficiales actuales; unverified no implica cierre.'),
  directory_status: z.enum(['listed', 'not_listed']).optional().describe('Presencia en el directorio recibido en esta consulta; not_listed no implica cierre.'),
  city: z.string().optional(), address: z.string().optional(),
  date: z.string().optional(), time: z.string().optional(), starts_at: z.string().optional(),
  format: z.string().optional(), language: z.string().optional(), screen: z.string().optional(),
  duration_minutes: z.number().optional(), genre: z.string().optional(), rating: z.string().optional(),
  url: PublicUrl.optional(), image_url: PublicUrl.optional(),
  category: z.string().optional(), stock: z.number().optional(),
  prices: z.array(z.object({ currency: z.enum(['USD', 'VES', 'unknown']), amount: z.number().nonnegative(), basis: z.enum(['provider', 'provider_conversion', 'unverified_currency']) })).optional(),
  provider_currency: z.string().optional(), provider_conversion_rate: z.number().optional(),
  final_total_verified: z.boolean().optional(),
  price_components: z.array(z.object({ name: z.string(), currency: z.enum(['USD', 'VES']), amount: z.number().nonnegative() })).optional(),
  redemption_only: z.boolean().optional(), child_only: z.boolean().optional(), sales_allowed: z.boolean().optional(), area_category_code: z.string().optional(),
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
    id: Id.describe('ID de sede. directory-* identifica una entrada sin código consultable; si code_status está presente, usa cinema_id solo cuando sea verified.'),
  }),
  movies: Item.pick({
    kind: true, id: true, name: true, cinema_id: true, city: true,
    duration_minutes: true, genre: true, rating: true, format: true,
    image_url: true, url: true,
  }).extend({
    kind: z.literal('movie'),
    id: Id.describe('ID de película devuelto por list_movies.'),
  }),
  showtimes: Item.pick({
    kind: true, id: true, name: true, cinema_id: true, movie_id: true,
    date: true, time: true, starts_at: true, format: true, language: true,
    screen: true, url: true,
  }).extend({
    kind: z.literal('showtime'),
    id: Id.describe('Identificador de la función; úsalo como session_id al consultar tarifas.'),
    cinema_id: Item.shape.cinema_id.unwrap().describe('ID de sede que devuelve list_cinemas.'),
    movie_id: Item.shape.movie_id.unwrap().describe('ID de película confirmado por list_movies o por el catálogo Cinex al consultar una sede completa.'),
    date: Item.shape.date.unwrap().describe('Fecha comercial de la función en America/Caracas (YYYY-MM-DD).'),
    time: Item.shape.time.unwrap().describe('Hora local de inicio (HH:mm).'),
    starts_at: Item.shape.starts_at.describe('Marca de tiempo con zona horaria; puede faltar en funciones de trasnoche.'),
  }),
  prices: Item.pick({
    kind: true, id: true, name: true, cinema_id: true, movie_id: true,
    session_id: true, prices: true, provider_currency: true,
    provider_conversion_rate: true, final_total_verified: true,
    price_components: true, redemption_only: true, child_only: true,
    sales_allowed: true, area_category_code: true, screen: true,
    format: true, language: true, url: true,
  }).extend({
    kind: z.literal('ticket_price'),
    id: Item.shape.id.describe('Identificador del tipo de tarifa.'),
    cinema_id: Item.shape.cinema_id.unwrap().describe('ID de sede consultada.'),
    session_id: Item.shape.session_id.unwrap().describe('ID de función; proviene de showtimes.'),
    prices: Item.shape.prices.unwrap().describe('Importes verificables del proveedor; [] significa que no hubo importe utilizable.'),
  }),
  concessions: Item.pick({
    kind: true, id: true, name: true, cinema_id: true, category: true,
    stock: true, prices: true, final_total_verified: true,
    options_required: true, image_url: true, url: true,
  }).extend({
    kind: z.literal('concession'),
    id: Item.shape.id.describe('Identificador del producto de caramelería.'),
    cinema_id: Item.shape.cinema_id.unwrap().describe('ID de sede consultada.'),
    prices: Item.shape.prices.unwrap().describe('Importes verificables del proveedor; [] significa que no hubo importe utilizable.'),
  }),
} as const;

export type OperationItem = z.infer<(typeof operationItemSchemas)[Operation]>;
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
export type Query = {
  provider: ProviderId; city?: string; cinema_id?: string; movie_id?: string; session_id?: string;
  date?: string; query?: string; offset?: number; limit?: number; refresh?: boolean;
};
export class DataError extends Error {
  constructor(public status: StatusId, message: string) { super(message); }
}
export const text = (v: unknown): string => typeof v === 'string' && !v.startsWith('$') ? v.trim() : typeof v === 'number' ? String(v) : '';
export const number = (v: unknown): number | undefined => (typeof v === 'number' || (typeof v === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim()))) && Number.isFinite(Number(v)) ? Number(v) : undefined;
export const folded = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function requireArg(q: Query, field: keyof Query): string {
  const value = q[field];
  if (typeof value !== 'string' || !value) throw new DataError('unavailable', `Se requiere ${field}; obtén el identificador mediante las herramientas de catálogo.`);
  return value;
}
