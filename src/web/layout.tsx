import { assetUrl } from './assets.js';
import { h, Fragment, raw, renderDocument, type Child } from './jsx.js';
import { icons } from './ui.js';
import { catalog } from './content.js';
import type { Locale } from './locale.js';
import { canonicalUrl, localeUrl } from './locale.js';

/** Search and social metadata, only for indexable public pages. */
function SocialMeta({ canonical, title, description, locale, path }: { canonical?: string | undefined; title: string; description: string; locale: Locale; path: string }) {
  const copy = catalog(locale).landing;
  const imagePath = locale === 'en' ? '/og-en.png' : '/og.png';
  const image = canonical ? new URL(assetUrl(imagePath), canonical).href : undefined;
  const esHref = canonicalUrl(new URL(path, canonical ?? 'https://cinve.invalid').href, 'es');
  const enHref = canonicalUrl(new URL(path, canonical ?? 'https://cinve.invalid').href, 'en');
  return <>
    <meta property="og:title" content={title} /><meta property="og:description" content={description} />
    <meta property="og:type" content="website" /><meta property="og:site_name" content="Cinve" />
    <meta property="og:locale" content={locale === 'es' ? 'es_VE' : 'en_US'} />
    <meta property="og:locale:alternate" content={locale === 'es' ? 'en_US' : 'es_VE'} />
    <meta name="robots" content="index,follow,max-image-preview:large" /><meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={title} /><meta name="twitter:description" content={description} />
    <link rel="alternate" hreflang="es" href={esHref} /><link rel="alternate" hreflang="en" href={enHref} /><link rel="alternate" hreflang="x-default" href={esHref} />
    {canonical && <>
      <link rel="canonical" href={canonical} /><meta property="og:url" content={canonical} /><meta property="og:image" content={image} />
      <meta property="og:image:type" content="image/png" /><meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content={copy.ogAlt} /><meta name="twitter:image" content={image} /><meta name="twitter:image:alt" content={copy.ogAlt} />
    </>}
  </>;
}

export type PageOptions = { compact?: boolean; script?: '/assets/js/site.js' | '/assets/js/connect.js'; index?: boolean; canonical?: string; description?: string; structuredData?: object; locale?: Locale; path?: string; clientCatalogs?: object };

export function Page({ title, compact, script, index, canonical, description, structuredData, locale = 'es', path = '/', clientCatalogs, children }: PageOptions & { title: string; children?: Child }) {
  const text = catalog(locale).common;
  const pageDescription = description ?? catalog(locale).landing.description;
  const localized = (target: Locale, route = path) => localeUrl(route, target);
  const home = localized(locale, '/');
  const internal = (href: string) => localized(locale, href);
  return (
    <html lang={locale} class="dark" data-client-catalogs={clientCatalogs ? JSON.stringify(clientCatalogs) : undefined} data-browser-text={JSON.stringify(catalog(locale).browser)}>
      <head>
        <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title} · Cinve</title><meta name="description" content={pageDescription} /><meta name="color-scheme" content="dark" />
        <meta name="author" content="Kevin Bravo" /><meta name="theme-color" content="#120a0e" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {index ? <SocialMeta canonical={canonical && canonicalUrl(canonical, locale)} title={`${title} · Cinve`} description={pageDescription} locale={locale} path={path} /> : <meta name="robots" content="noindex,nofollow" />}
        <link rel="preload" href="/assets/bricolage-grotesque.woff2" as="font" type="font/woff2" crossorigin />
        <link rel="preload" href="/assets/instrument-sans.woff2" as="font" type="font/woff2" crossorigin />
        <link rel="stylesheet" href={assetUrl('/assets/basecoat.css')} /><link rel="stylesheet" href={assetUrl('/assets/site.css')} />
        {structuredData && <script type="application/ld+json">{raw(JSON.stringify(structuredData).replace(/</g, '\\u003c'))}</script>}
      </head>
      <body>
        <a class="skip" href="#contenido" data-common-i18n="skip">{text.skip}</a><div class="wrap">
          <header class="site-header">
            <a class="brand" href={home} data-common-label="home" aria-label={text.home}>cinve<span>.</span></a>
            <nav class="site-nav" data-common-label="nav" aria-label={text.nav}>
              <a href={internal('/#preguntar')} data-common-i18n="questionNav">{text.questionNav}</a><a href={internal('/#datos')} data-common-i18n="dataNav">{text.dataNav}</a><a href={internal('/#preguntas')} data-common-i18n="faqNav">{text.faqNav}</a>
              <a class="nav-cta" href={internal('/#empezar')} data-common-i18n="startNav">{text.startNav}</a>
              <span class="language-switch" data-common-label="language" aria-label={text.language}>
                <details class="dropdown-menu language-menu">
                  <summary class="btn language-trigger" data-variant="ghost" data-size="sm"><span data-current-locale-label lang={locale}>{locale === 'es' ? text.spanish : text.english}</span>{icons.chevronDown()}</summary>
                  <div class="language-options">
                    <a data-locale-switch="es" href={localized('es')} lang="es" aria-current={locale === 'es' ? 'page' : undefined}><span>{text.spanish}</span><span class="language-check" data-locale-check="es" aria-hidden="true">{locale === 'es' ? '✓' : ''}</span></a>
                    <a data-locale-switch="en" href={localized('en')} lang="en" aria-current={locale === 'en' ? 'page' : undefined}><span>{text.english}</span><span class="language-check" data-locale-check="en" aria-hidden="true">{locale === 'en' ? '✓' : ''}</span></a>
                  </div>
                </details>
              </span>
            </nav>
          </header>
          <main id="contenido" class={compact ? 'compact' : undefined}>{children}</main>
          <footer class="site-footer">
            <div class="footer-brand"><a class="brand" href={home} data-common-label="home" aria-label={text.home}>cinve<span>.</span></a><p data-common-i18n="footerDescription">{text.footerDescription}</p></div>
            <nav class="footer-links" data-common-label="footerNav" aria-label={text.footerNav}>
              <div><p class="footer-title">Cinve</p><a href={internal('/#preguntar')} data-common-i18n="questionNav">{text.questionNav}</a><a href={internal('/#empezar')} data-common-i18n="start">{text.start}</a><a href={internal('/#datos')} data-common-i18n="dataNav">{text.dataNav}</a><a href={internal('/#preguntas')} data-common-i18n="questions">{text.questions}</a></div>
              <div><p class="footer-title" data-common-i18n="project">{text.project}</p><a href={internal('/instrucciones')} data-common-i18n="instructions">{text.instructions}</a><a href={internal('/privacidad')} data-common-i18n="privacy">{text.privacy}</a><a href="https://github.com/0bkevin/cinve" data-common-i18n="sourceCode">{text.sourceCode}</a><a href="https://github.com/0bkevin/cinve/issues/new/choose" data-common-i18n="report">{text.report}</a><a href="https://github.com/0bkevin/cinve/security/advisories/new" data-common-i18n="security">{text.security}</a></div>
            </nav>
            <div class="footer-base"><p><span data-common-i18n="madeBy">{text.madeBy}</span> <a href="https://kevinbravo.com">Kevin Bravo</a></p><a class="footer-gh" href="https://github.com/0bkevin/cinve" data-common-label="viewCode" aria-label={text.viewCode} title="GitHub">{icons.github()}</a></div>
          </footer>
        </div>
        {script && <script type="module" src={assetUrl(script)}></script>}
      </body>
    </html>
  );
}

export const renderPage = (title: string, content: JSX.Element, options: PageOptions = {}) =>
  renderDocument(<Page title={title} {...options}>{content}</Page>);
