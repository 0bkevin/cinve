// Every URL Cinve may fetch from a provider. HttpClient refuses any other
// host; adapters may read only these public routes, and the saved account
// sessions only the authenticated routes below. Nothing here selects, holds
// or buys a seat or pays: the only purchase steps are a one-ticket order that
// a seat lookup opens and always closes, on Cinex (assertCinexSeatOrder) and
// Supercines (assertSupercinesSeatPage). Cinex's boletos_datadev.php and
// asientos_datadevx.php are deliberately absent.
import { DataError, group, Id } from '../core.js';
import type { AuthProviderId } from '../auth/sessions.js';

export const publicHosts = new Set(['www.cinex.com.ve', 'www.cinesunidos.com', 'gateway.cinesunidos.com', 'cinepiccandelaria.com', 'cinepicvip.com', 'apifront.cinexo.com.ar', 'api.cinexo.com.ar', 'supercines.com.ve', 'www.grancine.net']);
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
            try { city = decodeURIComponent(group(m, 1)); } catch { return false; }
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
      case 'supercines.com.ve':
        return none && (path === '/cartelera' || /^\/booking\/\d{1,12}$/.test(path));
      case 'www.grancine.net':
        if (path === '/salas') return none;
        return path === '/sedes/sede.php' && exactQuery(u, { slug: v => !!v && /^[a-z0-9-]{1,80}$/.test(v), fecha: v => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) });
      default:
        return false;
    }
  })();
  if (!allowed) throw new DataError('error', 'Public query path not allowed.');
}

const digits = (value: string | undefined) => value !== undefined && /^\d{1,12}$/.test(value);
const isoDay = (value: string | undefined) => value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
const supercinesForms: Record<string, Record<string, (value: string | undefined) => boolean>> = {
  '/dame_empresas': {},
  '/api/app/cartelera/list': { type: value => value === 'all', idEmpresa: value => value === undefined || digits(value) },
  '/listCartelerafecha': { fecha: isoDay, id: digits },
  '/listBoletos': { idFuncion: digits, fecha: isoDay, unico: digits, tresD: value => value === '0' || value === '1', idEmpresa: digits },
  '/listCarameleria': { idEmpresa: digits },
};
/**
 * Public form reads. Only the listing routes Supercines' own pages call, with
 * exactly their fields: never login, registration, cart, booking or payment.
 */
export function assertPublicForm(value: string, fields: Record<string, string>) {
  const u = new URL(value), rules = u.hostname === 'supercines.com.ve' && !u.search && !u.hash ? supercinesForms[u.pathname] : undefined;
  const allowed = !!rules && Object.keys(fields).every(key => Object.hasOwn(rules, key)) && Object.entries(rules).every(([key, valid]) => valid(fields[key]));
  if (!allowed) throw new DataError('error', 'Public query path not allowed.');
}

export function assertPrivateRead(p: AuthProviderId, value: string) {
  const u = new URL(value);
  const safe = u.protocol === 'https:' && !u.port && !u.username && !u.password && !u.hash;
  const expected = ['/boletos.php', '/boletosdev.php'].includes(u.pathname) ? ['cinemaid', 'sessionid'] : u.pathname === '/concesiones.php' ? ['cinemaid'] : [];
  const params = [...u.searchParams];
  const cinexParams = params.length === expected.length && expected.every(key => u.searchParams.getAll(key).length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(u.searchParams.get(key) ?? ''));
  if (p === 'supercines') {
    // The reads made with a Supercines account: the fare list of one function
    // (fields checked by assertPublicForm), and the seat map, which the site
    // shows only inside a purchase: /bookSeat opens it with one ticket and no
    // seat (fields checked by assertSupercinesSeatPage), /cancelaCompra closes it.
    if (!safe || u.hostname !== 'supercines.com.ve' || !['/listBoletos', '/bookSeat', '/cancelaCompra'].includes(u.pathname) || u.search) throw new DataError('error', 'Authenticated route is not allowed.');
    return;
  }
  const route = p === 'cinesunidos'
    ? (u.hostname === 'www.cinesunidos.com' && u.pathname === '/api/seats' && params.length === 2 && ['theaterId', 'showTimeId'].every(key => u.searchParams.getAll(key).length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(u.searchParams.get(key) ?? ''))) || (u.hostname === 'gateway.cinesunidos.com' && /^\/tickets\/www\/theaters\/[\w-]+\/sessions\/[\w-]+\/$/.test(u.pathname) && !u.search)
    : u.hostname === 'www.cinex.com.ve' && ['/checklogin.php', '/boletos.php', '/boletosdev.php', '/asientos.php', '/asientosdev.php', '/concesiones.php', '/boletos_data.php', '/resetpurchase.php'].includes(u.pathname) && cinexParams;
  if (!safe || !route) throw new DataError('error', 'Authenticated route is not allowed.');
}

/**
 * The only order Cinve opens on Cinex: its regular seat page draws a room's map
 * only for an account session that has opened an order (seen 2026-11-11), so a
 * seat lookup may open one with exactly the fields cinex.com.ve's ticket form
 * posts for ONE ticket of one type, and reset it at once. No seat, no payment.
 */
export function assertCinexSeatOrder(fields: Record<string, string>) {
  const number = (v: string | undefined) => v !== undefined && /^\d{1,12}(?:\.\d{1,4})?$/.test(v);
  const keys = Object.keys(fields).sort().join(',');
  if (keys !== 'bookingfeetotal,cantboletos,indicetickets,tickettotal,total,totalticketsusd' || fields.cantboletos !== '1'
    || !/^,{1,30}1$/.test(fields.indicetickets ?? '') || !['total', 'bookingfeetotal', 'tickettotal', 'totalticketsusd'].every(k => number(fields[k]))) {
    throw new DataError('error', 'Cinex order not allowed.');
  }
}

/**
 * The other purchase step Cinve takes: Supercines draws a function's seat map
 * only after a ticket count is submitted to /bookSeat, which opens a purchase
 * with a countdown. Exactly one ticket of one type, no seat, no courtesy code,
 * no product: the fields its booking form sends, nothing that pays or picks.
 */
export function assertSupercinesSeatPage(entries: Array<[string, string]>) {
  const digits = (v: string) => /^\d{1,12}$/.test(v);
  const single: Record<string, (v: string) => boolean> = { id: digits, cartelera: digits, flagForm: v => v === '1', espectaculo: digits, cortesia_boleto: v => v === '' };
  const seen = new Set<string>(); let tickets = 0, types = 0, ids = 0;
  for (const [key, value] of entries) {
    const quantity = key.match(/^quantityBoleto\[(\d{1,12})\]$/);
    if (quantity) { types++; if (value === '1') tickets++; else if (value !== '0') tickets += 2; continue; }
    if (key === 'idBoleto[]' && digits(value)) { ids++; continue; }
    if (key === 'promoCombinada[]' && /^\d{0,12}$/.test(value)) continue;
    if (key === 'quantityBoletoCortesia[]' && value === '0') continue;
    const valid = single[key];
    if (!valid || seen.has(key) || !valid(value)) throw new DataError('error', 'Supercines seat page request not allowed.');
    seen.add(key);
  }
  if (tickets !== 1 || types < 1 || ids !== types || !['id', 'cartelera', 'flagForm'].every(k => seen.has(k))) throw new DataError('error', 'Supercines seat page request not allowed.');
}
