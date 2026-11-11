// Connects a cinema account through the private link an assistant created.
// The invitation travels in the URL fragment so it never reaches server logs
// or Referer headers; it is exchanged once for a short-lived browser token.

type Exchange = { browser_token: string; provider: 'cinex' | 'cinesunidos'; user_label: string };
type Login = { profile_update_requested?: boolean };

const invitation = location.hash.slice(1);
history.replaceState(null, '', '/connect');

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const checking = element<HTMLDivElement>('checking');
const form = element<HTMLFormElement>('login');
const result = element<HTMLDivElement>('result');
const username = element<HTMLInputElement>('username');
const password = element<HTMLInputElement>('password');
const show = element<HTMLButtonElement>('show');
const connect = element<HTMLButtonElement>('connect');
const cancel = element<HTMLButtonElement>('cancel');
const feedback = element<HTMLDivElement>('feedback');
const providerNames = { cinex: 'Cinex', cinesunidos: 'Cines Unidos' } as const;

let token = '';

/** Shows exactly one of the page's cards. */
function showCard(card: HTMLElement) {
  for (const candidate of [checking, form, result]) candidate.hidden = candidate !== card;
}

function showResult(tone: 'success' | 'error' | 'muted', title: string, text: string) {
  const icon = element<HTMLTemplateElement>(tone === 'success' ? 'icon-success' : 'icon-error').content.cloneNode(true);
  element('result-icon').replaceChildren(icon);
  result.querySelector('.status-panel')!.setAttribute('data-tone', tone);
  element('result-title').textContent = title;
  element('result-text').textContent = text;
  showCard(result);
  element('result-title').setAttribute('tabindex', '-1');
  element('result-title').focus();
}

function showError(message: string) {
  element('feedback-text').textContent = message;
  feedback.hidden = false;
}

const clearError = () => { feedback.hidden = true; };

function setBusy(busy: boolean) {
  connect.disabled = busy; cancel.disabled = busy; username.readOnly = busy;
  connect.setAttribute('aria-busy', String(busy));
  connect.replaceChildren(...(busy ? [element<HTMLTemplateElement>('icon-spinner').content.cloneNode(true), 'Conectando…'] : ['Conectar cuenta']));
}

async function request<T>(path: string, body: Record<string, string> = {}, credential = token): Promise<T> {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cinev-Connection': credential },
    body: JSON.stringify(body), cache: 'no-store', credentials: 'omit',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud.');
  return data as T;
}

show.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  show.textContent = visible ? 'Ocultar' : 'Mostrar';
  show.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
  show.setAttribute('aria-pressed', String(visible));
  password.focus();
});

for (const input of [username, password]) input.addEventListener('input', clearError);

form.addEventListener('submit', async event => {
  event.preventDefault();
  // The password leaves the page as soon as it is sent.
  const body = { username: username.value, password: password.value };
  password.value = ''; clearError(); setBusy(true);
  let connected = false;
  try {
    const pending = request<Login>('/connect/login', body); body.password = '';
    const data = await pending;
    connected = true; token = ''; form.reset();
    showResult('success', 'Cuenta conectada', 'Vuelve a tu asistente para consultar precios y asientos.' + (data.profile_update_requested ? ' Cinex solicita actualizar tu perfil en su sitio.' : ''));
  } catch (error) {
    showError((error as Error).message || 'No se pudo conectar. Pide un enlace nuevo a tu asistente.');
  } finally {
    body.password = '';
    if (!connected) { setBusy(false); password.focus(); }
  }
});

cancel.addEventListener('click', async () => {
  cancel.disabled = true;
  try { await request('/connect/cancel'); } catch {}
  token = ''; form.reset();
  showResult('muted', 'Conexión cancelada', 'No se conectó ninguna cuenta. Puedes cerrar esta pestaña.');
});

showCard(checking);
request<Exchange>('/connect/exchange', {}, invitation).then(data => {
  token = data.browser_token;
  const name = providerNames[data.provider] ?? data.provider;
  element('login-title').textContent = `Conecta tu cuenta de ${name}`;
  element('login-account').textContent = `Se conectará a tu acceso Cinve (${data.user_label}).`;
  connect.disabled = false;
  showCard(form);
  username.focus();
}).catch(() => {
  showResult('error', 'Enlace vencido o ya utilizado', 'Pide a tu asistente un enlace nuevo para conectar tu cuenta.');
});
