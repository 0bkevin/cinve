// The get_seats result contract (SeatResult is its MCP outputSchema) and the
// map orientation each provider's own seat page uses.
import * as z from 'zod';
import { Id, Provider, Source, Status, text } from '../core.js';
import { object } from '../providers/parsing.js';

// Unicode property escapes (\p{L}) are invalid in Python's re and RE2, and
// MCP clients such as the Python SDK validate structuredContent against the
// published outputSchema, so this rule is a server-side refinement.
const label = z.string().min(1).max(40).refine(value => /^[\p{L}\p{N} _:.()-]+$/u.test(value), 'Etiqueta de asiento no válida.');
const coordinate = z.number().int().min(0).max(199);
export const Seat = z.object({
  id: z.string().min(1).max(200), label, row: label, area: label,
  row_index: coordinate, column_index: coordinate,
  status: z.enum(['available', 'occupied', 'unavailable', 'unknown']),
  provider_status: z.string().max(40), category: z.string().max(100).optional(),
});
export type SeatData = z.infer<typeof Seat>;
/** The function as the seat page names it; every field is optional. */
export const ShowingFields = z.object({
  movie: z.string().max(200).optional(), cinema_name: z.string().max(120).optional(), screen: z.string().max(60).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});
export const SeatResult = z.object({
  provider: Provider, cinema_id: Id, session_id: Id, status: Status,
  queried_at: z.string(), timezone: z.literal('America/Caracas'),
  sources: z.array(Source), warnings: z.array(z.string()),
  seats: z.array(Seat).max(10000).optional().describe('Detalle por asiento; solo con include_seats=true. El mapa ascii ya muestra cada etiqueta con su estado.'),
  available: z.number().int().nonnegative(),
  occupied: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  availability_complete: z.boolean().describe('True only when a nonempty map has no unknown seat states. Does not promise purchase eligibility or a reservation.'),
  layout: z.object({
    screen: z.enum(['top', 'bottom', 'unverified']).describe('Lado de la pantalla en el mapa ascii y en la imagen, como lo dibuja la web del proveedor; unverified si no se pudo confirmar.'),
    column_order: z.enum(['ascending', 'descending']).describe('descending: la web del proveedor dibuja column_index de derecha a izquierda; el mapa ascii y la imagen lo respetan.'),
    row_shift: z.record(z.string().max(40), z.number().min(0).max(100)).optional().describe('Filas que la web del proveedor centra por ser más cortas: cuántos asientos (puede ser medio) se desplaza cada una desde column_index 0. El mapa ascii y la imagen ya lo aplican.'),
  }),
  showing: ShowingFields.optional().describe('La función según la misma respuesta del mapa (texto del proveedor), para rotular la imagen; los campos ausentes no se pudieron leer.'),
  ascii: z.string(),
});
export type SeatMapResult = z.infer<typeof SeatResult>;
export type Layout = SeatMapResult['layout'];
export type Showing = z.infer<typeof ShowingFields>;
/**
 * Orientation as each provider's own seat page draws it (checked in their web
 * code on 2026-11-05): Cinepic puts the screen above row 1 and draws "invertida"
 * rooms right to left; Cines Unidos draws rows by index downwards with the
 * screen underneath. Cinex's seat page (read with a session on 2026-11-05)
 * draws its rows and seats in document order (row A last) and its screen
 * image, pantallawidew.png, right after the grid, with no CSS that flips it.
 */
export function seatLayout(provider: string, cinepicData?: unknown): Layout {
  if (provider === 'cinepic') {
    const seats = object(cinepicData).butacas, first = Array.isArray(seats) ? object(seats[0]) : {};
    return { screen: 'top', column_order: text(first.invertida) === '1' ? 'descending' : 'ascending' };
  }
  if (provider === 'cinesunidos' || provider === 'cinex') return { screen: 'bottom', column_order: 'ascending' };
  return { screen: 'unverified', column_order: 'ascending' };
}
