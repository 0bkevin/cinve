import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

export type SeatStatus = 'available' | 'occupied' | 'unavailable' | 'unknown';
export type MapSeat = { label: string; row: string; area: string; row_index: number; column_index: number; status: SeatStatus };
/** The provider-verified orientation from SeatResult.layout. */
export type MapLayout = { screen: 'top' | 'bottom' | 'unverified'; column_order: 'ascending' | 'descending' };
/** cinema: the venue's name when known, else its ID. The rest, when the provider named them, label the function. */
export type MapHeader = { provider: string; cinema: string; session: string; queriedAt: string; movie?: string; screen?: string; date?: string; time?: string };

const providerNames: Record<string, string> = { cinex: 'Cinex', cinesunidos: 'Cines Unidos', cinepic: 'Cinepic' };
const palette: Record<SeatStatus, { fill: string; stroke: string; text: string; name: string }> = {
  available: { fill: '#1e8e3e', stroke: '#176f30', text: '#ffffff', name: 'Libre' },
  occupied: { fill: '#80868b', stroke: '#5f6368', text: '#ffffff', name: 'Ocupado' },
  unavailable: { fill: '#eceff1', stroke: '#9aa0a6', text: '#5f6368', name: 'No disponible' },
  unknown: { fill: '#f9ab00', stroke: '#c58900', text: '#202124', name: 'Desconocido' },
};
const CELL = 30, SEAT = 26, LABEL = 30, PAD = 28;

/** Characters XML 1.0 forbids (controls, lone surrogates, U+FFFE/FFFF); resvg and SVG viewers reject the whole document for one of them. */
const invalidXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const escape = (value: string) => value.replace(invalidXml, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Thrown before drawing a map whose image would exceed MAX_MAP_HEIGHT; the data answer is unaffected. */
export class MapTooLarge extends Error {}
/** In SVG units: about 90 rows of seats, far above any room seen (13-16 rows). */
export const MAX_MAP_HEIGHT = 3000;
/** Output pixels per PNG: about 12 MB of RGBA. Taller maps are scaled down instead of refused. */
export const MAX_PNG_PIXELS = 3_000_000;
// Advance widths of the bundled Inter (per mille of an em) for ASCII 32-126,
// read from src/assets with fontTools, so header text is fitted to the real glyphs.
const advances = {
  400: [281,288,466,633,642,982,644,300,365,365,501,662,288,460,288,360,631,407,610,618,646,593,620,566,619,620,288,302,662,662,662,511,966,690,654,730,722,601,590,746,743,269,571,672,565,903,753,765,639,765,644,642,646,744,690,985,682,679,629,365,360,365,471,456,323,562,612,571,612,583,370,613,591,242,242,549,242,876,591,600,612,612,376,528,327,591,562,818,546,562,552,426,333,426,662],
  700: [237,338,551,649,655,1016,672,339,377,377,559,679,334,468,334,388,674,431,629,646,676,622,649,582,651,649,334,343,679,679,679,560,1016,747,662,740,722,607,587,750,747,281,584,719,565,932,762,771,648,777,657,655,667,732,747,1038,738,731,664,377,388,377,487,476,365,581,630,588,630,596,398,632,623,271,271,580,271,913,623,613,630,630,407,560,366,623,600,850,580,602,573,469,372,469,679],
};
/** Text width in SVG units. Accents count as their base letter; glyphs outside the Latin font as a full em. */
export function textWidth(value: string, size: number, bold = false): number {
  const table = advances[bold ? 700 : 400];
  let em = 0;
  for (const char of value) {
    const code = char.normalize('NFD').charCodeAt(0);
    em += code >= 32 && code <= 126 ? table[code - 32] / 1000 : 1;
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

/** A self-contained SVG of the seat map, oriented as the provider's own seat page. */
export function renderSeatMapSvg(seats: MapSeat[], layout: MapLayout, header: MapHeader): string {
  const areas = [...new Set(seats.map(s => s.area))];
  const showAreaNames = areas.length > 1;
  // Columns share one scale across areas, as in the ASCII map, so an area keeps its horizontal place.
  const minCol = Math.min(...seats.map(s => s.column_index)), cols = Math.max(...seats.map(s => s.column_index)) - minCol + 1;
  const groups = areas.map(area => {
    const group = seats.filter(s => s.area === area);
    const minRow = Math.min(...group.map(s => s.row_index)), maxRow = Math.max(...group.map(s => s.row_index));
    return { area, group, minRow, rows: maxRow - minRow + 1 };
  });
  const rowsHeight = groups.reduce((sum, g) => sum + g.rows * CELL + 14 + (areas.length > 1 ? 22 : 0), 0);
  if (rowsHeight > MAX_MAP_HEIGHT) throw new MapTooLarge('El mapa es demasiado grande para dibujarlo como imagen.');
  const gridWidth = cols * CELL;
  const width = Math.max(PAD * 2 + LABEL * 2 + gridWidth, 560);
  const left = (width - gridWidth) / 2;
  const out: string[] = [];
  let y = PAD;
  const fit = (value: string, size: number, room: number, bold = false) => {
    value = value.replace(invalidXml, '');
    if (textWidth(value, size, bold) <= room) return value;
    const chars = Array.from(value);
    while (chars.length > 1 && textWidth(`${chars.join('').trimEnd()}…`, size, bold) > room) chars.pop();
    return `${chars.join('').trimEnd()}…`;
  };
  out.push(`<text x="${PAD}" y="${y + 18}" font-size="20" font-weight="700" fill="#202124">${escape(fit(header.movie ?? 'Mapa de asientos', 20, width - PAD * 2, true))}</text>`);
  const provider = providerNames[header.provider] ?? header.provider;
  const venue = header.cinema.toLowerCase().startsWith(provider.toLowerCase()) ? header.cinema : `${provider} · ${header.cinema}`;
  const when = [header.date?.split('-').reverse().join('/'), header.time].filter(Boolean).join(' ');
  const lines = [[venue, header.screen], [when, `Función ${header.session}`]].map(l => l.filter(Boolean).join(' · '));
  lines.forEach((line, i) => out.push(`<text x="${PAD}" y="${y + 40 + i * 18}" font-size="13" fill="#5f6368">${escape(fit(line, 13, width - PAD * 2))}</text>`));
  y += 82;
  // The screen arc bows toward the seats, with its label on the seat side.
  const screen = (top: number, side: 'top' | 'bottom') => {
    const x0 = left, x1 = left + gridWidth, mid = (x0 + x1) / 2;
    const [edge, bow, label] = side === 'top' ? [top + 2, top + 18, top + 34] : [top + 30, top + 14, top + 8];
    out.push(`<path d="M ${x0} ${edge} Q ${mid} ${bow} ${x1} ${edge}" fill="none" stroke="#9aa0a6" stroke-width="5" stroke-linecap="round"/>`);
    out.push(`<text x="${mid}" y="${label}" font-size="11" font-weight="700" fill="#80868b" text-anchor="middle" letter-spacing="3">PANTALLA</text>`);
  };
  if (layout.screen === 'top') { screen(y, 'top'); y += 50; }
  for (const g of groups) {
    if (showAreaNames) { out.push(`<text x="${left}" y="${y + 12}" font-size="12" font-weight="700" fill="#3c4043">${escape(`Área ${g.area}`)}</text>`); y += 22; }
    // Row names and seat numbers are bold and centred; they inherit that from one group per area.
    out.push('<g font-weight="700" text-anchor="middle">');
    for (let r = 0; r < g.rows; r++) {
      const rowSeats = g.group.filter(s => s.row_index - g.minRow === r);
      const cy = y + r * CELL;
      const name = rowSeats[0]?.row;
      if (name) {
        out.push(`<text x="${left - LABEL / 2}" y="${cy + SEAT / 2 + 4}" font-size="12" fill="#5f6368">${escape(name)}</text>`);
        out.push(`<text x="${left + gridWidth + LABEL / 2}" y="${cy + SEAT / 2 + 4}" font-size="12" fill="#5f6368">${escape(name)}</text>`);
      }
      for (const s of rowSeats) {
        const col = s.column_index - minCol, shown = layout.column_order === 'descending' ? cols - 1 - col : col;
        const x = left + shown * CELL + (CELL - SEAT) / 2, c = palette[s.status], number = seatNumber(s);
        const size = number.length > 3 ? 8 : number.length === 3 ? 9.5 : 11;
        out.push(`<g><title>${escape(`${s.label}: ${c.name.toLowerCase()}`)}</title><rect x="${x}" y="${cy}" width="${SEAT}" height="${SEAT}" rx="6" fill="${c.fill}" stroke="${c.stroke}"${s.status === 'unavailable' ? ' stroke-dasharray="3 2"' : ''}/>`
          + `<text x="${x + SEAT / 2}" y="${round(cy + SEAT / 2 + size / 2.8)}" font-size="${size}" fill="${c.text}">${escape(number)}</text></g>`);
      }
    }
    out.push('</g>');
    y += g.rows * CELL + 14;
  }
  if (layout.screen === 'bottom') { screen(y, 'bottom'); y += 44; }
  y += 6;
  const counts = Object.fromEntries((Object.keys(palette) as SeatStatus[]).map(k => [k, seats.filter(s => s.status === k).length])) as Record<SeatStatus, number>;
  const legend = (Object.keys(palette) as SeatStatus[]).filter(k => k === 'available' || k === 'occupied' || counts[k] > 0);
  let lx = PAD;
  for (const k of legend) {
    const c = palette[k], label = `${c.name} (${counts[k]})`;
    out.push(`<rect x="${lx}" y="${y}" width="16" height="16" rx="4" fill="${c.fill}" stroke="${c.stroke}"${k === 'unavailable' ? ' stroke-dasharray="3 2"' : ''}/>`);
    out.push(`<text x="${lx + 22}" y="${y + 12.5}" font-size="12" fill="#3c4043">${escape(label)}</text>`);
    lx += 22 + textWidth(label, 12) + 22;
  }
  // On narrow maps a full legend reaches the total; give the total its own line then.
  const total = `${counts.available} libres de ${seats.length}`;
  if (lx > width - PAD - textWidth(total, 12, true)) y += 24;
  out.push(`<text x="${width - PAD}" y="${y + 12.5}" font-size="12" font-weight="700" fill="#202124" text-anchor="end">${total}</text>`);
  y += 32;
  const notes = [
    `Consultado ${caracasTime(header.queriedAt)}, hora de Caracas.`,
    ...(layout.screen === 'unverified' ? ['La web del cine no indica el lado de la pantalla; filas y asientos como en su mapa.'] : []),
    ...(counts.unknown ? ['Desconocido: Cinve no pudo interpretar el estado; no significa libre ni agotado.'] : []),
    'Solo consulta: no reserva asientos. La disponibilidad puede cambiar antes de comprar.',
  ];
  for (const note of notes) { out.push(`<text x="${PAD}" y="${y + 10}" font-size="11" fill="#80868b">${escape(note)}</text>`); y += 17; }
  const height = y + PAD - 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, 'Helvetica Neue', Arial, sans-serif">`
    + `<rect width="${width}" height="${height}" rx="14" fill="#ffffff"/>${out.join('')}</svg>`;
}

const asset = (name: string) => readFileSync(new URL(`./assets/${name}`, import.meta.url));
// initWasm may succeed only once per process, so its promise is kept apart from
// the fonts: a font failure is retried on the next call without re-initializing.
let wasmReady: Promise<void> | undefined, fonts: Uint8Array[] | undefined;
/** resvg needs its WebAssembly and real font files; both ship in assets/. */
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
  return { fonts: fonts ??= [asset('inter-latin-400.ttf'), asset('inter-latin-700.ttf')].map(b => new Uint8Array(b)) };
}

/** Rasterizes the map for clients that show images inline; at most 1200 px wide and MAX_PNG_PIXELS in all. */
export async function renderSeatMapPng(svg: string): Promise<Uint8Array> {
  const { fonts } = await renderer();
  const width = Number(svg.match(/width="(\d+(?:\.\d+)?)"/)?.[1] ?? 800), height = Number(svg.match(/height="(\d+(?:\.\d+)?)"/)?.[1] ?? 800);
  // Width alone does not bound the raster: scale so the output stays within MAX_PNG_PIXELS.
  const scale = Math.min(1.5, 1200 / width, Math.sqrt(MAX_PNG_PIXELS / (width * height)));
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.floor(width * scale)) },
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  // free() after a failed render throws its own error; keep the original one.
  const release = (o: { free(): void }) => { try { o.free(); } catch { /* already released by the failure */ } };
  try {
    const image = resvg.render();
    try { return image.asPng(); } finally { release(image); }
  } finally { release(resvg); }
}
