import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { icons } from '../ui.js';
import { cinemaInstructions, serverInstructions } from '../../agent-instructions.js';
import { hostedAuthInstructions } from '../../hosted-auth-guidance.js';
import { seatInstructions } from '../../seat-guidance.js';
import { catalog } from '../content.js';
import { localeUrl, type Locale } from '../locale.js';

/** One instruction text, exactly as the assistant receives it. */
const Prompt = ({ title, children }: { title: string; children: string }) =>
  <section class="prompt">
    <h2>{title}</h2>
    <pre lang="en">{children}</pre>
  </section>;

export const instructionsPage = (origin: string, locale: Locale = 'es') => {
  const c = catalog(locale).instructions;
  const canonical = new URL(locale === 'en' ? '/instrucciones?lang=en' : '/instrucciones', origin).href;
  const prompts = <div><Prompt title={c.connect}>{serverInstructions({ publicHosted: true })}</Prompt><section class="prompt"><h2>{c.preference}</h2><pre><span lang="en">{cinemaInstructions}</span>{'\n\n'}<span lang="en">{seatInstructions}</span></pre></section><details class="more"><summary>{c.account} {icons.chevronDown()}</summary><Prompt title={c.connected}>{serverInstructions({ accounts: true })}</Prompt><Prompt title={c.authorize}>{hostedAuthInstructions(origin)}</Prompt></details></div>;
  return renderPage(c.title, <>
    <h1>{c.heading}</h1><p class="lead">{c.lead}</p>
    <p class="note">{c.original}</p>
    {prompts}
    <p class="note">{c.guide} <a href={localeUrl('/install?format=text', locale)}>{c.guideLink}</a>. {c.source} <a href="https://github.com/0bkevin/cinve">GitHub</a>.</p>
  </>, { locale, path: '/instrucciones', compact: true, index: true, canonical, description: c.lead });
};
