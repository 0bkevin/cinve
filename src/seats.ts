import { load } from 'cheerio';
import * as z from 'zod';
import { DataError, Id, Provider, Source, Status, requireArg, text } from './core.js';
import type { Query } from './core.js';
import { HttpClient, ReadContext } from './http.js';
import type { CallOptions } from './http.js';
import { cinepicTicketsLeft, cinepicVenueName, cpBuy } from './providers.js';
import { findField, object, rows } from './parsers.js';

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
type SeatData = z.infer<typeof Seat>;
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
  }),
  showing: z.object({
    movie: z.string().max(200).optional(), cinema_name: z.string().max(120).optional(), screen: z.string().max(60).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }).optional().describe('La función según la misma respuesta del mapa (texto del proveedor), para rotular la imagen; los campos ausentes no se pudieron leer.'),
  ascii: z.string(),
});
export type SeatMapResult = z.infer<typeof SeatResult>;
type Layout = SeatMapResult['layout'];
type Showing = NonNullable<SeatMapResult['showing']>;
/**
 * Orientation as each provider's own seat page draws it (checked in their web
 * code on 2026-11-05): Cinepic puts the screen above row 1 and draws "invertida"
 * rooms right to left; Cines Unidos draws rows by index downwards with the
 * screen underneath. Cinex's seat page (read with a session on 2026-11-05)
 * draws its rows and seats in document order and no screen at all, so its
 * screen side is not claimed.
 */
export function seatLayout(provider: string, cinepicData?: unknown): Layout {
  if (provider === 'cinepic') {
    const first = Array.isArray(object(cinepicData).butacas) ? object((object(cinepicData).butacas as unknown[])[0]) : {};
    return { screen: 'top', column_order: text(first.invertida) === '1' ? 'descending' : 'ascending' };
  }
  if (provider === 'cinesunidos') return { screen: 'bottom', column_order: 'ascending' };
  return { screen: 'unverified', column_order: 'ascending' };
}

const clean = (value: unknown, max: number) => {
  const v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return v && v.length <= max ? v : undefined;
};
/** Drops absent fields; undefined when nothing could be read. */
function showing(fields: Showing): Showing | undefined {
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
  if (!result.length) throw new DataError('unavailable', 'Cinex no devolvió asientos para esta función.');
  return validateSeats(result);
}

export function renderSeats(seats: SeatData[], layout: Layout = { screen: 'unverified', column_order: 'ascending' }): string {
  const symbols = { available: 'O', occupied: 'X', unavailable: '-', unknown: '?' };
  const lines = ['O libre | X ocupado | - restringido/no disponible | ? desconocido',
    layout.screen === 'unverified' ? 'Filas y columnas como la web del proveedor, que no indica el lado de la pantalla.' : `Orientado como la web del proveedor: pantalla ${layout.screen === 'top' ? 'arriba' : 'abajo'}.`];
  const screen = '[ PANTALLA ]';
  if (layout.screen === 'top') lines.push(screen);
  let cells = 0;
  for (const area of [...new Set(seats.map(s => s.area))]) {
    const group = seats.filter(s => s.area === area);
    const width = Math.max(...group.map(s => s.label.length)) + 2;
    const maxColumn = Math.max(...group.map(s => s.column_index));
    cells += (maxColumn + 1) * (Math.max(...group.map(s => s.row_index)) + 1);
    if (cells > 40000) throw new DataError('unavailable', 'El mapa excede el tamaño máximo de representación ASCII.');
    lines.push(`Area ${area}`);
    for (let row = 0; row <= Math.max(...group.map(s => s.row_index)); row++) {
      const rowSeats = group.filter(s => s.row_index === row);
      if (!rowSeats.length) { lines.push(''); continue; }
      lines.push(Array.from({ length: maxColumn + 1 }, (_, shown) => {
        const col = layout.column_order === 'descending' ? maxColumn - shown : shown;
        const s = rowSeats.find(s => s.column_index === col);
        return (s ? `${s.label}${symbols[s.status]}` : '').padEnd(width);
      }).join('').trimEnd());
    }
  }
  if (layout.screen === 'bottom') lines.push(screen);
  return lines.join('\n');
}

export async function getSeatMap(http: HttpClient, q: Query, call?: CallOptions): Promise<z.infer<typeof SeatResult>> {
  const result: z.infer<typeof SeatResult> = {
    provider: q.provider, cinema_id: requireArg(q, 'cinema_id'), session_id: requireArg(q, 'session_id'),
    status: 'unavailable', queried_at: new Date().toISOString(), timezone: 'America/Caracas',
    sources: [], warnings: [], seats: [], available: 0, occupied: 0, unavailable: 0, unknown: 0, total: 0, availability_complete: false,
    layout: seatLayout(q.provider), ascii: '',
  };
  const c = new ReadContext(http, true, call);
  try {
    if (q.provider === 'cinepic') {
      const { records, f } = await cpBuy(q, c);
      const map = findField(records, 'butacasData');
      // Tariffs only refine the map: without a list the seat states still stand.
      const tariffs = Array.isArray(f.tarifas) ? f.tarifas.map(object) : undefined;
      result.seats = parseCinepicSeats(map, tariffs ? cinepicBookableTypes(tariffs) : 'all');
      const special = result.seats.filter(s => s.status === 'unavailable').length;
      if (!tariffs) c.warnings.push('Cinepic no envió las tarifas de esta función; las butacas libres no se pudieron cruzar con los tipos de entrada a la venta.');
      else if (!tariffs.length) c.warnings.push('Cinepic no listó tarifas en línea para esta función; las butacas libres no se pudieron cruzar con los tipos de entrada y puede que su web no las venda.');
      else if (special) c.warnings.push(`${special} butacas libres de un tipo especial no se venden con las tarifas de esta función; la web de Cinepic las muestra no disponibles.`);
      result.layout = seatLayout('cinepic', map);
      const fn = rows(f.datos, 'datos')[0], at = text(fn?.fecha).match(/ - (\d{2}):(\d{2})hs$/);
      result.showing = showing({ movie: clean(fn?.pelicula, 200), cinema_name: cinepicVenueName(result.cinema_id), screen: clean(fn?.sala, 60),
        date: /^\d{4}-\d{2}-\d{2}$/.test(text(fn?.fechaDate)) ? text(fn?.fechaDate) : undefined, time: at ? `${at[1]}:${at[2]}` : undefined });
      // The page sells a cupo per tariff, often below the free seats; report it as the page shows it.
      const free = result.seats.filter(s => s.status === 'available').length;
      const left = (tariffs ?? []).map(t => [clean(t.descripcion, 60), cinepicTicketsLeft(t)] as const).filter(([name, n]) => name && n !== undefined);
      if (left.some(([, n]) => n! < free)) c.warnings.push(`La web de Cinepic ofrece en línea ${left.map(([name, n]) => `${n} entradas ${name}`).join(', ')}; puede vender menos entradas que las ${free} butacas libres del mapa.`);
      c.warnings.push('La disponibilidad de Cinepic depende también del tipo de entrada elegido. El campo seleccionada del proveedor no indica una reserva del usuario.');
    } else if (q.provider === 'cinesunidos') {
      const url = `https://www.cinesunidos.com/api/seats?${new URLSearchParams({ theaterId: result.cinema_id, showTimeId: result.session_id })}`;
      const data = JSON.parse(await c.authenticated('cinesunidos', url));
      result.seats = parseCinesUnidosSeats(data);
      // Area descriptions read "SALA 8 - FULL"; only a room number shared by every area names the room.
      const rooms = new Set(rows(object(object(data).seats).areas, 'seats.areas').map(a => text(a.description).match(/^SALA\s+(\d{1,3})\b/i)?.[1]));
      if (rooms.size === 1 && [...rooms][0]) result.showing = { screen: `Sala ${[...rooms][0]}` };
      c.warnings.push('Los estados especiales se muestran restringidos; verifica sus condiciones en la web del cine.');
    } else if (q.provider === 'cinex') {
      if (!await c.cinexSessionActive()) throw new DataError('auth_required', 'La sesión Cinex expiró; conecta de nuevo tu cuenta.');
      // Cinex keeps the chosen function in its PHP session: select and read it as one step.
      const html = await c.exclusive('cinex', async () => {
        await c.authenticated('cinex', `https://www.cinex.com.ve/boletosdev.php?${new URLSearchParams({ cinemaid: result.cinema_id, sessionid: result.session_id })}`);
        return c.authenticated('cinex', 'https://www.cinex.com.ve/asientosdev.php');
      });
      result.seats = parseCinexSeats(html, q);
      const page = parseCinexShowing(html);
      result.showing = page.showing;
      if (page.available !== undefined && page.available !== result.seats.filter(s => s.status === 'available').length) c.warnings.push('El contador de asientos disponibles de Cinex difiere del mapa; se conserva el estado de cada asiento.');
      c.warnings.push('Cinex: mapa leído sin seleccionar boletos ni asientos. Las categorías especiales pueden requerir una tarifa específica.');
    } else {
      throw new DataError('unavailable', 'Consulta de asientos no implementada para este proveedor.');
    }
    const seats = result.seats ?? [];
    result.available = seats.filter(s => s.status === 'available').length;
    result.occupied = seats.filter(s => s.status === 'occupied').length;
    result.unavailable = seats.filter(s => s.status === 'unavailable').length;
    result.unknown = seats.filter(s => s.status === 'unknown').length;
    result.total = seats.length;
    result.availability_complete = result.unknown === 0 && result.total > 0;
    if (result.unknown) c.warnings.push(`Mapa parcialmente interpretado por Cinve: ${result.unknown} asientos con estado desconocido (?). Los ${result.available} libres son únicamente los confirmados; cero libres confirmados no significa agotado.`);
    result.ascii = renderSeats(seats, result.layout);
    result.status = 'available';
    c.warnings.push('Lectura sin reserva, sin caché local. La disponibilidad puede cambiar; confirma en la web antes de comprar.');
  } catch (e) {
    result.status = e instanceof DataError ? e.status : 'error';
    result.seats = []; result.showing = undefined; result.available = 0; result.occupied = 0; result.unavailable = 0;
    result.unknown = 0; result.total = 0; result.availability_complete = false; result.ascii = '';
    c.warnings.push(e instanceof DataError ? e.message : 'No se pudo interpretar un mapa de asientos verificable.');
  }
  result.sources = c.sources; result.warnings = c.warnings;
  return SeatResult.parse(result);
}
