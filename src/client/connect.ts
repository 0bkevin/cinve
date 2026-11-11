// Connects a cinema account through the private link an assistant created.
// The invitation travels in the URL fragment so it never reaches server logs
// or Referer headers; it is exchanged once for a short-lived browser token.

type Exchange = { browser_token: string; provider: 'cinex' | 'cinesunidos'; user_label: string };
type Login = { profile_update_requested?: boolean };

const invitation = location.hash.slice(1);
history.replaceState(null, '', '/connect');

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const accounts = element<HTMLDivElement>('accounts');
const form = element<HTMLFormElement>('login');
const provider = element<HTMLSelectElement>('provider');
const username = element<HTMLInputElement>('username');
const password = element<HTMLInputElement>('password');
const show = element<HTMLButtonElement>('show');
const connect = element<HTMLButtonElement>('connect');
const done = element<HTMLButtonElement>('done');
const feedbackBox = element<HTMLDivElement>('feedback');

let token = '';

const feedback = (text: string, type = '') => { feedbackBox.textContent = text; feedbackBox.className = 'feedback ' + type; };

async function request<T>(path: string, body: Record<string, string> = {}, credential = token): Promise<T> {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cinev-Connection': credential },
    body: JSON.stringify(body), cache: 'no-store', credentials: 'omit',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud.');
  return data as T;
}

connect.disabled = true;

show.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  show.textContent = visible ? 'Ocultar' : 'Mostrar';
  show.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
  show.setAttribute('aria-pressed', String(visible));
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const body = { username: username.value, password: password.value };
  password.value = ''; connect.disabled = true; done.disabled = true; connect.textContent = 'Conectando…';
  feedback('Comprobando tu cuenta con el cine…');
  let connected = false;
  try {
    const pending = request<Login>('/connect/login', body); body.password = '';
    const data = await pending;
    connected = true; token = ''; username.value = ''; form.reset(); form.hidden = true;
    accounts.textContent = 'Cuenta conectada. Vuelve a tu asistente para consultar precios.' + (data.profile_update_requested ? ' Cinex solicita actualizar tu perfil en su sitio.' : '');
    done.hidden = true;
  } catch (error) {
    feedback((error as Error).message || 'No se pudo conectar. Pide un enlace nuevo a tu asistente.', 'error');
  } finally {
    body.password = '';
    if (!connected) { connect.disabled = false; done.disabled = false; connect.textContent = 'Conectar cuenta'; }
  }
});

done.addEventListener('click', async () => {
  try { await request('/connect/cancel'); } catch {}
  token = ''; form.reset(); form.hidden = true; done.hidden = true;
  accounts.textContent = 'Conexión cancelada. Puedes cerrar esta pestaña.';
});

request<Exchange>('/connect/exchange', {}, invitation).then(data => {
  token = data.browser_token; provider.value = data.provider;
  accounts.textContent = 'Conectar ' + (data.provider === 'cinex' ? 'Cinex' : 'Cines Unidos') + ' a tu acceso Cinve (' + data.user_label + ').';
  connect.disabled = false;
}).catch(() => {
  accounts.textContent = 'Enlace vencido o ya utilizado.'; form.hidden = true; done.hidden = true;
  const hint = document.createElement('p'); hint.textContent = 'Pide a tu asistente un enlace nuevo para conectar tu cuenta.';
  accounts.append(hint);
});
