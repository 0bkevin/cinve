import { h, Fragment } from './web/jsx.js';
import { renderPage } from './web/layout.js';
import { Alert, Button, icons } from './web/ui.js';
import { catalog } from './web/content.js';
import type { Locale } from './web/locale.js';

export function loginPage(locale: Locale = 'es') {
  const c = catalog(locale).connect;
  const catalogs = Object.fromEntries((['es', 'en'] as const).map(language => {
    const { connect, common, errors } = catalog(language);
    return [language, { connect, common, errors }];
  }));
  return renderPage(c.title, <>
    <h1 data-i18n="heading">{c.heading}</h1><p class="lead" data-i18n="lead">{c.lead}</p>
    <div class="card" id="checking" hidden><section class="loading" role="status">{icons.spinner()}<span data-i18n="checking">{c.checking}</span></section></div>
    <form class="card" id="login" hidden>
      <header><h2 id="login-title" data-i18n="formTitle">{c.formTitle}</h2><p id="login-account"></p></header>
      <section class="stack">
        <div class="field"><label for="username" data-i18n="email">{c.email}</label><input id="username" name="username" type="email" autocomplete="username" inputmode="email" maxlength="320" required /></div>
        <div class="field"><label for="password" data-i18n="password">{c.password}</label><div class="password-row"><input class="input" id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required /><Button id="show" variant="outline" aria-label={c.showPassword} aria-pressed="false" data-i18n-aria-label="showPassword" data-i18n="show">{c.show}</Button></div></div>
        <Alert id="feedback" variant="destructive" icon={icons.circleAlert()} role="alert" hidden><p id="feedback-text"></p></Alert>
        <p class="fine">{icons.lock()} <span data-i18n="safe">{c.safe}</span></p>
      </section>
      <footer><button class="btn full" id="connect" type="submit" data-size="lg" disabled data-i18n="connect">{c.connect}</button><Button id="cancel" variant="ghost" class="full" data-i18n="cancel">{c.cancel}</Button></footer>
    </form>
    <div class="card" id="result" hidden><section class="status-panel" aria-live="polite"><span id="result-icon"></span><h2 id="result-title"></h2><p id="result-text"></p></section></div>
    <template id="icon-success">{icons.circleCheck()}</template><template id="icon-error">{icons.circleAlert()}</template><template id="icon-spinner">{icons.spinner()}</template>
    <noscript><Alert icon={icons.circleAlert()} title={c.noscriptTitle}><p>{c.noscript}</p></Alert></noscript>
    <p class="note" data-i18n="expires">{c.expires}</p>
  </>, { locale, path: '/connect', compact: true, script: '/assets/js/connect.js', clientCatalogs: catalogs });
}
