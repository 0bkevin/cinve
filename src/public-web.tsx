import type { ServerResponse } from 'node:http';
import { h, Fragment, renderDocument } from './web/jsx.js';
import { Page, type PageOptions } from './web/layout.js';
import { Alert, Button, Card, LinkButton, icons } from './web/ui.js';
import { assetUrl } from './web/assets.js';
import { serverInstructions } from './agent-instructions.js';
import { hostedAuthInstructions } from './hosted-auth-guidance.js';
import { seatInstructions } from './seat-guidance.js';
import { cinemaInstructions } from './install.js';

export { escapeHtml } from './web/jsx.js';
export { servePublicAsset } from './web/assets.js';

/** Headers for every response, including pages served outside the hosted app (for example /install on Vercel). */
/** For pages that are the same for everyone (/, /install, /instrucciones):
 *  the CDN may cache them briefly; private pages keep no-store. */
export const publicPageCache = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';

export function setSecurityHeaders(res: ServerResponse, https: boolean) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

const page = (title: string, content: JSX.Element, options: PageOptions = {}) =>
  renderDocument(<Page title={title} {...options}>{content}</Page>);

/** The message users paste into their assistant; site.js reveals the copy button. */
function InstallMessage({ origin }: { origin: string }) {
  return <>
    <div class="install">
      <p id="install-message">Instala Cinve siguiendo {origin}/install</p>
      <Button id="copy-install" data-copy="install-message" data-feedback="copy-feedback" hidden>{icons.copy()}<span>Copiar</span></Button>
    </div>
    <p id="copy-feedback" class="note" role="status" aria-live="polite"></p>
  </>;
}

// The hero's seat map: an illustrative house of rows A–G, 4 + 10 + 4 seats,
// fixed so every load looks the same. On load the seats fill in as taken and
// the one free pair in the middle of row E lights up.
// . free  x taken  ? not confirmed  * the free pair
const house: [string, string][] = [
  ['A', '..x.xx..xx..x..x..'],
  ['B', '.x...xxxx.xxx...x.'],
  ['C', 'x..xxxx.xxxx.x.x..'],
  ['D', '..xxx.xxxxxx.xx..x'],
  ['E', '.x..xxxx**xx.xx.x.'],
  ['F', 'x.x..xxxxxxxx..x.x'],
  ['G', '..x.xx.xx.xx..????'],
];
const seatState = { '.': 'free', x: 'taken', '?': 'unknown', '*': 'pair' } as const;

function SeatMap() {
  return <div class="seating" role="img" aria-label="Ejemplo de mapa de una sala: quedan dos asientos libres juntos en el centro de la fila E.">
    <div class="screen"><span>Pantalla</span></div>
    {house.map(([row, seats]) => <div class="row">
      <span class="row-label">{row}</span>
      {[...seats].map(seat => <span class="seat" data-state={seatState[seat as keyof typeof seatState]}></span>)}
    </div>)}
  </div>;
}

// What each cinema publishes and whether it needs the visitor's own account.
type Access = 'open' | 'account' | 'none';
const accessLabel: Record<Access, string> = { open: 'Sin cuenta', account: 'Con tu cuenta', none: 'No disponible' };
const cinemas = ['Cinex', 'Cines Unidos', 'Cinepic', 'Supercines', 'Gran Cine'];
const coverage: { topic: string; ask: string; access: Access[] }[] = [
  { topic: 'Cartelera y horarios', ask: '¿Qué hay hoy en Caracas?', access: ['open', 'open', 'open', 'open', 'open'] },
  { topic: 'Precios', ask: '¿Cuánto cuesta la entrada?', access: ['account', 'account', 'open', 'open', 'none'] },
  { topic: 'Asientos', ask: '¿Quedan dos asientos juntos?', access: ['account', 'account', 'open', 'none', 'none'] },
  { topic: 'Caramelería', ask: '¿Qué combos tienen?', access: ['account', 'open', 'none', 'open', 'none'] },
];

function Coverage() {
  return <div class="board-scroll"><table class="board">
    <caption class="visually-hidden">Qué puede consultar tu asistente en cada cine</caption>
    <thead><tr><td></td>{cinemas.map(name => <th scope="col">{name}</th>)}</tr></thead>
    <tbody>
      {coverage.map(({ topic, ask, access }) => <tr>
        <th scope="row"><span class="topic">{topic}</span><span class="ask">{ask}</span></th>
        {/* The cinema name repeats inside each cell for the phone layout, where the table becomes a list. */}
        {access.map((level, i) => <td data-access={level}><span class="cell-cinema">{cinemas[i]}</span><span class="mark"><span class="glyph" aria-hidden="true">{level === 'account' && icons.lock()}</span>{accessLabel[level]}</span></td>)}
      </tr>)}
    </tbody>
  </table></div>;
}

// Assistants Cinve works with, with each one's documented way to add a remote
// MCP server (sources in src/assets/logos/SOURCES.md and each tool's docs or
// --help). Codex is configured in config.toml because some versions of
// `codex mcp add` start an optional login at once.
// Gemini CLI is left out: since June 2026 it only serves Gemini Code Assist
// Standard/Enterprise, and individual users moved to Antigravity.
type Assistant = { name: string; logo: string; how: string; setup: (endpoint: string) => string; file?: string };
const assistants: Assistant[] = [
  { name: 'Claude Code', logo: '/assets/logos/claudecode.svg', how: 'Ejecuta en tu terminal:', setup: url => `claude mcp add --transport http cinve ${url}` },
  { name: 'Codex', logo: '/assets/logos/codex.png', how: 'Añade esto a', file: '~/.codex/config.toml', setup: url => `[mcp_servers.cinve]\nurl = "${url}"` },
  { name: 'OpenCode', logo: '/assets/logos/opencode.svg', how: 'Ejecuta en tu terminal:', setup: url => `opencode mcp add cinve --global --url ${url}` },
  { name: 'Antigravity', logo: '/assets/logos/antigravity.svg', how: 'Ejecuta en tu terminal:', setup: url => `agy mcp add cinve ${url}` },
  { name: 'Hermes', logo: '/assets/logos/hermes.svg', how: 'Ejecuta en tu terminal:', setup: url => `hermes mcp add cinve --url ${url}` },
  { name: 'OpenClaw', logo: '/assets/logos/openclaw.svg', how: 'Ejecuta en tu terminal:', setup: url => `openclaw mcp add cinve --url ${url} --transport streamable-http` },
];

/** The assistant's logo on a light disc, so each mark shows as published. */
// Each logo gets a data-logo hook so CSS can size it by how big its visible
// mark looks, not by its file's box (see .app-mark in site.css). Claude
// Code's vendored mark is a bare shape, so CSS paints it in its brand colour
// through a mask instead of editing the file.
const AppMark = ({ logo }: { logo: string }) => {
  const slug = logo.slice(logo.lastIndexOf('/') + 1, logo.lastIndexOf('.'));
  return <span class="app-mark" aria-hidden="true">{slug === 'claudecode'
    ? <span class="logo-claudecode" data-logo={slug}></span>
    : <img src={assetUrl(logo)} alt="" width="18" height="18" loading="lazy" data-logo={slug} />}</span>;
};

function WorksWith() {
  return <ul class="works-with" aria-label="Asistentes compatibles">
    {assistants.map(({ name, logo }) => <li><AppMark logo={logo} />{name}</li>)}
  </ul>;
}

// How visitor data is handled: a four-card summary, then the details. Every
// claim matches the hosted service (docs/hosted.md); keep them in sync.
const safeguardSummary = [
  ['Tu contraseña', 'Se usa una vez para entrar al cine y no se guarda.'],
  ['Sesión cifrada', 'Atada a la conexión de tu asistente.'],
  ['Enlaces privados', 'De un solo uso; caducan en 10 minutos.'],
  ['Tú decides', 'Desconecta tu cuenta cuando quieras.'],
];
const safeguards: [JSX.Element, string, string][] = [
  [icons.keyRound(), 'Tu contraseña no se guarda', 'La escribes solo en la página privada del enlace, nunca en el chat. Cinve la usa una vez, por una conexión segura, para iniciar sesión en el cine, y no la almacena.'],
  [icons.lock(), 'Sesiones cifradas', 'Solo guardamos la sesión que te da el cine, cifrada con AES-256-GCM y atada a tu conexión. Vence cuando vence la del cine.'],
  [icons.link(), 'Enlaces de un solo uso', 'Caducan en 10 minutos. Su código va después del «#» de la dirección, así que el navegador no lo envía al servidor.'],
  [icons.shieldCheck(), 'Acceso con tu permiso', 'Tu asistente se conecta con OAuth y PKCE. Guardamos solo huellas SHA-256 de sus tokens, y reutilizar uno revoca la conexión.'],
  [icons.unplug(), 'Desconecta cuando quieras', 'Pídeselo a tu asistente y borramos tu sesión. Lo vencido se elimina cada día. Para cerrarla también en el cine, hazlo en su web.'],
  [icons.eyeOff(), 'Sin rastreadores', 'Esta web no carga anuncios, analíticas ni recursos de otros sitios. Cada conexión está separada: otra aplicación no ve tus cuentas.'],
];

// Answers must stay true to the service; see docs/hosted.md and src/install.ts.
const faq: [string, string][] = [
  ['¿Qué es Cinve?', 'Un servidor MCP gratuito y de código abierto. Con él, tu asistente consulta la cartelera, los horarios, los precios y los asientos de Cinex, Cines Unidos, Cinepic, Supercines y Gran Cine, según lo que publica cada cine. Solo consulta: no compra entradas.'],
  ['¿Cuánto cuesta?', 'Nada. Cinve es gratis y no muestra anuncios.'],
  ['¿Con qué asistentes funciona?', 'Con los que aceptan conexiones MCP remotas, como Claude Code, Codex u OpenCode. Si tu asistente no tiene esa opción, todavía no puede usar Cinve.'],
  ['¿Necesito crear una cuenta?', 'En Cinve, no. Para ver precios y asientos de Cinex y Cines Unidos, tu asistente te pedirá conectar tu cuenta de ese cine. En Supercines es opcional: sin ella ves las tarifas públicas.'],
  ['¿Qué tan actualizada está la información?', 'Cinve la consulta en la web del cine cuando preguntas y reutiliza algunas respuestas por unos minutos. Los asientos pueden cambiar: confírmalos en la web del cine antes de comprar.'],
  ['¿Puedo comprar entradas desde el chat?', 'No. Cinve solo consulta, pero cuando el cine lo publica, tu asistente te da el enlace para comprar esa función en su web.'],
  ['¿Por qué no aparece mi cine o mi ciudad?', 'Cinve muestra las sedes que cada cine publica en su web, y Cinepic por ahora solo en Caracas. Si falta alguna, avísanos en GitHub.'],
  ['¿Cómo desconecto mi cuenta del cine?', 'Escríbele a tu asistente «desconecta mi cuenta de Cinex» (o de Cines Unidos o Supercines) y borramos la sesión guardada.'],
  ['¿Cinve es oficial?', 'No. Es un proyecto independiente, sin relación con los cines.'],
];

/** Who and what Cinve is, for search and answer engines (schema.org). No
 *  ratings or offers: Cinve has none, so none are claimed. */
const structuredData = (origin: string) => ({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', '@id': `${origin}/#website`, url: `${origin}/`, name: 'Cinve', inLanguage: 'es-VE', publisher: { '@id': 'https://kevinbravo.com/#person' } },
    { '@type': 'SoftwareApplication', '@id': `${origin}/#app`, name: 'Cinve', url: `${origin}/`,
      description: 'Servidor MCP gratuito y de código abierto para que tu asistente consulte cartelera, horarios, precios y asientos de cines en Venezuela.',
      applicationCategory: 'UtilitiesApplication', operatingSystem: 'Cualquiera (servidor MCP remoto)', isAccessibleForFree: true,
      license: 'https://opensource.org/license/mit', inLanguage: 'es-VE', areaServed: { '@type': 'Country', name: 'Venezuela' },
      sameAs: ['https://github.com/0bkevin/cinve'], author: { '@id': 'https://kevinbravo.com/#person' } },
    { '@type': 'Person', '@id': 'https://kevinbravo.com/#person', name: 'Kevin Bravo', url: 'https://kevinbravo.com' },
  ],
});

export function landingPage(origin: string) {
  return page('Cartelera, precios y asientos de cines en Venezuela', <>
    <section class="hero" aria-labelledby="titulo">
      <figure class="house">
        <SeatMap />
        <figcaption class="legend">
          <span><i data-state="free"></i>Libre</span>
          <span><i data-state="taken"></i>Ocupado</span>
          <span><i data-state="unknown"></i>Sin confirmar</span>
        </figcaption>
      </figure>
      <div class="hero-copy">
        <h1 id="titulo"><span>¿Qué</span> <span>vemos hoy?</span></h1>
        <div>
          <p class="lead">Pregúntaselo a tu asistente. Con Cinve consulta la cartelera, los precios y los asientos de los principales cines de Venezuela.</p>
          <div class="hero-actions">
            <LinkButton href="#empezar" size="lg">Añadir Cinve a mi asistente</LinkButton>
            <LinkButton href="#cines" size="lg" variant="outline">Ver cines</LinkButton>
          </div>
        </div>
      </div>
    </section>
    <section class="section" id="preguntar" aria-labelledby="preguntar-titulo">
      <header class="section-head">
        <h2 id="preguntar-titulo">Qué puedes preguntar</h2>
      </header>
      <ul class="asks">
        {coverage.map(({ topic, ask }) => <li><span class="topic">{topic}</span><span class="ask">“{ask}”</span></li>)}
      </ul>
      {/* The per-cinema detail stays one click away; <details> works without JavaScript. */}
      <details class="more" id="cines">
        <summary><span>Ver qué ofrece cada cine</span>{icons.chevronDown()}</summary>
        <Coverage />
        <div class="notes">
          <p><strong>Con tu cuenta.</strong> Tu asistente te da un enlace privado para conectar tu cuenta del cine.</p>
          <p><strong>Asientos.</strong> El mapa distingue los libres, los ocupados y los que no se pudieron confirmar. Puede cambiar antes de que compres.</p>
          <p><strong>Solo consulta.</strong> Cinve no compra entradas ni reserva asientos.</p>
        </div>
      </details>
    </section>
    <section class="section band" id="empezar" aria-labelledby="empezar-titulo">
      <header class="section-head">
        <h2 id="empezar-titulo">Cómo empezar</h2>
        <p>Funciona con asistentes que aceptan conexiones MCP. <a href="/install">¿Prefieres hacerlo a mano?</a></p>
      </header>
      <WorksWith />
      <InstallMessage origin={origin} />
      <ol class="steps">
        <li>Copia este mensaje y envíaselo a tu asistente.</li>
        <li>Tu asistente añade Cinve y te pide permiso. No tienes que crear ninguna cuenta.</li>
        <li>Pregunta qué quieres ver, como en cualquier chat.</li>
      </ol>
    </section>
    <section class="section" id="datos" aria-labelledby="datos-titulo">
      <header class="section-head">
        <h2 id="datos-titulo">Cómo cuidamos tus datos</h2>
        <p>Solo guardamos algo si conectas tu cuenta del cine, y es lo mínimo para consultar con ella.</p>
      </header>
      <ul class="asks">
        {safeguardSummary.map(([title, text]) => <li><span class="topic">{title}</span><span class="ask">{text}</span></li>)}
      </ul>
      <details class="more">
        <summary><span>Ver cómo protegemos tus datos</span>{icons.chevronDown()}</summary>
        <ul class="safeguards">
          {safeguards.map(([icon, title, text]) => <li>{icon}<h3>{title}</h3><p>{text}</p></li>)}
        </ul>
        <p class="note">Si encuentras un fallo de seguridad, <a href="https://github.com/0bkevin/cinve/security/advisories/new">repórtalo en privado</a>.</p>
      </details>
    </section>
    <section class="section split" id="preguntas" aria-labelledby="preguntas-titulo">
      <header class="section-head">
        <h2 id="preguntas-titulo">Preguntas frecuentes</h2>
      </header>
      <div class="faq">
        {/* name= makes the questions exclusive: opening one closes the others, natively. */}
        {faq.map(([question, answer]) => <details name="faq">
          <summary><span>{question}</span>{icons.plus()}</summary>
          <p>{answer}</p>
        </details>)}
      </div>
    </section>
    <section class="closing" aria-labelledby="abierto-titulo">
      <h2 id="abierto-titulo">Gratis, independiente y de código abierto.</h2>
      <p>Cinve es un proyecto independiente. Solo usa la información que los cines ya publican y, si conectas tu cuenta, lo que esa cuenta te permite ver. Cualquiera puede revisar cómo funciona o ayudar a mejorarlo.</p>
      <div class="closing-links">
        <LinkButton href="https://github.com/0bkevin/cinve" variant="outline">{icons.github()}Ver el código</LinkButton>
        <LinkButton href="https://github.com/0bkevin/cinve/issues/new/choose" variant="ghost">Reportar un problema</LinkButton>
        <LinkButton href="https://github.com/0bkevin/cinve/issues/new/choose" variant="ghost">Proponer un cine</LinkButton>
      </div>
    </section>
  </>, { index: true, canonical: origin + '/', script: '/assets/js/site.js', structuredData: structuredData(origin) });
}

/** A command or setting to copy, with its own copy button. */
function Snippet({ id, children }: { id: string; children: string }) {
  return <div class="snippet">
    {/* Each word is unbreakable, so long commands wrap only between words. */}
    <pre id={id}>{children.split('\n').map((line, i) => <>{i > 0 && '\n'}{line.split(' ').map((word, j) => <>{j > 0 && ' '}<span>{word}</span></>)}</>)}</pre>
    <Button variant="ghost" size="sm" data-copy={id} aria-label="Copiar" hidden>{icons.copy()}<span>Copiar</span></Button>
  </div>;
}

export function installationPage(origin: string) {
  const endpoint = `${origin}/mcp`;
  return page('Cómo usar Cinve', <>
    <h1>Cinve en tu asistente.</h1>
    <p class="lead">Envía este mensaje a tu asistente y él se encarga del resto:</p>
    <InstallMessage origin={origin} />
    <section class="manual" aria-labelledby="mano">
      <h2 id="mano">Si prefieres añadirlo a mano</h2>
      {/* Pick an app, see only its step. Radios keep it working without
          JavaScript and give arrow-key navigation; CSS shows the panel whose
          position matches the checked radio. */}
      <div class="picker" role="radiogroup" aria-labelledby="mano">
        <div class="picker-options">
          {[...assistants.map(({ name, logo }, i) => <><input type="radio" name="app" id={`app-${i}`} class="visually-hidden" checked={i === 0} /><label for={`app-${i}`}><AppMark logo={logo} />{name}</label></>),
            <><input type="radio" name="app" id="app-other" class="visually-hidden" /><label for="app-other"><span class="app-mark app-mark-other" aria-hidden="true">{icons.ellipsis()}</span>Otra</label></>]}
        </div>
        <div class="picker-panels">
          {assistants.map(({ how, file, setup }, i) => <div class="picker-panel">
            <p>{how}{file && <> <code>{file}</code>:</>}</p>
            <Snippet id={`cmd-${i}`}>{setup(endpoint)}</Snippet>
          </div>)}
          <div class="picker-panel">
            <p>Busca en sus ajustes la opción para añadir un servidor MCP remoto o un conector personalizado. Ponle de nombre <strong>cinve</strong>, elige HTTP si te pide el tipo y usa esta dirección:</p>
            <Snippet id="cmd-url">{endpoint}</Snippet>
          </div>
        </div>
      </div>
      <p class="note">Reinicia tu asistente si no ve Cinve enseguida. Luego pregúntale qué películas hay en tu ciudad.</p>
    </section>
    <p class="note"><a href="/instrucciones">Ver qué instrucciones recibe tu asistente</a></p>
  </>, { compact: true, script: '/assets/js/site.js', index: true, canonical: origin + '/install',
    description: 'Añade Cinve a Claude Code, Codex, OpenCode, Antigravity, Hermes u OpenClaw con un mensaje o un comando.' });
}

/** One instruction text, exactly as the assistant receives it. */
function Prompt({ title, children }: { title: string; children: string }) {
  return <section class="prompt">
    <h2>{title}</h2>
    <pre>{children}</pre>
  </section>;
}

export function instructionsPage(origin: string) {
  return page('Instrucciones para tu asistente', <>
    <h1>Lo que Cinve le pide a tu asistente.</h1>
    <p class="lead">Cuando tu asistente se conecta a Cinve, recibe estas instrucciones. Las publicamos tal cual para que sepas qué hace y qué no.</p>
    <Prompt title="Al conectarse">{serverInstructions({ publicHosted: true })}</Prompt>
    <Prompt title="Al guardar tu preferencia">{cinemaInstructions + '\n\n' + seatInstructions}</Prompt>
    <details class="more">
      <summary>Al conectar tu cuenta del cine {icons.chevronDown()}</summary>
      <Prompt title="Con tu cuenta conectada">{serverInstructions({ accounts: true })}</Prompt>
      <Prompt title="Para autorizar la conexión">{hostedAuthInstructions(origin)}</Prompt>
    </details>
    <p class="note">La guía de instalación que sigue tu asistente está en <a href="/install?format=text">/install</a>. El código de estas instrucciones es público en <a href="https://github.com/0bkevin/cinve">GitHub</a>.</p>
  </>, { compact: true, index: true, canonical: origin + '/instrucciones',
    description: 'Las instrucciones exactas que Cinve envía a tu asistente, publicadas tal cual.' });
}

type Consent = { app: string; destination: string; id: string; csrf: string; publisher?: string; recognized: boolean;
  cinemaLogin: boolean; error?: string; provider?: string; username?: string };

export function authorizationPage(o: Consent) {
  const hidden = <><input type="hidden" name="request_id" value={o.id} /><input type="hidden" name="csrf" value={o.csrf} /></>;
  const option = (value: string, label: string) => <option value={value} selected={o.provider === value}>{label}</option>;
  return page('Conectar tu asistente', <>
    <h1>Conecta Cinve a {o.app}.</h1>
    <p class="lead">{o.cinemaLogin
      ? 'Inicia sesión con tu cuenta del cine para consultar precios desde tu asistente. Después vuelves al chat y listo.'
      : `Autoriza a ${o.app} para conectar tus cuentas de cine y consultar precios con ellas.`}</p>
    {/* A self-declared name is never enough: the destination (and, for a
        metadata-document client, the site that publishes it) is always shown. */}
    {o.publisher && <p class="note">Aplicación publicada por <strong>{o.publisher}</strong>. Continúa solo si reconoces ese sitio.</p>}
    <p class="note">Destino: <strong>{o.destination}</strong></p>
    {!o.recognized && <p class="warning" role="alert"><strong>Cinve no puede verificar esta aplicación.</strong> Su nombre lo eligió quien la registró y el destino no pertenece al sitio que la identifica. Continúa solo si acabas de iniciar esta conexión desde tu asistente y reconoces el destino. Si alguien te envió este enlace, cancela.</p>}
    {o.cinemaLogin && <form class="card" method="post" action="/oauth/authorize">
      <section class="stack">
        {hidden}
        {o.error && <Alert variant="destructive" icon={icons.circleAlert()} role="alert"><p>{o.error}</p></Alert>}
        <div class="field">
          <label for="provider">Cine</label>
          <div class="select-wrap"><select class="select" id="provider" name="provider">{option('cinex', 'Cinex')}{option('cinesunidos', 'Cines Unidos')}{option('supercines', 'Supercines')}</select>{icons.chevronDown()}</div>
        </div>
        <div class="field">
          <label for="username">Correo de tu cuenta del cine</label>
          <input id="username" name="username" type="email" autocomplete="username" maxlength="320" required value={o.username ?? ''} autofocus={!o.error} />
        </div>
        <div class="field">
          <label for="password">Contraseña</label>
          <input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required autofocus={Boolean(o.error)} />
        </div>
        <p class="fine">{icons.lock()} Cinve envía tus datos al cine por una conexión segura y guarda solo tu sesión cifrada, nunca tu contraseña. {o.app} no la verá.</p>
      </section>
      <footer><button class="btn full" type="submit" data-size="lg" name="decision" value="connect">Conectar</button></footer>
    </form>}
    <form method="post" action="/oauth/authorize" class="consent-actions">
      {hidden}
      {o.cinemaLogin
        ? <button class="btn" data-variant="outline" type="submit" name="decision" value="approve">Continuar sin conectar un cine</button>
        : <button class="btn" type="submit" name="decision" value="approve">{icons.shieldCheck()}Autorizar conexión</button>}
      <button class="btn" data-variant="ghost" type="submit" name="decision" value="deny">Cancelar</button>
    </form>
    <p class="fine">Cinve solo consulta datos: no compra entradas. La solicitud caduca en 10 minutos.</p>
  </>, { compact: true });
}

export function notFoundPage() {
  return page('Página no encontrada', <>
    <h1>Esta página no existe.</h1>
    <p class="lead">Puede que el enlace esté mal escrito o que la página se haya movido.</p>
    <LinkButton href="/" variant="outline">Volver al inicio</LinkButton>
  </>, { compact: true });
}

export function authorizationErrorPage() {
  return page('Conexión no disponible', <>
    <h1>No se pudo autorizar la conexión.</h1>
    <Alert variant="destructive" icon={icons.circleAlert()} title="La solicitud no es válida o caducó.">
      <p>Vuelve a tu asistente e inicia de nuevo la conexión de Cinve. Si vuelve a ocurrir, inténtalo más tarde.</p>
    </Alert>
    <LinkButton href="/" variant="outline">Volver al inicio</LinkButton>
  </>, { compact: true });
}
