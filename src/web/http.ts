import type { ServerResponse } from 'node:http';

/** For pages that are the same for everyone (/, /install, /instrucciones):
 *  the CDN may cache them briefly; private pages keep no-store. */
export const publicPageCache = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';

/** Headers for every response, including pages served outside the hosted app (for example /install on Vercel). */
export function setSecurityHeaders(res: ServerResponse, https: boolean) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
