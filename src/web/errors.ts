import { catalog } from './content.js';
import type { Locale } from './locale.js';

/** Only browser-facing errors use this catalog; MCP responses stay unchanged. */
export function webError(message: string, locale: Locale) {
  const source = catalog('es').errors;
  const key = (Object.keys(source) as (keyof typeof source)[]).find(key => source[key] === message) ?? 'generic';
  return { error: locale === 'es' ? message : catalog(locale).errors[key], error_key: key };
}

/** The Spanish source message for a sign-in field to fix; webError translates it like any other. */
export const credentialMessage = (problem: 'email' | 'password') => catalog('es').errors[problem];
