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
        // Only ordinary status 0 is presented as freely available. Special
        // selectable seats (7) retain their raw code, without assuming eligibility.
        status: status === '0' ? 'available' : ['1', '2'].includes(status) ? 'occupied' : ['3', '4', '5', '6', '7'].includes(status) ? 'unavailable' : 'unknown',
        provider_status: status, category: text(a.areaCategoryCode),
      } as SeatData;
    }))));
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
    sources: [], warnings: [], seats: [], available: 0, ascii: '',
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
    } else {
      throw new DataError('unavailable', q.provider === 'cinex'
        ? 'Cinex no entregó un mapa verificable mediante consultas de lectura. Consulta los asientos en su web; no se crean reservas para obtenerlos.'
        : 'Consulta de asientos no implementada para este proveedor.');
    }
    result.available = result.seats.filter(s => s.status === 'available').length;
    result.ascii = renderSeats(result.seats);
    result.status = 'available';
    c.warnings.push('Lectura sin reserva, sin caché local. La disponibilidad puede cambiar; confirma en la web antes de comprar.');
  } catch (e) {
    result.status = e instanceof DataError ? e.status : 'error';
    result.seats = []; result.available = 0; result.ascii = '';
    c.warnings.push(e instanceof DataError ? e.message : 'No se pudo interpretar un mapa de asientos verificable.');
  }
  result.sources = c.sources; result.warnings = c.warnings;
  return SeatResult.parse(result);
}
