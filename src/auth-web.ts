import { publicPage } from './public-web.js';

export function loginPage() {
  return publicPage('Conectar cuentas', `<p class="eyebrow">Conexión privada</p><h1 id="title">Conecta tu cuenta del cine.</h1>
<div class="card"><div id="accounts" class="status" aria-live="polite">Comprobando el enlace…</div>
<form id="login"><label for="username">Correo de tu cuenta del cine</label><input id="username" name="username" type="email" autocomplete="username" maxlength="320" required>
<label for="password">Contraseña</label><div class="password"><input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required><button id="show" type="button" aria-label="Mostrar contraseña" aria-pressed="false">Mostrar</button></div>
<button class="primary full" id="connect" type="submit" disabled>Conectar</button><div id="feedback" class="feedback" role="status" aria-live="polite"></div>
<p class="note">Cinve envía tus datos al cine por una conexión segura y guarda solo tu sesión cifrada, nunca tu contraseña.</p></form></div>
<p class="note" id="footer">¿No pediste este enlace? <button id="done" type="button" class="inline">Cancélalo</button>. Caduca en 10 minutos.</p><noscript><p>Activa JavaScript para conectar tu cuenta.</p></noscript>`, { compact: true, script: '/app.js' });
}

export const loginScript = `
const invitation = location.hash.slice(1);
history.replaceState(null, '', '/connect');
const $ = id => document.getElementById(id);
let token = '', cinema = '';
const feedback = (text, type = '') => { $('feedback').textContent = text; $('feedback').className = 'feedback ' + type; };
async function request(path, body, credential = token) {
  const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json','X-Cinev-Connection':credential}, body:JSON.stringify(body || {}), cache:'no-store', credentials:'omit'});
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud.'); return data;
}
$('connect').disabled = true;
$('show').onclick = () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; $('show').textContent = show ? 'Ocultar' : 'Mostrar'; $('show').setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña'); $('show').setAttribute('aria-pressed', String(show)); };
$('login').onsubmit = async event => {
  event.preventDefault(); const body = {username:$('username').value,password:$('password').value};
  $('password').value = ''; $('connect').disabled = true; $('done').disabled = true; $('connect').textContent = 'Conectando…'; feedback('Comprobando tu cuenta con el cine…');
  let connected = false;
  try { const pending = request('/connect/login', body); body.password = ''; const data = await pending;
    connected = true; token = ''; $('username').value = ''; $('login').reset(); $('login').hidden = true;
    $('title').textContent = 'Listo.'; $('accounts').className = 'lead'; $('accounts').textContent = 'Tu cuenta de ' + cinema + ' está conectada. Vuelve a tu asistente: ya puede consultar precios.' + (data.profile_update_requested ? ' Cinex pide actualizar tu perfil en su web.' : ''); $('footer').hidden = true;
    $('done').hidden = true;
  } catch(error) { feedback(error.message || 'No se pudo conectar. Pide un enlace nuevo a tu asistente.', 'error'); }
  finally { body.password = ''; if (!connected) { $('connect').disabled = false; $('done').disabled = false; $('connect').textContent = 'Conectar'; } }
};
$('done').onclick = async () => { try { await request('/connect/cancel'); } catch {} token = ''; $('login').reset(); $('login').hidden = true; $('footer').hidden = true; $('accounts').textContent = 'Conexión cancelada. Puedes cerrar esta pestaña.'; };
request('/connect/exchange', {}, invitation).then(data => {
  token = data.browser_token; cinema = data.provider === 'cinex' ? 'Cinex' : 'Cines Unidos';
  $('title').textContent = 'Conecta tu cuenta de ' + cinema + '.';
  const app = data.app;
  $('accounts').textContent = !app ? 'Se conectará a tu acceso Cinve.'
    : app.verified ? 'Se conectará a ' + app.name + ' (' + app.publisher + '). Usa este enlace solo si tu asistente acaba de crearlo para ti.'
    : 'Se conectará a «' + app.name + '». Cinve no puede confirmar qué aplicación es: continúa solo si tu asistente acaba de crear este enlace para ti.';
  if (app && !app.verified) $('accounts').className = 'status warning';
  $('connect').disabled = false;
}).catch(() => { $('accounts').textContent = 'Enlace vencido o ya utilizado.'; $('login').hidden = true; $('footer').hidden = true; const p = document.createElement('p'); p.textContent = 'Pide a tu asistente un enlace nuevo para conectar tu cuenta.'; $('accounts').append(p); });
`;
