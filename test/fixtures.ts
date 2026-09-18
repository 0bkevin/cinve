// Synthetic minimal responses based on the observed provider schemas; no customer data.
import { SessionStore } from '../src/auth.js';
export class EmptySessionStore extends SessionStore { override async read() { return undefined; } }
export function page(props: unknown): string {
  const record = 'a:' + JSON.stringify(['$', 'component', null, props]) + '\n';
  return `<script>self.__next_f.push(${JSON.stringify([1, record])})</script>`;
}
export const cpSessions = { success: true, data: {
  datos: [
    { peliculas_codigo: 'p1', peliculas_nombre: 'Película Uno', peliculas_duracion: '110', peliculas_tipo: '2D' },
    { peliculas_codigo: 'p2', peliculas_nombre: 'Próximo estreno' },
  ],
  funciones: [
    { _id: 'f1', codPelicula: 'p1', hora: '20:30', subtitulada: '1', formato: '2D', trasnoche: '0' },
    { _id: 'f2', codPelicula: 'p1', hora: '00:30', subtitulada: '0', formato: '2D', trasnoche: '1' },
  ],
} };
export const cpBuy = {
  butacasData: { butacas: [{ butaca: "A-1-1", nombre_butaca: "A:1", fila: "1", columna: "1", libre: "1" }] },
  functionData: { datos: [{ id: 'f1', codigo: 'p1' }], tarifas: [{ _id: 't1', descripcion: 'COMPLETO', precio: '4162.4' }] },
  configData: { moneda: '$$', tasaConversion: '832.48', payment_secret: 'SHOULD_NOT_LEAVE_PARSER' },
  candyData: { tiene_unidades_negocios: true, unidades_negocios: [] },
};
export const cuMovies = { movies: [{ vistaId: 'HO1', title: 'Una Película', theaters: [
  { id: '1002', name: 'Cine 1', showTimes: [
    { id: 's1', date: '2026-09-11T20:00:00', screen: 4, format: 'Digital' },
    { id: 's2', date: '2026-09-12T20:00:00', screen: 4, format: 'Digital' },
  ] },
  { id: '1005', name: 'Cine 2', showTimes: [{ id: 's3', date: '2026-09-11T21:00:00', screen: 2, format: '3D' }] },
] }] };
export const concessions = [
  { itemId: '1', itemDescription: 'Cotufas', itemPriceUSD: 5, itemPriceVE: 4000, itemStock: 0, itemClassDescription: 'COMBOS' },
  { itemId: '2', itemDescription: 'Agua', itemPriceUSD: null, itemPriceVE: null },
];
export const cxSession = `<h1>Película</h1><div onclick="javascript:checkLogin('76900','TLN');" alt="1789140000"><button>Sala 4<br>11:20 am</button></div>`;
export const mockFetch: typeof fetch = async (input) => {
  const url = String(input);
  let body: string;
  if (url.includes('/search/cities')) body = JSON.stringify(['Caracas', 'Mérida']);
  else if (url.includes('apifront.')) body = JSON.stringify(cpSessions);
  else if (url.includes('/compra?')) body = page(cpBuy);
  else if (url.includes('api.cinexo.com.ar/api/complejo/') && url.endsWith('/candy')) body = JSON.stringify(cpBuy.candyData);
  else if (url.includes('/concessions/www/')) body = JSON.stringify(concessions);
  else if (url.includes('/cartelera?')) body = page(cuMovies);
  else if (url.includes('/sinopsis-')) body = cxSession;
  else if (url.includes('trasnochocultural')) return new Response('blocked', { status: 403 });
  else throw new Error('Unexpected fixture URL: ' + url);
  return new Response(body, { status: 200 });
};
