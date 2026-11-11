import { load } from 'cheerio';
import * as z from 'zod';
import { DataError, Id, Provider, Source, Status, requireArg, text } from './core.js';
import type { Query } from './core.js';
import { HttpClient, ReadContext } from './http.js';
import type { CallOptions } from './http.js';
import { cpBuy } from './providers.js';
import { findField, object, rows } from './parsers.js';

// Unicode property escapes (\p{L}) are invalid in Python's re and RE2, and
// MCP clients such as the Python SDK validate structuredContent against the
// published outputSchema, so this rule is a server-side refinement.
const label = z.string().min(1).max(40).refine(value => /^[\p{L}\p{N} _:.()-]+$/u.test(value), 'Invalid seat label.');
const coordinate = z.number().int().min(0).max(199);
export const Seat = z.object({
  id: z.string().min(1).max(200), label, row: label, area: label,
  row_index: coordinate, column_index: coordinate,
  status: z.enum(['available', 'occupied', 'unavailable', 'unknown']),
  provider_status: z.string().max(40), category: z.string().max(100).optional(),
});
type SeatData = z.infer<typeof Seat>;
export const SeatResult = z.object({
  provider: Provider, cinema_id: Id, session_id: Id, status: Status,
  queried_at: z.string(), timezone: z.literal('America/Caracas'),
  sources: z.array(Source), warnings: z.array(z.string()),
  seats: z.array(Seat).max(10000).optional().describe('Per-seat detail; only with include_seats=true. The ascii map already shows each label with its state.'),
  available: z.number().int().nonnegative(),
  occupied: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  availability_complete: z.boolean().describe('True only when a nonempty map has no unknown seat states. Does not promise purchase eligibility or a reservation.'),
  ascii: z.string(),
});

function validateSeats(seats: SeatData[]): SeatData[] {
  const result = z.array(Seat).min(1).max(10000).parse(seats);
  const positions = new Set<string>(), ids = new Set<string>();
  for (const s of result) {
    const key = `${s.area}:${s.row_index}:${s.column_index}`;
    if (positions.has(key) || ids.has(s.id)) throw new DataError('error', 'The map contains duplicate positions or identifiers.');
    positions.add(key); ids.add(s.id);
  }
  return result;
}

export function parseCinepicSeats(data: unknown): SeatData[] {
  return validateSeats(rows(object(data).butacas, 'butacas').map(s => ({
    id: text(s.butaca), label: text(s.nombre_butaca), row: text(s.nombre_butaca).split(':')[0], area: 'Sala',
    row_index: Number(s.fila) - 1, column_index: Number(s.columna) - 1,
    status: text(s.libre) === '1' ? 'available' : text(s.libre) === '0' ? 'occupied' : 'unknown',
    provider_status: text(s.libre), category: text(s.tipo_butaca_id),
  })));
}

export function parseCinesUnidosSeats(data: unknown): SeatData[] {
  return validateSeats(rows(object(object(data).seats).areas, 'seats.areas').flatMap(a =>
    rows(a.rows, 'area.rows').flatMap(r => rows(r.seats, 'row.seats').map(s => {
      const p = object(s.position), status = text(s.status), area = text(a.number), row = text(r.physicalName);
      if (text(p.areaNumber) !== area || text(p.rowIndex) !== text(r.rowIndexZeroBased)) throw new DataError('error', 'Inconsistent seat position.');
      return {
        id: `${area}:${row}:${text(s.id)}`, label: `${row}:${text(s.id)}`, row, area,
        row_index: Number(p.rowIndex), column_index: Number(p.columnIndex),
        // Official seat component renders and selects both 0 and 7 as free.
        // Accessibility (3), selected (4), blocked/broken (5/6) are not free.
        status: ['0', '7'].includes(status) ? 'available' : ['1', '2'].includes(status) ? 'occupied' : ['3', '4', '5', '6'].includes(status) ? 'unavailable' : 'unknown',
        provider_status: status, category: text(a.areaCategoryCode),
      } as SeatData;
    }))));
}

export function parseCinexSeats(html: string, q: Query): SeatData[] {
  const $ = load(html);
  // Cinex stores the chosen function in its PHP session. Check the back link
  // in the SAME response so parallel reads cannot return another function's map.
  const back = $('#btnasientosatras').attr('href');
  const url = back ? new URL(back, 'https://www.cinex.com.ve/') : undefined;
  if (!url || url.origin !== 'https://www.cinex.com.ve' || url.pathname !== '/boletosdev.php' ||
      url.searchParams.getAll('cinemaid').length !== 1 || url.searchParams.getAll('sessionid').length !== 1 ||
      url.searchParams.get('cinemaid') !== q.cinema_id || url.searchParams.get('sessionid') !== q.session_id) {
    throw new DataError('unavailable', 'The Cinex map does not match the requested venue and showtime; repeat the query.');
  }
  if (/error al obtener el mapa/i.test(html)) throw new DataError('unavailable', 'Cinex responded with an error while loading the map for this showtime.');
  const result: SeatData[] = [];
  const freeClasses = new Set(['seat', 'seatestandar', 'seatvipbed', 'seatvipplus', 'seatvipstandar']);
  $('#mapcontent .row').filter((_, r) => $(r).children('.rowletter').length === 1).each((rowIndex, r) => {
    const row = $(r).children('.rowletter').text().trim();
    $(r).children().not('.rowletter').each((columnIndex, el) => {
      const seat = $(el);
      const classes = (seat.attr('class') ?? '').split(/\s+/);
      const occupied = classes.some(c => /^(?:seat|seatestandar|seatvipbed|seatvipplus|seatvipstandar)-occupied$/.test(c));
      const id = seat.attr('id') ?? (occupied ? seat.attr('title') : undefined);
      if (!id) {
        if (!seat.hasClass('blankspace')) throw new DataError('error', 'Unknown element in the Cinex map.');
        return;
      }
      // Argument 6 is the selected-ticket count, not seat availability. Cinex
      // emits an empty string in VIP rooms before any tickets are selected.
      const call = (seat.attr('onclick') ?? '').match(/^javascript:decideAsientoNew\('([A-Za-z0-9]+)','(\d+)','(\d+)','(\d+)','([A-Za-z0-9]+)','(\d*)','([NS])'(?:,'([NS])')?\);?$/);
      if (call && call[1] !== id) throw new DataError('error', 'Inconsistent Cinex seat identifier.');
      const restricted = classes.some(c => /wheelchair|selected/.test(c)) || call?.[7] === 'S' || call?.[8] === 'S';
      const available = call && seat.attr('alt') === '0' && classes.length === 1 && freeClasses.has(classes[0]);
      result.push({ id, label: id, row, area: 'Sala', row_index: rowIndex, column_index: columnIndex,
        status: occupied ? 'occupied' : restricted ? 'unavailable' : available ? 'available' : 'unknown',
        provider_status: seat.attr('alt') ?? 'unknown', category: call?.[5] });
    });
  });
  if (result.length !== $('#mapcontent [id], #mapcontent [class$="-occupied"]').length) throw new DataError('error', 'The Cinex map contains seats outside recognized rows.');
  if (!result.length) throw new DataError('unavailable', 'Cinex returned no seats for this showtime.');
  return validateSeats(result);
}

export function renderSeats(seats: SeatData[]): string {
  const symbols = { available: 'O', occupied: 'X', unavailable: '-', unknown: '?' };
  const lines = ['O available | X occupied | - restricted/unavailable | ? unknown', 'Provider coordinates; screen orientation not verified.'];
  let cells = 0;
  for (const area of [...new Set(seats.map(s => s.area))]) {
    const group = seats.filter(s => s.area === area);
    const width = Math.max(...group.map(s => s.label.length)) + 2;
    const maxColumn = Math.max(...group.map(s => s.column_index));
    cells += (maxColumn + 1) * (Math.max(...group.map(s => s.row_index)) + 1);
    if (cells > 40000) throw new DataError('unavailable', 'The map exceeds the maximum ASCII rendering size.');
    lines.push(`Area ${area}`);
    for (let row = 0; row <= Math.max(...group.map(s => s.row_index)); row++) {
      const rowSeats = group.filter(s => s.row_index === row);
      if (!rowSeats.length) { lines.push(''); continue; }
      lines.push(Array.from({ length: maxColumn + 1 }, (_, col) => {
        const s = rowSeats.find(s => s.column_index === col);
        return (s ? `${s.label}${symbols[s.status]}` : '').padEnd(width);
      }).join('').trimEnd());
    }
  }
  return lines.join('\n');
}

export async function getSeatMap(http: HttpClient, q: Query, call?: CallOptions): Promise<z.infer<typeof SeatResult>> {
  const result: z.infer<typeof SeatResult> = {
    provider: q.provider, cinema_id: requireArg(q, 'cinema_id'), session_id: requireArg(q, 'session_id'),
    status: 'unavailable', queried_at: new Date().toISOString(), timezone: 'America/Caracas',
    sources: [], warnings: [], seats: [], available: 0, occupied: 0, unavailable: 0, unknown: 0, total: 0, availability_complete: false, ascii: '',
  };
  const c = new ReadContext(http, true, call);
  try {
    if (q.provider === 'cinepic') {
      const { records, f } = await cpBuy(q, c);
      result.seats = parseCinepicSeats(findField(records, 'butacasData'));
      const count = Number(rows(f.datos, 'datos')[0]?.entradasDisponibles);
      if (Number.isFinite(count) && count !== result.seats.filter(s => s.status === 'available').length) c.warnings.push('The provider\'s ticket counter differs from the map; each seat\'s state is kept, without promising tickets for sale.');
      c.warnings.push('Cinepic availability also depends on the chosen ticket type. The provider\'s seleccionada field does not indicate a booking by the user.');
    } else if (q.provider === 'cinesunidos') {
      const url = `https://www.cinesunidos.com/api/seats?${new URLSearchParams({ theaterId: result.cinema_id, showTimeId: result.session_id })}`;
      result.seats = parseCinesUnidosSeats(JSON.parse(await c.authenticated('cinesunidos', url)));
      c.warnings.push('Special states are shown as restricted; check their conditions on the cinema\'s website.');
    } else if (q.provider === 'cinex') {
      if ((await c.authenticated('cinex', 'https://www.cinex.com.ve/checklogin.php')).trim() !== 'on') throw new DataError('auth_required', 'The Cinex session expired; connect your account again.');
      await c.authenticated('cinex', `https://www.cinex.com.ve/boletosdev.php?${new URLSearchParams({ cinemaid: result.cinema_id, sessionid: result.session_id })}`);
      result.seats = parseCinexSeats(await c.authenticated('cinex', 'https://www.cinex.com.ve/asientosdev.php'), q);
      c.warnings.push('Cinex: map read without selecting tickets or seats. Special categories may require a specific ticket type.');
    } else {
      throw new DataError('unavailable', 'Seat lookup not implemented for this provider.');
    }
    const seats = result.seats ?? [];
    result.available = seats.filter(s => s.status === 'available').length;
    result.occupied = seats.filter(s => s.status === 'occupied').length;
    result.unavailable = seats.filter(s => s.status === 'unavailable').length;
    result.unknown = seats.filter(s => s.status === 'unknown').length;
    result.total = seats.length;
    result.availability_complete = result.unknown === 0 && result.total > 0;
    if (result.unknown) c.warnings.push(`Map partially interpreted by Cinve: ${result.unknown} seats with unknown state (?). The ${result.available} available seats are only the confirmed ones; zero confirmed available seats does not mean sold out.`);
    result.ascii = renderSeats(seats);
    result.status = 'available';
    c.warnings.push('Read without booking, without local cache. Availability may change; confirm on the website before buying.');
  } catch (e) {
    result.status = e instanceof DataError ? e.status : 'error';
    result.seats = []; result.available = 0; result.occupied = 0; result.unavailable = 0;
    result.unknown = 0; result.total = 0; result.availability_complete = false; result.ascii = '';
    c.warnings.push(e instanceof DataError ? e.message : 'Could not interpret a verifiable seat map.');
  }
  result.sources = c.sources; result.warnings = c.warnings;
  return SeatResult.parse(result);
}
