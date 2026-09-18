import { load } from 'cheerio';
import * as z from 'zod';
import { DataError, Id, Provider, Source, Status, requireArg, text } from './core.js';
import type { Query } from './core.js';
import { HttpClient, ReadContext } from './http.js';
import { cpBuy } from './providers.js';
import { findField, object, rows } from './parsers.js';

const label = z.string().min(1).max(40).regex(/^[\p{L}\p{N} _:.()-]+$/u);
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
  seats: z.array(Seat).max(10000), available: z.number().int().nonnegative(),
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
    if (positions.has(key) || ids.has(s.id)) throw new DataError('error', 'El mapa contiene posiciones o identificadores duplicados.');
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

export function renderSeats(seats: SeatData[]): string {
  const symbols = { available: 'O', occupied: 'X', unavailable: '-', unknown: '?' };
  const lines = ['O libre | X ocupado | - restringido/no disponible | ? desconocido', 'Coordenadas del proveedor; orientacion de pantalla no verificada.'];
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
      lines.push(Array.from({ length: maxColumn + 1 }, (_, col) => {
        const s = rowSeats.find(s => s.column_index === col);
        return (s ? `${s.label}${symbols[s.status]}` : '').padEnd(width);
      }).join('').trimEnd());
    }
  }
  return lines.join('\n');
}

export async function getSeatMap(http: HttpClient, q: Query): Promise<z.infer<typeof SeatResult>> {
  const result: z.infer<typeof SeatResult> = {
    provider: q.provider, cinema_id: requireArg(q, 'cinema_id'), session_id: requireArg(q, 'session_id'),
    status: 'unavailable', queried_at: new Date().toISOString(), timezone: 'America/Caracas',
    sources: [], warnings: [], seats: [], available: 0, occupied: 0, unavailable: 0, unknown: 0, total: 0, availability_complete: false, ascii: '',
  };
  const c = new ReadContext(http, true);
  try {
    if (q.provider === 'cinepic') {
      const { records, f } = await cpBuy(q, c);
      result.seats = parseCinepicSeats(findField(records, 'butacasData'));
      const count = Number(rows(f.datos, 'datos')[0]?.entradasDisponibles);
      if (Number.isFinite(count) && count !== result.seats.filter(s => s.status === 'available').length) c.warnings.push('El contador de entradas del proveedor difiere del mapa; se conserva el estado de cada butaca, sin prometer cupos de venta.');
      c.warnings.push('La disponibilidad de Cinepic depende también del tipo de entrada elegido. El campo seleccionada del proveedor no indica una reserva del usuario.');
    } else if (q.provider === 'cinesunidos') {
      const url = `https://www.cinesunidos.com/api/seats?${new URLSearchParams({ theaterId: result.cinema_id, showTimeId: result.session_id })}`;
      result.seats = parseCinesUnidosSeats(JSON.parse(await c.authenticated('cinesunidos', url)));
      c.warnings.push('Los estados especiales se muestran restringidos; verifica sus condiciones en la web del cine.');
    } else if (q.provider === 'cinex') {
      if ((await c.authenticated('cinex', 'https://www.cinex.com.ve/checklogin.php')).trim() !== 'on') throw new DataError('auth_required', 'La sesión Cinex expiró; conecta de nuevo tu cuenta.');
      await c.authenticated('cinex', `https://www.cinex.com.ve/boletosdev.php?${new URLSearchParams({ cinemaid: result.cinema_id, sessionid: result.session_id })}`);
      result.seats = parseCinexSeats(await c.authenticated('cinex', 'https://www.cinex.com.ve/asientosdev.php'), q);
      c.warnings.push('Cinex: mapa leído sin seleccionar boletos ni asientos. Las categorías especiales pueden requerir una tarifa específica.');
    } else {
      throw new DataError('unavailable', 'Consulta de asientos no implementada para este proveedor.');
    }
    result.available = result.seats.filter(s => s.status === 'available').length;
    result.occupied = result.seats.filter(s => s.status === 'occupied').length;
    result.unavailable = result.seats.filter(s => s.status === 'unavailable').length;
    result.unknown = result.seats.filter(s => s.status === 'unknown').length;
    result.total = result.seats.length;
    result.availability_complete = result.unknown === 0 && result.total > 0;
    if (result.unknown) c.warnings.push(`Mapa parcialmente interpretado por Cinve: ${result.unknown} asientos con estado desconocido (?). Los ${result.available} libres son únicamente los confirmados; cero libres confirmados no significa agotado.`);
    result.ascii = renderSeats(result.seats);
    result.status = 'available';
    c.warnings.push('Lectura sin reserva, sin caché local. La disponibilidad puede cambiar; confirma en la web antes de comprar.');
  } catch (e) {
    result.status = e instanceof DataError ? e.status : 'error';
    result.seats = []; result.available = 0; result.occupied = 0; result.unavailable = 0;
    result.unknown = 0; result.total = 0; result.availability_complete = false; result.ascii = '';
    c.warnings.push(e instanceof DataError ? e.message : 'No se pudo interpretar un mapa de asientos verificable.');
  }
  result.sources = c.sources; result.warnings = c.warnings;
  return SeatResult.parse(result);
}
