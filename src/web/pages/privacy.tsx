import { h, Fragment, type Child } from '../jsx.js';
import { renderPage } from '../layout.js';

// Every statement here must match the code: see docs/hosted.md, src/auth.ts,
// src/hosted-store.ts, src/hosted-links.ts and src/oauth.ts. Change the page
// (and its date) together with any change to what the service stores.
const updated = '11 de noviembre de 2026';
const repo = 'https://github.com/0bkevin/cinve';

const Part = ({ id, title, children }: { id: string; title: string; children?: Child }) =>
  <section class="policy" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>
    {children}
  </section>;

export const privacyPage = (origin: string) => renderPage('Política de privacidad', <>
  <h1>Tu privacidad en Cinve.</h1>
  <p class="lead">Cinve consulta la cartelera por ti y guarda lo mínimo para hacerlo. Aquí está qué datos trata el servicio alojado en {new URL(origin).host}, para qué y cuánto tiempo.</p>
  <p class="note">Última actualización: {updated}. El código que hace todo esto es público en <a href={repo}>GitHub</a>.</p>

  <Part id="resumen" title="En resumen">
    <ul>
      <li>Para consultar películas, horarios y precios públicos no necesitas cuenta ni das ningún dato personal.</li>
      <li>Si conectas tu cuenta del cine, tu contraseña se usa una vez para iniciar sesión y no se guarda. Solo guardamos, cifrada, la sesión que te da el cine.</li>
      <li>No vendemos datos, no mostramos anuncios y la web no carga analíticas ni recursos de otros sitios.</li>
      <li>Puedes desconectar tu cuenta cuando quieras, y lo vencido se elimina solo.</li>
    </ul>
  </Part>

  <Part id="consultas" title="Consultas sin cuenta">
    <p>Tu asistente puede consultar ciudades, sedes, películas, funciones y los precios o la caramelería públicos sin conectar nada. Para responder, Cinve lee la web del cine desde su propio servidor y puede reutilizar esas respuestas públicas, que son iguales para todos, durante unos minutos.</p>
    <p>Cinve no tiene cuentas propias ni guarda el contenido de tus consultas. Lo que le pides a tu asistente y lo que él hace con las respuestas lo rige la política de privacidad de tu asistente.</p>
  </Part>

  <Part id="cuenta" title="Si conectas tu cuenta del cine">
    <p>Algunas consultas de Cinex y Cines Unidos (precios y asientos) requieren tu cuenta del cine; en Supercines es opcional. Escribes tu correo y tu contraseña solo en la página de autorización de Cinve o en un enlace privado, nunca en el chat.</p>
    <ul>
      <li><strong>Tu contraseña</strong> se envía una sola vez, por HTTPS, al cine que elegiste para iniciar sesión. Cinve no la guarda.</li>
      <li><strong>La sesión del cine</strong> (las cookies o el token que el cine entrega al iniciar sesión) se guarda cifrada con AES-256-GCM y atada a la conexión de tu asistente y a ese cine. Vence cuando vence la del cine: un día como máximo en Cinex y Supercines, y lo que dure el token en Cines Unidos.</li>
      <li><strong>Tu correo</strong> no se guarda como tal. Solo se usa, transformado en un resumen irreversible, para limitar los intentos de inicio de sesión.</li>
      <li>Cinve usa tu sesión solo para leer lo que tu cuenta te permite ver (tarifas, caramelería y mapas de asientos). No compra, no reserva asientos y no modifica tu cuenta.</li>
    </ul>
  </Part>

  <Part id="asistente" title="La conexión de tu asistente">
    <p>Tu asistente se conecta a Cinve con OAuth. Para eso guardamos:</p>
    <ul>
      <li>el nombre y las direcciones de retorno que declara la aplicación de tu asistente al registrarse;</li>
      <li>la autorización que apruebas, válida 30 días como máximo;</li>
      <li>los tokens de acceso (una hora) y de renovación, guardados solo como resúmenes SHA-256, nunca en claro.</li>
    </ul>
    <p>Cada autorización es una conexión separada: otra aplicación no ve tus cuentas del cine.</p>
  </Part>

  <Part id="abuso" title="Protección contra abusos">
    <p>Para que nadie use Cinve para probar contraseñas en los cines, se cuentan los intentos por red (tu dirección IP o su prefijo IPv6) y por cuenta del cine. Esas claves se guardan solo como HMAC-SHA256 con una clave secreta, así que no se pueden revertir a una dirección o un correo. Caducan en un día como máximo, salvo la marca que reconoce al dueño de una cuenta que ya se conectó, que dura 30 días.</p>
    <p>Además, cada servidor lleva en memoria contadores de solicitudes de un minuto por red, que no se guardan en la base de datos.</p>
  </Part>

  <Part id="cookies" title="Cookies">
    <p>Esta web solo usa dos cookies propias, ambas <code>HttpOnly</code> y limitadas a la página de autorización:</p>
    <ul>
      <li><code>cinve_approval_…</code>: protege tu aprobación contra solicitudes falsificadas. Dura 10 minutos.</li>
      <li><code>cinve_device</code>: se crea tras un inicio de sesión correcto, con un valor nuevo cada vez, para que el dueño de una cuenta no quede bloqueado por los intentos de otros. Dura 30 días.</li>
    </ul>
    <p>No hay cookies de publicidad, analítica ni de terceros.</p>
  </Part>

  <Part id="terceros" title="Con quién se comparten los datos">
    <ul>
      <li><strong>Los cines.</strong> Cinve consulta las webs de Cinex, Cines Unidos, Cinepic, Supercines y Gran Cine. Si conectas una cuenta, tus credenciales y luego tu sesión solo se envían al cine de esa cuenta. Su uso lo rigen las condiciones y la política de privacidad de cada cine.</li>
      <li><strong>El alojamiento.</strong> El servicio funciona en Vercel y guarda sus datos en una base PostgreSQL. Vercel puede registrar datos técnicos de cada solicitud, como la dirección IP, la ruta y la hora, según sus propias políticas.</li>
    </ul>
    <p>No vendemos, alquilamos ni cedemos datos a nadie más, y no los usamos para publicidad ni perfiles.</p>
  </Part>

  <Part id="conservacion" title="Cuánto tiempo se conservan">
    <ul>
      <li>Enlaces privados de conexión: 10 minutos.</li>
      <li>Aprobaciones pendientes: 10 minutos. Códigos de autorización: 5 minutos.</li>
      <li>Sesiones del cine: hasta que vence la del cine.</li>
      <li>Autorizaciones y sus tokens: 30 días como máximo.</li>
      <li>Claves de los límites de uso: un día, o 30 días la marca del dueño.</li>
      <li>Registros de aplicaciones sin autorizaciones vigentes: se eliminan tras 90 días sin uso.</li>
    </ul>
    <p>Una tarea diaria elimina lo vencido, y la validez se comprueba en cada acceso, así que nada vencido se usa mientras espera.</p>
  </Part>

  <Part id="borrar" title="Cómo desconectar y borrar tus datos">
    <ul>
      <li>Pídele a tu asistente que desconecte tu cuenta del cine: la herramienta <code>disconnect_account</code> borra esa sesión y cualquier enlace pendiente.</li>
      <li>Si quitas Cinve de tu asistente y este revoca su acceso, se borran la conexión y todas sus sesiones del cine.</li>
      <li>Si no haces nada, todo vence solo en los plazos de arriba.</li>
    </ul>
    <p>Desconectar en Cinve no cierra tu sesión en la web del cine; para eso, ciérrala allí o cambia tu contraseña.</p>
  </Part>

  <Part id="local" title="Si usas Cinve en tu equipo">
    <p>En el modo local (<code>stdio</code>), Cinve se ejecuta en tu equipo y no usa el servicio alojado. Guarda las sesiones del cine, no las contraseñas, en <code>~/.config/cinev</code> (o <code>$XDG_CONFIG_HOME/cinev</code>) con permisos privados, y las borras con <code>npm run logout</code>.</p>
  </Part>

  <Part id="contacto" title="Cambios y contacto">
    <p>Si cambia lo que el servicio guarda, actualizaremos esta página y su fecha; el historial de cambios queda en GitHub. Para dudas sobre esta política o tus datos, <a href={`${repo}/issues/new/choose`}>abre un issue</a>, sin incluir contraseñas ni datos personales. Si encuentras un fallo de seguridad, <a href={`${repo}/security/advisories/new`}>repórtalo en privado</a>.</p>
    <p>Cinve es un proyecto independiente: para compras, reembolsos o datos de tu cuenta del cine, contacta directamente al cine.</p>
  </Part>
</>, { compact: true, index: true, canonical: origin + '/privacidad',
  description: 'Qué datos guarda Cinve, para qué, cuánto tiempo y cómo borrarlos.' });
