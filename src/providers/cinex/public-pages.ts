// Parsers for Cinex's public HTML: the billboard (cartelera.html), a film's
// synopsis page and a venue's calendar page, each read without an account.
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { DataError, folded, group, Id, number } from '../../core.js';
import type { DataItem } from '../../core.js';
import { ReadContext } from '../../http/read-context.js';
import { decodeLabel } from '../parsing.js';
import { providerWarning, providerWarningSummary, warningLabel } from '../diagnostics.js';

export const CX = 'https://www.cinex.com.ve';
export function parseCinexMovies(html: string): DataItem[] {
  const $ = load(html), items = new Map<string, DataItem>();
  $('.poster[onclick]').each((_, e) => {
    const id = ($(e).attr('onclick') ?? '').match(/sinopsis-([a-zA-Z0-9._-]+)\.html/)?.[1];
    if (!id || !Id.safeParse(id).success) return;
    const name = decodeLabel($(e).attr('title') || $(e).attr('alt'));
    if (name) items.set(id, { kind: 'movie', id, name, url: `${CX}/sinopsis-${id}.html` });
  });
  if (!items.size) throw new DataError('error', 'Unrecognized Cinex HTML listings.');
  return [...items.values()];
}
export function parseCinexShowtimes(html: string, movieId: string, date: string, c?: ReadContext): DataItem[] {
  const $ = load(html);
  const title = decodeLabel($('h1').first().text() || movieId);
  // "<strong>Censura: </strong>C", the film's age rating.
  const ratingItem = $('li').filter((_, li) => /^Censura:/i.test($(li).find('strong').first().text().trim())).first();
  const rating = decodeLabel(ratingItem.text().replace(/^\s*Censura:\s*/i, '')).slice(0, 20) || undefined;
  const nodes = $('[onclick*="checkLogin("]');
  if (!nodes.length) throw new DataError('unavailable', 'The Cinex movie page contains no recognizable showtimes.');
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
    const sessionId = group(match, 1), cinemaId = group(match, 2), key = `${cinemaId}:${sessionId}`;
    const list = occurrences.get(key) ?? []; occurrences.set(key, list);
    list.push({ kind: 'showtime', id: sessionId, name: title,
      movie_id: movieId, cinema_id: cinemaId, date: local.slice(0, 10), time: local.slice(11, 16), starts_at: `${local}-04:00`, rating, ...details,
      url: `${CX}/sinopsis-${movieId}.html` });
  });
  const items: DataItem[] = [];
  for (const list of occurrences.values()) {
    const [first] = list;
    if (!first || !list.some(item => item.date === date)) continue;
    if (list.some(item => cinexSessionConflict(first, item))) {
      if (c) { c.partial = true; providerWarning(c, 'cinex-movie-conflict', () => `Cinex returned contradictory times for showtime ${warningLabel(first.id)}; it was omitted.`); }
      continue;
    }
    items.push(first);
  }
  if (malformed && c) {
    c.partial = true;
    providerWarning(c, 'cinex-movie-malformed-session', 'Cinex returned one or more movie showtimes with a malformed epoch or identifier; they were omitted.');
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
  if (!Id.safeParse(cinemaId).success) throw new DataError('error', 'Invalid Cinex venue code.');
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
  const tabDates = cinexTabDates($);
  let boxOffice = 0;
  $('.sessionslist').each((_, block) => {
    blocks++;
    const title = decodeLabel($(block).find('h5.title').first().text());
    // "Censura: <b>B</b>", the venue's age rating for this film.
    const rating = decodeLabel($(block).find('.movieinforow3 b').first().text()).slice(0, 20) || undefined;
    const sessionNodes = $(block).find('[onclick*="checkLogin("]');
    // Venues that sell only at the box office (most outside Caracas, seen 2026-11-12)
    // list their functions without checkLogin, session ID or epoch; only the
    // date tab of the block's page dates them.
    const boxNodes = $(block).find('.cinemasessionpos').filter((_, e) => !($(e).attr('onclick') ?? '').includes('checkLogin(') && /solo\s+por\s+taquilla/i.test($(e).attr('title') ?? ''));
    nodes += sessionNodes.length + boxNodes.length;
    if (boxNodes.length) {
      const page = /^pagedate(\d+)$/.exec($(block).closest('[id^="pagedate"]').attr('id') ?? '')?.[1];
      const pageDate = page === undefined ? undefined : tabDates.get(Number(page));
      if (!pageDate) {
        c.partial = true;
        providerWarning(c, 'cinex-box-office-undated', 'Cinex listed box-office-only showtimes whose date could not be confirmed; they were omitted.');
      } else if (pageDate === date) {
        const matches = title ? (byTitle.get(cinexMovieTitle(title)) ?? []) : [];
        const movie = matches.length === 1 ? matches[0] : undefined;
        if (!movie) {
          c.partial = true;
          providerWarning(c, 'cinex-box-office-unknown-title', () => `Cinex listed a box-office-only showtime whose title is not in its catalog (${warningLabel(title || 'untitled movie')}); it was omitted because its movie_id cannot be confirmed.`);
        } else boxNodes.each((_, e) => {
          const readable = $(e).clone(); readable.find('br').replaceWith('\n');
          const text = readable.text();
          const time = cinexClock(text);
          if (!time) { c.partial = true; providerWarning(c, 'cinex-box-office-malformed', () => `Cinex omitted a box-office-only showtime of ${warningLabel(title)} without a readable time.`); return; }
          const details = cinexSessionDetails(text, $(e).find('img.icoIdioma').attr('src'));
          // Cinex publishes no ID for these functions. This one identifies the listing
          // (venue, date, time, room, film) so repeated reads agree; it does not exist
          // upstream and cannot be used for prices or seats.
          const id = `${cinexBoxOfficePrefix}${createHash('sha256').update(JSON.stringify([cinemaId, date, time, details.screen ?? null, movie.id])).digest('hex').slice(0, 20)}`;
          boxOffice++;
          items.set(`${cinemaId}:${id}`, { kind: 'showtime', id, name: movie.name, cinema_id: cinemaId, cinema_name: cinemaName, movie_id: movie.id,
            date, time, starts_at: `${date}T${time}:00-04:00`, rating, ...details, url });
        });
      }
    }
    if (!sessionNodes.length) return;
    const validEpoch = (alt: string | undefined) => {
      const epoch = number(alt);
      return epoch !== undefined && Number.isInteger(epoch) && epoch >= 1e9 && epoch <= 1e11 ? epoch : undefined;
    };
    const validEpochNodes = sessionNodes.filter((_, e) => validEpoch($(e).attr('alt')) !== undefined);
    if (validEpochNodes.length !== sessionNodes.length) {
      c.partial = true;
      providerWarning(c, 'cinex-cinema-malformed-epoch', 'Cinex returned one or more venue showtimes with a missing or malformed epoch time; they were omitted.');
    }
    const datedNodes = validEpochNodes.filter((_, e) => {
      const epoch = validEpoch($(e).attr('alt'));
      return epoch !== undefined && new Date(epoch * 1000 - 4 * 3600000).toISOString().slice(0, 10) === date;
    });
    // Do not report a missing catalog match for a different commercial date
    // present in the same multi-day cinema page.
    if (!datedNodes.length) {
      return;
    }
    const matches = title ? (byTitle.get(cinexMovieTitle(title)) ?? []) : [];
    const movie = matches.length === 1 ? matches[0] : undefined;
    if (!movie) {
      c.partial = true;
      providerWarning(c, !title ? 'cinex-cinema-missing-title' : matches.length > 1 ? 'cinex-cinema-ambiguous-title' : 'cinex-cinema-unknown-title', () => !title
        ? 'Cinex returned a showtime without a movie title; it was omitted because its movie_id cannot be confirmed.'
        : matches.length > 1
          ? `Cinex returned a showtime with an ambiguous title (${warningLabel(title)}); it was omitted because its movie_id cannot be confirmed.`
          : `Cinex did not find the showtime title in its catalog (${warningLabel(title)}); it was omitted because its movie_id cannot be confirmed.`);
      return;
    }
    datedNodes.each((_, e) => {
      const raw = $(e).attr('onclick') ?? '';
      const match = raw.match(/checkLogin\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i);
      const epoch = number($(e).attr('alt'));
      if (!match || epoch === undefined || !Number.isInteger(epoch) || epoch < 1e9 || epoch > 1e11) {
        c.partial = true; providerWarning(c, 'cinex-cinema-malformed-session', () => `Cinex omitted a malformed showtime of ${warningLabel(title || 'untitled movie')}.`); return;
      }
      const sessionId = group(match, 1), sourceCinema = group(match, 2);
      if (!Id.safeParse(sessionId).success || sourceCinema !== cinemaId) {
        c.partial = true; providerWarning(c, 'cinex-cinema-invalid-id', () => `Cinex omitted a showtime with an unverifiable venue or session identifier (${warningLabel(sessionId)}).`); return;
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
        c.partial = true; providerWarning(c, 'cinex-cinema-conflict', () => `Cinex returned contradictory times for showtime ${warningLabel(sessionId)}; it was omitted.`); items.delete(key); suppressed.add(key); return;
      }
      items.set(key, item);
    });
  });
  if (!blocks) throw new DataError('error', 'Unrecognized Cinex showtime structure.');
  if (!nodes) providerWarning(c, 'cinex-cinema-no-sessions', 'Cinex returned no showtimes for the requested date.');
  if (boxOffice) providerWarning(c, 'cinex-box-office', cinexBoxOfficeWarning);
  providerWarningSummary(c);
  return [...items.values()];
}

/** Showtime IDs Cinve computes for functions Cinex sells only at the box office. */
export const cinexBoxOfficePrefix = 'taquilla-';
const cinexBoxOfficeWarning = `Some Cinex venues sell these showtimes only at the box office (taquilla), not online: Cinex publishes no session for them, so their id (${cinexBoxOfficePrefix}...) is computed by Cinve and cannot be used for prices or seats. Confirm times with the venue.`;
export const cinexBoxOfficeError = () => new DataError('unavailable', 'This Cinex showtime is sold only at the venue\'s box office: Cinex publishes no online prices or seat map for it.');

const spanishMonths = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/**
 * The date of each page of a venue's calendar, from its tab ("Jueves 12
 * Noviembre") and the page's first date (#fecha, YYYY-MM-DD) for the year.
 * The tabs skip days without functions, so a page index is not a day offset.
 * Checked on 2026-11-12 against the epochs of 608 online functions: all agree.
 */
function cinexTabDates($: CheerioAPI): Map<number, string> {
  const dates = new Map<number, string>();
  const first = /^(\d{4})-(\d{2})-\d{2}$/.exec($('#fecha').first().text().trim());
  if (!first) return dates;
  const year = Number(first[1]), month = Number(first[2]);
  $('[id^="divdate"]').each((_, tab) => {
    const index = /^divdate(\d+)$/.exec($(tab).attr('id') ?? '')?.[1];
    const label = folded($(tab).text()).replace(/\s+/g, ' ').trim().match(/(\d{1,2}) ([a-z]+)$/);
    const m = label ? spanishMonths.indexOf(label[2] ?? '') + 1 : 0;
    if (index === undefined || !label || !m) return;
    // A calendar that starts in December continues into January of the next year.
    const y = m < month ? year + 1 : year, d = Number(label[1]);
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) === iso) dates.set(Number(index), iso);
  });
  return dates;
}

/** "04:35 pm" on its own line, as 24-hour HH:MM. */
function cinexClock(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = line.replace(/\s+/g, ' ').trim().match(/^(\d{1,2}):(\d{2}) ?(am|pm)$/i);
    if (!m) continue;
    const h = Number(m[1]), min = Number(m[2]);
    if (h < 1 || h > 12 || min > 59) return undefined;
    return `${String((h % 12) + (/pm/i.test(m[3] ?? '') ? 12 : 0)).padStart(2, '0')}:${m[2]}`;
  }
  return undefined;
}
