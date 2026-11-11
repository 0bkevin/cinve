import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { LinkButton, icons } from '../ui.js';
import { coverage, faq, safeguardSummary, safeguards, structuredData } from '../content.js';
import { ChatDemo, SeatMap } from '../components/seats.js';
import { Coverage } from '../components/coverage.js';
import { WorksWith } from '../components/assistants.js';
import { InstallMessage } from '../components/copy.js';

const repo = 'https://github.com/0bkevin/cinve';

/** A titled landing section; its heading id doubles as the section's label. */
const Section = ({ id, title, intro, class: className = 'section', children }: { id: string; title: string; intro?: JSX.Element | string; class?: string; children?: JSX.Element | JSX.Element[] }) =>
  <section class={className} id={id} aria-labelledby={`${id}-titulo`}>
    <header class="section-head">
      <h2 id={`${id}-titulo`}>{title}</h2>
      {intro && <p>{intro}</p>}
    </header>
    {children}
  </section>;

/** Short points in open columns, each marked with a small amber seat. */
const Points = ({ items }: { items: [title: string, text: string][] }) =>
  <ul class="asks">{items.map(([title, text]) => <li><span class="topic">{title}</span><span class="ask">{text}</span></li>)}</ul>;

/** <details> keeps every collapsed section working without JavaScript. */
const More = ({ id, summary, children }: { id?: string; summary: string; children?: JSX.Element | JSX.Element[] }) =>
  <details class="more" id={id}>
    <summary><span>{summary}</span>{icons.chevronDown()}</summary>
    {children}
  </details>;

const Hero = () =>
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
  </section>;

const Asking = () =>
  <Section id="preguntar" title="Qué puedes preguntar">
    <div class="ask-grid">
      <Points items={coverage.map(({ topic, ask }) => [topic, `“${ask}”`])} />
      <ChatDemo />
    </div>
    <More id="cines" summary="Ver qué ofrece cada cine">
      <Coverage />
      <div class="notes">
        <p><strong>Con tu cuenta.</strong> Tu asistente te da un enlace privado para conectar tu cuenta del cine.</p>
        <p><strong>Asientos.</strong> El mapa distingue los libres, los ocupados y los que no se pudieron confirmar. Puede cambiar antes de que compres.</p>
        <p><strong>Solo consulta.</strong> Cinve no compra entradas ni reserva asientos.</p>
      </div>
    </More>
  </Section>;

const Start = ({ origin }: { origin: string }) =>
  <Section id="empezar" class="section band" title="Cómo empezar" intro={<>Funciona con asistentes que aceptan conexiones MCP. <a href="/install">¿Prefieres hacerlo a mano?</a></>}>
    <WorksWith />
    <InstallMessage origin={origin} />
    <ol class="steps">
      <li>Copia este mensaje y envíaselo a tu asistente.</li>
      <li>Tu asistente añade Cinve y te pide permiso. No tienes que crear ninguna cuenta.</li>
      <li>Pregunta qué quieres ver, como en cualquier chat.</li>
    </ol>
  </Section>;

const Data = () =>
  <Section id="datos" title="Cómo cuidamos tus datos" intro="Solo guardamos algo si conectas tu cuenta del cine, y es lo mínimo para consultar con ella.">
    <Points items={safeguardSummary} />
    <More summary="Ver cómo protegemos tus datos">
      <ul class="safeguards">{safeguards.map(([icon, title, text]) => <li>{icon}<h3>{title}</h3><p>{text}</p></li>)}</ul>
      <p class="note">Si encuentras un fallo de seguridad, <a href={`${repo}/security/advisories/new`}>repórtalo en privado</a>.</p>
    </More>
  </Section>;

// name= keeps the answers exclusive without JavaScript; site.js animates them.
const Faq = () =>
  <Section id="preguntas" class="section split" title="Preguntas frecuentes">
    <div class="faq">
      {faq.map(([question, answer]) => <details name="faq">
        <summary><span>{question}</span>{icons.plus()}</summary>
        <p>{answer}</p>
      </details>)}
    </div>
  </Section>;

const Closing = () =>
  <section class="closing" aria-labelledby="abierto-titulo">
    <h2 id="abierto-titulo">Gratis, independiente y de código abierto.</h2>
    <p>Cinve es un proyecto independiente. Solo usa la información que los cines ya publican y, si conectas tu cuenta, lo que esa cuenta te permite ver. Cualquiera puede revisar cómo funciona o ayudar a mejorarlo.</p>
    <div class="closing-links">
      <LinkButton href={repo} variant="outline">{icons.github()}Ver el código</LinkButton>
      <LinkButton href={`${repo}/issues/new/choose`} variant="ghost">Reportar un problema</LinkButton>
      <LinkButton href={`${repo}/issues/new/choose`} variant="ghost">Proponer un cine</LinkButton>
    </div>
  </section>;

export const landingPage = (origin: string) => renderPage('Cartelera, precios y asientos de cines en Venezuela', <>
  <Hero />
  <Asking />
  <Start origin={origin} />
  <Data />
  <Faq />
  <Closing />
</>, { index: true, canonical: origin + '/', script: '/assets/js/site.js', structuredData: structuredData(origin) });
