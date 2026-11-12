import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

/** Every seat state, in legend order. */
const seatStatuses = ['available', 'occupied', 'unavailable', 'unknown'] as const;
export type SeatStatus = typeof seatStatuses[number];
/** accessible: a wheelchair seat, drawn blue with a wheelchair icon unless it is taken. */
export type MapSeat = { label: string; row: string; area: string; row_index: number; column_index: number; status: SeatStatus; accessible?: boolean | undefined };
/** What a seat is drawn as: its status, or a wheelchair seat that is not taken. */
type SeatKind = SeatStatus | 'accessible';
/** Only a wheelchair seat that is free or restricted is drawn blue; a taken or unknown one keeps its own look. */
const kindOf = (s: Pick<MapSeat, 'status' | 'accessible'>): SeatKind => s.accessible && (s.status === 'available' || s.status === 'unavailable') ? 'accessible' : s.status;
/** The provider-verified orientation from SeatResult.layout. */
/** row_shift: rows the provider centers because they are shorter, in seats (may be half a seat). */
export type MapLayout = { screen: 'top' | 'bottom' | 'unverified'; column_order: 'ascending' | 'descending'; row_shift?: Record<string, number> | undefined };
/** cinema: the venue's name when known, else its ID. The rest, when the provider named them, label the function. */
export type MapHeader = { provider: string; cinema: string; session: string; queriedAt: string; movie?: string | undefined; screen?: string | undefined; date?: string | undefined; time?: string | undefined };

const providerNames: Record<string, string> = { cinex: 'Cinex', cinesunidos: 'Cines Unidos', cinepic: 'Cinepic', supercines: 'Supercines' };
/**
 * Cinve's house palette (site.css on the public site): a dark room, upholstery
 * red for a free seat, and amber only for what is "for you", here the free count.
 * Every colour is opaque, so the indexed PNG keeps each one exact.
 */
const ink = {
  night: '#120a0e', rim: '#2a1820', line: '#33212a', cream: '#f6eee4', dust: '#b8a7a1', faint: '#8c7d7a', amber: '#ffbd3f',
} as const;
/** Free and taken seats are flat solid fills; restricted and unknown ones are outlines (dashed when restricted). */
const palette: Record<SeatKind, { fill: string; stroke?: string; dash?: boolean; text: string; name: string }> = {
  available: { fill: '#a92037', text: ink.cream, name: 'Libre' },
  occupied: { fill: '#2e1b23', text: '#7d6670', name: 'Ocupado' },
  unavailable: { fill: '#1b1016', stroke: '#6b4a5a', dash: true, text: '#8a7480', name: 'No disponible' },
  unknown: { fill: ink.night, stroke: ink.dust, text: ink.cream, name: 'Desconocido' },
  // Blue, as the cinemas draw them; the seat shows a wheelchair instead of its number (its title keeps the label).
  accessible: { fill: '#2f6bd8', text: ink.cream, name: 'Silla de ruedas' },
};
const kinds: SeatKind[] = ['available', 'occupied', 'accessible', 'unavailable', 'unknown'];
/** A wheelchair icon centred in a seat box, in the seat's text colour. */
const wheelchair = (x: number, y: number, colour: string) => `<g transform="translate(${round(x + SEAT / 2 - 6)} ${round(y + SEAT_H / 2 - 7)})" fill="none" stroke="${colour}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">`
  + `<circle cx="6.2" cy="1.9" r="1.5" fill="${colour}" stroke="none"/><path d="M6 4.4v4h4.2l1.4 3.8"/><path d="M4.4 6.2a3.9 3.9 0 1 0 5.3 4.7"/></g>`;
/** Row pitch and seat box: seats keep the site's 1 : 0.86 proportion. */
const CELL = 30, SEAT = 26, SEAT_H = 22, LABEL = 30, MAX_LABEL = 96, PAD = 28;
const fonts = { text: "'Instrument Sans', system-ui, sans-serif", display: "'Bricolage Grotesque', 'Instrument Sans', system-ui, sans-serif" };

/** Characters XML 1.0 forbids (controls, lone surrogates, U+FFFE/FFFF); resvg and SVG viewers reject the whole document for one of them. */
const invalidXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Emoji and their joiners and selectors: no bundled font draws them. */
const noGlyph = /[\p{Extended_Pictographic}\u200D\uFE0E\uFE0F]|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]/gu;
const escape = (value: string) => value.replace(invalidXml, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
/** Thrown before drawing a map whose image would exceed MAX_MAP_HEIGHT; the data answer is unaffected. */
export class MapTooLarge extends Error {}
/** In SVG units: about 90 rows of seats, far above any room seen (13-16 rows). */
const MAX_MAP_HEIGHT = 3000;
/** Output pixels per PNG: about 12 MB of RGBA. Taller maps are scaled down instead of refused. */
export const MAX_PNG_PIXELS = 3_000_000;
/** The bundled faces: Instrument Sans 400 for text, 600 for labels, Bricolage Grotesque 750 for the title and figures. */
export type Face = 'text' | 'strong' | 'display';
// Advance widths of the bundled fonts (per mille of an em) for ASCII 32-126,
// read from src/assets with fontTools, so header text is fitted to the real glyphs.
const advances: Record<Face, number[]> = {
  text: [200,273,384,716,608,786,755,232,406,406,408,531,255,506,255,443,666,391,545,574,600,574,599,532,582,610,255,255,531,531,531,567,853,728,636,741,752,638,602,765,736,254,455,692,588,906,736,786,656,787,656,608,648,712,728,1089,688,676,623,406,443,406,531,426,354,533,606,533,606,564,354,606,599,240,240,535,240,922,599,584,606,606,375,473,377,589,523,767,551,523,496,406,242,406,531],
  strong: [193,295,449,727,637,786,768,256,439,439,430,544,275,493,275,444,677,387,557,579,615,581,615,561,598,619,275,275,544,544,544,580,867,733,645,747,755,630,594,764,725,254,427,712,589,898,725,794,667,806,664,637,664,704,733,1087,707,700,631,439,444,439,544,466,354,558,621,552,621,571,370,621,612,260,260,558,260,941,612,597,621,621,390,494,406,604,536,800,587,536,513,439,234,439,544],
  display: [224,293,365,627,636,979,747,180,322,320,446,525,202,350,242,361,659,347,601,603,627,606,651,510,652,648,251,228,525,525,525,420,987,699,677,676,692,616,586,716,715,290,371,683,502,931,771,716,642,717,675,646,568,718,672,984,696,644,570,323,359,320,572,547,283,584,634,565,635,578,399,597,627,275,279,590,272,942,627,605,634,635,434,543,397,619,572,863,573,597,524,345,266,342,525],
};
/** Text width in SVG units, without letter-spacing. Accents count as their base letter; glyphs outside the Latin font as a full em. */
export function textWidth(value: string, size: number, face: Face = 'text'): number {
  const table = advances[face];
  let em = 0;
  for (const char of value) {
    const code = char.normalize('NFD').charCodeAt(0);
    // The tables cover ASCII 32-126; any other glyph counts as a full em.
    em += (table[code - 32] ?? 1000) / 1000;
  }
  return em * size;
}
/** The seat's number within its row: "A:5" and "B12" in row A or B give 5 and 12. */
export function seatNumber(seat: Pick<MapSeat, 'label' | 'row'>): string {
  const rest = seat.label.startsWith(seat.row) ? seat.label.slice(seat.row.length).replace(/^[\s:._-]+/, '') : seat.label;
  return rest || seat.label;
}
/** Two decimals: a hundredth of an SVG unit is invisible, and seat positions no longer print 17 digits. */
const round = (n: number) => Math.round(n * 100) / 100;
const caracasTime = (iso: string) => new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

/** A self-contained SVG of the seat map, oriented as the provider's own seat page, in Cinve's dark house style. */
export function renderSeatMapSvg(seats: MapSeat[], layout: MapLayout, header: MapHeader): string {
  const areas = [...new Set(seats.map(s => s.area))];
  const showAreaNames = areas.length > 1;
  // Columns share one scale across areas, as in the ASCII map, so an area keeps its horizontal place.
  // A seat's place across the room: its column, plus the shift of a row the provider centers.
  const place = (s: MapSeat) => s.column_index + (layout.row_shift?.[s.row] ?? 0);
  const minCol = Math.min(...seats.map(place)), cols = Math.max(...seats.map(place)) - minCol + 1;
  const groups = areas.map(area => {
    const group = seats.filter(s => s.area === area);
    const minRow = Math.min(...group.map(s => s.row_index)), maxRow = Math.max(...group.map(s => s.row_index));
    return { area, group, minRow, rows: maxRow - minRow + 1 };
  });
  const rowsHeight = groups.reduce((sum, g) => sum + g.rows * CELL + 14 + (areas.length > 1 ? 22 : 0), 0);
  if (rowsHeight > MAX_MAP_HEIGHT) throw new MapTooLarge('El mapa es demasiado grande para dibujarlo como imagen.');
  const gridWidth = cols * CELL;
  // Row names sit in a column on each side, as wide as the longest one (within reason); longer names are cut.
  const rowNames = [...new Set(seats.map(s => s.row))];
  const label = Math.min(MAX_LABEL, Math.max(LABEL, ...rowNames.map(name => Math.ceil(textWidth(name, 12, 'strong') + 14))));
  const width = Math.max(PAD * 2 + label * 2 + gridWidth, 560);
  const left = (width - gridWidth) / 2, right = width - PAD;
  const counts: Record<SeatStatus, number> = { available: 0, occupied: 0, unavailable: 0, unknown: 0 };
  for (const s of seats) counts[s.status]++;
  // The legend counts what is drawn: a wheelchair seat that is not taken has its own entry.
  const drawn: Record<SeatKind, number> = { available: 0, occupied: 0, unavailable: 0, unknown: 0, accessible: 0 };
  for (const s of seats) drawn[kindOf(s)]++;
  const out: string[] = [];
  let y = PAD;
  const fit = (value: string, size: number, room: number, face: Face = 'text') => {
    // The bundled Latin fonts have no emoji, which would draw as empty boxes.
    value = value.replace(invalidXml, '').replace(noGlyph, '').replace(/\s{2,}/g, ' ').trim();
    if (textWidth(value, size, face) <= room) return value;
    const chars = Array.from(value);
    while (chars.length > 1 && textWidth(`${chars.join('').trimEnd()}…`, size, face) > room) chars.pop();
    return `${chars.join('').trimEnd()}…`;
  };
  // Every seat number shares one size, set by the widest number in the room (11 down to 7), so a row reads evenly;
  // an unusually long number is cut, and the seat's title keeps the full label. Each distinct number is fitted once.
  const numbers = new Map<string, string>();
  for (const s of seats) numbers.set(seatNumber(s), '');
  const numberSize = round(Math.max(7, Math.min(11, (SEAT - 8) / Math.max(...[...numbers.keys()].map(n => textWidth(n, 1, 'strong')), 0.001))));
  for (const n of numbers.keys()) numbers.set(n, fit(n, numberSize, SEAT - 4, 'strong'));
  // The answer first: the free count in amber at the top right, and only confirmed seats count as free.
  const free = String(counts.available), of = `libres${counts.unknown ? ' confirmados' : ''} de ${seats.length}`;
  const stat = Math.max(textWidth(free, 30, 'display'), textWidth(of, 12));
  out.push(`<text x="${right}" y="${y + 24}" font-family="${fonts.display}" font-size="30" font-weight="700" fill="${ink.amber}" text-anchor="end">${free}</text>`);
  out.push(`<text x="${right}" y="${y + 44}" font-size="12" fill="${ink.dust}" text-anchor="end">${of}</text>`);
  const room = width - PAD * 2 - stat - 24;
  out.push(`<text x="${PAD}" y="${y + 20}" font-family="${fonts.display}" font-size="22" font-weight="700" letter-spacing="-0.4" fill="${ink.cream}">${escape(fit(header.movie ?? '', 22, room, 'display') || 'Mapa de asientos')}</text>`);
  const provider = providerNames[header.provider] ?? header.provider;
  const venue = header.cinema.toLowerCase().startsWith(provider.toLowerCase()) ? header.cinema : `${provider} · ${header.cinema}`;
  const when = [header.date?.split('-').reverse().join('/'), header.time].filter(Boolean).join(' ');
  const lines = [[venue, header.screen], [when, `Función ${header.session}`]].map(l => l.filter(Boolean).join(' · '));
  lines.forEach((line, i) => out.push(`<text x="${PAD}" y="${y + 44 + i * 18}" font-size="13" fill="${ink.dust}">${escape(fit(line, 13, room))}</text>`));
  y += 88;
  // The screen: a thin lit arc, as on the site; flat, with no glow or shadow.
  const screen = (top: number, side: 'top' | 'bottom') => {
    const x0 = left + 6, x1 = left + gridWidth - 6, mid = (x0 + x1) / 2;
    const [edge, bow, label] = side === 'top' ? [top + 2, top + 18, top + 36] : [top + 30, top + 14, top + 6];
    out.push(`<path d="M ${x0} ${edge} Q ${mid} ${bow} ${x1} ${edge}" fill="none" stroke="${ink.cream}" stroke-width="2.5" stroke-linecap="round"/>`);
    out.push(`<text x="${mid}" y="${label}" font-size="10.5" font-weight="600" fill="${ink.dust}" text-anchor="middle" letter-spacing="3.4">PANTALLA</text>`);
  };
  if (layout.screen === 'top') { screen(y, 'top'); y += 52; }
  for (const g of groups) {
    if (showAreaNames) { out.push(`<text x="${left}" y="${y + 12}" font-size="12" font-weight="600" fill="${ink.dust}">${escape(`Área ${g.area}`)}</text>`); y += 22; }
    // Row names and seat numbers are semibold and centred; they inherit that from one group per area.
    out.push('<g font-weight="600" text-anchor="middle">');
    for (let r = 0; r < g.rows; r++) {
      const rowSeats = g.group.filter(s => s.row_index - g.minRow === r);
      const cy = y + r * CELL;
      const name = rowSeats[0]?.row;
      if (name) {
        const shown = escape(fit(name, 12, label - 14, 'strong'));
        out.push(`<text x="${left - label / 2}" y="${cy + SEAT_H / 2 + 4}" font-size="12" fill="${ink.faint}">${shown}</text>`);
        out.push(`<text x="${left + gridWidth + label / 2}" y="${cy + SEAT_H / 2 + 4}" font-size="12" fill="${ink.faint}">${shown}</text>`);
      }
      for (const s of rowSeats) {
        const col = place(s) - minCol, shown = layout.column_order === 'descending' ? cols - 1 - col : col;
        const kind = kindOf(s), x = left + shown * CELL + (CELL - SEAT) / 2, c = palette[kind], number = seatNumber(s);
        const size = numberSize, fitted = numbers.get(number) ?? number;
        out.push(`<g><title>${escape(`${s.label}: ${c.name.toLowerCase()}`)}</title><rect x="${x}" y="${cy}" width="${SEAT}" height="${SEAT_H}" rx="4" ${seatPaint(kind, 1)}/>`
          + (kind === 'accessible' ? wheelchair(x, cy, c.text) : `<text x="${x + SEAT / 2}" y="${round(cy + SEAT_H / 2 + size / 2.8 - 1)}" font-size="${size}" fill="${c.text}">${escape(fitted)}</text>`) + '</g>');
      }
    }
    out.push('</g>');
    y += g.rows * CELL + 14;
  }
  if (layout.screen === 'bottom') { screen(y, 'bottom'); y += 46; }
  y += 8;
  // The legend wraps instead of running off a narrow map.
  const legend = kinds.filter(k => k === 'available' || k === 'occupied' || drawn[k] > 0);
  let lx = PAD;
  for (const k of legend) {
    const label = `${palette[k].name} (${drawn[k]})`, item = 24 + textWidth(label, 12.5);
    if (lx > PAD && lx + item > right) { lx = PAD; y += 24; }
    out.push(`<rect x="${lx}" y="${y + 1}" width="17" height="14.5" rx="3" ${seatPaint(k, 1.25)}/>`);
    out.push(`<text x="${lx + 24}" y="${y + 12.5}" font-size="12.5" fill="${ink.dust}">${escape(label)}</text>`);
    lx += item + 22;
  }
  y += 34;
  const notes = [
    ...(layout.screen === 'unverified' ? ['La web del cine no indica el lado de la pantalla; filas y asientos como en su mapa.'] : []),
    ...(counts.unknown ? ['Desconocido: Cinve no pudo interpretar el estado; no significa libre ni agotado.'] : []),
    'Solo consulta: no reserva asientos. La disponibilidad puede cambiar antes de comprar.',
  ];
  for (const note of notes) { out.push(`<text x="${PAD}" y="${y + 10}" font-size="11" fill="${ink.faint}">${escape(note)}</text>`); y += 17; }
  // A rule, then when it was read and whose map it is.
  y += 10;
  out.push(`<path d="M ${PAD} ${y} H ${right}" stroke="${ink.line}"/>`);
  out.push(`<text x="${PAD}" y="${y + 26}" font-size="11.5" fill="${ink.dust}">Consultado ${caracasTime(header.queriedAt)}, hora de Caracas.</text>`);
  out.push(`<text x="${right}" y="${y + 28}" font-family="${fonts.display}" font-size="20" font-weight="700" letter-spacing="-0.6" fill="${ink.cream}" text-anchor="end">cinve<tspan fill="${ink.amber}">.</tspan></text>`);
  const height = y + 40 + PAD - 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${fonts.text}">`
    + `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="${ink.night}" stroke="${ink.rim}"/>${out.join('')}</svg>`;
}

/** A seat's paint: a solid fill, plus an outline (dashed when restricted) for the states drawn as outlines. */
function seatPaint(status: SeatKind, strokeWidth: number) {
  const c = palette[status];
  return `fill="${c.fill}"${c.stroke ? ` stroke="${c.stroke}" stroke-width="${strokeWidth}"${c.dash ? ' stroke-dasharray="3 2"' : ''}` : ''}`;
}

const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url));
// initWasm may succeed only once per process, so its promise is kept apart from
// the fonts: a font failure is retried on the next call without re-initializing.
let wasmReady: Promise<void> | undefined, fontFiles: Uint8Array[] | undefined;
/** resvg needs its WebAssembly and real font files; both ship in src/assets/ (dist/assets/ once built). */
async function renderer() {
  await (wasmReady ??= (async () => {
    let wasm: Buffer;
    try { wasm = asset('resvg.wasm'); } catch { wasm = readFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')); }
    await initWasm(wasm);
  })().catch(error => {
    // initWasm refuses any second call; that refusal means the module is ready.
    if (/already initialized/i.test(String(error))) return;
    wasmReady = undefined;
    throw error;
  }));
  // Static, Latin-only instances of the site's variable fonts: resvg reads only static faces, and smaller files parse faster on every render.
  return { fonts: fontFiles ??= ['instrument-sans-400.ttf', 'instrument-sans-600.ttf', 'bricolage-grotesque-750.ttf'].map(name => new Uint8Array(asset(name))) };
}

/** Rasterizes the map for clients that show images inline; at most 1200 px wide and MAX_PNG_PIXELS in all. */
export async function renderSeatMapPng(svg: string): Promise<Uint8Array> {
  const { fonts } = await renderer();
  const width = Number(svg.match(/width="(\d+(?:\.\d+)?)"/)?.[1] ?? 800), height = Number(svg.match(/height="(\d+(?:\.\d+)?)"/)?.[1] ?? 800);
  // Width alone does not bound the raster: scale so the output stays within MAX_PNG_PIXELS.
  const scale = Math.min(1.5, 1200 / width, Math.sqrt(MAX_PNG_PIXELS / (width * height)));
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.floor(width * scale)) },
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Instrument Sans' },
  });
  // free() after a failed render throws its own error; keep the original one.
  const release = (o: { free(): void }) => { try { o.free(); } catch { /* already released by the failure */ } };
  let pixels: Uint8Array, w: number, h: number;
  try {
    const image = resvg.render();
    // Copy the pixels out and free the WebAssembly side before encoding, so the
    // module's memory (which never shrinks) does not also hold the PNG.
    try { pixels = image.pixels; w = image.width; h = image.height; } finally { release(image); }
  } finally { release(resvg); }
  try { return encodeIndexedPng(pixels, w, h); } finally { discard(pixels); }
}

/**
 * Frees a large buffer this module owns now instead of at the next GC: under
 * repeated renders, uncollected multi-megabyte copies raised peak RSS by about 25 MB.
 */
function discard(bytes: Uint8Array) {
  // ArrayBuffer.prototype.transfer is ES2024 (Node 21+); the ES2022 lib does not declare it.
  const buffer = bytes.buffer as ArrayBuffer & { transfer?: (length: number) => ArrayBuffer };
  if (bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) try { buffer.transfer?.(0); } catch { /* not detachable; GC frees it */ }
}

// Colours the SVG draws solid; the PNG palette always keeps them exact, however few pixels use them.
const solidInks = [...new Set([...Object.values(palette).flatMap(c => [c.fill, c.stroke, c.text]), ...Object.values(ink)].filter(c => c !== undefined))];
/** tiny-skia's premultiplied little-endian 0xAABBGGRR for an #rrggbb colour at alpha `a`. */
const premultiplied = (hex: string, a: number) => {
  const v = parseInt(hex.slice(1), 16), c = (shift: number) => Math.round((v >>> shift & 255) * a / 255);
  return (a << 24 | c(0) << 16 | c(8) << 8 | c(16)) >>> 0;
};
/**
 * Element `i` of a typed array at an index the caller has already bounded (a
 * masked hash slot, a loop over the array's own length). Out of range is a
 * bug in this encoder, never something an image can cause.
 */
function entry(array: Uint8Array | Uint32Array | Int32Array | Float64Array, i: number): number {
  const value = array[i];
  if (value === undefined) throw new RangeError(`Index ${i} is outside a ${array.length}-element buffer.`);
  return value;
}
const crcTable = Int32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n; });
const pngChunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); out.set(data, 8);
  let crc = -1;
  for (const byte of out.subarray(4, 8 + data.length)) crc = entry(crcTable, (crc ^ byte) & 255) ^ (crc >>> 8);
  out.writeUInt32BE(~crc >>> 0, 8 + data.length);
  return out;
};
/**
 * An 8-bit indexed PNG of tiny-skia's premultiplied RGBA. A map has a dozen solid
 * colours plus their anti-aliased edges (a few hundred in all), so a 256-colour
 * palette keeps every solid colour exact, moves only rare edge pixels slightly,
 * and is about a third of resvg's RGBA PNG, encoded faster by Node's zlib.
 */
export function encodeIndexedPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  if (rgba.length < n * 4) throw new Error('Imagen incompleta.');
  const px = rgba.byteOffset % 4 ? new Uint32Array(rgba.slice(0, n * 4).buffer) : new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  // Distinct colours (little-endian 0xAABBGGRR) in an open-addressing table, counted per run of equal pixels.
  let keys = new Uint32Array(4096), used = new Uint8Array(4096), counts = new Float64Array(4096), size = 0;
  const find = (p: number) => {
    const mask = keys.length - 1;
    const hash = Math.imul(p, 0x9e3779b1);
    let i = (hash ^ hash >>> 16) & mask;
    while (used[i] && keys[i] !== p) i = (i + 1) & mask;
    return i;
  };
  const count = (p: number, runs: number) => {
    let i = find(p);
    if (!used[i]) {
      if (++size * 2 > keys.length) {
        const [k, u, c] = [keys, used, counts];
        keys = new Uint32Array(k.length * 2); used = new Uint8Array(k.length * 2); counts = new Float64Array(k.length * 2);
        for (const [j, key] of k.entries()) if (u[j]) { const at = find(key); used[at] = 1; keys[at] = key; counts[at] = entry(c, j); }
        i = find(p);
      }
      used[i] = 1; keys[i] = p;
    }
    counts[i] = entry(counts, i) + runs;
  };
  // -1 equals no 32-bit pixel, so the first pixel starts the first run.
  let prev = -1, run = 0;
  for (let i = 0; i < px.length; i++) {
    const p = entry(px, i);
    if (p === prev) { run++; continue; }
    if (run) count(prev, run);
    prev = p; run = 1;
  }
  if (run) count(prev, run);
  const slot = new Uint8Array(keys.length), colors: number[] = [];
  const take = (p: number) => {
    const i = find(p);
    if (used[i] && entry(counts, i) < 0) return;
    if (used[i]) { slot[i] = colors.length; counts[i] = -1; }
    if (colors.length < 256) colors.push(p);
  };
  // Transparent and translucent rim: the card's anti-aliased rounded corners. Then the solid inks, then the most frequent.
  for (let a = 0; a < 255; a += 17) take(premultiplied(ink.rim, a));
  for (const colour of solidInks) take(premultiplied(colour, 255));
  const present: number[] = [];
  for (let i = 0; i < keys.length; i++) if (used[i] && entry(counts, i) >= 0) present.push(i);
  present.sort((a, b) => entry(counts, b) - entry(counts, a));
  for (const i of present.splice(0, Math.max(0, 256 - colors.length))) { slot[i] = colors.length; counts[i] = -1; colors.push(entry(keys, i)); }
  // Any rarer colour takes the entry that looks closest over both a white and a black background.
  for (const i of present) {
    const p = entry(keys, i);
    let best = 0, bestError = Infinity;
    for (const [j, q] of colors.entries()) {
      const r = (p & 255) - (q & 255), g = (p >>> 8 & 255) - (q >>> 8 & 255), b = (p >>> 16 & 255) - (q >>> 16 & 255), a = (p >>> 24) - (q >>> 24);
      const error = r * r + g * g + b * b + (r - a) ** 2 + (g - a) ** 2 + (b - a) ** 2;
      if (error < bestError) { bestError = error; best = j; }
    }
    slot[i] = best;
  }
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0, o = 0, prev = -1, index = 0; y < height; y++) {
    raw[o++] = 0; // filter type None, the usual best for indexed images
    for (let x = 0, i = y * width; x < width; x++, i++) { const p = entry(px, i); if (p !== prev) { prev = p; index = entry(slot, find(p)); } raw[o++] = index; }
  }
  let idat: Uint8Array;
  try { idat = deflateSync(raw); } finally { discard(raw); }
  const plte = new Uint8Array(colors.length * 3), trns = new Uint8Array(colors.length);
  let translucent = 0;
  colors.forEach((p, j) => {
    const a = p >>> 24, straight = (c: number) => a ? Math.min(255, Math.round(c * 255 / a)) : 0;
    plte.set([straight(p & 255), straight(p >>> 8 & 255), straight(p >>> 16 & 255)], j * 3); trns[j] = a;
    if (a < 255) translucent = j + 1;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 3; // 8-bit, indexed colour
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('PLTE', plte),
    ...(translucent ? [pngChunk('tRNS', trns.subarray(0, translucent))] : []), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array())]);
}
