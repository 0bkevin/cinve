import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { InstallMessage } from '../components/copy.js';
import { AppPicker } from '../components/assistants.js';
import { catalog } from '../content.js';
import { localeUrl, type Locale } from '../locale.js';

export const installationPage = (origin: string, locale: Locale = 'es') => {
  const c = catalog(locale).install;
  const canonical = new URL(locale === 'en' ? '/install?lang=en' : '/install', origin).href;
  return renderPage(c.title, <>
    <h1>{c.heading}</h1><p class="lead">{c.lead}</p><InstallMessage origin={origin} locale={locale} />
    <section class="manual" aria-labelledby="mano"><h2 id="mano">{c.manual}</h2><AppPicker endpoint={`${origin}/mcp`} labelledBy="mano" locale={locale} /><p class="note">{c.restart}</p></section>
    <p class="note"><a href={localeUrl('/instrucciones', locale)}>{c.instructionsLink}</a></p>
  </>, { locale, path: '/install', compact: true, script: '/assets/js/site.js', index: true, canonical, description: c.description });
};
