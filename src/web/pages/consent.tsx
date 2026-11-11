import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { Alert, LinkButton, icons } from '../ui.js';
import { catalog } from '../content.js';
import { localeUrl, type Locale } from '../locale.js';

export type Consent = { app: string; destination: string; id: string; csrf: string; publisher?: string; recognized: boolean; cinemaLogin: boolean; error?: string; provider?: string; username?: string };
const fillApp = (text: string, app: string) => text.replace('{app}', app);

export function authorizationPage(o: Consent, locale: Locale = 'es', path = '/oauth/authorize') {
  const c = catalog(locale).consent;
  const action = localeUrl(path, locale);
  const hidden = <><input type="hidden" name="request_id" value={o.id} /><input type="hidden" name="csrf" value={o.csrf} /></>;
  const option = (value: string, label: string) => <option value={value} selected={o.provider === value}>{label}</option>;
  return renderPage(c.title, <>
    <h1>{c.heading} {o.app}.</h1>
    <p class="lead">{o.cinemaLogin ? c.cinemaLead : fillApp(c.appLead, o.app)}</p>
    {o.publisher && <p class="note">{c.publisher} <strong>{o.publisher}</strong>. {c.publisherContinue}</p>}
    <p class="note">{c.destination} <strong>{o.destination}</strong></p>
    {!o.recognized && <p class="warning" role="alert"><strong>{c.unverified}</strong> {c.unverifiedDetail}</p>}
    {o.cinemaLogin && <form class="card" method="post" action={action}><section class="stack">{hidden}
      {o.error && <Alert variant="destructive" icon={icons.circleAlert()} role="alert"><p>{o.error}</p></Alert>}
      <div class="field"><label for="provider">{c.cinema}</label><div class="select-wrap"><select class="select" id="provider" name="provider">{option('cinex', 'Cinex')}{option('cinesunidos', 'Cines Unidos')}{option('supercines', 'Supercines')}</select>{icons.chevronDown()}</div></div>
      <div class="field"><label for="username">{c.email}</label><input id="username" name="username" type="email" autocomplete="username" maxlength="320" required value={o.username ?? ''} autofocus={!o.error} /></div>
      <div class="field"><label for="password">{c.password}</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required autofocus={Boolean(o.error)} /></div>
      <p class="fine">{icons.lock()} {c.safeLogin} {o.app} {c.appCannotSee}</p>
    </section><footer><button class="btn full" type="submit" data-size="lg" name="decision" value="connect">{c.connect}</button></footer></form>}
    <form method="post" action={action} class="consent-actions">{hidden}
      {o.cinemaLogin ? <button class="btn" data-variant="outline" type="submit" name="decision" value="approve">{c.continueWithout}</button> : <button class="btn" type="submit" name="decision" value="approve">{icons.shieldCheck()}{c.authorize}</button>}
      <button class="btn" data-variant="ghost" type="submit" name="decision" value="deny">{c.cancel}</button>
    </form>
    <p class="fine">{c.readOnlyExpiry}</p>
  </>, { locale, path, compact: true });
}

export function authorizationErrorPage(locale: Locale = 'es', path = '/oauth/authorize') {
  const c = catalog(locale).consent;
  return renderPage(c.errorTitle, <><h1>{c.errorHeading}</h1><Alert variant="destructive" icon={icons.circleAlert()} title={c.invalid}><p>{c.retry}</p></Alert><LinkButton href={localeUrl('/', locale)} variant="outline">{c.home}</LinkButton></>, { locale, path, compact: true });
}
