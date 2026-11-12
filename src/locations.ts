// Where each venue is, and the places people name instead of a city ("estoy
// en Chacao"), so list_cinemas can sort venues by distance from them. No
// provider publishes coordinates: they were looked up once in OpenStreetMap
// by each venue's name and address, and checked against the address the
// provider shows. A venue that opens later has no entry until it is added
// here; it is listed after the located ones, never given a guessed position.
import { folded } from './core.js';
import type { ProviderId } from './core.js';

export type Point = { lat: number; lng: number };
/** approximate: only the venue's area or town could be placed, not the building. */
export type VenueLocation = Point & { area: string; city: string; approximate?: true };

// Generated on 2026-11-12 from OpenStreetMap (Nominatim); data (c) OpenStreetMap contributors, ODbL.
export const venueLocations: Readonly<Record<string, VenueLocation>> = {
  'cinex:SBC': { lat: 10.48903, lng: -66.85425, area: 'Chacao', city: 'Caracas' },
  'cinex:CSI': { lat: 10.49782, lng: -66.85643, area: 'La Castellana, Chacao', city: 'Caracas' },
  'cinex:TLN': { lat: 10.48033, lng: -66.86069, area: 'Las Mercedes, Baruta', city: 'Caracas' },
  'cinex:REC': { lat: 10.49175, lng: -66.8771, area: 'Sabana Grande, Libertador', city: 'Caracas' },
  'cinex:MPP': { lat: 10.48546, lng: -66.93437, area: 'El Paraíso, Libertador', city: 'Caracas' },
  'cinex:IPC': { lat: 10.47277, lng: -66.89605, area: 'Los Próceres, Libertador', city: 'Caracas' },
  'cinex:GLN': { lat: 10.44014, lng: -66.836, area: 'Los Naranjos, El Hatillo', city: 'Caracas' },
  'cinex:PCV': { lat: 10.4502, lng: -66.8308, area: 'Cerro Verde, El Hatillo', city: 'Caracas' },
  'cinex:HAT': { lat: 10.42358, lng: -66.82401, area: 'El Hatillo', city: 'Caracas' },
  'cinex:BVG': { lat: 10.46455, lng: -66.57396, area: 'Guatire, Miranda', city: 'Guatire' },
  'cinex:STV': { lat: 10.59458, lng: -66.99108, area: 'Catia La Mar, La Guaira', city: 'La Guaira' },
  'cinex:31': { lat: 8.59972, lng: -71.15557, area: 'Mérida', city: 'Mérida' },
  'cinex:32': { lat: 8.61429, lng: -70.2502, area: 'Alto Barinas, Barinas', city: 'Barinas' },
  'cinex:39': { lat: 10.39508, lng: -71.4414, area: 'Cabimas, Zulia', city: 'Maracaibo', approximate: true },
  'cinex:38': { lat: 10.67161, lng: -71.65369, area: 'La Limpia, Maracaibo', city: 'Maracaibo' },
  'cinex:LMM': { lat: 10.68353, lng: -71.59456, area: 'El Milagro, Maracaibo', city: 'Maracaibo' },
  'cinex:SFC': { lat: 10.573, lng: -71.61638, area: 'San Francisco, Zulia', city: 'Maracaibo' },
  'cinex:35': { lat: 10.47613, lng: -64.18568, area: 'Cumaná', city: 'Cumaná' },
  'cinex:PCA': { lat: 10.9906, lng: -63.82604, area: 'Pampatar, Margarita', city: 'Margarita' },
  'cinex:30': { lat: 10.18029, lng: -64.68392, area: 'Lechería, Anzoátegui', city: 'Lechería' },
  'cinex:SBP': { lat: 11.68527, lng: -70.17365, area: 'Punto Fijo, Falcón', city: 'Paraguaná' },
  'cinex:36': { lat: 11.65676, lng: -70.2053, area: 'Cardón, Punto Fijo', city: 'Paraguaná' },
  'cinex:34': { lat: 9.29736, lng: -70.61484, area: 'Valera, Trujillo', city: 'Valera' },
  'cinex:directory-metropolisbarquisimeto': { lat: 10.06269, lng: -69.36564, area: 'Zona Industrial, Barquisimeto', city: 'Barquisimeto' },
  'cinesunidos:1008': { lat: 10.48323, lng: -66.81852, area: 'La California, Sucre', city: 'Caracas' },
  'cinesunidos:1009': { lat: 10.47484, lng: -66.94573, area: 'El Paraíso, Libertador', city: 'Caracas' },
  'cinesunidos:1027': { lat: 10.48615, lng: -66.8209, area: 'La California, Sucre', city: 'Caracas' },
  'cinesunidos:1002': { lat: 10.50449, lng: -66.91673, area: 'El Silencio, Libertador', city: 'Caracas' },
  'cinesunidos:1026': { lat: 10.49509, lng: -66.83266, area: 'Los Dos Caminos, Sucre', city: 'Caracas' },
  'cinesunidos:1005': { lat: 10.48903, lng: -66.85425, area: 'Chacao', city: 'Caracas' },
  'cinesunidos:1025': { lat: 10.07157, lng: -69.29343, area: 'Este, Barquisimeto', city: 'Barquisimeto' },
  'cinesunidos:1006': { lat: 10.08082, lng: -69.28136, area: 'Las Trinitarias, Barquisimeto', city: 'Barquisimeto' },
  'cinesunidos:1016': { lat: 10.64981, lng: -71.64436, area: 'Maracaibo', city: 'Maracaibo', approximate: true },
  'cinesunidos:1017': { lat: 10.72261, lng: -71.63268, area: 'Norte, Maracaibo', city: 'Maracaibo' },
  'cinesunidos:1015': { lat: 10.25448, lng: -67.58494, area: 'Maracay', city: 'Maracay' },
  'cinesunidos:1010': { lat: 10.26223, lng: -67.58823, area: 'Las Delicias, Maracay', city: 'Maracay' },
  'cinesunidos:3000': { lat: 10.97954, lng: -63.82087, area: 'Porlamar, Margarita', city: 'Margarita' },
  'cinesunidos:1021': { lat: 10.9969, lng: -63.81263, area: 'Pampatar, Margarita', city: 'Margarita' },
  'cinesunidos:1007': { lat: 9.80062, lng: -63.20399, area: 'Maturín', city: 'Maturín' },
  'cinesunidos:1019': { lat: 10.21052, lng: -64.63258, area: 'Puerto La Cruz', city: 'Puerto La Cruz' },
  'cinesunidos:1023': { lat: 8.29327, lng: -62.73996, area: 'Puerto Ordaz', city: 'Puerto Ordaz' },
  'cinesunidos:1024': { lat: 7.79318, lng: -72.23462, area: 'San Cristóbal', city: 'San Cristóbal' },
  'cinesunidos:1011': { lat: 10.18474, lng: -67.97385, area: 'Zona Industrial, Valencia', city: 'Valencia' },
  'cinesunidos:1014': { lat: 10.23903, lng: -68.00014, area: 'Mañongo, Naguanagua', city: 'Valencia' },
  'supercines:2': { lat: 10.35455, lng: -67.00284, area: 'Carrizal, Miranda', city: 'Carrizal' },
  'supercines:7': { lat: 10.24078, lng: -68.01168, area: 'La Granja, Naguanagua', city: 'Valencia' },
  'supercines:4': { lat: 10.18689, lng: -67.58018, area: 'Palo Negro, Aragua', city: 'Maracay' },
  'supercines:5': { lat: 10.46779, lng: -68.04367, area: 'Puerto Cabello', city: 'Puerto Cabello', approximate: true },
  'supercines:3': { lat: 10.15632, lng: -64.69763, area: 'Nueva Barcelona', city: 'Barcelona' },
  'supercines:9': { lat: 10.25412, lng: -67.58224, area: 'Maracay', city: 'Maracay' },
  'grancine:cinevilalder': { lat: 10.48615, lng: -66.8209, area: 'La California, Sucre', city: 'Caracas' },
  'grancine:lder': { lat: 10.48615, lng: -66.8209, area: 'La California, Sucre', city: 'Caracas' },
  'grancine:cinticaculturallosruices': { lat: 10.48159, lng: -66.83119, area: 'Los Ruices, Sucre', city: 'Caracas', approximate: true },
  'grancine:paseo-las-mercedes': { lat: 10.47775, lng: -66.8585, area: 'Las Mercedes, Baruta', city: 'Caracas' },
  'grancine:plazalospalosgrandescaracas': { lat: 10.50012, lng: -66.84413, area: 'Los Palos Grandes, Chacao', city: 'Caracas' },
  'grancine:villaplanchartelcerrito': { lat: 10.47396, lng: -66.85253, area: 'El Cerrito, Baruta', city: 'Caracas' },
  'grancine:supercineslacascadalosteques': { lat: 10.35455, lng: -67.00284, area: 'Carrizal, Miranda', city: 'Los Teques' },
  'grancine:supercineslagranjavalencia': { lat: 10.24078, lng: -68.01168, area: 'La Granja, Naguanagua', city: 'Valencia' },
  'grancine:supercineslosaviadoresmaracay': { lat: 10.18689, lng: -67.58018, area: 'Palo Negro, Aragua', city: 'Maracay' },
  'cinepic:123300': { lat: 10.50482, lng: -66.90148, area: 'La Candelaria, Libertador', city: 'Caracas' },
  'cinepic:123301': { lat: 10.49107, lng: -66.8625, area: 'El Rosal, Chacao', city: 'Caracas' },
};
export const knownPlaces: Readonly<Record<string, Point>> = {
  '23 de Enero': { lat: 10.51304, lng: -66.93059 },
  'Altagracia': { lat: 10.50521, lng: -66.91486 },
  'Altamira': { lat: 10.49559, lng: -66.84886 },
  'Antímano': { lat: 10.46552, lng: -66.97862 },
  'Barcelona': { lat: 10.1326, lng: -64.68196 },
  'Barinas': { lat: 8.61827, lng: -70.22741 },
  'Barquisimeto': { lat: 10.07744, lng: -69.32223 },
  'Baruta': { lat: 10.4342, lng: -66.87372 },
  'Bello Monte': { lat: 10.48733, lng: -66.87487 },
  'Boleíta': { lat: 10.49819, lng: -66.82075 },
  'Cabimas': { lat: 10.39508, lng: -71.4414 },
  'Cabudare': { lat: 10.02605, lng: -69.24366 },
  'Campo Alegre': { lat: 10.49438, lng: -66.86135 },
  'Caraballeda': { lat: 10.61284, lng: -66.84981 },
  'Caracas': { lat: 10.50609, lng: -66.9146 },
  'Caricuao': { lat: 10.4348, lng: -66.98125 },
  'Carrizal': { lat: 10.35199, lng: -66.99187 },
  'Catia': { lat: 10.51675, lng: -66.94281 },
  'Catia La Mar': { lat: 10.59927, lng: -67.01451 },
  'Caurimare': { lat: 10.47194, lng: -66.83876 },
  'Chacao': { lat: 10.49303, lng: -66.85454 },
  'Chacaíto': { lat: 10.49099, lng: -66.86835 },
  'Chuao': { lat: 10.48433, lng: -66.85873 },
  'Ciudad Bolívar': { lat: 8.10285, lng: -63.54696 },
  'Coche': { lat: 10.44782, lng: -66.92348 },
  'Colinas de Bello Monte': { lat: 10.48318, lng: -66.87921 },
  'Cumaná': { lat: 10.44957, lng: -64.1578 },
  'El Cafetal': { lat: 10.46497, lng: -66.82948 },
  'El Hatillo': { lat: 10.42368, lng: -66.82525 },
  'El Marqués': { lat: 10.48323, lng: -66.81852 },
  'El Paraíso': { lat: 10.49143, lng: -66.93418 },
  'El Recreo': { lat: 10.49175, lng: -66.8771 },
  'El Rosal': { lat: 10.49025, lng: -66.86357 },
  'El Silencio': { lat: 10.50603, lng: -66.91881 },
  'El Valle': { lat: 10.46847, lng: -66.90496 },
  'El Viñedo': { lat: 10.2126, lng: -68.0131 },
  'Guarenas': { lat: 10.46629, lng: -66.60784 },
  'Guatire': { lat: 10.46846, lng: -66.54311 },
  'La Boyera': { lat: 10.42666, lng: -66.8383 },
  'La California': { lat: 10.482, lng: -66.81838 },
  'La Candelaria': { lat: 10.50722, lng: -66.90578 },
  'La Castellana': { lat: 10.49786, lng: -66.85181 },
  'La Guaira': { lat: 10.58025, lng: -66.86035 },
  'La Lagunita': { lat: 10.42277, lng: -66.81042 },
  'La Trinidad': { lat: 10.435, lng: -66.86632 },
  'La Urbina': { lat: 10.48946, lng: -66.80336 },
  'La Vega': { lat: 10.47419, lng: -66.94742 },
  'Las Acacias': { lat: 10.50124, lng: -66.87931 },
  'Las Delicias': { lat: 10.29476, lng: -67.5624 },
  'Las Mercedes': { lat: 10.4821, lng: -66.86169 },
  'Lechería': { lat: 10.19105, lng: -64.68455 },
  'Los Chaguaramos': { lat: 10.49018, lng: -66.89166 },
  'Los Cortijos': { lat: 10.48957, lng: -66.82673 },
  'Los Dos Caminos': { lat: 10.49418, lng: -66.83234 },
  'Los Naranjos': { lat: 10.43956, lng: -66.83894 },
  'Los Palos Grandes': { lat: 10.50307, lng: -66.84402 },
  'Los Ruices': { lat: 10.48159, lng: -66.83119 },
  'Los Teques': { lat: 10.34374, lng: -67.04531 },
  'Macaracuay': { lat: 10.46919, lng: -66.81953 },
  'Maiquetía': { lat: 10.59661, lng: -66.95975 },
  'Maracaibo': { lat: 10.64981, lng: -71.64436 },
  'Maracay': { lat: 10.23751, lng: -67.58902 },
  'Maturín': { lat: 9.74228, lng: -63.18889 },
  'Mañongo': { lat: 10.23443, lng: -67.99775 },
  'Montalbán': { lat: 10.47263, lng: -66.95775 },
  'Mérida': { lat: 8.5817, lng: -71.16581 },
  'Naguanagua': { lat: 10.25814, lng: -68.0121 },
  'Palo Negro': { lat: 10.16303, lng: -67.55343 },
  'Palo Verde': { lat: 10.47883, lng: -66.79848 },
  'Pampatar': { lat: 10.99573, lng: -63.80508 },
  'Parque Central': { lat: 10.49789, lng: -66.90209 },
  'Petare': { lat: 10.47871, lng: -66.80722 },
  'Plaza Venezuela': { lat: 10.49692, lng: -66.88574 },
  'Porlamar': { lat: 10.96358, lng: -63.84645 },
  'Prados del Este': { lat: 10.45127, lng: -66.8717 },
  'Prebo': { lat: 10.20988, lng: -68.02152 },
  'Propatria': { lat: 10.50474, lng: -66.95596 },
  'Puerto Cabello': { lat: 10.46779, lng: -68.04367 },
  'Puerto La Cruz': { lat: 10.20286, lng: -64.63076 },
  'Puerto Ordaz': { lat: 8.27504, lng: -62.75583 },
  'Punto Fijo': { lat: 11.69317, lng: -70.19172 },
  'Sabana Grande': { lat: 10.49384, lng: -66.87621 },
  'San Antonio de los Altos': { lat: 10.37513, lng: -66.96654 },
  'San Bernardino': { lat: 10.51415, lng: -66.88954 },
  'San Cristóbal': { lat: 7.77567, lng: -72.22142 },
  'San Diego': { lat: 10.22999, lng: -67.9618 },
  'San Francisco': { lat: 10.55982, lng: -71.64302 },
  'San Félix': { lat: 8.34754, lng: -62.64713 },
  'San Román': { lat: 10.4722, lng: -66.85732 },
  'Santa Mónica': { lat: 10.47848, lng: -66.89219 },
  'Santa Paula': { lat: 10.46397, lng: -66.83713 },
  'Terrazas del Ávila': { lat: 10.49656, lng: -66.78823 },
  'Valencia': { lat: 10.18283, lng: -68.0033 },
  'Valera': { lat: 9.31482, lng: -70.60817 },
};

const placeKey = (text: string) => folded(text).replace(/[^a-z0-9]+/g, ' ').trim()
  // "Urbanización Las Mercedes", "municipio Chacao", "cerca de Altamira".
  .replace(/^(?:(?:cerca|near) (?:de |of )?)?(?:(?:urbanizacion|urb|sector|municipio|parroquia|zona) )?/, '');
const places = new Map(Object.entries(knownPlaces).map(([name, point]) => [placeKey(name), { name, point }]));
// "lat,lng" as a phone shares it, accepted only inside Venezuela's extent.
const coordinates = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,2}(?:\.\d+)?)\s*$/;
const inVenezuela = ({ lat, lng }: Point) => lat >= 0.5 && lat <= 12.5 && lng >= -73.5 && lng <= -59.5;

/** A place name Cinve knows ("Chacao", "Las Mercedes, Caracas") or "lat,lng" inside Venezuela. */
export function resolvePlace(text: string): { name: string; point: Point } | undefined {
  const pair = coordinates.exec(text);
  if (pair) {
    const point = { lat: Number(pair[1]), lng: Number(pair[2]) };
    return inVenezuela(point) ? { name: `${point.lat},${point.lng}`, point } : undefined;
  }
  for (const part of [text, ...text.split(',')]) {
    const found = places.get(placeKey(part));
    if (found) return found;
  }
  return undefined;
}

export function venueLocation(provider: ProviderId, id: string): VenueLocation | undefined {
  return Object.hasOwn(venueLocations, `${provider}:${id}`) ? venueLocations[`${provider}:${id}`] : undefined;
}

/** Straight-line (great-circle) distance in km. */
export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The provider's city whose venue is nearest to the point: Cines Unidos lists venues only by city. */
export function nearestCity(provider: ProviderId, point: Point): string | undefined {
  let best: { city: string; km: number } | undefined;
  for (const [key, venue] of Object.entries(venueLocations)) {
    if (!key.startsWith(`${provider}:`)) continue;
    const km = distanceKm(point, venue);
    if (!best || km < best.km) best = { city: venue.city, km };
  }
  return best?.city;
}
