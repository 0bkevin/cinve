import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { LinkButton, icons } from '../ui.js';
import { coverage, faq, safeguardSummary, safeguards, structuredData, catalog } from '../content.js';
import { ChatDemo, SeatMap } from '../components/seats.js';
import { Coverage } from '../components/coverage.js';
import { WorksWith } from '../components/assistants.js';
import { InstallMessage } from '../components/copy.js';
import { localeUrl, type Locale } from '../locale.js';

const repo = 'https://github.com/0bkevin/cinve';
const Section = ({ id, title, intro, class: className = 'section', children }: { id: string; title: string; intro?: JSX.Element | string; class?: string; children?: JSX.Element | JSX.Element[] }) =>
  <section class={className} id={id} aria-labelledby={`${id}-titulo`}><header class="section-head"><h2 id={`${id}-titulo`}>{title}</h2>{intro && <p>{intro}</p>}</header>{children}</section>;
const Points = ({ items }: { items: readonly (readonly [string, string])[] }) => <ul class="asks">{items.map(([title, text]) => <li><span class="topic">{title}</span><span class="ask">{text}</span></li>)}</ul>;
const More = ({ id, summary, children }: { id?: string; summary: string; children?: JSX.Element | JSX.Element[] }) => <details class="more" id={id}><summary><span>{summary}</span>{icons.chevronDown()}</summary>{children}</details>;

const Hero = ({ locale }: { locale: Locale }) => {
  const c = catalog(locale).landing;
  return <section class="hero" aria-labelledby="titulo">
    <figure class="house"><SeatMap locale={locale} /><figcaption class="legend"><span><i data-state="free"></i>{c.demo.free}</span><span><i data-state="taken"></i>{c.demo.taken}</span><span><i data-state="unknown"></i>{c.demo.unknown}</span></figcaption></figure>
    <div class="hero-copy"><h1 id="titulo"><span>{c.heroTitle[0]}</span> <span>{c.heroTitle[1]}</span></h1><div><p class="lead">{c.heroLead}</p><div class="hero-actions"><LinkButton href="#empezar" size="lg">{c.addAssistant}</LinkButton><LinkButton href="#cines" size="lg" variant="outline">{c.viewCinemas}</LinkButton></div></div></div>
  </section>;
};

const Asking = ({ locale }: { locale: Locale }) => {
  const c = catalog(locale).landing;
  return <Section id="preguntar" title={c.askTitle}><div class="ask-grid"><Points items={coverage(locale).map(({ topic, ask }) => [topic, `“${ask}”`])} /><ChatDemo locale={locale} /></div>
    <More id="cines" summary={c.coverageSummary}><Coverage locale={locale} /><div class="notes"><p><strong>{c.accountNoteTitle}</strong> {c.accountNote}</p><p><strong>{c.seatsNoteTitle}</strong> {c.seatsNote}</p><p><strong>{c.readOnlyTitle}</strong> {c.readOnly}</p></div></More>
  </Section>;
};

const Start = ({ origin, locale }: { origin: string; locale: Locale }) => {
  const c = catalog(locale).landing;
  return <Section id="empezar" class="section band" title={c.startTitle} intro={<>{c.mcpIntro} <a href={localeUrl('/install', locale)}>{c.manualLink}</a></>}>
    <WorksWith locale={locale} /><InstallMessage origin={origin} locale={locale} /><ol class="steps">{c.steps.map(step => <li>{step}</li>)}</ol>
  </Section>;
};

const Data = ({ locale }: { locale: Locale }) => {
  const c = catalog(locale).landing;
  return <Section id="datos" title={c.dataTitle} intro={c.dataIntro}><Points items={safeguardSummary(locale)} /><More summary={c.safeguardsSummary}><ul class="safeguards">{safeguards(locale).map(([icon, title, text]) => <li>{icon}<h3>{title}</h3><p>{text}</p></li>)}</ul><p class="note">{c.safeguardsNote} <a href={`${repo}/security/advisories/new`}>{c.reportPrivately}</a>.</p></More></Section>;
};

const Faq = ({ locale }: { locale: Locale }) => <Section id="preguntas" class="section split" title={catalog(locale).landing.faqTitle}><div class="faq">{faq(locale).map(([question, answer]) => <details name="faq"><summary><span>{question}</span>{icons.plus()}</summary><p>{answer}</p></details>)}</div></Section>;
const Closing = ({ locale }: { locale: Locale }) => {
  const c = catalog(locale).landing;
  return <section class="closing" aria-labelledby="abierto-titulo"><h2 id="abierto-titulo">{c.closingTitle}</h2><p>{c.closingText}</p><div class="closing-links"><LinkButton href={repo} variant="outline">{icons.github()}{c.viewSource}</LinkButton><LinkButton href={`${repo}/issues/new/choose`} variant="ghost">{catalog(locale).common.report}</LinkButton><LinkButton href={`${repo}/issues/new/choose`} variant="ghost">{c.proposeCinema}</LinkButton></div></section>;
};

export const landingPage = (origin: string, locale: Locale = 'es') => {
  const c = catalog(locale).landing;
  const canonical = new URL(locale === 'en' ? '/?lang=en' : '/', origin).href;
  return renderPage(c.title, <><Hero locale={locale} /><Asking locale={locale} /><Start origin={origin} locale={locale} /><Data locale={locale} /><Faq locale={locale} /><Closing locale={locale} /></>, {
    locale, path: '/', index: true, canonical, script: '/assets/js/site.js', description: c.description, structuredData: structuredData(origin, locale),
  });
};
