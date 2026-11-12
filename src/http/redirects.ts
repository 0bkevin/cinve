// The only provider redirects HttpClient follows, both one same-origin Cinex
// hop with the IDs intact; any other redirect is reported, never followed.
import { assertPrivateRead } from './allow-list.js';

export function cinexTicketRedirect(url: string, response: Response): string | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return;
  const location = response.headers.get('location');
  if (!location) return;
  try {
    const from = new URL(url), to = new URL(location, url);
    if (from.origin !== 'https://www.cinex.com.ve' || from.pathname !== '/boletos.php' ||
        to.origin !== from.origin || to.pathname !== '/boletosdev.php') return;
    assertPrivateRead('cinex', to.href);
    if (['cinemaid', 'sessionid'].every(key => to.searchParams.get(key) === from.searchParams.get(key))) return to.href;
  } catch { /* Unrecognized redirects remain unavailable, without leaking their URL. */ }
  return undefined;
}

export function cinexCinemaRedirect(url: string, response: Response): string | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return;
  const location = response.headers.get('location');
  if (!location) return;
  try {
    const from = new URL(url), to = new URL(location, url);
    // Cinex has renamed cinema detail pages (for example, sambil.html to
    // sambilchacao.html). Follow only a single same-origin cinema-page hop;
    // generic public redirects remain unavailable by design.
    if (from.origin !== 'https://www.cinex.com.ve' || to.origin !== from.origin ||
        !/^\/cinex-[A-Za-z0-9_-]{1,80}\.html$/.test(from.pathname) ||
        !/^\/cinex-[A-Za-z0-9_-]{1,80}\.html$/.test(to.pathname) ||
        to.username || to.password || to.search || to.hash) return;
    return to.href;
  } catch { /* Unrecognized redirects remain unavailable, without leaking their URL. */ }
  return undefined;
}
