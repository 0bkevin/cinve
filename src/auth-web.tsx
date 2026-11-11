import { h, renderDocument } from './web/jsx.js';
import { Page } from './web/layout.js';
import { Alert, Button, Eyebrow, icons } from './web/ui.js';

// One card is visible at a time (checking, form, result); connect.js
// switches between them. Without JavaScript only the noscript notice shows.
export function loginPage() {
  return renderDocument(<Page title="Conectar cuentas" compact script="/assets/js/connect.js">
    <Eyebrow>Conexión privada</Eyebrow>
    <h1>Conecta tu cuenta del cine.</h1>
    <p class="lead">Conecta tu cuenta para consultar precios de entradas y, en Cinex, caramelería.</p>
    <div class="card" id="checking" hidden><section class="loading" role="status">{icons.spinner()}<span>Comprobando el enlace…</span></section></div>
    <form class="card" id="login" hidden>
      <header><h2 id="login-title">Conecta tu cuenta</h2><p id="login-account"></p></header>
      <section class="stack">
        <div class="field">
          <label for="username">Correo de tu cuenta</label>
          <input id="username" name="username" type="email" autocomplete="username" inputmode="email" maxlength="320" required />
        </div>
        <div class="field">
          <label for="password">Contraseña</label>
          <div class="password-row">
            <input class="input" id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required />
            <Button id="show" variant="outline" aria-label="Mostrar contraseña" aria-pressed="false">Mostrar</Button>
          </div>
        </div>
        <Alert id="feedback" variant="destructive" icon={icons.circleAlert()} role="alert" hidden><p id="feedback-text"></p></Alert>
        <p class="fine">{icons.lock()} Cinve enviará tus datos al cine por una conexión segura y guardará tu sesión cifrada para que tu asistente consulte precios con tu cuenta. No guarda tu contraseña.</p>
        <p class="fine"><strong>Usa este enlace solo si tu asistente acaba de crearlo para ti.</strong> Si otra persona te lo envió, ciérralo: tu cuenta del cine quedaría conectada al acceso de esa persona.</p>
      </section>
      <footer>
        <button class="btn full" id="connect" type="submit" data-size="lg" disabled>Conectar cuenta</button>
        <Button id="cancel" variant="ghost" class="full">Cancelar conexión</Button>
      </footer>
    </form>
    <div class="card" id="result" hidden>
      <section class="status-panel" aria-live="polite">
        <span id="result-icon"></span>
        <h2 id="result-title"></h2>
        <p id="result-text"></p>
      </section>
    </div>
    <template id="icon-success">{icons.circleCheck()}</template>
    <template id="icon-error">{icons.circleAlert()}</template>
    <template id="icon-spinner">{icons.spinner()}</template>
    <noscript><Alert icon={icons.circleAlert()} title="Activa JavaScript para conectar tu cuenta."><p>El enlace se comprueba en tu navegador para que nunca llegue al servidor.</p></Alert></noscript>
    <p class="note">Cinepic funciona sin cuenta. Vuelve a tu asistente después de conectar. Este enlace caduca en 10 minutos.</p>
  </Page>);
}
