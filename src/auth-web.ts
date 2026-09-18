export function loginPage() {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conectar cuentas · Cinve</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f3ee;color:#202522;font:16px/1.5 system-ui,sans-serif}main{max-width:580px;margin:8vh auto;padding:32px}header{display:flex;justify-content:space-between;align-items:center}.brand{font-size:25px;font-weight:800;letter-spacing:-1px}.local{font-size:12px;background:#e1e9de;padding:5px 10px;border-radius:20px}h1{font-size:34px;line-height:1.15;letter-spacing:-1px;margin:32px 0 12px}p{color:#59615a}.card{background:white;border:1px solid #dedfd6;border-radius:18px;padding:26px;margin-top:26px}label{display:block;font-size:14px;font-weight:650;margin:17px 0 6px}input,select{font:inherit;width:100%;padding:12px;border:1px solid #b4bdb5;border-radius:8px;background:white}input:focus,select:focus,button:focus-visible{outline:3px solid #8db798;outline-offset:2px}button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:12px 16px}button:disabled{opacity:.6;cursor:wait}.primary{background:#244d3b;color:white;width:100%;margin-top:22px;font-weight:650}.secondary{background:transparent;color:#355643;padding:8px 0}.password{display:flex;gap:8px}.password input{min-width:0}.password button{background:#edf1eb}.note{font-size:13px;margin:18px 0 0}.status{font-size:14px;padding:12px;background:#f1f4ef;border-radius:8px;margin:12px 0}.feedback{min-height:24px;margin-top:16px;font-size:14px}.feedback.error{color:#a32925}.feedback.success{color:#24513c}footer{font-size:12px;color:#647066;margin-top:22px}@media(max-width:600px){main{margin:0 auto;padding:24px}.card{padding:20px}h1{font-size:30px}}
</style><main><header><span class="brand">cinve<span style="color:#6e9169">.</span></span><span class="local">Conexión privada</span></header>
<h1>Tus cines, conectados.</h1><p>Conecta tu cuenta para consultar precios de entradas y, en Cinex, caramelería.</p>
<div class="card"><div id="accounts" aria-live="polite">Comprobando conexiones…</div>
<form id="login"><label for="provider">Cuenta del cine</label><select id="provider" name="provider" disabled><option value="cinex" >Cinex</option><option value="cinesunidos" >Cines Unidos</option></select>
<label for="username">Correo de tu cuenta</label><input id="username" name="username" type="email" autocomplete="username" maxlength="320" required>
<label for="password">Contraseña</label><div class="password"><input id="password" name="password" type="password" autocomplete="current-password" maxlength="4096" required><button id="show" type="button" aria-label="Mostrar contraseña" aria-pressed="false">Mostrar</button></div>
<p class="note">Cinev enviará tus datos al cine elegido por HTTPS. Guardará tu sesión cifrada para que tu agente consulte precios con tu cuenta. No guarda tu contraseña.</p>
<button class="primary" id="connect" type="submit">Conectar cuenta</button><div id="feedback" class="feedback" role="status" aria-live="polite"></div></form></div>
<button id="done" class="secondary">Cancelar conexión</button><footer>Cinepic funciona sin cuenta. Vuelve a tu agente después de conectar. Este enlace caduca en 10 minutos.</footer></main><script src="/app.js"></script></html>`;
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
    $('accounts').textContent = 'Cuenta conectada. Vuelve a tu agente para consultar precios.' + (data.profile_update_requested ? ' Cinex solicita actualizar tu perfil en su sitio.' : '');
    $('done').hidden = true;
  } catch(error) { feedback(error.message || 'No se pudo conectar. Pide un enlace nuevo a tu agente.', 'error'); }
  finally { body.password = ''; if (!connected) { $('connect').disabled = false; $('done').disabled = false; $('connect').textContent = 'Conectar cuenta'; } }
};
$('done').onclick = async () => { try { await request('/connect/cancel'); } catch {} token = ''; $('login').reset(); $('login').hidden = true; $('done').hidden = true; $('accounts').textContent = 'Conexión cancelada. Puedes cerrar esta pestaña.'; };
request('/connect/exchange', {}, invitation).then(data => {
  token = data.browser_token; $('provider').value = data.provider;
  $('accounts').textContent = 'Conectar ' + (data.provider === 'cinex' ? 'Cinex' : 'Cines Unidos') + ' a tu acceso Cinev (' + data.user_label + ').';
  $('connect').disabled = false;
}).catch(() => { $('accounts').textContent = 'Enlace vencido o ya utilizado.'; $('login').hidden = true; $('done').hidden = true; const p = document.createElement('p'); p.textContent = 'Pide a tu agente un enlace nuevo para conectar tu cuenta.'; $('accounts').append(p); });
`;
