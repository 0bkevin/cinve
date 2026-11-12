import { h } from '../jsx.js';
import { icons } from '../ui.js';
import { accessLabel, cinemas, coverage, catalog } from '../content.js';
import type { Locale } from '../locale.js';

/** What each cinema offers. Below 900px CSS turns it into one list per topic,
 *  so each cell repeats its cinema's name. */
export function Coverage({ locale = 'es' }: { locale?: Locale }) {
  const rows = coverage(locale);
  return <div class="board-scroll"><table class="board">
    <caption class="visually-hidden">{catalog(locale).landing.coverageCaption}</caption>
    <thead><tr><td></td>{cinemas.map(name => <th scope="col">{name}</th>)}</tr></thead>
    <tbody>
      {rows.map(({ topic, ask, access }) => <tr>
        <th scope="row"><span class="topic">{topic}</span><span class="ask">{ask}</span></th>
        {access.map((level, i) => <td data-access={level}>
          <span class="cell-cinema">{cinemas[i]}</span>
          <span class="mark"><span class="glyph" aria-hidden="true">{level === 'account' && icons.lock()}</span>{accessLabel(locale)[level]}</span>
        </td>)}
      </tr>)}
    </tbody>
  </table></div>;
}
