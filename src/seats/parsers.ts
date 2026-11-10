// Each provider's seat map, read into one Seat list with four states. Only a
// seat the provider marks free becomes available; anything unrecognised stays
// unknown, never free.
import { load } from 'cheerio';
import * as z from 'zod';
import { DataError, text } from '../core.js';
import type { Query } from '../core.js';
import { object, rows } from '../providers/parsing.js';
import { Seat } from './schema.js';
import type { SeatData, Showing } from './schema.js';

export const clean = (value: unknown, max: number) => {
  const v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return v && v.length <= max ? v : undefined;
};
/** Drops absent fields; undefined when nothing could be read. */
export function showing(fields: Showing): Showing | undefined {
  const kept = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Showing;
  return Object.keys(kept).length ? kept : undefined;
}

/** Cinex's seat page names its function in one line: "CINEX SAMBIL CHACAO | Sala 3 | Fecha: 05-11-2026 | Hora: 02:45pm | ... | Asientos disponibles: 154 asiento(s)". */
export function parseCinexShowing(html: string): { showing?: Showing; available?: number } {
  const $ = load(html);
  const line = $('div').filter((_, el) => $(el).children('b').filter((_, b) => /^Asientos disponibles:/.test($(b).text().trim())).length === 1).first().text();
  const parts = line.split('|').map(p => p.replace(/\s+/g, ' ').trim());
  const field = (name: string) => parts.find(p => p.startsWith(`${name}:`))?.slice(name.length + 1).trim();
  // Only real calendar dates and clock times: "31-02-2026" and "02:99pm" are dropped.
  const day = field('Fecha')?.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const date = day && new Date(Date.UTC(Number(day[3]), Number(day[2]) - 1, Number(day[1]))).toISOString().startsWith(`${day[3]}-${day[2]}-${day[1]}`) ? day : undefined;
  const clock = field('Hora')?.match(/^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?$/i);
  const hour = clock && Number(clock[2]) <= 59 ? clock : undefined;
  const h = hour ? Number(hour[1]) % 12 + (hour[3].toLowerCase() === 'p' ? 12 : 0) : NaN;
  const count = field('Asientos disponibles')?.match(/^(\d+) asiento/);
  return {
    showing: showing({
      movie: clean($('#cinexasientodatalistzy .movie-details h3.title').first().text(), 200),
      cinema_name: parts.length > 2 && !parts[0].includes(':') ? clean(parts[0], 120) : undefined,
      screen: /^Sala\b/i.test(parts[1] ?? '') ? clean(parts[1], 60) : undefined,
      date: date ? `${date[3]}-${date[2]}-${date[1]}` : undefined,
      time: hour && Number(hour[1]) >= 1 && Number(hour[1]) <= 12 ? `${String(h).padStart(2, '0')}:${hour[2]}` : undefined,
    }),
    available: count ? Number(count[1]) : undefined,
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

export function parseCinepicSeats(data: unknown, bookable: Set<string> | 'all' = 'all'): SeatData[] {
  return validateSeats(rows(object(data).butacas, 'butacas').map(s => ({
    id: text(s.butaca), label: text(s.nombre_butaca), row: text(s.nombre_butaca).split(':')[0], area: 'Sala',
    row_index: Number(s.fila) - 1, column_index: Number(s.columna) - 1,
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
      } as SeatData;
    }))));
}

/** The right function's page arrived with an empty grid. */
export class EmptyCinexMap extends DataError {}

export function parseCinexSeats(html: string, q: Query): SeatData[] {
  const $ = load(html);
  // Cinex stores the chosen function in its PHP session. Check the back link
  // in the SAME response so parallel reads cannot return another function's map.
  const back = $('#btnasientosatras').attr('href');
  const url = back ? new URL(back, 'https://www.cinex.com.ve/') : undefined;
  if (!url || url.origin !== 'https://www.cinex.com.ve' || url.pathname !== '/boletosdev.php' ||
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
      const occupied = classes.some(c => /^(?:seat|seatestandar|seatvipbed|seatvipplus|seatvipstandar)-occupied$/.test(c));
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
      const available = call && seat.attr('alt') === '0' && classes.length === 1 && freeClasses.has(classes[0]);
      result.push({ id, label: id, row, area: 'Sala', row_index: rowIndex, column_index: columnIndex,
        status: occupied ? 'occupied' : restricted ? 'unavailable' : available ? 'available' : 'unknown',
        provider_status: seat.attr('alt') ?? 'unknown', category: call?.[5] });
    });
  });
  if (result.length !== $('#mapcontent [id], #mapcontent [class$="-occupied"]').length) throw new DataError('error', 'El mapa Cinex contiene asientos fuera de filas reconocidas.');
  if (!result.length) throw new EmptyCinexMap('unavailable', 'Cinex no devolvió asientos para esta función.');
  return validateSeats(result);
}
