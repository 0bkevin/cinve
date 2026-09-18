import { publicPage } from './public-web.js';

export function loginPage() {
  return publicPage('Conectar cuentas', `<p class="eyebrow">Conexión privada</p><h1>Conecta tu cuenta del cine.</h1><p class="lead">Conecta tu cuenta para consultar precios de entradas y, en Cinex, caramelería.</p>
<div class="card"><div id="accounts" class="status" aria-live="polite">Comprobando conexiones…</div>
<form id="login"><label for="provider">Cuenta del cine</label><select id="provider" name="provider" disabled><option value="cinex">Cinex</option><option value="cinesunidos">Cines Unidos</option></select>
<label for="username">Correo de tu cuenta</label><input id="username" name="username" type="email" autocomplete="username" maxlength="320" required>
<label for="password">Contraseña</label><div class="password"><input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required><button id="show" type="button" aria-label="Mostrar contraseña" aria-pressed="false">Mostrar</button></div>
<p class="note">Cinve enviará tus datos al cine elegido por una conexión segura. Guardará tu sesión cifrada para que tu asistente consulte precios con tu cuenta. No guarda tu contraseña.</p>
<button class="primary full" id="connect" type="submit" disabled>Conectar cuenta</button><div id="feedback" class="feedback" role="status" aria-live="polite"></div></form></div>
<button id="done" class="secondary">Cancelar conexión</button><p class="note">Cinepic funciona sin cuenta. Vuelve a tu asistente después de conectar. Este enlace caduca en 10 minutos.</p><noscript><p>Activa JavaScript para conectar tu cuenta.</p></noscript>`, { compact: true, script: '/app.js' });
}

export const loginScript = `
const invitation = location.hash.slice(1);
history.replaceState(null, '', '/connect');
const $ = id => document.getElementById(id);
let token = '';
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
    $('accounts').textContent = 'Cuenta conectada. Vuelve a tu asistente para consultar precios.' + (data.profile_update_requested ? ' Cinex solicita actualizar tu perfil en su sitio.' : '');
    $('done').hidden = true;
  } catch(error) { feedback(error.message || 'No se pudo conectar. Pide un enlace nuevo a tu asistente.', 'error'); }
  finally { body.password = ''; if (!connected) { $('connect').disabled = false; $('done').disabled = false; $('connect').textContent = 'Conectar cuenta'; } }
};
$('done').onclick = async () => { try { await request('/connect/cancel'); } catch {} token = ''; $('login').reset(); $('login').hidden = true; $('done').hidden = true; $('accounts').textContent = 'Conexión cancelada. Puedes cerrar esta pestaña.'; };
request('/connect/exchange', {}, invitation).then(data => {
  token = data.browser_token; $('provider').value = data.provider;
  $('accounts').textContent = 'Conectar ' + (data.provider === 'cinex' ? 'Cinex' : 'Cines Unidos') + ' a tu acceso Cinve (' + data.user_label + ').';
  $('connect').disabled = false;
}).catch(() => { $('accounts').textContent = 'Enlace vencido o ya utilizado.'; $('login').hidden = true; $('done').hidden = true; const p = document.createElement('p'); p.textContent = 'Pide a tu asistente un enlace nuevo para conectar tu cuenta.'; $('accounts').append(p); });
`;
