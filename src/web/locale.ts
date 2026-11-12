/** URL language wins; negotiated pages vary on Accept-Language. */
export type Locale = 'es' | 'en';
export const locales: readonly Locale[] = ['es', 'en'];

export function resolveLocale(url: URL, acceptLanguage = ''): Locale {
  const explicit = url.searchParams.get('lang');
  if (explicit === 'es' || explicit === 'en') return explicit;
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
