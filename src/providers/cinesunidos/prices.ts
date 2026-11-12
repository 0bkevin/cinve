import { DataError, number, text } from '../../core.js';
import type { DataItem, Query } from '../../core.js';
import { object, requiredText, rows } from '../parsing.js';

/** Ticket types and prices of one function, from the authenticated tickets API. */
export function parseCinesUnidosPrices(value: unknown, q: Query, url: string): DataItem[] {
  return rows(value, 'ticket sessions').flatMap(s => {
    if (text(s.cinemaId) !== q.cinema_id || text(s.sessionId) !== q.session_id || (q.movie_id && text(s.scheduledFilmId) !== q.movie_id)) {
      throw new DataError('unavailable', 'The prices do not match the requested venue, showtime or movie.');
    }
    return rows(s.tickets, 'tickets').map(t => {
      const p = object(t.price), prices: NonNullable<DataItem['prices']> = [];
      // The UI passes refPrice as USD and total as VES into formatCurrency.
      for (const [key, currency] of [['refPrice', 'USD'], ['total', 'VES']] as const) {
        const amount = number(p[key]); if (amount !== undefined && amount >= 0) prices.push({ currency, amount, basis: 'provider' });
      }
      return { kind: 'ticket_price', id: `${requiredText(t, 'ticketTypeCode')}:${requiredText(t, 'areaCategoryCode')}`,
        name: requiredText(t, 'description'), cinema_id: q.cinema_id, session_id: q.session_id, movie_id: text(s.scheduledFilmId),
        prices, provider_conversion_rate: number(p.exchangeRate), final_total_verified: false,
        redemption_only: typeof t.redemptionOnly === 'boolean' ? t.redemptionOnly : undefined,
        child_only: typeof t.isChildOnlyTicket === 'boolean' ? t.isChildOnlyTicket : undefined,
        sales_allowed: typeof s.allowTicketSales === 'boolean' ? s.allowTicketSales : undefined,
        area_category_code: text(t.areaCategoryCode), screen: text(s.screenName), format: text(s.format), language: text(s.language), url };
    });
  });
}
