// Every URL Cinve may fetch from a provider. HttpClient refuses any other
// host; adapters may read only these public routes, and the saved account
// sessions only the authenticated read routes below. Nothing here selects,
// holds or buys seats or tickets: boletos_datadev.php, which starts a timed
// Cinex order, is deliberately absent.
import { DataError, Id } from '../core.js';
import type { AuthProviderId } from '../auth/sessions.js';

export const publicHosts = new Set(['www.cinex.com.ve', 'www.cinesunidos.com', 'gateway.cinesunidos.com', 'cinepiccandelaria.com', 'cinepicvip.com', 'apifront.cinexo.com.ar', 'api.cinexo.com.ar']);
const ids = (value: string | null) => value !== null && Id.safeParse(value).success;
/** Each listed query key appears exactly once, and no other key appears. */
function exactQuery(u: URL, rules: Record<string, (value: string | null) => boolean>) {
  const keys = [...u.searchParams.keys()];
  return keys.length === Object.keys(rules).length &&
    Object.entries(rules).every(([key, valid]) => u.searchParams.getAll(key).length === 1 && valid(u.searchParams.get(key)));
}
const cinexDatasource: Record<string, Record<string, (value: string | null) => boolean>> = {
  getcinemacitieslist: { method: () => true },
  getcinemadatafromcinemaid: { method: () => true, cinemaid: ids },
};
/**
 * Public GET routes the provider adapters are allowed to read. The host
 * allowlist in HttpClient bounds egress; this bounds it to the read-only pages
 * and APIs Cinve actually parses, so a future adapter bug cannot turn a
 * permitted host into a request for a purchase or account endpoint.
 */
export function assertPublicRead(value: string) {
  const u = new URL(value), path = u.pathname, none = !u.search;
  const allowed = (() => {
    switch (u.hostname) {
      case 'www.cinex.com.ve':
        if (['/cines.html', '/cartelera.html'].includes(path)) return none;
        if (/^\/cinex-[A-Za-z0-9_-]{1,80}\.html$/.test(path)) return none;
        if (path.startsWith('/sinopsis-') && path.endsWith('.html')) return none && Id.safeParse(path.slice(10, -5)).success;
        if (path === '/assets/php/datasource.php') {
          const rules = cinexDatasource[u.searchParams.get('method') ?? ''];
          return !!rules && exactQuery(u, rules);
        }
        return false;
      case 'www.cinesunidos.com':
        return ['/cines', '/cartelera'].includes(path) && exactQuery(u, { city: v => !!v && v.length <= 80 });
      case 'gateway.cinesunidos.com':
        if (path === '/search/cities') return none;
        {
          const m = path.match(/^\/search\/cities\/([^/]+)\/(theaters|films|sessions)$/);
          if (m) {
            let city = '';
            try { city = decodeURIComponent(m[1]); } catch { return false; }
            if (!city || city.length > 80 || /[\u0000-\u001f/\\]/.test(city)) return false;
            return m[2] === 'sessions' ? exactQuery(u, { Title: v => !!v && v.length <= 200 }) : none;
          }
        }
        { const m = path.match(/^\/concessions\/www\/cinemas\/([^/]+)\/concessions$/); return !!m && none && Id.safeParse(m[1]).success; }
      case 'cinepiccandelaria.com': case 'cinepicvip.com':
        if (path === '/es-AR') return none;
        return path === '/es-AR/compra' && exactQuery(u, { cid: ids, fid: ids, pid: ids });
      case 'apifront.cinexo.com.ar':
        return path === '/mobile/consultas/peliculas/PeliculasConFuncionesYHorarios' &&
          exactQuery(u, { idComplejo: ids, fecha: v => !!v && /^\d{2}\/\d{2}\/\d{4}$/.test(v) });
      case 'api.cinexo.com.ar':
        { const m = path.match(/^\/api\/complejo\/([^/]+)\/(?:candy|configuration)$/); return !!m && none && Id.safeParse(m[1]).success; }
      default:
        return false;
    }
  })();
  if (!allowed) throw new DataError('error', 'Ruta de consulta pública no permitida.');
}

export function assertPrivateRead(p: AuthProviderId, value: string) {
  const u = new URL(value);
  const safe = u.protocol === 'https:' && !u.port && !u.username && !u.password && !u.hash;
  const expected = ['/boletos.php', '/boletosdev.php'].includes(u.pathname) ? ['cinemaid', 'sessionid'] : u.pathname === '/concesiones.php' ? ['cinemaid'] : [];
  const params = [...u.searchParams];
  const cinexParams = params.length === expected.length && expected.every(key => u.searchParams.getAll(key).length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(u.searchParams.get(key) ?? ''));
  const route = p === 'cinesunidos'
    ? (u.hostname === 'www.cinesunidos.com' && u.pathname === '/api/seats' && params.length === 2 && ['theaterId', 'showTimeId'].every(key => u.searchParams.getAll(key).length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(u.searchParams.get(key) ?? ''))) || (u.hostname === 'gateway.cinesunidos.com' && /^\/tickets\/www\/theaters\/[\w-]+\/sessions\/[\w-]+\/$/.test(u.pathname) && !u.search)
    : u.hostname === 'www.cinex.com.ve' && ['/checklogin.php', '/boletos.php', '/boletosdev.php', '/asientosdev.php', '/concesiones.php'].includes(u.pathname) && cinexParams;
  if (!safe || !route) throw new DataError('error', 'Ruta autenticada no permitida.');
}
