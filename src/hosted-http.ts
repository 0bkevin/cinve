import { HttpClient } from './http.js';
import { SessionStore } from './auth.js';

/**
 * A request-scoped client with an application-scoped public cache.
 *
 * HttpClient intentionally keeps authentication state and public caching on
 * the same instance. Hosted requests need the opposite lifetime for those
 * concerns, so only public reads are delegated to the shared client. The
 * inherited authenticated-read path continues to use this instance's session
 * store and bypasses the shared cache.
 */
export class HostedHttpClient extends HttpClient {
  constructor(
    request: typeof fetch,
    timeout: number,
    sessions: SessionStore,
    private readonly publicClient: HttpClient,
  ) {
    super(request, timeout, sessions);
  }

  override get(url: string, ttl = 120000, refresh = false) {
    return this.publicClient.get(url, ttl, refresh);
  }
}
