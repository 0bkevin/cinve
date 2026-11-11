import { assetUrl } from './assets.js';
import { h, Fragment, raw, type Child } from './jsx.js';

const description = 'Consulta películas, horarios, precios y asientos de cines en Venezuela desde tu asistente.';
const ogTitle = 'Cinve · Consulta de cines en Venezuela';
const ogImageAlt = 'Cinve. Ilustración de una sala de cine con butacas ámbar. Consulta películas, horarios y precios desde tu asistente.';

const gitHubIcon = raw('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.768-.244.768-.543 0-.267-.01-.975-.015-1.914-3.13.68-3.79-1.508-3.79-1.508-.512-1.3-1.25-1.646-1.25-1.646-1.022-.7.078-.686.078-.686 1.13.08 1.725 1.16 1.725 1.16 1.005 1.722 2.638 1.225 3.28.937.102-.728.394-1.225.716-1.507-2.498-.284-5.124-1.25-5.124-5.562 0-1.229.439-2.233 1.16-3.02-.117-.285-.503-1.429.11-2.979 0 0 .945-.302 3.094 1.154a10.8 10.8 0 0 1 5.63 0c2.148-1.456 3.092-1.154 3.092-1.154.614 1.55.228 2.694.112 2.979.722.787 1.158 1.791 1.158 3.02 0 4.323-2.63 5.275-5.136 5.553.404.35.765 1.044.765 2.104 0 1.519-.014 2.744-.014 3.117 0 .302.203.653.774.542A11.252 11.252 0 0 0 12 .75Z"/></svg>');

/** Search and social metadata, only for the indexable landing page. */
function SocialMeta({ canonical }: { canonical?: string }) {
  const image = canonical ? new URL('/og.png?v=2', canonical).href : undefined;
  return <>
    <meta property="og:title" content={ogTitle} />
    <meta property="og:description" content={description} />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Cinve" />
    <meta property="og:locale" content="es_VE" />
    <meta name="robots" content="index,follow" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={ogTitle} />
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

export type PageOptions = { compact?: boolean; script?: '/assets/js/site.js' | '/assets/js/connect.js'; index?: boolean; canonical?: string };

export function Page({ title, compact, script, index, canonical, children }: PageOptions & { title: string; children?: Child }) {
  return (
    <html lang="es" class="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title} · Cinve</title>
        <meta name="description" content={description} />
        <meta name="color-scheme" content="dark" />
        <meta name="author" content="Kevin Bravo" />
        <meta name="theme-color" content="#1f0d15" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {index ? <SocialMeta canonical={canonical} /> : <meta name="robots" content="noindex,nofollow" />}
        <link rel="preload" href="/assets/big-shoulders-display.woff2" as="font" type="font/woff2" crossorigin />
        <link rel="preload" href="/assets/instrument-sans.woff2" as="font" type="font/woff2" crossorigin />
        <link rel="stylesheet" href={assetUrl('/assets/basecoat.css')} />
        <link rel="stylesheet" href={assetUrl('/assets/site.css')} />
      </head>
      <body>
        <a class="skip" href="#contenido">Ir al contenido</a>
        <div class="wrap">
          <header class="site-header">
            <a class="brand" href="/" aria-label="Cinve, inicio">cinve<span>.</span></a>
            <nav class="site-nav" aria-label="Principal"><a href="/#empezar">Cómo empezar</a></nav>
          </header>
          <main id="contenido" class={compact ? 'compact' : undefined}>{children}</main>
          <footer class="site-footer">
            <p>Developed by <a href="https://kevinbravo.com">Kevin Bravo</a></p>
            <a href="https://github.com/0bkevin/cinve" aria-label="Ver código en GitHub" title="GitHub">{gitHubIcon}</a>
          </footer>
        </div>
        {script && <script type="module" src={assetUrl(script)}></script>}
      </body>
    </html>
  );
}
