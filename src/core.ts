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
export const Item = z.object({
  kind: z.enum(['provider', 'city', 'cinema', 'movie', 'showtime', 'ticket_price', 'concession']),
  id: z.string().min(1).max(200), name: z.string().min(1).max(512),
  cinema_id: Id.optional(), movie_id: Id.optional(), session_id: Id.optional(),
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
export const Result = z.object({
  provider: Provider, status: Status, queried_at: z.string(), timezone: z.literal('America/Caracas'),
  sources: z.array(Source), items: z.array(Item), warnings: z.array(z.string()),
  total: z.number().int().nonnegative(), next_offset: z.number().int().nullable(), partial: z.boolean(),
});
export type QueryResult = z.infer<typeof Result>;
export type Operation = 'cities' | 'cinemas' | 'movies' | 'showtimes' | 'prices' | 'concessions';
export type Query = {
  provider: ProviderId; city?: string; cinema_id?: string; movie_id?: string; session_id?: string;
  date?: string; query?: string; offset?: number; limit?: number;
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
