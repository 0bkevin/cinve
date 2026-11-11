// Illustrative seat maps: the hero's house and the sample conversation's
// answer. Both are fixed so every load looks the same, and both use the same
// seat states (styled by [data-state] in site.css).
import { h } from '../jsx.js';

// . free  x taken  ? not confirmed  * the free pair
const seatStates = { '.': 'free', x: 'taken', '?': 'unknown', '*': 'pair' } as const;
type SeatCode = keyof typeof seatStates;
const states = (row: string) => [...row].map(code => seatStates[code as SeatCode]);

// Rows A–G, 4 + 10 + 4 seats. On load the seats fill in as taken and the one
// free pair in the middle of row E lights up.
const house: [row: string, seats: string][] = [
  ['A', '..x.xx..xx..x..x..'],
  ['B', '.x...xxxx.xxx...x.'],
  ['C', 'x..xxxx.xxxx.x.x..'],
  ['D', '..xxx.xxxxxx.xx..x'],
  ['E', '.x..xxxx**xx.xx.x.'],
  ['F', 'x.x..xxxxxxxx..x.x'],
  ['G', '..x.xx.xx.xx..????'],
];

export function SeatMap() {
  return <div class="seating" role="img" aria-label="Ejemplo de mapa de una sala: quedan dos asientos libres juntos en el centro de la fila E.">
    <div class="screen"><span>Pantalla</span></div>
    {house.map(([row, seats]) => <div class="row">
      <span class="row-label">{row}</span>
      {states(seats).map(state => <span class="seat" data-state={state}></span>)}
    </div>)}
  </div>;
}

// The sample answer's house: the only adjacent free seats are the lit pair,
// so "quedan dos juntos" is the only true reading.
const demoRows = ['x.x.xx.x.x.x', '.x.xx.x.x.xx', 'x.xxx**xx.x.', '.x.x.xx.x.x.'];

/** A sample exchange, played once when it scrolls into view (site.js): the
 *  question types itself, the assistant thinks, then answers with a seat map.
 *  Without JavaScript or with reduced motion it shows finished. No titles,
 *  prices or times, so nothing is invented. */
export function ChatDemo() {
  return <figure class="demo" aria-label="Ejemplo: preguntas si quedan dos asientos juntos esta noche y tu asistente responde con el mapa de la sala.">
    <p class="demo-me" data-text="¿Quedan dos asientos juntos esta noche?">¿Quedan dos asientos juntos esta noche?</p>
    <div class="demo-bot">
      <div class="demo-who"><span class="demo-dot"></span>Tu asistente<span class="demo-sep">·</span>con Cinve</div>
      <div class="demo-thinking" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="demo-answer">
        <p>Sí, en la fila C quedan dos juntos:</p>
        <div class="demo-map" aria-hidden="true">
          <div class="demo-screen"></div>
          {demoRows.map((row, r) => <div class="demo-row"><b>{'ABCD'[r]}</b>{states(row).map(state => <i data-state={state}></i>)}</div>)}
        </div>
        <div class="demo-key" aria-hidden="true"><span><i data-state="free"></i>Libre</span><span><i data-state="taken"></i>Ocupado</span><span><i data-state="pair"></i>Juntos</span></div>
      </div>
    </div>
  </figure>;
}
