import { h, Fragment, renderDocument } from './web/jsx.js';
import { Page, type PageOptions } from './web/layout.js';
import { Alert, Button, Card, Eyebrow, LinkButton, icons } from './web/ui.js';

export { escapeHtml } from './web/jsx.js';
export { servePublicAsset } from './web/assets.js';

const page = (title: string, content: JSX.Element, options: PageOptions = {}) =>
  renderDocument(<Page title={title} {...options}>{content}</Page>);

/** The message users paste into their assistant, with a copy button that site.js reveals. */
function InstallMessage({ origin, label }: { origin: string; label?: string }) {
  return <div class="message">
    {label && <p class="eyebrow">{label}</p>}
    <p id="install-message">Instala Cinve siguiendo {origin}/install</p>
    <Button id="copy-install" variant="outline" size="sm" hidden>{icons.copy()}<span>Copiar mensaje</span></Button>
    <p id="copy-feedback" class="note" role="status" aria-live="polite"></p>
  </div>;
}

const examples = [
  ['01 / Cartelera', '“¿Qué películas hay hoy en Caracas?”', 'Busca películas, cines y horarios para elegir una función.'],
  ['02 / Precios', '“¿Cuánto cuesta la entrada en Cinepic?”', 'Consulta las tarifas de una función y las opciones de caramelería que publique el cine.'],
  ['03 / Asientos', '“¿Quedan dos asientos juntos?”', 'Revisa los asientos disponibles en Cinex, Cines Unidos y Cinepic antes de comprar.'],
];

export function landingPage(origin: string) {
  return page('Consulta de cines en Venezuela', <>
    <section class="hero">
      <Eyebrow>Cines de Venezuela</Eyebrow>
      <h1>Consulta películas,<br /><span class="accent">horarios y precios.</span></h1>
      <p class="lead">Cinve permite consultar películas, horarios, precios y asientos de cines en Venezuela desde tu asistente.</p>
      <div class="actions">
        <LinkButton href="#como-usarlo" size="lg">Empezar a usar Cinve {icons.arrowUpRight()}</LinkButton>
        <LinkButton href="#que-puedes-consultar" variant="outline" size="lg">Qué puedo preguntar</LinkButton>
      </div>
    </section>
    <div class="providers" aria-label="Cines incluidos"><span>Consulta en</span><span>Cinex</span><span>Cines Unidos</span><span>Cinepic</span></div>
    <section class="section" id="que-puedes-consultar">
      <Eyebrow>Consultas</Eyebrow>
      <h2>Qué puedes consultar</h2>
      <p>Dile a tu asistente qué quieres ver y en qué ciudad estás.</p>
      <div class="examples">
        {examples.map(([number, question, detail]) => <article class="card">
          <section><span class="number">{number}</span><h3 class="example-question">{question}</h3><p>{detail}</p></section>
        </article>)}
      </div>
      <p class="note">La información disponible depende de cada cine. Cinve consulta los datos, pero no compra entradas ni reserva asientos.</p>
    </section>
    <section class="section setup" id="como-usarlo">
      <div>
        <Eyebrow>Cómo usarlo</Eyebrow>
        <h2>Añade Cinve a tu asistente.</h2>
        <p>Copia este mensaje y envíaselo a tu asistente. Te ayudará a conectar Cinve.</p>
        <p class="fine">Necesitas un asistente que permita añadir conexiones MCP. Puedes consultar la cartelera sin crear una cuenta en Cinve.</p>
      </div>
      <div>
        <InstallMessage origin={origin} label="Mensaje para tu asistente" />
        <p class="note"><a href="/install">Ver instrucciones</a></p>
      </div>
    </section>
    <section class="section setup">
      <div><Eyebrow>Tu cuenta del cine</Eyebrow><h2>Conéctala cuando haga falta.</h2></div>
      <div>
        <p>Algunos precios y consultas requieren una cuenta del cine. Tu asistente te dará un enlace privado para conectarla y luego podrás seguir en el chat.</p>
        <p class="fine">La contraseña se escribe solo en ese formulario, nunca en el chat. Cinve no guarda tu contraseña.</p>
      </div>
    </section>
    <aside class="project-note" aria-label="Sobre Cinve"><p>Cinve es un proyecto independiente, sin fines de lucro y completamente gratuito. No tiene ninguna alianza ni afiliación con Cinex, Cines Unidos o Cinepic.</p></aside>
  </>, { index: true, canonical: origin + '/', script: '/assets/js/site.js' });
}

export function installationPage(origin: string) {
  return page('Cómo usar Cinve', <>
    <Eyebrow>Cómo usarlo</Eyebrow>
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
    <Eyebrow>Conexión privada</Eyebrow>
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
    <Eyebrow>Conexión no disponible</Eyebrow>
    <h1>No se pudo autorizar la conexión.</h1>
    <Alert variant="destructive" icon={icons.circleAlert()} title="La solicitud no es válida o caducó.">
      <p>Vuelve a tu asistente e inicia de nuevo la conexión de Cinve. Si vuelve a ocurrir, inténtalo más tarde.</p>
    </Alert>
    <LinkButton href="/" variant="outline">Volver al inicio</LinkButton>
  </>, { compact: true });
}
