import { DataError } from '../core.js';
import type { Layout, SeatData } from './schema.js';

export function renderSeats(seats: SeatData[], layout: Layout = { screen: 'unverified', column_order: 'ascending' }): string {
  const symbols = { available: 'O', occupied: 'X', unavailable: '-', unknown: '?' };
  const lines = ['O libre | X ocupado | - restringido/no disponible | ? desconocido',
    layout.screen === 'unverified' ? 'Filas y columnas como la web del proveedor, que no indica el lado de la pantalla.' : `Orientado como la web del proveedor: pantalla ${layout.screen === 'top' ? 'arriba' : 'abajo'}.`];
  const screen = '[ PANTALLA ]';
  if (layout.screen === 'top') lines.push(screen);
  let cells = 0;
  for (const area of [...new Set(seats.map(s => s.area))]) {
    const group = seats.filter(s => s.area === area);
    const width = Math.max(...group.map(s => s.label.length)) + 2;
    const maxColumn = Math.max(...group.map(s => s.column_index));
    const place = (s: SeatData) => s.column_index + (layout.row_shift?.[s.row] ?? 0);
    // Column 0 stays at the left edge (descending: the highest place does), as before shifts existed.
    const highest = Math.max(...group.map(place));
    const shownAt = (s: SeatData) => layout.column_order === 'descending' ? highest - place(s) : place(s);
    cells += (maxColumn + 1) * (Math.max(...group.map(s => s.row_index)) + 1);
    if (cells > 40000) throw new DataError('unavailable', 'El mapa excede el tamaño máximo de representación ASCII.');
    lines.push(`Area ${area}`);
    for (let row = 0; row <= Math.max(...group.map(s => s.row_index)); row++) {
      const rowSeats = group.filter(s => s.row_index === row);
      if (!rowSeats.length) { lines.push(''); continue; }
      // Each seat starts at its place times the column width; a row the provider centers
      // carries its shift (half a seat is half a column), on either column order.
      let line = '';
      for (const s of [...rowSeats].sort((a, b) => shownAt(a) - shownAt(b))) {
        line = line.padEnd(Math.round(shownAt(s) * width)) + `${s.label}${symbols[s.status]}`;
      }
      lines.push(line);
    }
  }
  if (layout.screen === 'bottom') lines.push(screen);
  return lines.join('\n');
}
