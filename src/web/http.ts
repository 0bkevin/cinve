import type { IncomingMessage, ServerResponse } from 'node:http';
import { localeUrl, resolveLocale, type Locale } from './locale.js';

/** Append rather than overwrite: /install also varies by representation. */
export function pageLocale(req: IncomingMessage, res: ServerResponse) {
  const vary = String(res.getHeader('Vary') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (!vary.some(value => value.toLowerCase() === 'accept-language')) vary.push('Accept-Language');
  res.setHeader('Vary', vary.join(', '));
  const locale = resolveLocale(new URL(req.url ?? '/', 'https://cinve.invalid'), req.headers['accept-language']);
  res.setHeader('Content-Language', locale);
  return locale;
}

/** Pin automatically selected English to its shareable URL. Social crawlers
 *  do not inherit the visitor's browser language preferences. */
export function redirectNegotiatedEnglish(req: IncomingMessage, res: ServerResponse, locale: Locale): boolean {
  const url = new URL(req.url ?? '/', 'https://cinve.invalid');
  const explicit = url.searchParams.get('lang');
  if (locale !== 'en' || explicit === 'es' || explicit === 'en') return false;
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(307, { Location: localeUrl(url.pathname + url.search, 'en') });
  res.end();
  return true;
}

/** Public HTML may be cached briefly, varying by language and representation.
 *  Private pages and language-negotiation redirects keep no-store. */
export const publicPageCache = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';

/** Headers for every response, including pages served outside the hosted app (for example /install on Vercel). */
export function setSecurityHeaders(res: ServerResponse, https: boolean) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  // No page needs these browser features; deny them to this origin and any frame.
  res.setHeader('Permissions-Policy', 'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), serial=(), usb=(), xr-spatial-tracking=()');
  // Isolate pages from cross-origin windows. CORP only applies to no-cors
  // loads, so CORS callers of /mcp and OAuth discovery are unaffected; every
  // page loads only same-origin resources (see the CSP), so COEP holds too.
  // The OAuth consent page relaxes COOP: see HostedOAuth.consent.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
