import { h, Fragment, renderDocument } from './web/jsx.js';
import { Page, type PageOptions } from './web/layout.js';
import { Alert, Button, Card, LinkButton, icons } from './web/ui.js';

export { escapeHtml } from './web/jsx.js';
export { servePublicAsset } from './web/assets.js';

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

// The hero's seat map: rows A–G of a 3 + 8 + 3 house, fixed so every load
// looks the same. On load the seats fill in as taken, leaving one free pair.
const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const taken = new Set(['A1', 'A2', 'A6', 'A7', 'A8', 'B4', 'B5', 'B9', 'B10', 'B13', 'C5', 'C6', 'C7', 'C8', 'C9', 'C12', 'D1', 'D4', 'D5', 'D6',
  'D9', 'D10', 'D11', 'E4', 'E5', 'E6', 'E9', 'E10', 'E11', 'E14', 'F3', 'F6', 'F7', 'F8', 'F9', 'G1', 'G2', 'G6', 'G7', 'G12', 'G13', 'G14']);
const pair = new Set(['E7', 'E8']);
const blocks = [[1, 2, 3], [4, 5, 6, 7, 8, 9, 10, 11], [12, 13, 14]];

function SeatMap() {
  return <div class="seating" role="img" aria-label="Mapa de una sala con dos asientos libres juntos en la fila E.">
    {rows.map(row => <div class="row">
      <span class="row-label">{row}</span>
      {blocks.map(block => <span class="block">
        {block.map(n => <span class="seat" data-state={pair.has(row + n) ? 'pair' : taken.has(row + n) ? 'taken' : 'free'}></span>)}
      </span>)}
    </div>)}
  </div>;
}

const questions = ['¿Qué películas hay hoy en Caracas?', '¿Cuánto cuesta la entrada en Cinepic?', '¿Quedan dos asientos juntos a las 7?'];

export function landingPage(origin: string) {
  return page('Consulta de cines en Venezuela', <>
    <section class="hero" aria-labelledby="titulo">
      <SeatMap />
      <h1 id="titulo">La cartelera, en tu chat.</h1>
      <p class="lead">Pregúntale a tu asistente de IA qué películas hay, a qué hora, cuánto cuesta la entrada y qué asientos quedan libres en Cinex, Cines Unidos y Cinepic.</p>
      <LinkButton href="#empezar" size="lg">Añadir Cinve a mi asistente</LinkButton>
    </section>
    <section class="section" id="empezar">
      <h2>Cómo empezar</h2>
      <ol class="steps">
        <li>
          <p>Copia este mensaje y envíaselo a tu asistente.</p>
          <InstallMessage origin={origin} />
        </li>
        <li><p>Tu asistente añade Cinve y te pide permiso antes. Funciona con asistentes que admiten conexiones MCP. <a href="/install">Hacerlo a mano</a></p></li>
        <li>
          <p>Pregunta como siempre:</p>
          <ul class="asks">{questions.map(question => <li>{question}</li>)}</ul>
        </li>
      </ol>
      <p class="note">Algunos precios piden tu cuenta del cine. Tu asistente te dará un enlace privado para conectarla; la contraseña nunca pasa por el chat.</p>
    </section>
    <aside class="project-note" aria-label="Sobre Cinve"><p>Cinve es gratis e independiente, sin relación con Cinex, Cines Unidos ni Cinepic. Consulta la información; no compra entradas ni reserva asientos.</p></aside>
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

export function authorizationPage(app: string, destination: string, id: string, csrf: string, publisher?: string) {
  // A metadata-document client is identified by the site that publishes it;
  // its name is self-declared, so the page names that site as well.
  const provenance = publisher
    ? <>Esta aplicación se identifica con un documento publicado en <strong>{publisher}</strong>. Comprueba que reconoces ese sitio y el destino:</>
    : 'Esta aplicación fue registrada por un tercero. Comprueba que reconoces el destino:';
  return page('Conectar tu asistente', <>
    <h1>Conecta tu asistente.</h1>
    <p class="lead">Autoriza a <strong>{app}</strong> para conectar tus cuentas de cine y consultar precios con ellas.</p>
    <p>Después volverás al chat para elegir el cine y conectar tu cuenta. Tu asistente no recibirá la contraseña del cine.</p>
    <form class="card" method="post" action="/oauth/authorize">
      <header><h2>Revisa la conexión</h2><p>{provenance}</p></header>
      <section>
        <input type="hidden" name="request_id" value={id} />
        <input type="hidden" name="csrf" value={csrf} />
        <code class="code">{destination}</code>
        <p class="note">Esta aprobación crea una conexión privada nueva para este asistente. No comparte cuentas conectadas en otras aplicaciones. Permite consultar y desconectar las cuentas que conectes aquí; no comprar entradas.</p>
      </section>
      <footer>
        <button class="btn" type="submit" name="decision" value="approve">{icons.shieldCheck()}Autorizar conexión</button>
        <button class="btn" data-variant="outline" type="submit" name="decision" value="deny">Cancelar</button>
      </footer>
    </form>
    <p class="fine">La solicitud caduca en 10 minutos. Si no iniciaste esta conexión, cancela.</p>
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
