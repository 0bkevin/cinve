import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { catalog, structuredData } from '../src/web/content.js';
import { canonicalUrl, localeUrl, resolveLocale, type Locale } from '../src/web/locale.js';
import { landingPage, installationPage, instructionsPage, authorizationPage, authorizationErrorPage, notFoundPage } from '../src/public-web.js';
import { loginPage } from '../src/auth-web.js';
import { serverInstructions } from '../src/agent-instructions.js';

const origin = 'https://cinve.example';

test('locale selection honors explicit URL, weighted regional languages, and Spanish fallback', () => {
  const cases: [string, string, Locale][] = [
    ['?lang=es', 'en-US,en;q=0.9', 'es'], ['?lang=en', 'es-VE', 'en'],
    ['', 'en-GB,en;q=0.9,es;q=0.8', 'en'], ['', 'en;q=0.2,es-VE;q=0.9', 'es'],
    ['', 'fr-CA, en-US;q=0.7, es;q=0.6', 'en'], ['', 'en;q=0,es;q=0.5', 'es'],
    ['', 'en;q=garbage, es;q=0.8', 'es'], ['', 'en;q=1.1,es;q=0.8', 'es'],
    ['', 'en;q=0.5,es;q=0.5', 'en'], ['', 'fr,de', 'es'], ['', '', 'es'],
    ['?lang=fr', 'en', 'en'], ['?lang=<script>', '', 'es'],
  ];
  for (const [query, header, expected] of cases) assert.equal(resolveLocale(new URL(origin + '/' + query), header), expected, `${query} / ${header}`);
});

test('locale links preserve OAuth fields and fragments and replace an existing language', () => {
  const path = '/oauth/authorize?client_id=https%3A%2F%2Fapp.example&state=a%26b&lang=es#private';
  const localized = new URL(localeUrl(path, 'en'), origin);
  assert.equal(localized.searchParams.get('lang'), 'en');
  assert.equal(localized.searchParams.get('state'), 'a&b');
  assert.equal(localized.searchParams.get('client_id'), 'https://app.example');
  assert.equal(localized.hash, '#private');
  assert.equal(canonicalUrl(origin + '/?lang=es', 'es'), origin + '/');
});

function keys(value: unknown, path = ''): string[] {
  if (typeof value === 'string') { assert.ok(value.trim(), path); return [path]; }
  return Object.entries(value as object).flatMap(([key, child]) => keys(child, `${path}.${key}`));
}

test('both catalogs contain the same nonempty keys, including browser and server errors', () => {
  assert.deepEqual(keys(catalog('en')), keys(catalog('es')));
});

test('every view localizes visible text and provides a working language switcher', () => {
  for (const locale of ['es', 'en'] as const) {
    const pages = [landingPage(origin, locale), installationPage(origin, locale), instructionsPage(origin, locale), loginPage(locale), notFoundPage(locale, '/missing?x=1'), authorizationErrorPage(locale),
      authorizationPage({ app: 'App', destination: 'https://app.example', id: 'id', csrf: 'csrf', recognized: false, cinemaLogin: true }, locale)];
    for (const html of pages) {
      const $ = load(html);
      assert.equal($('html').attr('lang'), locale);
      const currentLanguage = locale === 'es' ? 'Español' : 'English';
      assert.equal($('[data-current-locale-label]').text(), currentLanguage);
      assert.equal($('[data-current-locale-label]').attr('lang'), locale);
      assert.equal($(`[data-locale-switch="${locale}"]`).attr('aria-current'), 'page');
      assert.equal($(`[data-locale-check="${locale}"]`).text(), '✓');
      assert.equal($(`[data-locale-check="${locale === 'es' ? 'en' : 'es'}"]`).text(), '');
      assert.equal($('.language-menu').attr('open'), undefined, 'language disclosure starts closed');
      for (const target of ['es', 'en']) {
        const link = $(`[data-locale-switch="${target}"]`);
        assert.equal(new URL(link.attr('href')!, origin).searchParams.get('lang'), target);
        assert.equal(link.attr('lang'), target);
      }
      $('pre, script, noscript').remove(); // Original MCP instructions are deliberately unchanged.
      const visible = $('body').text();
      if (locale === 'en') {
        assert.doesNotMatch(visible, /Qué preguntar|Tus datos|Tu contraseña|Conecta tu|Volver al inicio|Página no encontrada|Cartelera y horarios|Hecho por/);
        assert.match(visible, /What to ask/);
      } else assert.match(visible, /Qué preguntar/);
    }
  }
});

test('localized canonical URLs, reciprocal alternates and social images agree', () => {
  for (const locale of ['es', 'en'] as const) {
    for (const [render, path] of [[landingPage, '/'], [installationPage, '/install'], [instructionsPage, '/instrucciones']] as const) {
      const $ = load(render(origin, locale));
      assert.equal($('link[rel="canonical"]').attr('href'), canonicalUrl(origin + path, locale));
      for (const [target, language] of [['es', 'es'], ['en', 'en'], ['x-default', 'es']] as const) assert.equal($(`link[hreflang="${target}"]`).attr('href'), canonicalUrl(origin + path, language));
      assert.equal($('meta[property="og:locale"]').attr('content'), locale === 'es' ? 'es_VE' : 'en_US');
      assert.match($('meta[property="og:image"]').attr('content')!, locale === 'en' ? /\/og-en\.png\?v=/ : /\/og\.png\?v=/);
      assert.equal($('meta[property="og:url"]').attr('content'), $('link[rel="canonical"]').attr('href'));
    }
    const $ = load(instructionsPage(origin, locale));
    assert.ok($('pre[lang="es"]').text().includes(serverInstructions({ publicHosted: true })));
  }
});

test('structured data reflects each locale, its FAQ, and Venezuelan service coverage', () => {
  for (const locale of ['es', 'en'] as const) {
    const data = structuredData(origin, locale);
    const site = data['@graph'][0]!;
    const app = data['@graph'][1]!;
    assert.equal(site.inLanguage, locale === 'es' ? 'es-VE' : 'en-US');
    assert.equal(app.url, canonicalUrl(origin + '/', locale));
    assert.equal(app.areaServed?.name, 'Venezuela');
    assert.deepEqual(app.mainEntity?.mainEntity.map(q => [q.name, q.acceptedAnswer.text]), catalog(locale).landing.faq);
    assert.doesNotMatch(JSON.stringify(data), /aggregateRating|review|offers/);
  }
});
