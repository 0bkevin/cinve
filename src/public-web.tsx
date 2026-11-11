import type { ServerResponse } from 'node:http';
import { h, Fragment, renderDocument } from './web/jsx.js';
import { Page, type PageOptions } from './web/layout.js';
import { Alert, Button, Card, LinkButton, icons } from './web/ui.js';
import { serverInstructions } from './agent-instructions.js';
import { hostedAuthInstructions } from './hosted-auth-guidance.js';
import { seatInstructions } from './seat-guidance.js';
import { cinemaInstructions } from './install.js';

export { escapeHtml } from './web/jsx.js';
export { servePublicAsset } from './web/assets.js';

/** Headers for every response, including pages served outside the hosted app (for example /install on Vercel). */
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
      <Button id="copy-install" hidden>{icons.copy()}<span>Copiar</span></Button>
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
  return <div class="board-scroll" role="region" aria-label="Qué ofrece cada cine" tabindex="0"><table class="board">
    <caption class="visually-hidden">Qué puede consultar tu asistente en cada cine</caption>
    <thead><tr><td></td>{cinemas.map(name => <th scope="col">{name}</th>)}</tr></thead>
    <tbody>
      {coverage.map(({ topic, ask, access }) => <tr>
        <th scope="row"><span class="topic">{topic}</span><span class="ask">{ask}</span></th>
        {access.map(level => <td data-access={level}><span class="mark"><span class="glyph" aria-hidden="true">{level === 'account' && icons.lock()}</span>{accessLabel[level]}</span></td>)}
      </tr>)}
    </tbody>
  </table></div>;
}

// How visitor data is handled: a four-card summary, then the details. Every
// claim matches the hosted service (docs/hosted.md); keep them in sync.
const safeguardSummary = [
  ['Tu contraseña', 'Se usa una vez para entrar al cine y no se guarda.'],
  ['Sesión cifrada', 'Con AES-256-GCM y atada a tu conexión.'],
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
  ['¿Cuánto cuesta?', 'Nada. Cinve es gratis y no muestra anuncios.'],
  ['¿Con qué asistentes funciona?', 'Con los que aceptan conexiones MCP remotas, como Claude Code, Codex u OpenCode. Si tu asistente no tiene esa opción, todavía no puede usar Cinve.'],
  ['¿Necesito crear una cuenta?', 'En Cinve, no. Para ver precios y asientos de Cinex y Cines Unidos, tu asistente te pedirá conectar tu cuenta de ese cine. En Supercines es opcional: sin ella ves las tarifas públicas.'],
  ['¿Qué tan actualizada está la información?', 'Cinve la consulta en la web del cine cuando preguntas y reutiliza algunas respuestas por unos minutos. Los asientos pueden cambiar antes de que compres.'],
  ['¿Puedo comprar entradas desde el chat?', 'No. Cinve solo consulta; la compra se hace en la web o la app del cine.'],
  ['¿Por qué no aparece mi cine o mi ciudad?', 'Cinve muestra las sedes que cada cine publica en su web, y Cinepic por ahora solo en Caracas. Si falta alguna, avísanos en GitHub.'],
  ['¿Cómo desconecto mi cuenta del cine?', 'Escríbele a tu asistente «desconecta mi cuenta de Cinex» (o de Cines Unidos o Supercines) y borramos la sesión guardada.'],
  ['¿Cinve es oficial?', 'No. Es un proyecto independiente, sin relación con los cines.'],
];

export function landingPage(origin: string) {
  return page('Consulta de cines en Venezuela', <>
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
          <p class="lead">Pregúntaselo a tu asistente. Con Cinve, él revisa Cinex, Cines Unidos, Cinepic, Supercines y Gran Cine por ti.</p>
          <LinkButton href="#empezar" size="lg">Añadir Cinve a mi asistente</LinkButton>
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
      <details class="more">
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
        <p>No necesitas crear una cuenta en Cinve, y solo guardamos lo necesario para consultar con la tuya del cine.</p>
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
        {faq.map(([question, answer]) => <details>
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
  </>, { index: true, canonical: origin + '/', script: '/assets/js/site.js' });
}

export function installationPage(origin: string) {
  return page('Cómo usar Cinve', <>
    <h1>Cinve en tu asistente.</h1>
    <p>Envía este mensaje a tu asistente para que te ayude a añadir Cinve:</p>
    <InstallMessage origin={origin} />
    <Card title="Si lo añades a mano" description={<>En las conexiones de tu asistente, añade un servidor MCP llamado <strong>Cinve</strong> con esta dirección:</>}>
      <code class="code">{origin}/mcp</code>
      <p class="note">Elige HTTP si te pide el tipo de conexión. Tu asistente debe admitir servidores MCP remotos.</p>
    </Card>
    <p>Después, pregunta qué películas hay en tu ciudad. Para consultar la cartelera no necesitas una cuenta. Si una consulta requiere conectarte al cine, tu asistente te dará un enlace privado.</p>
    <p class="note"><a href="/install?format=text">Ver las instrucciones completas para el asistente</a></p>
  </>, { compact: true, script: '/assets/js/site.js' });
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
  </>, { compact: true });
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

export function authorizationErrorPage() {
  return page('Conexión no disponible', <>
    <h1>No se pudo autorizar la conexión.</h1>
    <Alert variant="destructive" icon={icons.circleAlert()} title="La solicitud no es válida o caducó.">
      <p>Vuelve a tu asistente e inicia de nuevo la conexión de Cinve. Si vuelve a ocurrir, inténtalo más tarde.</p>
    </Alert>
    <LinkButton href="/" variant="outline">Volver al inicio</LinkButton>
  </>, { compact: true });
}
