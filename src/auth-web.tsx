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
    <div class="connect-panel" id="checking" hidden><section class="loading" role="status">{icons.spinner()}<span data-i18n="checking">{c.checking}</span></section></div>
    <form class="connect-panel connect-form" id="login" novalidate hidden>
      <header><h2 id="login-title" data-i18n="formTitle">{c.formTitle}</h2><p id="login-account"></p></header>
      <div class="field"><label for="username" data-i18n="email">{c.email}</label><input id="username" name="username" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" maxlength="254" required aria-describedby="username-error" /><p class="field-error" id="username-error" hidden></p></div>
      <div class="field"><label for="password" data-i18n="password">{c.password}</label>
        <div class="password-field"><input class="input" id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required aria-describedby="password-error" />
          <Button id="show" variant="ghost" class="reveal" aria-label={c.showPassword} aria-pressed="false" aria-controls="password" data-i18n-aria-label="showPassword"><span class="when-hidden">{icons.eye()}</span><span class="when-shown">{icons.eyeOff()}</span></Button></div>
        <p class="field-error" id="password-error" hidden></p></div>
      <Alert id="feedback" variant="destructive" icon={icons.circleAlert()} role="alert" hidden><p id="feedback-text"></p></Alert>
      <button class="btn full" id="connect" type="submit" data-size="lg" disabled data-i18n="connect">{c.connect}</button>
      <p class="fine safe">{icons.lock()}<span data-i18n="safe">{c.safe}</span></p>
      <footer><span class="note" data-i18n="expires">{c.expires}</span><Button id="cancel" variant="link" class="cancel" data-i18n="cancel">{c.cancel}</Button></footer>
    </form>
    <div class="connect-panel" id="result" hidden><section class="status-panel" aria-live="polite"><span id="result-icon"></span><h2 id="result-title"></h2><p id="result-text"></p></section></div>
    <template id="icon-success">{icons.circleCheck()}</template><template id="icon-error">{icons.circleAlert()}</template><template id="icon-spinner">{icons.spinner()}</template>
    <noscript><Alert icon={icons.circleAlert()} title={c.noscriptTitle}><p>{c.noscript}</p></Alert></noscript>
  </>, { locale, path: '/connect', compact: true, script: '/assets/js/connect.js', clientCatalogs: catalogs });
}
