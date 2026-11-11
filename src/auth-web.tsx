import { h, Fragment, renderDocument } from './web/jsx.js';
import { Page } from './web/layout.js';
import { pageStyles } from './public-web.js';

export function loginPage() {
  return renderDocument(<Page title="Conectar cuentas" styles={pageStyles} compact script="/assets/js/connect.js">
    <p class="eyebrow">Conexión privada</p>
    <h1>Conecta tu cuenta del cine.</h1>
    <p class="lead">Conecta tu cuenta para consultar precios de entradas y, en Cinex, caramelería.</p>
    <div class="card">
      <div id="accounts" class="status" aria-live="polite">Comprobando conexiones…</div>
      <form id="login">
        <label for="provider">Cuenta del cine</label>
        <select id="provider" name="provider" disabled><option value="cinex">Cinex</option><option value="cinesunidos">Cines Unidos</option></select>
        <label for="username">Correo de tu cuenta</label>
        <input id="username" name="username" type="email" autocomplete="username" maxlength="320" required />
        <label for="password">Contraseña</label>
        <div class="password">
          <input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required />
          <button id="show" type="button" aria-label="Mostrar contraseña" aria-pressed="false">Mostrar</button>
        </div>
        <p class="note">Cinve enviará tus datos al cine elegido por una conexión segura. Guardará tu sesión cifrada para que tu asistente consulte precios con tu cuenta. No guarda tu contraseña.</p>
        <p class="note"><strong>Usa este enlace solo si tu asistente acaba de crearlo para ti.</strong> Si otra persona te lo envió, ciérralo: tu cuenta del cine quedaría conectada al acceso de esa persona.</p>
        <button class="primary full" id="connect" type="submit" disabled>Conectar cuenta</button>
        <div id="feedback" class="feedback" role="status" aria-live="polite"></div>
      </form>
    </div>
    <button id="done" class="secondary">Cancelar conexión</button>
    <p class="note">Cinepic funciona sin cuenta. Vuelve a tu asistente después de conectar. Este enlace caduca en 10 minutos.</p>
    <noscript><p>Activa JavaScript para conectar tu cuenta.</p></noscript>
  </Page>);
}
