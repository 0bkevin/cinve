// The two configured Cinepic venue sites and the purchase page each one
// serves: function data, tariffs and seat map in one Next.js response, read
// by ticket prices (providers/cinepic/adapter.ts) and seats (seats/).
import { load } from 'cheerio';
import { DataError, Id, requireArg, text } from '../../core.js';
import type { Query } from '../../core.js';
import type { ReadContext } from '../../http/read-context.js';
import { findField, flight, object, rows } from '../parsing.js';
import { flightPage } from '../read-policy.js';

export const CP = {
  '123300': { name: 'Cinepic Candelaria', host: 'https://cinepiccandelaria.com' },
  '123301': { name: 'Cinepic VVIP', host: 'https://cinepicvip.com' },
} as const;
/** One of the configured venue IDs. An own key only: `'constructor' in CP` is true too. */
const isCinepicVenue = (id: string): id is keyof typeof CP => Object.hasOwn(CP, id);
/** The configured name of a Cinepic venue, if it is one. */
export const cinepicVenueName = (id: string): string | undefined => isCinepicVenue(id) ? CP[id].name : undefined;
export function cpSite(q: Query) {
  const id = requireArg(q, 'cinema_id');
  if (!isCinepicVenue(id)) throw new DataError('unavailable', 'Cinepic supports the venues 123300 (Candelaria) and 123301 (VVIP Lido).');
  return { id, ...CP[id] };
}
/**
 * Tickets the purchase page still offers with a tariff, as its own JS counts
 * them: cupo (tot) minus sold (vend) minus held in open checkouts (temp).
 */
export function cinepicTicketsLeft(tariff: Record<string, unknown>): number | undefined {
  const count = (v: unknown) => /^\d+$/.test(text(v)) ? Number(text(v)) : NaN;
  const tot = count(tariff.tot), vend = count(tariff.vend), temp = count(tariff.temp);
  return [tot, vend, temp].every(Number.isSafeInteger) ? Math.max(0, tot - vend - temp) : undefined;
}

export async function cpBuy(q: Query, c: ReadContext) {
  const site = cpSite(q);
  const url = `${site.host}/es-AR/compra?${new URLSearchParams({ cid: requireArg(q, 'cinema_id'), fid: requireArg(q, 'session_id'), pid: requireArg(q, 'movie_id') })}`;
  const html = await c.get(url, 60000, flightPage), records = flight(html);
  const functionData = findField(records, 'functionData');
  if (functionData === undefined) {
    const $ = load(html); $('script,style').remove();
    if (/No pudimos mostrar la función/.test($.text()) && /\bAC-001\b/.test($.text())) throw new DataError('unavailable', 'Cinepic reports that it could not load the showtime (AC-001). Try again later.');
    // A movie_id from another film renders the page without function data;
    // that is a mismatched pair, not a provider format change.
    throw new DataError('unavailable', 'Cinepic did not return that showtime; use the session_id and movie_id of one showtime from get_showtimes.');
  }
  const f = object(functionData);
  const functions = rows(f.datos, 'functionData.datos');
  if (text(functions[0]?.id) !== q.session_id) throw new DataError('unavailable', 'The page does not match the requested showtime and movie.');
  // Cinepic serves a function under another film's movie_id; name the right pair instead of guessing.
  if (text(functions[0]?.codigo) !== q.movie_id) {
    const actual = Id.safeParse(text(functions[0]?.codigo));
    throw new DataError('unavailable', `That showtime is for another movie${actual.success ? ` (movie_id ${actual.data})` : ''}; use the session_id and movie_id of one showtime from get_showtimes.`);
  }
  return { records, f, url };
}
