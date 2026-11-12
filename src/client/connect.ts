// The invitation stays in this module's memory until exchanged. Locale
// changes update the current page in place, preserving both invitation and
// exchanged browser token without putting either in a later navigation URL.
type App = { name: string; publisher: string | null; verified: boolean };
type Exchange = { browser_token: string; provider: 'cinex' | 'cinesunidos' | 'supercines'; app: App | null };
type Login = { profile_update_requested?: boolean };
type Copy = Record<string, string>;
const catalogs = JSON.parse(document.documentElement.dataset.clientCatalogs ?? '{}') as Record<'es' | 'en', { connect: Copy; common: Copy; errors: Copy }>;
let currentLocale: 'es' | 'en' = document.documentElement.lang === 'en' ? 'en' : 'es';
const copy = () => catalogs[currentLocale].connect;
let invitation = location.hash.slice(1);
let exchanged = false;

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
const providerNames = { cinex: 'Cinex', cinesunidos: 'Cines Unidos', supercines: 'Supercines' } as const;
let token = '';
let provider = '';
let app: App | null = null;

function translated(key: string, values: Record<string, string> = {}) {
  return Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), copy()[key] ?? '');
}
function translatePage() {
  document.documentElement.lang = currentLocale;
  document.title = `${copy().title} · Cinve`;
  const common = catalogs[currentLocale].common;
  document.querySelector('meta[name="description"]')?.setAttribute('content', common.footerDescription!);
  for (const node of document.querySelectorAll<HTMLElement>('[data-common-i18n]')) node.textContent = common[node.getAttribute('data-common-i18n')!] ?? '';
  for (const node of document.querySelectorAll<HTMLElement>('[data-common-label]')) node.setAttribute('aria-label', common[node.dataset.commonLabel!] ?? '');
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const url = new URL(link.getAttribute('href')!, location.href);
    if (url.origin !== location.origin || !url.searchParams.has('lang') || link.dataset.localeSwitch) continue;
    url.searchParams.set('lang', currentLocale);
    link.href = url.pathname + url.search + url.hash;
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.getAttribute('data-i18n')!;
    // The provider-specific heading is refreshed separately after an exchange.
    if (node.id !== 'login-title') node.textContent = copy()[key] ?? '';
  }
  const showPassword = password.type === 'password';
  show.textContent = showPassword ? copy().show : copy().hide;
  show.setAttribute('aria-label', copy()[showPassword ? 'showPassword' : 'hidePassword'] ?? '');
  setBusy(connect.getAttribute('aria-busy') === 'true');
  const errorKey = feedback.dataset.errorKey;
  if (errorKey) element('feedback-text').textContent = catalogs[currentLocale].errors[errorKey] ?? copy().genericError;
  if (provider) updateAppCopy();
  if (result.hidden === false) {
    // Result copy is represented by keys so switching language never repeats
    // an exchange or login request.
    const resultKey = result.dataset.resultKey;
    if (resultKey) {
      element('result-title').textContent = copy()[resultKey] ?? '';
      element('result-text').textContent = translated(result.dataset.resultTextKey ?? '', JSON.parse(result.dataset.resultValues ?? '{}'));
      if (result.dataset.profileUpdate === 'true') element('result-text').textContent += copy().profileUpdate;
    }
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-locale-switch]')) {
    const active = link.dataset.localeSwitch === currentLocale;
    link.href = `/connect?lang=${link.dataset.localeSwitch}`;
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  const currentLabel = document.querySelector<HTMLElement>('[data-current-locale-label]');
  if (currentLabel) {
    currentLabel.textContent = common[currentLocale === 'es' ? 'spanish' : 'english'] ?? '';
    currentLabel.lang = currentLocale;
  }
  for (const check of document.querySelectorAll<HTMLElement>('[data-locale-check]')) {
    check.textContent = check.dataset.localeCheck === currentLocale ? '✓' : '';
  }
}

function updateAppCopy() {
  element('login-title').textContent = translated('accountTitle', { provider });
  const account = element('login-account');
  account.textContent = !app ? copy().accountApp
    : app.verified ? translated('appVerified', { app: app.name, publisher: app.publisher ?? '' })
    : translated('appUnverified', { app: app.name });
  account.classList.toggle('warning', Boolean(app && !app.verified));
}

document.addEventListener('click', event => {
  const link = (event.target as Element).closest<HTMLAnchorElement>('[data-locale-switch]');
  if (!link) return;
  event.preventDefault();
  const target = link.dataset.localeSwitch;
  if (target !== 'es' && target !== 'en') return;
  const languageMenu = link.closest('details') as HTMLDetailsElement | null;
  if (languageMenu) languageMenu.open = false;
  currentLocale = target;
  const url = new URL(location.href);
  url.searchParams.set('lang', target);
  if (exchanged) url.hash = '';
  else url.hash = invitation;
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  translatePage();
});

function showCard(card: HTMLElement) { for (const candidate of [checking, form, result]) candidate.hidden = candidate !== card; }
function showResult(tone: 'success' | 'error' | 'muted', titleKey: string, textKey: string, values: Record<string, string> = {}) {
  const icon = element<HTMLTemplateElement>(tone === 'success' ? 'icon-success' : 'icon-error').content.cloneNode(true);
  element('result-icon').replaceChildren(icon);
  result.querySelector('.status-panel')!.setAttribute('data-tone', tone);
  result.dataset.resultKey = titleKey;
  result.dataset.resultTextKey = textKey;
  result.dataset.resultValues = JSON.stringify(values);
  element('result-title').textContent = copy()[titleKey] ?? '';
  element('result-text').textContent = translated(textKey, values);
  showCard(result); element('result-title').setAttribute('tabindex', '-1'); element('result-title').focus();
}
function showError(message: string, key?: string) {
  feedback.dataset.errorKey = key ?? '';
  element('feedback-text').textContent = key ? catalogs[currentLocale].errors[key] ?? copy().genericError : message || copy().failure;
  feedback.hidden = false;
}
const clearError = () => { feedback.hidden = true; };
function setBusy(busy: boolean) {
  connect.disabled = busy || !exchanged; cancel.disabled = busy; username.readOnly = busy;
  connect.setAttribute('aria-busy', String(busy));
  connect.replaceChildren(...(busy ? [element<HTMLTemplateElement>('icon-spinner').content.cloneNode(true), ` ${copy().connecting}`] : [copy().connect]));
}

async function request<T>(path: string, body: Record<string, string> = {}, credential = token): Promise<T> {
  const localizedPath = `${path}${path.includes('?') ? '&' : '?'}lang=${currentLocale}`;
  const response = await fetch(localizedPath, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cinev-Connection': credential }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit' })
    .catch(() => { throw Object.assign(new Error(copy().genericError), { key: 'generic' }); });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || copy().genericError), { key: data.error_key ?? 'generic' });
  return data as T;
}

show.addEventListener('click', () => {
  const visible = password.type === 'password'; password.type = visible ? 'text' : 'password';
  show.textContent = visible ? copy().hide : copy().show;
  show.setAttribute('aria-label', copy()[visible ? 'hidePassword' : 'showPassword'] ?? '');
  show.setAttribute('aria-pressed', String(visible)); password.focus();
});
for (const input of [username, password]) input.addEventListener('input', clearError);

form.addEventListener('submit', async event => {
  event.preventDefault();
  const body = { username: username.value, password: password.value };
  password.value = ''; clearError(); setBusy(true); let connected = false;
  try {
    const pending = request<Login>('/connect/login', body); body.password = '';
    const data = await pending; connected = true; token = ''; form.reset();
    showResult('success', 'success', 'successText');
    if (data.profile_update_requested) { result.dataset.profileUpdate = 'true'; element('result-text').textContent += copy().profileUpdate; }
  } catch (error) { showError((error as Error).message || copy().failure, (error as Error & { key?: string }).key); }
  finally { body.password = ''; if (!connected) { setBusy(false); password.focus(); } }
});

cancel.addEventListener('click', async () => {
  cancel.disabled = true;
  try { await request('/connect/cancel'); } catch {}
  token = ''; form.reset(); showResult('muted', 'cancelled', 'cancelText');
});

showCard(checking);
request<Exchange>('/connect/exchange', {}, invitation).then(data => {
  exchanged = true; invitation = ''; token = data.browser_token; provider = providerNames[data.provider] ?? data.provider; app = data.app;
  // The invitation is removed only after its one-time exchange succeeds.
  const url = new URL(location.href); url.hash = ''; history.replaceState(null, '', url.pathname + url.search);
  updateAppCopy(); connect.disabled = false; showCard(form); username.focus();
}).catch(() => showResult('error', 'expired', 'expiredText'));
translatePage();
