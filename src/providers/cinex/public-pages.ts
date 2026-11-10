// Parsers for Cinex's public HTML: the billboard (cartelera.html), a film's
// synopsis page and a venue's calendar page, each read without an account.
import { load } from 'cheerio';
import { DataError, folded, Id, number } from '../../core.js';
import type { DataItem } from '../../core.js';
import { ReadContext } from '../../http/client.js';
import { decodeLabel } from '../parsing.js';
import { providerWarning, providerWarningSummary, warningLabel } from '../diagnostics.js';

export const CX = 'https://www.cinex.com.ve';
export function parseCinexMovies(html: string): DataItem[] {
  const $ = load(html), items = new Map<string, DataItem>();
  $('.poster[onclick]').each((_, e) => {
    const match = ($(e).attr('onclick') ?? '').match(/sinopsis-([a-zA-Z0-9._-]+)\.html/);
    if (!match || !Id.safeParse(match[1]).success) return;
    const name = decodeLabel($(e).attr('title') || $(e).attr('alt'));
    if (name) items.set(match[1], { kind: 'movie', id: match[1], name, url: `${CX}/sinopsis-${match[1]}.html` });
  });
  if (!items.size) throw new DataError('error', 'No se reconoció la cartelera HTML de Cinex.');
  return [...items.values()];
}
export function parseCinexShowtimes(html: string, movieId: string, date: string, c?: ReadContext): DataItem[] {
  const $ = load(html);
  const title = decodeLabel($('h1').first().text() || movieId);
  // "<strong>Censura: </strong>C", the film's age rating.
  const ratingItem = $('li').filter((_, li) => /^Censura:/i.test($(li).find('strong').first().text().trim())).first();
  const rating = decodeLabel(ratingItem.text().replace(/^\s*Censura:\s*/i, '')).slice(0, 20) || undefined;
  const nodes = $('[onclick*="checkLogin("]');
  if (!nodes.length) throw new DataError('unavailable', 'La ficha Cinex no contiene funciones reconocibles.');
  let malformed = 0;
  // Read every date on the page first: a session ID reported on two dates is
  // as contradictory as one reported at two times, and filtering by the
  // requested date first would hide the other occurrence.
  const occurrences = new Map<string, DataItem[]>();
  nodes.each((_, e) => {
    const match = ($(e).attr('onclick') ?? '').match(/checkLogin\('([^']+)','([^']+)'\)/);
    const epoch = number($(e).attr('alt'));
    if (!match || epoch === undefined || !Number.isInteger(epoch) || epoch < 1e9 || epoch > 1e11) { malformed++; return; }
    const local = new Date(epoch * 1000 - 4 * 3600000).toISOString().slice(0, 19);
    const readable = $(e).clone(); readable.find('br').replaceWith('\n');
    // Same button layout as the venue page.
    const details = cinexSessionDetails(readable.text(), $(e).find('img.icoIdioma').attr('src'));
    const key = `${match[2]}:${match[1]}`;
    const list = occurrences.get(key) ?? []; occurrences.set(key, list);
    list.push({ kind: 'showtime', id: match[1], name: title,
      movie_id: movieId, cinema_id: match[2], date: local.slice(0, 10), time: local.slice(11, 16), starts_at: `${local}-04:00`, rating, ...details,
      url: `${CX}/sinopsis-${movieId}.html` });
  });
  const items: DataItem[] = [];
  for (const list of occurrences.values()) {
    if (!list.some(item => item.date === date)) continue;
    if (list.some(item => cinexSessionConflict(list[0], item))) {
      if (c) { c.partial = true; providerWarning(c, 'cinex-movie-conflict', () => `Cinex devolvió horarios contradictorios para la función ${warningLabel(list[0].id)}; se omitió.`); }
      continue;
    }
    items.push(list[0]);
  }
  if (malformed && c) {
    c.partial = true;
    providerWarning(c, 'cinex-movie-malformed-session', 'Cinex devolvió una o más funciones de película con epoch o identificador malformado; se omitieron.');
  }
  if (c) providerWarningSummary(c);
  return items;
}

/** The same session ID with another film, date, time or room cannot drive a price or seat lookup. */
function cinexSessionConflict(a: DataItem, b: DataItem) {
  // starts_at keeps the provider's seconds; time is rounded to the minute.
  return a.movie_id !== b.movie_id || a.date !== b.date || a.time !== b.time || a.starts_at !== b.starts_at || (a.screen ?? null) !== (b.screen ?? null);
}

/**
 * Room, version and format of one Cinex session button. Its text is the room
 * line ("Sala 3", "Sala VIP", "VIP (Piso 5)") then the time; its icon gives
 * the version: xes (Spanish, dubbed), xen, xsub (subtitled) or a format such
 * as x4DX, which then says nothing about the language.
 */
export function cinexSessionDetails(text: string, icon?: string): Pick<DataItem, 'screen' | 'language' | 'format'> {
  const lines = text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const at = lines.findIndex(line => /^\d{1,2}:\d{2}\s*(?:am|pm)?$/i.test(line));
  // The line before the time; without a time line, only an explicit "Sala ...".
  const line = at > 0 ? lines[at - 1] : lines.find(l => /^Sala\s+\S/i.test(l));
  const room = line?.replace(/^Sala\s+/i, '');
  const screen = room && room.length <= 40 ? room : undefined;
  const code = icon?.split(/[/?#]/).pop()?.toLowerCase().match(/^x?([a-z0-9]+)(?:[._-]|$)/)?.[1];
  if (code === 'es' || code === 'en') return { screen, language: code };
  if (code === 'sub') return { screen, language: 'subtitulada' };
  if (code && /^(?:2d|3d|4dx|imax|screenx)$/.test(code)) return { screen, format: code.toUpperCase() };
  return { screen };
}

const cinexMovieTitle = (name: string) => folded(name).replace(/[^a-z0-9]/g, '');

/** Parse the calendar-style cinema page, whose blocks have titles but no movie slugs. */
export function parseCinexCinemaShowtimes(html: string, movies: DataItem[], cinemaId: string, date: string, c: ReadContext, url: string, cinemaName?: string): DataItem[] {
  if (!Id.safeParse(cinemaId).success) throw new DataError('error', 'Código de sede Cinex inválido.');
  const byTitle = new Map<string, DataItem[]>();
  for (const movie of movies) {
    const key = cinexMovieTitle(movie.name);
    const list = byTitle.get(key) ?? []; list.push(movie); byTitle.set(key, list);
  }
  const $ = load(html), items = new Map<string, DataItem>();
  const suppressed = new Set<string>();
  let blocks = 0, nodes = 0;
  const sessionCall = /checkLogin\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i;
  // A session ID must have one film, start and room across the whole page,
  // not only within the requested date: compare every occurrence first.
  const identities = new Map<string, string>(), contradictory = new Set<string>();
  $('.sessionslist').each((_, block) => {
    const blockTitle = cinexMovieTitle(decodeLabel($(block).find('h5.title').first().text()));
    $(block).find('[onclick*="checkLogin("]').each((_, e) => {
      const match = ($(e).attr('onclick') ?? '').match(sessionCall), epoch = number($(e).attr('alt'));
      if (!match || match[2] !== cinemaId || epoch === undefined || !Number.isInteger(epoch)) return;
      const readable = $(e).clone(); readable.find('br').replaceWith('\n');
      const identity = JSON.stringify([blockTitle, epoch, readable.text().match(/Sala\s+([A-Za-z0-9_-]+)/i)?.[1] ?? null]);
      const key = `${cinemaId}:${match[1]}`, previous = identities.get(key);
      if (previous === undefined) identities.set(key, identity); else if (previous !== identity) contradictory.add(key);
    });
  });
  $('.sessionslist').each((_, block) => {
    blocks++;
    const title = decodeLabel($(block).find('h5.title').first().text());
    // "Censura: <b>B</b>", the venue's age rating for this film.
    const rating = decodeLabel($(block).find('.movieinforow3 b').first().text()).slice(0, 20) || undefined;
    const sessionNodes = $(block).find('[onclick*="checkLogin("]');
    nodes += sessionNodes.length;
    if (!sessionNodes.length) return;
    const validEpochNodes = sessionNodes.filter((_, e) => {
      const epoch = number($(e).attr('alt'));
      return epoch !== undefined && Number.isInteger(epoch) && epoch >= 1e9 && epoch <= 1e11;
    });
    if (validEpochNodes.length !== sessionNodes.length) {
      c.partial = true;
      providerWarning(c, 'cinex-cinema-malformed-epoch', 'Cinex devolvió una o más funciones de sede con hora epoch ausente o malformada; se omitieron.');
    }
    const datedNodes = validEpochNodes.filter((_, e) => new Date(number($(e).attr('alt'))! * 1000 - 4 * 3600000).toISOString().slice(0, 10) === date);
    // Do not report a missing catalog match for a different commercial date
    // present in the same multi-day cinema page.
    if (!datedNodes.length) {
      return;
    }
    const matches = title ? (byTitle.get(cinexMovieTitle(title)) ?? []) : [];
    if (matches.length !== 1) {
      c.partial = true;
      providerWarning(c, !title ? 'cinex-cinema-missing-title' : matches.length > 1 ? 'cinex-cinema-ambiguous-title' : 'cinex-cinema-unknown-title', () => !title
        ? 'Cinex devolvió una función sin título de película; se omitió porque no se puede confirmar su movie_id.'
        : matches.length > 1
          ? `Cinex devolvió una función con título ambiguo (${warningLabel(title)}); se omitió porque no se puede confirmar su movie_id.`
          : `Cinex no encontró el título de función en su catálogo (${warningLabel(title)}); se omitió porque no se puede confirmar su movie_id.`);
      return;
    }
    const movie = matches[0];
    datedNodes.each((_, e) => {
      const raw = $(e).attr('onclick') ?? '';
      const match = raw.match(/checkLogin\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i);
      const epoch = number($(e).attr('alt'));
      if (!match || epoch === undefined || !Number.isInteger(epoch) || epoch < 1e9 || epoch > 1e11) {
        c.partial = true; providerWarning(c, 'cinex-cinema-malformed-session', () => `Cinex omitió una función malformada de ${warningLabel(title || 'película sin título')}.`); return;
      }
      const sessionId = match[1], sourceCinema = match[2];
      if (!Id.safeParse(sessionId).success || sourceCinema !== cinemaId) {
        c.partial = true; providerWarning(c, 'cinex-cinema-invalid-id', () => `Cinex omitió una función con identificador de sede o sesión no verificable (${warningLabel(sessionId)}).`); return;
      }
      const local = new Date(epoch * 1000 - 4 * 3600000).toISOString().slice(0, 19);
      if (local.slice(0, 10) !== date) return;
      const readable = $(e).clone(); readable.find('br').replaceWith('\n');
      const item: DataItem = { kind: 'showtime', id: sessionId, name: movie.name, cinema_id: cinemaId, cinema_name: cinemaName, movie_id: movie.id,
        date, time: local.slice(11, 16), starts_at: `${local}-04:00`, rating,
        ...cinexSessionDetails(readable.text(), $(e).find('img.icoIdioma').attr('src')), url };
      const key = `${cinemaId}:${sessionId}`;
      if (suppressed.has(key)) return;
      const previous = items.get(key);
      if (contradictory.has(key) || (previous && cinexSessionConflict(previous, item))) {
        c.partial = true; providerWarning(c, 'cinex-cinema-conflict', () => `Cinex devolvió horarios contradictorios para la función ${warningLabel(sessionId)}; se omitió.`); items.delete(key); suppressed.add(key); return;
      }
      items.set(key, item);
    });
  });
  if (!blocks) throw new DataError('error', 'No se reconoció la estructura de funciones de Cinex.');
  if (!nodes) providerWarning(c, 'cinex-cinema-no-sessions', 'Cinex no devolvió funciones para la fecha solicitada.');
  providerWarningSummary(c);
  return [...items.values()];
}
