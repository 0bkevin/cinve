import { DataError, folded, Id, isoDate, number, text } from '../../core.js';
import type { DataItem, Operation, Query } from '../../core.js';
import { CallStopped, ReadContext } from '../../http/client.js';
import { findField, flight, object, objects, requiredText, rows } from '../parsing.js';
import type { Obj } from '../parsing.js';
import { providerWarning, warningLabel } from '../diagnostics.js';
import { flightPage, hourTtl } from '../read-policy.js';
import { CP, cinepicTicketsLeft, cpBuy, cpSite } from './sites.js';

function flagValue(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return undefined;
}
function movieCP(r: Obj, site: string): DataItem {
  return { kind: 'movie', id: requiredText(r, 'peliculas_codigo'), name: requiredText(r, 'peliculas_nombre'),
    duration_minutes: number(r.peliculas_duracion), genre: text(r.peliculas_genero), rating: text(r.peliculas_clasificacion),
    format: text(r.peliculas_tipo), image_url: text(r.imagen), url: `${site}/es-AR/programacion/${encodeURIComponent(text(r.peliculas_codigo))}` };
}
export async function cinepic(op: Operation, q: Query, c: ReadContext): Promise<DataItem[]> {
  if (op === 'cities') {
    c.warnings.push('Cobertura Cinepic configurada: solo Caracas; list_cities no consulta los dos sitios de sede.');
    return [{ kind: 'city', id: 'Caracas', name: 'Caracas' }];
  }
  if (op === 'cinemas') {
    if (q.city && folded(q.city) !== 'caracas') return [];
    c.warnings.push('Cobertura Cinepic: dos sedes configuradas, Candelaria y VVIP; no hay descubrimiento automático de nuevas sedes.');
    return Promise.all(Object.entries(CP).map(async ([id, site]) => {
      const url = `${site.host}/es-AR`;
      try {
        const records = flight(await c.get(url, hourTtl, flightPage));
        const configs = [...objects(records)].filter(r => text(r.idUltracine) === id && text(r.nombre));
        const config = configs[0];
        if (!config || text(config.nombre).length > 512 || configs.some(r => text(r.nombre) !== text(config.nombre))) {
          throw new DataError('error', 'Configuración pública de sede ausente o contradictoria.');
        }
        return { kind: 'cinema' as const, id, cinema_id: id, code_status: 'verified' as const,
          name: text(config.nombre), city: 'Caracas', address: text(config.direccion), url };
      } catch (error) {
        c.partial = true;
        c.warnings.push(`${site.name}: no se pudo verificar la configuración actual; se conserva la sede conocida y su enlace. Esto no indica cierre. ${error instanceof DataError ? error.message : ''}`);
        return { kind: 'cinema' as const, id: `directory-cinepic-${id}`, code_status: 'unverified' as const, name: site.name, city: 'Caracas', url };
      }
    }));
  }
  if (op === 'concessions') {
      const site = cpSite(q), api = `https://api.cinexo.com.ar/api/complejo/${encodeURIComponent(q.cinema_id!)}`;
      // The purchase page embeds this same catalog as candyData, so an empty one
      // means Cinepic's own checkout offers no products either (seen 2026-11-05).
      // Cinepic publishes no stock; the catalog and its rate change slowly, and
      // its backend can take ~19 s to answer, so both are kept a few minutes.
      const units = rows(object(await c.json(`${api}/candy`, 5 * 60000)).unidades_negocios, 'candy.unidades_negocios');
      if (!units.length) {
        c.warnings.push('El catálogo de caramelería que Cinepic publica para esta sede está vacío; su web de compra usa ese mismo catálogo y tampoco ofrece productos. No implica que no venda en taquilla.');
        return [];
      }
      let rate: number | undefined;
      try { rate = number(object(object(await c.json(`${api}/configuration`, 10 * 60000)).datos).tasaConversion); } catch (e) { if (e instanceof CallStopped) throw e; }
      if (rate === undefined || rate <= 0) rate = undefined;
      c.warnings.push(`Precios en VES del catálogo en línea de Cinepic (su web los muestra en Bs.); ${rate ? 'USD con su tasa de conversión, no una tasa BCV verificada' : 'sin tasa de conversión de Cinepic, se omite la equivalencia USD'}. Cinepic no publica stock; cargos finales no verificados.`);
      // JSON API strings are literal: a leading "$" is a name, not a Next.js reference as text() assumes.
      const str = (v: unknown) => typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
      const cut = (v: string, max: number) => { const chars = Array.from(v); return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : v; };
      const list = (v: unknown) => Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x)) : undefined;
      const items: DataItem[] = [], seen = new Set<string>();
      let skipped = 0;
      const add = (r: Obj, unit: Obj, category: string) => {
        const id = str(r.id), name = str(r.nombre);
        if (!Id.safeParse(id).success || !name) { skipped++; return; }
        if (seen.has(id)) return;
        seen.add(id);
        const amount = number(r.precio);
        const prices: NonNullable<DataItem['prices']> = amount !== undefined && amount >= 0 ? [{ currency: 'VES', amount, basis: 'provider' }] : [];
        if (amount !== undefined && amount >= 0 && rate) prices.push({ currency: 'USD', amount: Number((amount / rate).toFixed(2)), basis: 'provider_conversion' });
        if (!prices.length) c.warnings.push(`Producto ${warningLabel(id)} sin precio verificable.`);
        const contents = str(r.descripcion), image = str(r.imagen);
        items.push({ kind: 'concession', id, name: cut(contents && contents !== name ? `${name} (${contents})` : name, 512),
          cinema_id: q.cinema_id, category: cut([units.length > 1 ? str(unit.nombre_empresa) : '', category].filter(Boolean).join(' · '), 200) || undefined,
          prices, final_total_verified: false, url: `${site.host}/es-AR`,
          // "dinamico" items and items with productos ask the buyer to pick options.
          options_required: str(r.formato) === 'dinamico' || (Array.isArray(r.productos) && r.productos.length > 0),
          ...(image.length <= 4096 && /^https:\/\/[^\s]+$/.test(image) ? { image_url: image } : {}) });
      };
      for (const unit of units) {
        // The purchase JS reads unidades_negocios[].categorias[].items[]. It adds its own
        // "TODOS" category only when the server sent none, so a server "TODOS" is shown
        // too: read named categories first, then any TODOS items not already listed.
        const categories = list(unit.categorias);
        if (!categories) { skipped++; continue; }
        const todos = (cat: Obj) => folded(str(cat.nombre)) === 'todos';
        for (const cat of [...categories.filter(x => !todos(x)), ...categories.filter(todos)]) {
          const rowsOf = list(cat.items);
          if (!rowsOf) { skipped++; continue; }
          for (const r of rowsOf) add(r, unit, todos(cat) ? '' : str(cat.nombre));
        }
      }
      if (skipped) { c.partial = true; c.warnings.push(`Cinepic: ${skipped} productos o grupos del catálogo sin identificador, nombre o lista válidos se omitieron.`); }
      if (!items.length && !skipped) c.warnings.push('El catálogo de caramelería que Cinepic publica para esta sede no tiene productos; su web de compra usa ese mismo catálogo. No implica que no venda en taquilla.');
      return items;
  }
  if (op === 'prices') {
    const { records, f, url } = await cpBuy(q, c);
    const cfg = object(findField(records, 'configData'));
    const rate = number(cfg.tasaConversion);
    // Verified in the current purchase JS: tarifa.precio is labeled '(Bs.)';
    // checkout divides SubtotalTarifas by tasaConversion and sets currency:'USD'.
    c.warnings.push('Tarifas en VES según la interfaz del proveedor. USD calculado con su tasa de conversión, no una tasa BCV verificada; cargos finales no verificados.');
    if (rate === undefined || rate <= 0) c.warnings.push('Sin tasa de conversión positiva; se omite la equivalencia USD.');
    return rows(f.tarifas, 'functionData.tarifas').map(r => {
      const amount = number(r.precio);
      if (amount === undefined || amount < 0) throw new DataError('error', 'Tarifa sin importe válido.');
      const prices: NonNullable<DataItem['prices']> = [{ currency: 'VES', amount, basis: 'provider' }];
      if (rate !== undefined && rate > 0) prices.push({ currency: 'USD', amount: Number((amount / rate).toFixed(2)), basis: 'provider_conversion' });
      return { kind: 'ticket_price', id: requiredText(r, '_id'), name: requiredText(r, 'descripcion'),
        cinema_id: q.cinema_id, movie_id: q.movie_id, session_id: q.session_id, url,
        prices, provider_currency: text(cfg.moneda), provider_conversion_rate: rate, final_total_verified: false, tickets_available: cinepicTicketsLeft(r) };
    });
  }
  const site = cpSite(q), date = isoDate(q);
  const [year, month, day] = date.split('-');
  const url = `https://apifront.cinexo.com.ar/mobile/consultas/peliculas/PeliculasConFuncionesYHorarios?${new URLSearchParams({ idComplejo: q.cinema_id!, fecha: `${day}/${month}/${year}` })}`;
  const payload = object(await c.json(url));
  if (payload.success !== true) throw new DataError('error', 'Cinepic no confirmó el éxito de la consulta.');
  const data = object(payload.data);
  const movies = rows(data.datos, 'data.datos'), sessions = rows(data.funciones, 'data.funciones');
  const names = new Map(movies.map(r => [text(r.peliculas_codigo), r]));
  if (op === 'movies') {
    const scheduled = new Set(sessions.map(r => Id.parse(requiredText(r, 'codPelicula'))));
    return [...scheduled].map(mid => {
      const movie = names.get(mid);
      if (movie && text(movie.peliculas_nombre)) return { ...movieCP(movie, site.host), cinema_id: q.cinema_id };
      c.partial = true;
      c.warnings.push(`Película ${mid}: hay funciones pero no se recibió una ficha con título; se conserva la referencia.`);
      return { kind: 'movie', id: mid, name: `Película ${mid}`, cinema_id: q.cinema_id,
        url: `${site.host}/es-AR/programacion/${encodeURIComponent(mid)}` };
    });
  }
  return sessions.filter(r => !q.movie_id || text(r.codPelicula) === q.movie_id).map(r => {
    const id = requiredText(r, '_id'), mid = requiredText(r, 'codPelicula'), movie = names.get(mid);
    const time = requiredText(r, 'hora');
    if (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new DataError('error', 'Horario Cinepic inválido.');
    const overnight = flagValue(r.trasnoche);
    if (overnight === undefined) {
      c.partial = true;
      providerWarning(c, 'cinepic-unknown-trasnoche', () => `Función ${warningLabel(id)}: Cinepic no confirmó si es trasnoche; se omite la marca de fecha calendario.`);
    } else if (overnight) {
      providerWarning(c, 'cinepic-trasnoche', () => `Función ${warningLabel(id)}: trasnoche; fecha comercial recibida, fecha calendario sin confirmar.`);
    }
    if (!movie || !text(movie.peliculas_nombre)) {
      c.partial = true;
      providerWarning(c, 'cinepic-missing-movie-title', () => `Función ${warningLabel(id)}: no se recibió ficha con título de la película ${warningLabel(mid)}.`);
    }
    const subtitled = flagValue(r.subtitulada);
    if (subtitled === undefined) {
      c.partial = true;
      providerWarning(c, 'cinepic-unknown-subtitle', () => `Función ${warningLabel(id)}: Cinepic no confirmó el estado de subtítulos; se omite language.`);
    }
    return { kind: 'showtime', id, name: text(movie?.peliculas_nombre) || `Película ${mid}`, cinema_id: q.cinema_id, cinema_name: site.name, movie_id: mid,
      date, time, starts_at: overnight === true ? undefined : overnight === false ? `${date}T${time}:00-04:00` : undefined,
      format: text(r.formato), language: subtitled === undefined ? undefined : subtitled ? 'subtitulada' : 'no_subtitulada',
      rating: text(movie?.peliculas_clasificacion) || undefined,
      url: `${site.host}/es-AR/compra?${new URLSearchParams({ cid: q.cinema_id!, fid: id, pid: mid })}` };
  });
}
