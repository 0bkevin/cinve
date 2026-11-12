// Illustrative seat maps: the hero's house and the sample conversation's
// answer. Both are fixed so every load looks the same, and both use the same
// seat states (styled by [data-state] in site.css).
import { h } from '../jsx.js';
import { catalog } from '../content.js';
import type { Locale } from '../locale.js';

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

export function SeatMap({ locale = 'es' }: { locale?: Locale }) {
  const text = catalog(locale).landing.demo;
  return <div class="seating" role="img" aria-label={text.seatMap}>
    <div class="screen"><span>{text.screen}</span></div>
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
export function ChatDemo({ locale = 'es' }: { locale?: Locale }) {
  const text = catalog(locale).landing.demo;
  return <figure class="demo" aria-label={text.figure}>
    <p class="demo-me" data-text={text.question}>{text.question}</p>
    <div class="demo-bot">
      <div class="demo-who"><span class="demo-dot"></span>{text.assistant}<span class="demo-sep">·</span>{text.withCinve}</div>
      <div class="demo-thinking" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="demo-answer">
        <p>{text.yes}</p>
        <div class="demo-map" aria-hidden="true">
          <div class="demo-screen"></div>
          {demoRows.map((row, r) => <div class="demo-row"><b>{'ABCD'[r]}</b>{states(row).map(state => <i data-state={state}></i>)}</div>)}
        </div>
        <div class="demo-key" aria-hidden="true"><span><i data-state="free"></i>{text.free}</span><span><i data-state="taken"></i>{text.taken}</span><span><i data-state="pair"></i>{text.pair}</span></div>
      </div>
    </div>
  </figure>;
}
