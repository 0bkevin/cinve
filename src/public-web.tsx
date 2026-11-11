import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { h, Fragment, renderDocument } from './web/jsx.js';
import { Page, type PageOptions } from './web/layout.js';

export { escapeHtml } from './web/jsx.js';

// Palette, typography and spacing follow portfoliov2's global.css and Tailwind theme.
export const pageStyles = `
@font-face{font-family:Inter;src:url('/assets/inter-latin.woff2') format('woff2');font-weight:400 700;font-display:swap}
:root{color-scheme:light dark;--bg:#fafafa;--text:#171717;--muted:#525252;--line:#e5e5e5;--panel:#f5f5f5;--accent:#b45309;--brand:#d97706;--button:#171717;--on-button:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0a;--text:#e5e5e5;--muted:#a3a3a3;--line:#262626;--panel:#171717;--accent:#fbbf24;--brand:#fbbf24;--button:#f5f5f5;--on-button:#171717}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 Inter,ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}::selection{background:var(--brand);color:var(--bg)}a{color:inherit;text-underline-offset:5px}a:hover{color:var(--accent)}button,input,select{font:inherit}button,a,input,select{touch-action:manipulation}:focus-visible{outline:2px solid var(--accent);outline-offset:5px}[hidden]{display:none!important}.wrap{width:min(100% - 48px,960px);margin:auto}.site-header{height:56px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:20px}.brand{font-size:24px;font-weight:700;letter-spacing:-.04em;text-decoration:none}.brand span{color:var(--brand)}.site-nav{display:flex;gap:24px;align-items:center;font-size:13px}.site-nav a{text-decoration:none;color:var(--muted)}.eyebrow{font-size:12px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0 0 22px}.accent{color:var(--brand)}h1,h2,h3{font-weight:600;letter-spacing:-.035em;line-height:1.13}h1{font-size:clamp(40px,6.4vw,68px);margin:0 0 26px}h2{font-size:32px;margin:0 0 20px}h3{font-size:19px;margin:0 0 10px}p{margin:0 0 20px;color:var(--muted)}.lead{font-size:19px;line-height:1.7;max-width:570px}.hero{padding:94px 0 68px;max-width:760px}.hero h1{max-width:720px}.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:30px}.button,button{display:inline-flex;justify-content:center;align-items:center;gap:12px;border:1px solid var(--line);border-radius:8px;padding:12px 20px;background:transparent;color:var(--text);font-size:14px;font-weight:500;text-decoration:none;cursor:pointer;min-height:46px}.primary{background:var(--button);color:var(--on-button);border-color:var(--button)}.primary:hover{opacity:.85;color:var(--on-button)}button:disabled{opacity:.55;cursor:wait}.secondary{background:transparent}.fine{font-size:13px}.providers{display:flex;gap:12px 28px;flex-wrap:wrap;padding:23px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:14px}.providers span:first-child{color:var(--muted)}.section{padding:64px 0;border-bottom:1px solid var(--line)}.examples{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px;margin-top:32px}.number{font-size:12px;color:var(--accent);display:block;margin-bottom:18px}.examples p{font-size:14px;margin-bottom:0}.example-question{font-size:17px;color:var(--text);line-height:1.5;margin-bottom:12px}.setup{display:grid;grid-template-columns:1fr 1fr;gap:48px}.instruction{padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.instruction p{color:var(--text);overflow-wrap:anywhere;margin:0}.instruction .eyebrow{color:var(--muted);margin-bottom:14px;font-size:11px}.note{font-size:13px;margin:16px 0 0}.project-note{padding:24px 0;border-bottom:1px solid var(--line)}.project-note p{font-size:13px;max-width:760px;margin:0}.site-footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px;padding:16px 0;color:var(--muted);font-size:12px}.site-footer p{margin:0}.site-footer a{text-decoration:none}.site-footer>a{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;margin:-12px -12px -12px 0}.compact{max-width:560px;margin:64px auto 80px}.compact h1{font-size:38px}.compact .lead{font-size:16px}.card{padding:28px;border:1px solid var(--line);border-radius:12px;margin:28px 0 20px;background:var(--panel)}label{display:block;font-size:13px;font-weight:500;margin:18px 0 7px}input,select{width:100%;min-width:0;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}.password{display:flex;gap:8px}.password button{padding:10px 12px}.full{width:100%;margin-top:24px}.feedback{font-size:14px;margin-top:12px}.feedback:empty{display:none}.error{color:#c2410c}.status{font-size:14px;padding-bottom:16px;border-bottom:1px solid var(--line)}small{display:block;color:var(--muted);font-size:13px;overflow-wrap:anywhere}.card .actions{margin-top:24px}.skip{position:absolute;top:-100px;left:20px;background:var(--bg);padding:12px;z-index:2}.skip:focus{top:12px}
@media(max-width:640px){.wrap{width:calc(100% - 40px)}.site-header{height:56px}.site-nav{gap:16px}.hero{padding:36px 0 32px}.hero .eyebrow{font-size:11px;letter-spacing:.12em;margin-bottom:16px}.hero h1{font-size:clamp(28px,8.5vw,36px);line-height:1.15;letter-spacing:-.035em;margin-bottom:20px}.hero .lead{font-size:16px;line-height:1.6;margin-bottom:0}.hero .actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:24px}.hero .button{width:100%;min-height:48px}.lead{font-size:17px}.examples,.setup{grid-template-columns:1fr;gap:28px}.section{padding:42px 0}.examples{gap:30px}.number{margin-bottom:8px}.compact{margin:42px auto 56px}.compact h1{font-size:32px}.card{padding:20px}.providers{gap:10px 20px}.providers span:first-child{width:100%}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

const page = (title: string, content: JSX.Element, options: PageOptions = {}) =>
  renderDocument(<Page title={title} styles={pageStyles} {...options}>{content}</Page>);

function InstallMessage({ origin }: { origin: string }) {
  return <p id="install-message">Instala Cinve siguiendo {origin}/install</p>;
}

function CopyInstall() {
  return <button id="copy-install" type="button" hidden>Copiar mensaje</button>;
}

const copyFeedback = <p id="copy-feedback" class="note" role="status" aria-live="polite"></p>;

export function landingPage(origin: string) {
  return page('Consulta de cines en Venezuela', <>
    <section class="hero">
      <p class="eyebrow">Cines de Venezuela</p>
      <h1>Consulta películas,<br /><span class="accent">horarios y precios.</span></h1>
      <p class="lead">Cinve permite consultar películas, horarios, precios y asientos de cines en Venezuela desde tu asistente.</p>
      <div class="actions">
        <a class="button primary" href="#como-usarlo">Empezar a usar Cinve <span aria-hidden="true">↗</span></a>
        <a class="button" href="#que-puedes-consultar">Qué puedo preguntar</a>
      </div>
    </section>
    <div class="providers" aria-label="Cines incluidos"><span>Consulta en</span><span>Cinex</span><span>Cines Unidos</span><span>Cinepic</span></div>
    <section class="section" id="que-puedes-consultar">
      <p class="eyebrow">Consultas</p>
      <h2>Qué puedes consultar</h2>
      <p>Dile a tu asistente qué quieres ver y en qué ciudad estás.</p>
      <div class="examples">
        <article><span class="number">01 / Cartelera</span><h3 class="example-question">“¿Qué películas hay hoy en Caracas?”</h3><p>Busca películas, cines y horarios para elegir una función.</p></article>
        <article><span class="number">02 / Precios</span><h3 class="example-question">“¿Cuánto cuesta la entrada en Cinepic?”</h3><p>Consulta las tarifas de una función y las opciones de caramelería que publique el cine.</p></article>
        <article><span class="number">03 / Asientos</span><h3 class="example-question">“¿Quedan dos asientos juntos?”</h3><p>Revisa los asientos disponibles en Cinex, Cines Unidos y Cinepic antes de comprar.</p></article>
      </div>
      <p class="note">La información disponible depende de cada cine. Cinve consulta los datos, pero no compra entradas ni reserva asientos.</p>
    </section>
    <section class="section setup" id="como-usarlo">
      <div>
        <p class="eyebrow">Cómo usarlo</p>
        <h2>Añade Cinve a tu asistente.</h2>
        <p>Copia este mensaje y envíaselo a tu asistente. Te ayudará a conectar Cinve.</p>
        <p class="fine">Necesitas un asistente que permita añadir conexiones MCP. Puedes consultar la cartelera sin crear una cuenta en Cinve.</p>
      </div>
      <div>
        <div class="instruction"><p class="eyebrow">Mensaje para tu asistente</p><InstallMessage origin={origin} /></div>
        <div class="actions"><CopyInstall /><a class="fine" href="/install">Ver instrucciones</a></div>
        {copyFeedback}
      </div>
    </section>
    <section class="section setup">
      <div><p class="eyebrow">Tu cuenta del cine</p><h2>Conéctala cuando haga falta.</h2></div>
      <div>
        <p>Algunos precios y consultas requieren una cuenta del cine. Tu asistente te dará un enlace privado para conectarla y luego podrás seguir en el chat.</p>
        <p class="fine">La contraseña se escribe solo en ese formulario, nunca en el chat. Cinve no guarda tu contraseña.</p>
      </div>
    </section>
    <aside class="project-note" aria-label="Sobre Cinve"><p>Cinve es un proyecto independiente, sin fines de lucro y completamente gratuito. No tiene ninguna alianza ni afiliación con Cinex, Cines Unidos o Cinepic.</p></aside>
  </>, { index: true, canonical: origin + '/', script: '/site.js' });
}

export function installationPage(origin: string) {
  return page('Cómo usar Cinve', <>
    <p class="eyebrow">Cómo usarlo</p>
    <h1>Cinve en tu asistente.</h1>
    <p>Envía este mensaje a tu asistente para que te ayude a añadir Cinve:</p>
    <div class="instruction"><InstallMessage origin={origin} /></div>
    <div class="actions"><CopyInstall /></div>
    {copyFeedback}
    <div class="card">
      <h2>Si lo añades a mano</h2>
      <p>En las conexiones de tu asistente, añade un servidor MCP llamado <strong>Cinve</strong> con esta dirección:</p>
      <small><strong>{origin}/mcp</strong></small>
      <p class="note">Elige HTTP si te pide el tipo de conexión. Tu asistente debe admitir servidores MCP remotos.</p>
    </div>
    <p>Después, pregunta qué películas hay en tu ciudad. Para consultar la cartelera no necesitas una cuenta. Si una consulta requiere conectarte al cine, tu asistente te dará un enlace privado.</p>
    <a href="/install?format=text">Ver las instrucciones completas para el asistente</a>
  </>, { compact: true, script: '/site.js' });
}

export const siteScript = `const button=document.getElementById('copy-install');button.hidden=false;button.onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById('install-message').textContent);document.getElementById('copy-feedback').textContent='Mensaje copiado. Pégalo en tu asistente.';}catch{document.getElementById('copy-feedback').textContent='Selecciona el mensaje y cópialo para enviarlo a tu asistente.';}};`;

export function authorizationPage(app: string, destination: string, id: string, csrf: string, publisher?: string) {
  // A metadata-document client is identified by the site that publishes it;
  // its name is self-declared, so the page names that site as well.
  const provenance = publisher
    ? <>Esta aplicación se identifica con un documento publicado en <strong>{publisher}</strong>. Comprueba que reconoces ese sitio y el destino:</>
    : 'Esta aplicación fue registrada por un tercero. Comprueba que reconoces el destino:';
  return page('Conectar tu asistente', <>
    <p class="eyebrow">Conexión privada</p>
    <h1>Conecta tu asistente.</h1>
    <p class="lead">Autoriza a <strong>{app}</strong> para conectar tus cuentas de cine y consultar precios con ellas.</p>
    <p>Después volverás al chat para elegir el cine y conectar tu cuenta. Tu asistente no recibirá la contraseña del cine.</p>
    <form class="card" method="post" action="/oauth/authorize">
      <input type="hidden" name="request_id" value={id} />
      <input type="hidden" name="csrf" value={csrf} />
      <p>{provenance}</p>
      <small><strong>{destination}</strong></small>
      <p class="note">Esta aprobación crea una conexión privada nueva para este asistente. No comparte cuentas conectadas en otras aplicaciones. Permite consultar y desconectar las cuentas que conectes aquí; no comprar entradas.</p>
      <div class="actions">
        <button class="primary" name="decision" value="approve">Autorizar conexión</button>
        <button name="decision" value="deny">Cancelar</button>
      </div>
    </form>
    <small>La solicitud caduca en 10 minutos. Si no iniciaste esta conexión, cancela.</small>
  </>, { compact: true });
}

export function authorizationErrorPage() {
  return page('Conexión no disponible', <>
    <p class="eyebrow">Conexión no disponible</p>
    <h1>No se pudo autorizar la conexión.</h1>
    <p>La solicitud puede haber caducado o no ser válida. Vuelve a tu asistente e inicia de nuevo la conexión de Cinve.</p>
    <p>Si vuelve a ocurrir, inténtalo más tarde.</p>
    <a class="button primary" href="/">Volver al inicio</a>
  </>, { compact: true });
}

export function servePublicAsset(req: IncomingMessage, res: ServerResponse) {
  const path = req.url?.split('?')[0];
  if (!['/assets/inter-latin.woff2', '/site.js', '/og.png', '/favicon.svg'].includes(path ?? '')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
  const font = path === '/assets/inter-latin.woff2';
  const body = font ? readFileSync(new URL('./assets/inter-latin.woff2', import.meta.url)) : path === '/og.png' ? readFileSync(new URL('./assets/og.png', import.meta.url)) : path === '/favicon.svg' ? readFileSync(new URL('./assets/favicon.svg', import.meta.url)) : siteScript;
  res.writeHead(200, { 'Content-Type': font ? 'font/woff2' : path === '/og.png' ? 'image/png' : path === '/favicon.svg' ? 'image/svg+xml' : 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body); return true;
}
