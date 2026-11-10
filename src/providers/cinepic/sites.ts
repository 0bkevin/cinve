// The two configured Cinepic venue sites and the purchase page each one
// serves: function data, tariffs and seat map in one Next.js response, read
// by ticket prices (providers/cinepic/adapter.ts) and seats (seats/).
import { load } from 'cheerio';
import { DataError, Id, requireArg, text } from '../../core.js';
import type { Query } from '../../core.js';
import type { ReadContext } from '../../http/client.js';
import { findField, flight, object, rows } from '../parsing.js';
import { flightPage } from '../read-policy.js';

export const CP = {
  '123300': { name: 'Cinepic Candelaria', host: 'https://cinepiccandelaria.com' },
  '123301': { name: 'Cinepic VVIP', host: 'https://cinepicvip.com' },
} as const;
/** The configured name of a Cinepic venue, if it is one. */
export const cinepicVenueName = (id: string): string | undefined => (CP as Record<string, { name: string }>)[id]?.name;
export function cpSite(q: Query) {
  const id = requireArg(q, 'cinema_id');
  if (!(id in CP)) throw new DataError('unavailable', 'Cinepic admite las sedes 123300 (Candelaria) y 123301 (VVIP Lido).');
  return CP[id as keyof typeof CP];
}
/**
 * Tickets the purchase page still offers with a tariff, as its own JS counts
 * them: cupo (tot) minus sold (vend) minus held in open checkouts (temp).
 */
export function cinepicTicketsLeft(tariff: Record<string, unknown>): number | undefined {
  const [tot, vend, temp] = [tariff.tot, tariff.vend, tariff.temp].map(v => /^\d+$/.test(text(v)) ? Number(text(v)) : NaN);
  return [tot, vend, temp].every(Number.isSafeInteger) ? Math.max(0, tot - vend - temp) : undefined;
}

export async function cpBuy(q: Query, c: ReadContext) {
  const site = cpSite(q);
  const url = `${site.host}/es-AR/compra?${new URLSearchParams({ cid: requireArg(q, 'cinema_id'), fid: requireArg(q, 'session_id'), pid: requireArg(q, 'movie_id') })}`;
  const html = await c.get(url, 60000, flightPage), records = flight(html);
  const functionData = findField(records, 'functionData');
  if (functionData === undefined) {
    const $ = load(html); $('script,style').remove();
    if (/No pudimos mostrar la función/.test($.text()) && /\bAC-001\b/.test($.text())) throw new DataError('unavailable', 'Cinepic informa que no pudo cargar la función (AC-001). Inténtalo nuevamente más tarde.');
    // A movie_id from another film renders the page without function data;
    // that is a mismatched pair, not a provider format change.
    throw new DataError('unavailable', 'Cinepic no devolvió esa función; usa session_id y movie_id de una misma función de get_showtimes.');
  }
  const f = object(functionData);
  const functions = rows(f.datos, 'functionData.datos');
  if (text(functions[0]?.id) !== q.session_id) throw new DataError('unavailable', 'La página no corresponde a la función y película solicitadas.');
  // Cinepic serves a function under another film's movie_id; name the right pair instead of guessing.
  if (text(functions[0]?.codigo) !== q.movie_id) {
    const actual = Id.safeParse(text(functions[0]?.codigo));
    throw new DataError('unavailable', `Esa función es de otra película${actual.success ? ` (movie_id ${actual.data})` : ''}; usa session_id y movie_id de una misma función de get_showtimes.`);
  }
  return { records, f, url };
}
