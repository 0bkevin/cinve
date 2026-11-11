import { h, Fragment, renderDocument } from './web/jsx.js';
import { Page, type PageOptions } from './web/layout.js';
import { Alert, Button, Card, LinkButton, icons } from './web/ui.js';

export { escapeHtml } from './web/jsx.js';
export { servePublicAsset } from './web/assets.js';

const page = (title: string, content: JSX.Element, options: PageOptions = {}) =>
  renderDocument(<Page title={title} {...options}>{content}</Page>);

/** The message users paste into their assistant, printed as an admission
 *  ticket; site.js reveals the copy button on its tear-off stub. */
function InstallMessage({ origin }: { origin: string }) {
  return <>
    <div class="ticket">
      <div class="ticket-main">
        <p class="ticket-label">Mensaje para tu asistente</p>
        <p id="install-message">Instala Cinve siguiendo {origin}/install</p>
      </div>
      <div class="ticket-stub">
        <Button id="copy-install" variant="primary" hidden>{icons.copy()}<span>Copiar mensaje</span></Button>
        <span class="ticket-admit" aria-hidden="true">Admite uno</span>
      </div>
    </div>
    <p id="copy-feedback" class="note" role="status" aria-live="polite"></p>
  </>;
}

// The hero's auditorium: rows A–G of a 3 + 8 + 3 seat house. The pattern is
// fixed so the page is the same on every load; one pair in row E is free.
const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const taken = new Set(['A1', 'A2', 'A6', 'A7', 'A8', 'B4', 'B5', 'B9', 'B10', 'B13', 'C5', 'C6', 'C7', 'C8', 'C9', 'C12', 'D1', 'D4', 'D5', 'D6',
  'D9', 'D10', 'D11', 'E4', 'E5', 'E6', 'E9', 'E10', 'E11', 'E14', 'F3', 'F6', 'F7', 'F8', 'F9', 'G1', 'G2', 'G6', 'G7', 'G12', 'G13', 'G14']);
const pair = new Set(['E7', 'E8']);
const blocks = [[1, 2, 3], [4, 5, 6, 7, 8, 9, 10, 11], [12, 13, 14]];

function Auditorium() {
  return <div class="seating" role="img" aria-label="Sala de cine vista desde atrás, con dos asientos libres y juntos en la fila E.">
    {rows.map(row => <div class="row">
      <span class="row-label">{row}</span>
      {blocks.map(block => <span class="block">
        {block.map(n => <span class="seat" data-state={pair.has(row + n) ? 'pair' : taken.has(row + n) ? 'taken' : 'free'}></span>)}
      </span>)}
    </div>)}
  </div>;
}

const questions = [
  ['Cartelera', '¿Qué películas hay hoy en Caracas?', 'Películas, cines y horarios para elegir una función.'],
  ['Precios', '¿Cuánto cuesta la entrada en Cinepic?', 'Las tarifas de una función y la caramelería que publique el cine.'],
  ['Asientos', '¿Quedan dos asientos juntos?', 'El mapa de la sala en Cinex, Cines Unidos y Cinepic antes de comprar.'],
];

export function landingPage(origin: string) {
  return page('Consulta de cines en Venezuela', <>
    <section class="auditorium" aria-labelledby="estreno">
      <div class="screen"><h1 id="estreno">Consulta películas, horarios y precios.</h1></div>
      <Auditorium />
      <p class="seat-caption">Fila E, asientos 7 y 8: libres y juntos.</p>
      <p class="lead">Pregúntale a tu asistente por la cartelera de Cinex, Cines Unidos y Cinepic. Cinve consulta al cine y te responde en el chat.</p>
      <div class="actions">
        <LinkButton href="#como-usarlo" size="lg">Añadir Cinve a mi asistente</LinkButton>
        <LinkButton href="#que-puedes-consultar" variant="outline" size="lg">Ver qué puedo preguntar</LinkButton>
      </div>
    </section>
    <section class="section" id="que-puedes-consultar">
      <h2>Qué puedes preguntar</h2>
      <p>Dile a tu asistente qué quieres ver y en qué ciudad estás.</p>
      <ul class="board">
        {questions.map(([kind, question, detail]) => <li>
          <span class="board-kind">{kind}</span>
          <p class="board-question">{question}</p>
          <p class="board-detail">{detail}</p>
        </li>)}
      </ul>
      <p class="note">La información depende de cada cine. Cinve consulta los datos; no compra entradas ni reserva asientos.</p>
    </section>
    <section class="section setup" id="como-usarlo">
      <div>
        <h2>Añade Cinve a tu asistente.</h2>
        <p>Copia este mensaje y envíaselo a tu asistente. Te ayudará a conectar Cinve.</p>
        <p class="fine">Necesitas un asistente que permita añadir conexiones MCP. Para consultar la cartelera no hace falta crear una cuenta. <a href="/install">Ver instrucciones</a></p>
      </div>
      <div><InstallMessage origin={origin} /></div>
    </section>
    <section class="section setup">
      <h2>Conecta tu cuenta del cine cuando haga falta.</h2>
      <div>
        <p>Algunos precios requieren una cuenta del cine. Tu asistente te dará un enlace privado para conectarla y luego sigues en el chat.</p>
        <p class="fine">La contraseña se escribe solo en ese formulario, nunca en el chat. Cinve no guarda tu contraseña.</p>
      </div>
    </section>
    <aside class="project-note" aria-label="Sobre Cinve"><p>Cinve es un proyecto independiente, sin fines de lucro y completamente gratuito. No tiene ninguna alianza ni afiliación con Cinex, Cines Unidos o Cinepic.</p></aside>
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
