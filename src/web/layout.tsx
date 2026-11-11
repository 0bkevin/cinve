import { assetUrl } from './assets.js';
import { h, Fragment, raw, renderDocument, type Child } from './jsx.js';
import { icons } from './ui.js';

const siteDescription = 'Consulta películas, horarios, precios y asientos de cines en Venezuela desde tu asistente.';
const ogImageAlt = 'Cinve. «Pregúntale a tu asistente por el cine.» Una conversación de ejemplo: alguien pregunta si quedan dos asientos juntos esta noche y el asistente responde con un mapa de la sala con dos asientos libres juntos. Funciona con Claude Code, Codex, OpenCode, Antigravity, Hermes, OpenClaw y cualquier asistente compatible con MCP. Gratis y de código abierto.';


/** Search and social metadata, only for the indexable landing page. */
function SocialMeta({ canonical, title, description }: { canonical?: string; title: string; description: string }) {
  // Content-hashed, so link previews pick up a new image after each change.
  const image = canonical ? new URL(assetUrl('/og.png'), canonical).href : undefined;
  return <>
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Cinve" />
    <meta property="og:locale" content="es_VE" />
    <meta name="robots" content="index,follow,max-image-preview:large" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={description} />
    {canonical && <>
      <link rel="canonical" href={canonical} />
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={image} />
      <meta property="og:image:type" content="image/png" />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content={ogImageAlt} />
      <meta name="twitter:image" content={image} />
      <meta name="twitter:image:alt" content={ogImageAlt} />
    </>}
  </>;
}

/** index pages also need canonical; description defaults to the site's. */
export type PageOptions = { compact?: boolean; script?: '/assets/js/site.js' | '/assets/js/connect.js'; index?: boolean; canonical?: string; description?: string; structuredData?: object };

export function Page({ title, compact, script, index, canonical, description = siteDescription, structuredData, children }: PageOptions & { title: string; children?: Child }) {
  return (
    <html lang="es" class="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title} · Cinve</title>
        <meta name="description" content={description} />
        <meta name="color-scheme" content="dark" />
        <meta name="author" content="Kevin Bravo" />
        <meta name="theme-color" content="#120a0e" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {index ? <SocialMeta canonical={canonical} title={`${title} · Cinve`} description={description} /> : <meta name="robots" content="noindex,nofollow" />}
        <link rel="preload" href="/assets/bricolage-grotesque.woff2" as="font" type="font/woff2" crossorigin />
        <link rel="preload" href="/assets/instrument-sans.woff2" as="font" type="font/woff2" crossorigin />
        <link rel="stylesheet" href={assetUrl('/assets/basecoat.css')} />
        <link rel="stylesheet" href={assetUrl('/assets/site.css')} />
        {/* JSON-LD is a data block, never executed, so script-src 'self' does
            not apply. "<" is escaped so the data cannot close the tag. */}
        {structuredData && <script type="application/ld+json">{raw(JSON.stringify(structuredData).replace(/</g, '\\u003c'))}</script>}
      </head>
      <body>
        <a class="skip" href="#contenido">Ir al contenido</a>
        <div class="wrap">
          <header class="site-header">
            <a class="brand" href="/" aria-label="Cinve, inicio">cinve<span>.</span></a>
            <nav class="site-nav" aria-label="Principal">
              <a href="/#preguntar">Qué preguntar</a>
              <a href="/#datos">Tus datos</a>
              <a href="/#preguntas">Preguntas</a>
              <a class="nav-cta" href="/#empezar">Empezar</a>
            </nav>
          </header>
          <main id="contenido" class={compact ? 'compact' : undefined}>{children}</main>
          <footer class="site-footer">
            <div class="footer-brand">
              <a class="brand" href="/" aria-label="Cinve, inicio">cinve<span>.</span></a>
              <p>Cartelera, precios y asientos de los cines de Venezuela, desde tu asistente.</p>
            </div>
            <nav class="footer-links" aria-label="Pie de página">
              <div>
                <p class="footer-title">Cinve</p>
                <a href="/#preguntar">Qué preguntar</a>
                <a href="/#empezar">Empezar</a>
                <a href="/#datos">Tus datos</a>
                <a href="/#preguntas">Preguntas</a>
              </div>
              <div>
                <p class="footer-title">Proyecto</p>
                <a href="/instrucciones">Instrucciones</a>
                <a href="/privacidad">Privacidad</a>
                <a href="https://github.com/0bkevin/cinve">Código en GitHub</a>
                <a href="https://github.com/0bkevin/cinve/issues/new/choose">Reportar un problema</a>
                <a href="https://github.com/0bkevin/cinve/security/advisories/new">Seguridad</a>
              </div>
            </nav>
            <div class="footer-base">
              <p>Hecho por <a href="https://kevinbravo.com">Kevin Bravo</a></p>
              <a class="footer-gh" href="https://github.com/0bkevin/cinve" aria-label="Ver código en GitHub" title="GitHub">{icons.github()}</a>
            </div>
          </footer>
        </div>
        {script && <script type="module" src={assetUrl(script)}></script>}
      </body>
    </html>
  );
}

/** A complete HTML document for one page. */
export const renderPage = (title: string, content: JSX.Element, options: PageOptions = {}) =>
  renderDocument(<Page title={title} {...options}>{content}</Page>);
