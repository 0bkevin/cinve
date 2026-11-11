import { h, Fragment, type Child } from '../jsx.js';
import { catalog } from '../content.js';
import { canonicalUrl, type Locale } from '../locale.js';
import { renderPage } from '../layout.js';

// Every statement here must match the code: see docs/hosted.md, src/auth.ts,
// src/hosted-store.ts, src/hosted-links.ts and src/oauth.ts. Change the page
// (and its date) together with any change to what the service stores.
const repo = 'https://github.com/0bkevin/cinve';

const Part = ({ id, title, children }: { id: string; title: string; children?: Child }) =>
  <section class="policy" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>
    {children}
  </section>;

export const privacyPage = (origin: string, locale: Locale = 'es') => {
  const text = catalog(locale).privacy;
  const host = new URL(origin).host;
  return renderPage(text.title, <>
    <h1>{text.heading}</h1>
    <p class="lead">{text.lead.replace('{host}', host)}</p>
    <p class="note">{text.updatedLabel} {text.updated}. {text.codeIntro} <a href={repo}>{text.github}</a>.</p>

    <Part id="resumen" title={text.summary.title}>
      <ul>{text.summary.items.map(item => <li>{item}</li>)}</ul>
    </Part>

    <Part id="consultas" title={text.queries.title}>
      <p>{text.queries.paragraph1}</p><p>{text.queries.paragraph2}</p>
    </Part>

    <Part id="cuenta" title={text.account.title}>
      <p>{text.account.intro}</p>
      <ul>
        <li><strong>{text.account.passwordLabel}</strong> {text.account.password}</li>
        <li><strong>{text.account.sessionLabel}</strong> {text.account.session}</li>
        <li><strong>{text.account.emailLabel}</strong> {text.account.email}</li>
        <li>{text.account.use}</li>
      </ul>
    </Part>

    <Part id="asistente" title={text.assistant.title}>
      <p>{text.assistant.intro}</p>
      <ul>{text.assistant.items.map(item => <li>{item}</li>)}</ul>
      <p>{text.assistant.isolation}</p>
    </Part>

    <Part id="abuso" title={text.abuse.title}>
      <p>{text.abuse.paragraph1}</p><p>{text.abuse.paragraph2}</p>
    </Part>

    <Part id="cookies" title={text.cookies.title}>
      <p>{text.cookies.intro} <code>HttpOnly</code> {text.cookies.limitedTo}</p>
      <ul>
        <li><code>cinve_approval_…</code>: {text.cookies.approval}</li>
        <li><code>cinve_device</code>: {text.cookies.device}</li>
      </ul>
      <p>{text.cookies.noOthers}</p>
    </Part>

    <Part id="terceros" title={text.sharing.title}>
      <ul>
        <li><strong>{text.sharing.cinemasLabel}</strong> {text.sharing.cinemas}</li>
        <li><strong>{text.sharing.hostingLabel}</strong> {text.sharing.hosting}</li>
      </ul>
      <p>{text.sharing.noOthers}</p>
    </Part>

    <Part id="conservacion" title={text.retention.title}>
      <ul>{text.retention.items.map(item => <li>{item}</li>)}</ul>
      <p>{text.retention.cleanup}</p>
    </Part>

    <Part id="borrar" title={text.deletion.title}>
      <ul>
        <li>{text.deletion.disconnectStart} <code>disconnect_account</code> {text.deletion.disconnectEnd}</li>
        <li>{text.deletion.revoke}</li>
        <li>{text.deletion.expire}</li>
      </ul>
      <p>{text.deletion.signOut}</p>
    </Part>

    <Part id="local" title={text.local.title}>
      <p>{text.local.before}<code>stdio</code>{text.local.middle} <code>~/.config/cinev</code> {text.local.or} <code>$XDG_CONFIG_HOME/cinev</code>{text.local.after} <code>npm run logout</code>.</p>
    </Part>

    <Part id="contacto" title={text.contact.title}>
      <p>{text.contact.changes} <a href={repo}>{text.github}</a>. {text.contact.questions} <a href={`${repo}/issues/new/choose`}>{text.contact.issue}</a>, {text.contact.noPersonal} {text.contact.security} <a href={`${repo}/security/advisories/new`}>{text.contact.report}</a>.</p>
      <p>{text.contact.cinema}</p>
    </Part>
  </>, { compact: true, index: true, locale, canonical: canonicalUrl(origin + '/privacidad', locale), path: '/privacidad', description: text.description });
};
