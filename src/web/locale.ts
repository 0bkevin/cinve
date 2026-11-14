/** Spanish unless the URL asks for English; browser language settings are ignored. */
export type Locale = 'es' | 'en';
export const locales: readonly Locale[] = ['es', 'en'];

export function resolveLocale(url: URL): Locale {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'es';
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
