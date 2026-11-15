/** URL language wins, then the visitor's saved choice, then Accept-Language;
 *  negotiated pages vary on Accept-Language and Cookie. */
export type Locale = 'es' | 'en';
export const locales: readonly Locale[] = ['es', 'en'];

export function resolveLocale(url: URL, acceptLanguage = '', saved?: Locale): Locale {
  const explicit = url.searchParams.get('lang');
  if (explicit === 'es' || explicit === 'en') return explicit;
  if (saved) return saved;
  const preferences = acceptLanguage.split(',').map((part, order) => {
    const [tag, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { language: tag?.split('-')[0], q, order };
  }).filter(item => Number.isFinite(item.q) && item.q > 0 && item.q <= 1)
    .sort((a, b) => b.q - a.q || a.order - b.order);
  return preferences.find(item => item.language === 'es' || item.language === 'en')?.language as Locale | undefined ?? 'es';
}

/** Preserve OAuth parameters and fragments while selecting a language. */
export function localeUrl(path: string, locale: Locale): string {
  const url = new URL(path, 'https://cinve.invalid');
  url.searchParams.set('lang', locale);
  return path.startsWith('http:') || path.startsWith('https:') ? url.href : url.pathname + url.search + url.hash;
}

/** Existing Spanish URLs remain canonical; English has its own URL. */
export function canonicalUrl(path: string, locale: Locale): string {
  const url = new URL(path);
  url.searchParams.delete('lang');
  if (locale === 'en') url.searchParams.set('lang', locale);
  return url.href;
}

/** The cookie that remembers the language a visitor picked in the menu. */
export const localeCookie = 'cinve_lang';
export const localeCookieMaxAge = 365 * 24 * 60 * 60;

export function savedLocale(cookieHeader = ''): Locale | undefined {
  return /(?:^|;\s*)cinve_lang=(es|en)(?:;|$)/.exec(cookieHeader)?.[1] as Locale | undefined;
}

/** The language menu goes through /lang, which saves the choice and returns
 *  to the same page in that language. */
export function localeChoiceUrl(path: string, locale: Locale): string {
  return `/lang?${new URLSearchParams({ to: locale, next: path })}`;
}
