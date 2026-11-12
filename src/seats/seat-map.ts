import * as z from 'zod';
import { DataError, requireArg, text } from '../core.js';
import type { Query } from '../core.js';
import { HttpClient } from '../http/client.js';
import { ReadContext } from '../http/read-context.js';
import type { CallOptions } from '../http/read-context.js';
import { cinepicTicketsLeft, cinepicVenueName, cpBuy } from '../providers/cinepic/sites.js';
import { findField, object, rows } from '../providers/parsing.js';
import { SeatResult, seatLayout } from './schema.js';
import { clean, cinepicBookableTypes, cinexRowShifts, EmptyCinexMap, parseCinepicSeats, parseCinesUnidosSeats, parseCinexSeats, parseCinexShowing, showing } from './parsers.js';
import { renderSeats } from './ascii.js';

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
      // A long or missing tariff name only shortens the label; its counter still counts.
      const tariffName = (t: Record<string, unknown>) => { const v = Array.from(text(t.descripcion).replace(/\s+/g, ' ')); return v.length ? (v.length > 60 ? `${v.slice(0, 59).join('').trimEnd()}…` : v.join('')) : 'sin nombre'; };
      const left = (tariffs ?? []).map(t => [tariffName(t), cinepicTicketsLeft(t)] as const).filter((entry): entry is readonly [string, number] => entry[1] !== undefined);
      if (left.some(([, n]) => n < free)) c.warnings.push(`La web de Cinepic ofrece en línea ${left.map(([name, n]) => `${n} entradas ${name}`).join(', ')}; puede vender menos entradas que las ${free} butacas libres del mapa.`);
      c.warnings.push('La disponibilidad de Cinepic depende también del tipo de entrada elegido. El campo seleccionada del proveedor no indica una reserva del usuario.');
    } else if (q.provider === 'cinesunidos') {
      const url = `https://www.cinesunidos.com/api/seats?${new URLSearchParams({ theaterId: result.cinema_id, showTimeId: result.session_id })}`;
      let data: unknown;
      try { data = JSON.parse(await c.authenticated('cinesunidos', url)); }
      catch (e) { if (e instanceof DataError) throw e; throw new DataError('error', 'Cines Unidos no devolvió un mapa de asientos en JSON válido.'); }
      // A function it no longer sells online (already started, or sales closed) answers only
      // {"maxSeatsPerTransaction": 0}: no map to read, not a change in its format (seen 2026-11-11).
      const body = object(data);
      if (body.seats === undefined && Number(body.maxSeatsPerTransaction) === 0) {
        throw new DataError('unavailable', 'Cines Unidos no vende en línea esta función (puede haber comenzado o cerrado su venta) y no envió el mapa de asientos. Elige otra función con get_showtimes.');
      }
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
      const page = parseCinexShowing(html);
      try {
        result.seats = parseCinexSeats(html, q);
        const shifts = cinexRowShifts(html);
        if (Object.keys(shifts).length) result.layout = { ...result.layout, row_shift: shifts };
      }
      catch (e) {
        // Seen 2026-11-05: for many functions Cinex sends the grid only after tickets are
        // chosen (boletos_datadev.php, which starts a timed order). Cinve never does that,
        // since it would hold tickets; Cinex's own counter is still on the page.
        if (e instanceof EmptyCinexMap && page.available !== undefined) {
          throw new DataError('unavailable', `Cinex informa ${page.available} asientos disponibles en esta función, pero no envió el mapa: su web solo lo muestra después de elegir boletos, y Cinve no los elige porque eso los retiene. Consulta el mapa en cinex.com.ve.`);
        }
        throw e;
      }
      result.showing = page.showing;
      // Seen 2026-11-05: the counter can lag the grid on the same page (seats just bought or held).
      const mapped = result.seats.filter(s => s.status === 'available').length;
      if (page.available !== undefined && page.available !== mapped) c.warnings.push(`El contador de asientos disponibles de Cinex (${page.available}) difiere del mapa (${mapped} libres); se conserva el estado de cada asiento del mapa.`);
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
