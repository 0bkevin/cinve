import { load } from 'cheerio';
import { DataError, number, text } from './core.js';
import type { DataItem, Query } from './core.js';

/** "Bs. 21.477,36", and whole amounts such as the "Bs. 0" of a membership ticket. */
function bolivars(raw: string) {
  const value = raw.match(/Bs\.\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)(?![\d.,])/i)?.[1];
  return value ? Number(value.replaceAll('.', '').replace(',', '.')) : undefined;
}
/** Cinex's own notice when a venue's online sales are switched off. */
const salesClosed = (html: string, what: 'boletos' | 'dulceria') =>
  new RegExp(what === 'boletos' ? 'la compra de boletos en este complejo no est[aá] disponible' : 'la venta de dulcer[ií]a web para este complejo no est[aá] disponible', 'i').test(html);
export function parseCinexPrices(html: string, q: Query, url: string): DataItem[] {
  const $ = load(html), items: DataItem[] = [];
  if (/listado tickets no disp\.|error al obtener los boletos/i.test(html)) throw new DataError('unavailable', 'Cinex no ofrece boletos para esta función; puede haber comenzado o cerrado la venta.');
  if (salesClosed(html, 'boletos')) throw new DataError('unavailable', 'Cinex indica que la compra de boletos en línea en esta sede no está disponible en este momento.');
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
    // Account perks ("1 entrada gratis VIP al mes") carry their remaining quota.
    const quota = lines.map(s => s.match(/Total disponible:\s*(\d+)/i)?.[1]).find(Boolean);
    items.push({ kind: 'ticket_price', id, name, cinema_id: q.cinema_id, session_id: q.session_id,
      prices: [{ currency: 'VES', amount, basis: 'provider' }], final_total_verified: false,
      price_components: [{ name: 'Boleto', currency: 'VES', amount: base }, { name: 'Otros cargos', currency: 'VES', amount: fees }], url,
      ...(quota !== undefined ? { redemption_only: true, tickets_available: Number(quota) } : {}) });
  });
  if (!items.length) throw new DataError('unavailable', 'Cinex no devolvió una estructura de tarifas reconocida.');
  return items;
}

export function parseCinexConcessions(html: string, q: Query, url: string): DataItem[] {
  const $ = load(html), items: DataItem[] = [];
  if (salesClosed(html, 'dulceria')) throw new DataError('unavailable', 'Cinex indica que la venta de caramelería en línea en esta sede no está disponible en este momento.');
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
