// Each provider's seat map, read into one Seat list with four states. Only a
// seat the provider marks free becomes available; anything unrecognised stays
// unknown, never free.
import { load } from 'cheerio';
import * as z from 'zod';
import { beforeFirst, DataError, group, text } from '../core.js';
import type { Query } from '../core.js';
import { object, rows } from '../providers/parsing.js';
import { Seat, ShowingFields } from './schema.js';
import type { SeatData, Showing } from './schema.js';

export const clean = (value: unknown, max: number) => {
  const v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return v && v.length <= max ? v : undefined;
};
/** Drops absent fields; undefined when nothing could be read. */
export function showing(fields: Showing): Showing | undefined {
  const kept: Showing = {};
  for (const key of ShowingFields.keyof().options) { const value = fields[key]; if (value !== undefined) kept[key] = value; }
  return Object.keys(kept).length ? kept : undefined;
}

/** Cinex's seat page names its function in one line: "CINEX SAMBIL CHACAO | Sala 3 | Fecha: 05-11-2026 | Hora: 02:45pm | ... | Asientos disponibles: 154 asiento(s)". */
export function parseCinexShowing(html: string): { showing?: Showing | undefined; available?: number | undefined } {
  const $ = load(html);
  const line = $('div').filter((_, el) => $(el).children('b').filter((_, b) => /^Asientos disponibles:/.test($(b).text().trim())).length === 1).first().text();
  const parts = line.split('|').map(p => p.replace(/\s+/g, ' ').trim());
  const field = (name: string) => parts.find(p => p.startsWith(`${name}:`))?.slice(name.length + 1).trim();
  // Only real calendar dates and clock times: "31-02-2026" and "02:99pm" are dropped.
  let date: string | undefined, time: string | undefined;
  const day = field('Fecha')?.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (day) {
    const [d, m, y] = [group(day, 1), group(day, 2), group(day, 3)];
    if (new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).toISOString().startsWith(`${y}-${m}-${d}`)) date = `${y}-${m}-${d}`;
  }
  const clock = field('Hora')?.match(/^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?$/i);
  if (clock) {
    const hour = Number(group(clock, 1)), minutes = group(clock, 2), pm = group(clock, 3).toLowerCase() === 'p';
    if (Number(minutes) <= 59 && hour >= 1 && hour <= 12) time = `${String(hour % 12 + (pm ? 12 : 0)).padStart(2, '0')}:${minutes}`;
  }
  const count = field('Asientos disponibles')?.match(/^(\d+) asiento/)?.[1];
  const [first, second] = parts;
  return {
    showing: showing({
      movie: clean($('#cinexasientodatalistzy .movie-details h3.title').first().text(), 200),
      cinema_name: parts.length > 2 && first && !first.includes(':') ? clean(first, 120) : undefined,
      screen: /^Sala\b/i.test(second ?? '') ? clean(second, 60) : undefined,
      date,
      time,
    }),
    available: count ? Number(count) : undefined,
  };
}

function validateSeats(seats: SeatData[]): SeatData[] {
  const result = z.array(Seat).min(1).max(10000).parse(seats);
  const positions = new Set<string>(), ids = new Set<string>();
  for (const s of result) {
    const key = `${s.area}:${s.row_index}:${s.column_index}`;
    if (positions.has(key) || ids.has(s.id)) throw new DataError('error', 'El mapa contiene posiciones o identificadores duplicados.');
    positions.add(key); ids.add(s.id);
  }
  return result;
}

/**
 * Seat types the function's tariffs can book. Cinepic's purchase JS (2026-11-05)
 * matches a tariff's id against tipo_butaca_id: a free seat of another type is
 * drawn "no disponible", and a tariff without id books any free seat.
 */
export function cinepicBookableTypes(tariffs: unknown[]): Set<string> | 'all' {
  const list = tariffs.map(object);
  // An empty list is not evidence that no seat sells (the page may simply omit it); keep the map's states.
  if (!list.length || list.some(t => !text(t.id))) return 'all';
  return new Set(list.map(t => seatType(t.id)));
}
/** "08" and "8" name one type; non-numeric types compare as text, never as NaN. */
const seatType = (value: unknown) => { const t = text(value); return /^\d+$/.test(t) ? String(Number(t)) : t; };

/**
 * A Cinepic grid coordinate, 1-based. Rooms set up with tipoColumna "letras"
 * send columns as letters; the purchase page (2026-11-11) numbers its grid
 * ["0", "A", ..., "Z"], so A is column 1. Anything else is not a coordinate.
 */
function cinepicCoordinate(value: unknown): number {
  const v = text(value).trim();
  if (/^\d+$/.test(v)) return Number(v);
  return /^[A-Z]$/i.test(v) ? v.toUpperCase().charCodeAt(0) - 64 : NaN;
}

export function parseCinepicSeats(data: unknown, bookable: Set<string> | 'all' = 'all'): SeatData[] {
  return validateSeats(rows(object(data).butacas, 'butacas').map(s => ({
    id: text(s.butaca), label: text(s.nombre_butaca), row: beforeFirst(text(s.nombre_butaca), ':'), area: 'Sala',
    row_index: cinepicCoordinate(s.fila) - 1, column_index: cinepicCoordinate(s.columna) - 1,
    status: text(s.libre) === '1' ? (bookable === 'all' || bookable.has(seatType(s.tipo_butaca_id)) ? 'available' : 'unavailable')
      : text(s.libre) === '0' ? 'occupied' : 'unknown',
    provider_status: text(s.libre), category: text(s.tipo_butaca_id),
  })));
}

export function parseCinesUnidosSeats(data: unknown): SeatData[] {
  return validateSeats(rows(object(object(data).seats).areas, 'seats.areas').flatMap(a =>
    rows(a.rows, 'area.rows').flatMap(r => rows(r.seats, 'row.seats').map(s => {
      const p = object(s.position), status = text(s.status), area = text(a.number), row = text(r.physicalName);
      if (text(p.areaNumber) !== area || text(p.rowIndex) !== text(r.rowIndexZeroBased)) throw new DataError('error', 'Posición de asiento inconsistente.');
      return {
        id: `${area}:${row}:${text(s.id)}`, label: `${row}:${text(s.id)}`, row, area,
        row_index: Number(p.rowIndex), column_index: Number(p.columnIndex),
        // Official seat component renders and selects both 0 and 7 as free.
        // Accessibility (3), selected (4), blocked/broken (5/6) are not free.
        status: ['0', '7'].includes(status) ? 'available' : ['1', '2'].includes(status) ? 'occupied' : ['3', '4', '5', '6'].includes(status) ? 'unavailable' : 'unknown',
        provider_status: status, category: text(a.areaCategoryCode),
        // cinesunidos.com draws status 3 in blue with a wheelchair icon (2026-11-11).
        ...(status === '3' ? { accessible: true } : {}),
      } satisfies SeatData;
    }))));
}

/**
 * cinex.com.ve centers each row of its map (.centermap is display:flex;
 * justify-content:center, checked 2026-11-11), and most rooms pad every row to
 * one width with blank cells. Where a row is shorter (Parque Cerro Verde VIP:
 * row A has 11 cells, the others 13), the page draws it shifted right by half
 * the difference. Returns that shift, in seats, for each shorter row.
 */
export function cinexRowShifts(html: string): Record<string, number> {
  const $ = load(html), widths = new Map<string, number>();
  // Only rows that hold seats are drawn by Cinve; a row of blank cells alone does not move anything.
  $('#mapcontent .row').filter((_, r) => $(r).children('.rowletter').length === 1).each((_, r) => {
    const cells = $(r).children().not('.rowletter');
    if (cells.filter((_, el) => !$(el).hasClass('blankspace')).length) widths.set($(r).children('.rowletter').text().trim(), cells.length);
  });
  const widest = Math.max(0, ...widths.values()), shifts: Record<string, number> = {};
  // A shift beyond 100 seats or a row name beyond 40 characters is no room Cinex draws: keep the seats unshifted.
  for (const [row, width] of widths) if (width < widest && row.length <= 40 && (widest - width) / 2 <= 100) shifts[row] = (widest - width) / 2;
  return shifts;
}

/**
 * The fields cinex.com.ve's ticket form (doValidateTickets in scripts.min.js,
 * 2026-11-11) posts to boletos_data.php for ONE ticket of the first type that
 * can be bought alone (a child ticket needs another one with it), computed as
 * its updateCount() does. Undefined when the page offers no such ticket.
 */
export function cinexSeatOrderFields(ticketPage: string): Record<string, string> | undefined {
  for (const m of ticketPage.matchAll(/updateCount\('qty(\d{1,6})', 'total\d{1,6}', 'amount\d{1,6}', 'plus', '(\d{1,3})', '[\d.]+', '([\d.,]+)', '(\d+(?:\.\d+)?)', '(\d+(?:\.\d+)?)', '\d+', '([^']*)'\)/g)) {
    const [, item, index, ticketCost, bookingFee, usd, name] = m as unknown as [string, string, string, string, string, string, string];
    if (/niñ/i.test(name)) continue;
    const amount = ticketPage.match(new RegExp(`id="amount${item}"[^>]*value="(\\d+(?:\\.\\d+)?)"`))?.[1];
    if (!amount) continue;
    return { total: amount, cantboletos: '1', indicetickets: `${','.repeat(Number(index))}1`,
      bookingfeetotal: String(parseFloat(bookingFee)), tickettotal: String(parseFloat(ticketCost)), totalticketsusd: String(parseFloat(usd)) };
  }
  return undefined;
}

/** The right function's page arrived with an empty grid. */
export class EmptyCinexMap extends DataError {}

export function parseCinexSeats(html: string, q: Query): SeatData[] {
  const $ = load(html);
  // Cinex stores the chosen function in its PHP session. Check the back link
  // in the SAME response so parallel reads cannot return another function's map.
  const back = $('#btnasientosatras').attr('href');
  const url = back ? new URL(back, 'https://www.cinex.com.ve/') : undefined;
  if (!url || url.origin !== 'https://www.cinex.com.ve' || !['/boletos.php', '/boletosdev.php'].includes(url.pathname) ||
      url.searchParams.getAll('cinemaid').length !== 1 || url.searchParams.getAll('sessionid').length !== 1 ||
      url.searchParams.get('cinemaid') !== q.cinema_id || url.searchParams.get('sessionid') !== q.session_id) {
    throw new DataError('unavailable', 'El mapa Cinex no corresponde a la sede y función solicitadas; repite la consulta.');
  }
  if (/error al obtener el mapa/i.test(html)) throw new DataError('unavailable', 'Cinex respondió con un error al cargar el mapa de esta función.');
  const result: SeatData[] = [];
  const freeClasses = new Set(['seat', 'seatestandar', 'seatvipbed', 'seatvipplus', 'seatvipstandar']);
  $('#mapcontent .row').filter((_, r) => $(r).children('.rowletter').length === 1).each((rowIndex, r) => {
    const row = $(r).children('.rowletter').text().trim();
    $(r).children().not('.rowletter').each((columnIndex, el) => {
      const seat = $(el);
      const classes = (seat.attr('class') ?? '').split(/\s+/);
      // The newer page marks a sold seat "seatestandar-occupied"; the regular one "seat occupied"
      // (2026-11-11). Either way it has no id and names the seat in its title.
      const occupied = classes.some(c => /^(?:seat|seatestandar|seatvipbed|seatvipplus|seatvipstandar)-occupied$/.test(c))
        || (classes.includes('occupied') && classes.some(c => freeClasses.has(c)));
      const id = seat.attr('id') ?? (occupied ? seat.attr('title') : undefined);
      if (!id) {
        if (!seat.hasClass('blankspace')) throw new DataError('error', 'Elemento desconocido en el mapa Cinex.');
        return;
      }
      // Argument 6 is the selected-ticket count, not seat availability. Cinex
      // emits an empty string in VIP rooms before any tickets are selected.
      const call = (seat.attr('onclick') ?? '').match(/^javascript:decideAsientoNew\('([A-Za-z0-9]+)','(\d+)','(\d+)','(\d+)','([A-Za-z0-9]+)','(\d*)','([NS])'(?:,'([NS])')?\);?$/);
      if (call && call[1] !== id) throw new DataError('error', 'Identificador de asiento Cinex inconsistente.');
      const restricted = classes.some(c => /wheelchair|selected/.test(c)) || call?.[7] === 'S' || call?.[8] === 'S';
      const available = call && seat.attr('alt') === '0' && classes.length === 1 && classes.every(c => freeClasses.has(c));
      result.push({ id, label: id, row, area: 'Sala', row_index: rowIndex, column_index: columnIndex,
        status: occupied ? 'occupied' : restricted ? 'unavailable' : available ? 'available' : 'unknown',
        provider_status: seat.attr('alt') ?? 'unknown', category: call?.[5], ...(classes.some(c => /wheelchair/.test(c)) ? { accessible: true } : {}) });
    });
  });
  if (result.length !== $('#mapcontent [id], #mapcontent [class$="-occupied"], #mapcontent .occupied:not([id])').length) throw new DataError('error', 'El mapa Cinex contiene asientos fuera de filas reconocidas.');
  if (!result.length) throw new EmptyCinexMap('unavailable', 'Cinex no devolvió asientos para esta función.');
  return validateSeats(result);
}
