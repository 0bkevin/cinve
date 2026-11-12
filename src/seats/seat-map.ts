import * as z from 'zod';
import { DataError, requireArg, text } from '../core.js';
import type { Query } from '../core.js';
import { HttpClient } from '../http/client.js';
import { ReadContext } from '../http/read-context.js';
import type { CallOptions } from '../http/read-context.js';
import { cinepicTicketsLeft, cinepicVenueName, cpBuy } from '../providers/cinepic/sites.js';
import { supercinesSeatPage } from '../providers/supercines/adapter.js';
import { findField, object, rows } from '../providers/parsing.js';
import { SeatResult, seatLayout } from './schema.js';
import { cinepicBookableTypes, cinexRowShifts, cinexSeatOrderFields, clean, EmptyCinexMap, parseCinepicSeats, parseCinesUnidosSeats, parseCinesUnidosShowing, parseCinexSeats, parseCinexShowing, parseSupercinesSeats, showing } from './parsers.js';
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
      if (!tariffs) c.warnings.push('Cinepic did not send the fares of this showtime; the free seats could not be checked against the ticket types on sale.');
      else if (!tariffs.length) c.warnings.push('Cinepic listed no online fares for this showtime; the free seats could not be checked against the ticket types, and its website may not sell them.');
      else if (special) c.warnings.push(`${special} free seats of a special type are not sold with this showtime\'s fares; Cinepic\'s website shows them as unavailable.`);
      result.layout = seatLayout('cinepic', map);
      const fn = rows(f.datos, 'datos')[0], at = text(fn?.fecha).match(/ - (\d{2}):(\d{2})hs$/);
      result.showing = showing({ movie: clean(fn?.pelicula, 200), cinema_name: cinepicVenueName(result.cinema_id), screen: clean(fn?.sala, 60),
        date: /^\d{4}-\d{2}-\d{2}$/.test(text(fn?.fechaDate)) ? text(fn?.fechaDate) : undefined, time: at ? `${at[1]}:${at[2]}` : undefined });
      // The page sells a cupo per tariff, often below the free seats; report it as the page shows it.
      const free = result.seats.filter(s => s.status === 'available').length;
      // A long or missing tariff name only shortens the label; its counter still counts.
      const tariffName = (t: Record<string, unknown>) => { const v = Array.from(text(t.descripcion).replace(/\s+/g, ' ')); return v.length ? (v.length > 60 ? `${v.slice(0, 59).join('').trimEnd()}…` : v.join('')) : 'sin nombre'; };
      const left = (tariffs ?? []).map(t => [tariffName(t), cinepicTicketsLeft(t)] as const).filter((entry): entry is readonly [string, number] => entry[1] !== undefined);
      if (left.some(([, n]) => n < free)) c.warnings.push(`Cinepic\'s website offers online ${left.map(([name, n]) => `${n} ${name} tickets`).join(', ')}; it may sell fewer tickets than the ${free} free seats on the map.`);
      c.warnings.push('Cinepic availability also depends on the chosen ticket type. The provider\'s seleccionada field does not indicate a booking by the user.');
    } else if (q.provider === 'cinesunidos') {
      const url = `https://www.cinesunidos.com/api/seats?${new URLSearchParams({ theaterId: result.cinema_id, showTimeId: result.session_id })}`;
      // The film and venue for the image come from the session read ticket prices use, sent
      // alongside the seat read; the map never depends on it.
      const sessionUrl = `https://gateway.cinesunidos.com/tickets/www/theaters/${encodeURIComponent(result.cinema_id)}/sessions/${encodeURIComponent(result.session_id)}/`;
      const naming = c.authenticated('cinesunidos', sessionUrl).then(body => parseCinesUnidosShowing(JSON.parse(body), result.cinema_id, result.session_id)).catch(() => undefined);
      let data: unknown;
      try { data = JSON.parse(await c.authenticated('cinesunidos', url)); }
      catch (e) { await naming; if (e instanceof DataError) throw e; throw new DataError('error', 'Cines Unidos did not return a seat map in valid JSON.'); }
      const named = await naming;
      // A function it no longer sells online (already started, or sales closed) answers only
      // {"maxSeatsPerTransaction": 0}: no map to read, not a change in its format (seen 2026-11-11).
      const body = object(data);
      if (body.seats === undefined && (body.maxSeatsPerTransaction === 0 || body.maxSeatsPerTransaction === '0')) {
        throw new DataError('unavailable', 'Cines Unidos does not sell this showtime online (it may have started or its sales closed) and sent no seat map. Pick another showtime with get_showtimes.');
      }
      result.seats = parseCinesUnidosSeats(data);
      // Area descriptions read "SALA 8 - FULL"; only a room number shared by every area names the room.
      const rooms = new Set(rows(object(object(data).seats).areas, 'seats.areas').map(a => text(a.description).match(/^SALA\s+(\d{1,3})\b/i)?.[1]));
      result.showing = showing({ ...named, screen: rooms.size === 1 && [...rooms][0] ? `Sala ${[...rooms][0]}` : named?.screen });
      c.warnings.push('Special states are shown as restricted; check their conditions on the cinema\'s website.');
    } else if (q.provider === 'cinex') {
      if (!await c.cinexSessionActive()) throw new DataError('auth_required', 'The Cinex session expired; connect your account again.');
      // Cinex keeps the chosen function in its PHP session: select and read it as one step.
      // Checked in a browser on 2026-11-11: selecting the function on boletos.php is enough
      // for its seat page to draw the map, with no ticket chosen. Read the seat page its own
      // checkout leads to: boletos.php sends VIP functions on to the newer checkout
      // (boletosdev.php, followed by the client, whose form posts to boletos_datadev.php
      // and continues to asientosdev.php); every other room continues to asientos.php.
      // The two pages can differ for the same function (a VIP row only the newer one
      // draws), and asientosdev.php draws no grid for regular rooms. If the page chosen
      // draws no grid, the other one is read.
      // Found 2026-11-11: asientos.php draws a regular room's map only for an account
      // session that has opened an order at least once; a fresh login gets the page
      // without its grid. When neither page draws one for a regular room, Cinve opens a
      // one-ticket order on this function (as its ticket form would), reads the seat
      // page, and always resets the order with resetpurchase.php, the route Cinex itself
      // uses when the order's countdown ends. No seat is chosen and nothing is paid; the
      // session then draws maps directly, so this happens about once per login.
      const grid = (body: string) => /class\s*=\s*["']?[^"'>]*\browletter\b/i.test(body);
      let ordered = false;
      const html = await c.exclusive('cinex', async () => {
        const ticket = await c.authenticated('cinex', `https://www.cinex.com.ve/boletos.php?${new URLSearchParams({ cinemaid: result.cinema_id, sessionid: result.session_id })}`);
        const vip = /boletos_datadev\.php/.test(ticket);
        const pages = vip ? ['asientosdev.php', 'asientos.php'] : ['asientos.php', 'asientosdev.php'];
        const first = await c.authenticated('cinex', `https://www.cinex.com.ve/${pages[0]}`);
        if (grid(first)) return first;
        const second = await c.authenticated('cinex', `https://www.cinex.com.ve/${pages[1]}`);
        if (grid(second) || vip) return grid(second) ? second : first;
        const order = cinexSeatOrderFields(ticket);
        if (!order) return first;
        let seatPage = first;
        c.assertTimeForOrder();
        ordered = true;
        try {
          await c.cinexSeatOrder(order);
          seatPage = await c.authenticated('cinex', 'https://www.cinex.com.ve/asientos.php');
        } finally {
          // Always reset the order, even when opening it failed half way or the client cancelled the call.
          const closed = await c.closeAuthenticated('cinex', 'https://www.cinex.com.ve/resetpurchase.php');
          c.warnings.push(closed
            ? 'Cinex shows this room\'s map only inside an order: Cinve opened one for 1 ticket without choosing a seat, read the map and cancelled it at once. Nothing was booked or paid.'
            : 'Cinex did not confirm the cancellation of the 1-ticket order Cinve opened to read the map; it expires on its own when its countdown ends (about 10 minutes). No seat was chosen.');
        }
        return seatPage;
      });
      const page = parseCinexShowing(html);
      try {
        result.seats = parseCinexSeats(html, q);
        const shifts = cinexRowShifts(html);
        if (Object.keys(shifts).length) result.layout = { ...result.layout, row_shift: shifts };
      }
      catch (e) {
        // Neither seat page drew a grid; Cinex's own counter is still on the page.
        if (e instanceof EmptyCinexMap && page.available !== undefined) {
          throw new DataError('unavailable', `Cinex reports ${page.available} available seats for this showtime, but its website did not publish the seat map. Check the map at cinex.com.ve.`);
        }
        throw e;
      }
      result.showing = page.showing;
      // Seen 2026-11-05: the counter can lag the grid on the same page (seats just bought or held).
      const mapped = result.seats.filter(s => s.status === 'available').length;
      if (page.available !== undefined && page.available !== mapped) c.warnings.push(`Cinex\'s available-seat counter (${page.available}) differs from the map (${mapped} free); each seat\'s state on the map is kept.`);
      c.warnings.push(ordered ? 'Special categories may require a specific fare.' : 'Cinex: map read without selecting tickets or seats. Special categories may require a specific fare.');
    } else if (q.provider === 'supercines') {
      const page = await supercinesSeatPage(q, c);
      if (!page.cancelled) c.warnings.push('Supercines did not confirm that the purchase Cinve opened to read the map was cancelled; it expires on its own when its countdown (about 10 minutes) ends. No seat was chosen.');
      result.seats = parseSupercinesSeats(page.html, { cinemaId: result.cinema_id, date: page.date, time: page.time, movie: page.movie });
      result.showing = showing({ movie: clean(page.movie, 200), cinema_name: clean(page.venue, 120), date: page.date, time: page.time });
      c.warnings.push('Supercines shows its seat map only inside a purchase: Cinve opened one with a single ticket, chose no seat, read the map and cancelled it right away. Nothing was reserved or paid.');
      if (result.seats.some(s => s.provider_status === 'restringido')) c.warnings.push('Seats marked restricted are reserved for special tickets on Supercines\' website.');
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
    // Checked here, so a layout the schema refuses fails this lookup with a status instead of throwing.
    result.layout = SeatResult.shape.layout.parse(result.layout);
    result.ascii = renderSeats(seats, result.layout);
    result.status = 'available';
    c.warnings.push('Read without booking, without local cache. Availability may change; confirm on the website before buying.');
  } catch (e) {
    result.status = e instanceof DataError ? e.status : 'error';
    result.seats = []; result.showing = undefined; result.available = 0; result.occupied = 0; result.unavailable = 0;
    result.unknown = 0; result.total = 0; result.availability_complete = false; result.ascii = '';
    result.layout = seatLayout(q.provider);
    c.warnings.push(e instanceof DataError ? e.message : 'Could not interpret a verifiable seat map.');
  }
  result.sources = c.sources; result.warnings = c.warnings;
  return SeatResult.parse(result);
}
