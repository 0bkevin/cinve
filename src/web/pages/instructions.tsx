import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { icons } from '../ui.js';
import { cinemaInstructions, serverInstructions } from '../../agent-instructions.js';
import { hostedAuthInstructions } from '../../hosted-auth-guidance.js';
import { seatInstructions } from '../../seat-guidance.js';

/** One instruction text, exactly as the assistant receives it. */
const Prompt = ({ title, children }: { title: string; children: string }) =>
  <section class="prompt">
    <h2>{title}</h2>
    <pre>{children}</pre>
  </section>;

export const instructionsPage = (origin: string) => renderPage('Instrucciones para tu asistente', <>
  <h1>Lo que Cinve le pide a tu asistente.</h1>
  <p class="lead">Cuando tu asistente se conecta a Cinve, recibe estas instrucciones. Las publicamos tal cual para que sepas qué hace y qué no.</p>
  <Prompt title="Al conectarse">{serverInstructions({ publicHosted: true })}</Prompt>
  <Prompt title="Al guardar tu preferencia">{`${cinemaInstructions}\n\n${seatInstructions}`}</Prompt>
  <details class="more">
    <summary>Al conectar tu cuenta del cine {icons.chevronDown()}</summary>
    <Prompt title="Con tu cuenta conectada">{serverInstructions({ accounts: true })}</Prompt>
    <Prompt title="Para autorizar la conexión">{hostedAuthInstructions(origin)}</Prompt>
  </details>
  <p class="note">La guía de instalación que sigue tu asistente está en <a href="/install?format=text">/install</a>. El código de estas instrucciones es público en <a href="https://github.com/0bkevin/cinve">GitHub</a>.</p>
</>, { compact: true, index: true, canonical: origin + '/instrucciones',
  description: 'Las instrucciones exactas que Cinve envía a tu asistente, publicadas tal cual.' });
