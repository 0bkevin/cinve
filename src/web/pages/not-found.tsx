import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { LinkButton } from '../ui.js';
import { catalog } from '../content.js';
import { localeUrl, type Locale } from '../locale.js';

export function notFoundPage(locale: Locale = 'es', path = '/') {
  const c = catalog(locale).notFound;
  return renderPage(c.title, <>
    {/* An empty row in the hero's style, numbered 404 instead of a letter. */}
    <div class="lost-row" aria-hidden="true">
      <span class="lost-label">404</span>
      {Array.from({ length: 8 }, () => <i></i>)}
    </div>
    <h1>{c.heading}</h1>
    <p class="lead">{c.lead}</p>
    <div class="lost-actions">
      <LinkButton href={localeUrl('/', locale)} size="lg">{c.home}</LinkButton>
      <LinkButton href={localeUrl('/#empezar', locale)} size="lg" variant="outline">{c.start}</LinkButton>
    </div>
  </>, { locale, path, compact: true });
}
