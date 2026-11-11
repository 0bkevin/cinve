import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { Alert, LinkButton, icons } from '../ui.js';

/** The OAuth consent page. It can also sign in to a cinema in the same step,
 *  and is re-rendered with the error after a failed sign-in. */
export type Consent = { app: string; destination: string; id: string; csrf: string; publisher?: string; recognized: boolean;
  cinemaLogin: boolean; error?: string; provider?: string; username?: string };

export function authorizationPage(o: Consent) {
  const hidden = <><input type="hidden" name="request_id" value={o.id} /><input type="hidden" name="csrf" value={o.csrf} /></>;
  const option = (value: string, label: string) => <option value={value} selected={o.provider === value}>{label}</option>;
  return renderPage('Conectar tu asistente', <>
    <h1>Conecta Cinve a {o.app}.</h1>
    <p class="lead">{o.cinemaLogin
      ? 'Inicia sesión con tu cuenta del cine para consultar precios desde tu asistente. Después vuelves al chat y listo.'
      : `Autoriza a ${o.app} para conectar tus cuentas de cine y consultar precios con ellas.`}</p>
    {/* A self-declared name is never enough: the destination (and, for a
        metadata-document client, the site that publishes it) is always shown. */}
    {o.publisher && <p class="note">Aplicación publicada por <strong>{o.publisher}</strong>. Continúa solo si reconoces ese sitio.</p>}
    <p class="note">Destino: <strong>{o.destination}</strong></p>
    {!o.recognized && <p class="warning" role="alert"><strong>Cinve no puede verificar esta aplicación.</strong> Su nombre lo eligió quien la registró y el destino no pertenece al sitio que la identifica. Continúa solo si acabas de iniciar esta conexión desde tu asistente y reconoces el destino. Si alguien te envió este enlace, cancela.</p>}
    {o.cinemaLogin && <form class="card" method="post" action="/oauth/authorize">
      <section class="stack">
        {hidden}
        {o.error && <Alert variant="destructive" icon={icons.circleAlert()} role="alert"><p>{o.error}</p></Alert>}
        <div class="field">
          <label for="provider">Cine</label>
          <div class="select-wrap"><select class="select" id="provider" name="provider">{option('cinex', 'Cinex')}{option('cinesunidos', 'Cines Unidos')}{option('supercines', 'Supercines')}</select>{icons.chevronDown()}</div>
        </div>
        <div class="field">
          <label for="username">Correo de tu cuenta del cine</label>
          <input id="username" name="username" type="email" autocomplete="username" maxlength="320" required value={o.username ?? ''} autofocus={!o.error} />
        </div>
        <div class="field">
          <label for="password">Contraseña</label>
          <input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required autofocus={Boolean(o.error)} />
        </div>
        <p class="fine">{icons.lock()} Cinve envía tus datos al cine por una conexión segura y guarda solo tu sesión cifrada, nunca tu contraseña. {o.app} no la verá.</p>
      </section>
      <footer><button class="btn full" type="submit" data-size="lg" name="decision" value="connect">Conectar</button></footer>
    </form>}
    <form method="post" action="/oauth/authorize" class="consent-actions">
      {hidden}
      {o.cinemaLogin
        ? <button class="btn" data-variant="outline" type="submit" name="decision" value="approve">Continuar sin conectar un cine</button>
        : <button class="btn" type="submit" name="decision" value="approve">{icons.shieldCheck()}Autorizar conexión</button>}
      <button class="btn" data-variant="ghost" type="submit" name="decision" value="deny">Cancelar</button>
    </form>
    <p class="fine">Cinve solo consulta datos: no compra entradas. La solicitud caduca en 10 minutos.</p>
  </>, { compact: true });
}

export function authorizationErrorPage() {
  return renderPage('Conexión no disponible', <>
    <h1>No se pudo autorizar la conexión.</h1>
    <Alert variant="destructive" icon={icons.circleAlert()} title="La solicitud no es válida o caducó.">
      <p>Vuelve a tu asistente e inicia de nuevo la conexión de Cinve. Si vuelve a ocurrir, inténtalo más tarde.</p>
    </Alert>
    <LinkButton href="/" variant="outline">Volver al inicio</LinkButton>
  </>, { compact: true });
}
