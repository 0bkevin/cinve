import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { LinkButton } from '../ui.js';
import { catalog } from '../content.js';
import { localeUrl, type Locale } from '../locale.js';

// "404" spelled out in lit seats: three blocks of 5 seats split by aisles,
// rows A–I. # is a lit seat, . a taken one.
const digits = {
  4: ['#...#', '#...#', '#...#', '#####', '....#', '....#', '....#'],
  0: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
};
const empty = '.'.repeat(15);
const rows = [empty, ...digits[4].map((four, r) => four + digits[0][r] + four), empty];

function LostHouse({ label, screen }: { label: string; screen: string }) {
  return <figure class="lost-house" role="img" aria-label={label}>
    <div class="lost-screen" aria-hidden="true"><span>{screen}</span></div>
    <div class="lost-seats" aria-hidden="true">
      {rows.map((row, r) => <div class="lost-row">
        <b>{'ABCDEFGHI'[r]}</b>
        {[...row].map(code => <i data-state={code === '#' ? 'lit' : 'taken'}></i>)}
      </div>)}
    </div>
  </figure>;
}

export function notFoundPage(locale: Locale = 'es', path = '/') {
  const c = catalog(locale).notFound;
  const screen = catalog(locale).landing.demo.screen;
  return renderPage(c.title, <>
    <section class="lost">
      <div class="lost-copy">
        <p class="lost-code">{c.code}</p>
        <h1>{c.heading}</h1>
        <p class="lead">{c.lead}</p>
        <div class="lost-actions">
          <LinkButton href={localeUrl('/', locale)} size="lg">{c.home}</LinkButton>
          <LinkButton href={localeUrl('/#empezar', locale)} size="lg" variant="outline">{c.start}</LinkButton>
        </div>
      </div>
      <LostHouse label={c.seatMap} screen={screen} />
    </section>
  </>, { locale, path });
}
