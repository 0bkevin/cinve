import { load } from 'cheerio';
import { DataError, number, text } from './core.js';
import type { DataItem, Query } from './core.js';
import { object, requiredText, rows } from './parsers.js';

export function parseCinesUnidosPrices(value: unknown, q: Query, url: string): DataItem[] {
  return rows(value, 'ticket sessions').flatMap(s => {
    if (text(s.cinemaId) !== q.cinema_id || text(s.sessionId) !== q.session_id || (q.movie_id && text(s.scheduledFilmId) !== q.movie_id)) {
      throw new DataError('unavailable', 'Las tarifas no corresponden a la sede, función o película solicitadas.');
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

function bolivars(raw: string) {
  const value = raw.match(/Bs\.\s*([\d.]+,\d{2})/i)?.[1];
  return value ? Number(value.replaceAll('.', '').replace(',', '.')) : undefined;
}
export function parseCinexPrices(html: string, q: Query, url: string): DataItem[] {
  const $ = load(html), items: DataItem[] = [];
  if (/listado tickets no disp\.|error al obtener los boletos/i.test(html)) throw new DataError('unavailable', 'Cinex no ofrece boletos para esta función; puede haber comenzado o cerrado la venta.');
  $('#frmboletos input[id^=amount]').each((_, el) => {
    const field = $(el), id = field.attr('id')!.slice('amount'.length), row = field.closest('.row'), description = row.find('.col-md-8').first();
    const name = description.find('span').first().text().trim(), amount = number(field.attr('value'));
    const parts = description.clone(); parts.find('br').replaceWith('\n');
    const lines = parts.text().split('\n');
    const base = bolivars(lines.find(s => /Precio Boleto/i.test(s)) ?? '');
    const fees = bolivars(lines.find(s => /Otros Cargos/i.test(s)) ?? '');
    if (!name || amount === undefined || amount < 0 || base === undefined || fees === undefined || Math.abs(base + fees - amount) > 0.025) {
      throw new DataError('error', 'Cambió la estructura o la suma de tarifas Cinex.');
    }
    items.push({ kind: 'ticket_price', id, name, cinema_id: q.cinema_id, session_id: q.session_id,
      prices: [{ currency: 'VES', amount, basis: 'provider' }], final_total_verified: false,
      price_components: [{ name: 'Boleto', currency: 'VES', amount: base }, { name: 'Otros cargos', currency: 'VES', amount: fees }], url });
  });
  if (!items.length) throw new DataError('unavailable', 'Cinex no devolvió una estructura de tarifas reconocida.');
  return items;
}

export function parseCinexConcessions(html: string, q: Query, url: string): DataItem[] {
  const $ = load(html), items: DataItem[] = [];
  $('#frmconcesiones .itemstyle').each((_, el) => {
    const card = $(el), id = card.attr('id')?.match(/^item(\d+)$/)?.[1];
    if (!id) return;
    const name = card.find(`[id="nombreitem${id}"]`).text().trim();
    const visible = bolivars(card.find(`[id="precioitemref${id}"]`).text());
    const overlay = $(`[id="overlaycombofather${id}"]`);
    const field = card.find(`[id="amount${id}"]`).length ? card.find(`[id="amount${id}"]`) : overlay.find(`[id="amount${id}"]`);
    const amount = number(field.attr('value')) ?? visible;
    if (!name || (amount !== undefined && (amount < 0 || (visible !== undefined && Math.abs(amount - visible) > 0.015)))) throw new DataError('error', 'Cambió la estructura o moneda de caramelería Cinex.');
    if (visible === undefined && !overlay.length && field.length) throw new DataError('error', 'Moneda de caramelería Cinex no reconocida.');
    const src = card.find('img').first().attr('src');
    items.push({ kind: 'concession', id, name, cinema_id: q.cinema_id,
      prices: amount === undefined ? [] : [{ currency: 'VES', amount, basis: 'provider' }], final_total_verified: false,
      options_required: overlay.length > 0 || card.find('input[type=radio]').length > 0,
      image_url: src ? new URL(src, url).href : undefined, url });
  });
  if (!items.length) throw new DataError('unavailable', 'Cinex no devolvió un catálogo de caramelería reconocido.');
  return items;
}
