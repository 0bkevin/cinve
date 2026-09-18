# Cinev hosted: Vercel + Postgres

The hosted service uses Postgres for client access, encrypted cinema sessions,
expiring account-connection links, and rate budgets. It does not use Appwrite,
Blob, persistent local files, or process memory for authentication state.
The original local stdio login still uses private local files.

## Public first

Connect an HTTP MCP client to `https://<domain>/mcp` without an Authorization
header for public cities, cinemas, movies, showtimes, and public prices or
concessions. Hosted queries refresh from the provider by default. Protected
Cinex/Cines Unidos queries return `auth_required`; public Cinepic prices and
Cines Unidos concessions do not require login. Invalid supplied access tokens
return HTTP 401 rather than silently falling back to anonymous access.

## Self-service account connection

Users no longer need an operator-issued bearer token. Anonymous clients discover
`connect_account` alongside the public tools. Calling it without authorization
returns HTTP 401 with `WWW-Authenticate` pointing to the protected-resource
metadata. An OAuth-capable MCP client discovers the authorization server,
registers itself, and opens the browser approval page. After approval it exchanges
the one-time code with PKCE and retries `connect_account` with its new access token.
The tool returns the existing ten-minute private cinema login link. The user
connects the cinema there, returns to chat, and the agent checks `get_auth_status`
and retries the original query. Cinema credentials never enter tool arguments.

The first connection has two browser steps: authorize the assistant, then connect
the cinema. No extra Cinve password or email account is required. Each approval
creates a new, empty principal dedicated to that connection; it cannot inherit
another user's sessions or access any accounts from an existing browser session.
Connecting from another app, losing the client's tokens, or authorizing again
requires reconnecting cinemas. There is no cross-app identity or account recovery.

Public tools remain anonymous. Protected cinema queries return `auth_required`
with instructions to call `connect_account`; that tool triggers authorization.
Clients must support HTTP MCP OAuth, dynamic client registration, and S256 PKCE.
If a client does not launch authorization on a tool-call 401, the assistant should
start the client's native OAuth action. In local Codex, it can run
`codex mcp login cinve` (using the configured server name), present the generated
URL and keep the process alive until the user approves. This must run against
the user's own local installation, not an unrelated cloud terminal. It is
assistant authorization, not the local cinema-password login. Settings instructions
are a fallback only when neither the native action nor local CLI is accessible.
A test with Codex 0.155.0 confirmed that CLI login leaves an existing conversation
using its anonymous connection. `get_auth_status.connection.client_authorized`
distinguishes this from a missing cinema session; anonymous provider statuses
are `client_authorization_required`. Use the host's native refresh action once
(`config/mcpServer/reload` in app-server integrations), rather than repeating login.
Native `mcpServer/oauth/login` with the thread ID updates the running thread after
its completion event and avoids that extra refresh. Assistants must only use host
actions actually available to them; a remote MCP cannot execute these client APIs.

The assistant should show the OAuth URL as a progress update and watch completion,
without demanding a "done" reply. It must keep the callback process alive, stop it
on cancellation, and avoid short subprocess timeouts or hiding output. Codex's CLI
callback returned HTTP 400 for a standard OAuth denial in testing; the pending
command must be stopped when the user cancels. Public queries remain usable.

For a public-only installation, edit the Codex MCP configuration table directly:
`codex mcp add` can start optional OAuth immediately and block awaiting approval.
The `/install` guide describes the non-interactive registration path.
Clients without OAuth can still use public data. Never send users to search for a login page or paste tokens in chat.

### OAuth endpoints and lifecycle

- `/.well-known/oauth-protected-resource/mcp` (also the root metadata path)
  describes `/mcp` and its authorization server.
- `/.well-known/oauth-authorization-server` publishes discovery metadata.
- `POST /oauth/register` registers public clients with exact redirect URIs.
  HTTPS and HTTP loopback redirects are supported; custom schemes are not.
- `GET /oauth/authorize` presents explicit approval with the app name and callback
  origin. `POST` requires a same-origin form and a browser-bound, single-use CSRF
  token. Client names are unverified and HTML-escaped. No approval happens on GET.
- `POST /oauth/token` accepts form-encoded authorization-code and refresh grants.
  S256 PKCE, exact redirect matching, client binding, and the `/mcp` resource
  indicator are mandatory. Codes last five minutes; pending approvals last ten.
- Access tokens last one hour; refresh tokens rotate on every use within an
  absolute 30-day grant. Reusing a consumed refresh token revokes the connection
  and deletes its cinema sessions and pending links. Code replay also revokes
  the connection. Concurrent refresh attempts must be serialized by the client.
- `POST /oauth/revoke` invalidates the whole connection, including cinema sessions.
  Disconnecting one cinema through `disconnect_account` preserves MCP access.

Opaque OAuth tokens are stored only as SHA-256 digests. Cinema sessions retain
AES-256-GCM encryption. Code redemption and refresh rotation use database locks;
all connection mutations continue to serialize on the principal row. OAuth
registration/approval/token requests have persistent per-IP and global budgets.
Discovery/token endpoints and `/mcp` support bearer-only cross-origin clients;
cinema forms and browser approval retain same-origin protection. Client metadata
URL documents and confidential-client secrets are not supported in this version.
Existing operator-issued tokens and the stdio bridge remain supported.

## Deploy

1. Create a Vercel project and connect a dedicated Neon Postgres database from
   its Marketplace. Select the Free plan explicitly and use the same region as
   the function. An existing Postgres provider also works. Keep preview and
   production databases and encryption keys separate.
2. Set `DATABASE_URL` to the pooled, TLS-enabled connection string. Follow the
   provider's TLS configuration; do not disable certificate verification.
3. Set `CINEV_PUBLIC_URL` to the exact public HTTPS origin. Set
   `CINEV_ENCRYPTION_KEY` to 32 random bytes encoded as 64 hex characters and
   `CRON_SECRET` to a separate random secret. Use Vercel environment variables;
   do not commit or paste their values into agent chat.
4. With the database environment loaded locally, run `npm run db:migrate`.
   Use `DATABASE_URL_UNPOOLED` for a direct migration connection when available;
   application traffic continues to use pooled `DATABASE_URL`.
   This applies both `001_hosted.sql` and `002_oauth.sql`. Apply the OAuth
   migration before deploying this version, including for existing installations.
   Migration is transactional, idempotent, and serialized with an advisory lock.
   It runs explicitly, never during an HTTP request or production cold start.
   If the operator network blocks Postgres TCP, run
   `node --env-file=.env.production.local --import tsx scripts/migrate-neon.ts`
   to apply this plain-DDL migration over Neon HTTPS.
5. Deploy with `vercel --prod`. The root `server.ts` exports the HTTP handler. `build:hosted` compiles it into
   `.hosted/index.js`, separately from the stdio entrypoint in `dist/index.js`.
   The checked-in Vercel config routes requests to it and allows 90-second
   invocations. `/health` checks process health; verify `/mcp` separately to
   exercise the database and protocol.
6. Test live public queries from the deployed endpoint. Provider availability
   from a local machine does not establish availability from Vercel's network.

Hobby is intended for personal, non-commercial use. The database has its own
plan quotas. No paid subscription is required by the code.

## Operator access

For legacy clients without OAuth, operators can still run
`npm run hosted:admin -- issue` after building, with `DATABASE_URL` set.
This displays a new client ID and bearer token once, only in the operator's
terminal. Configure it in the MCP client's private Authorization setting;
never put it in a URL. Each client ID has its own cinema connections.

Run `npm run hosted:admin -- revoke <client-id>` to revoke access and remove
its saved sessions and links. Revocation is retained across deployments.
The initial implementation has no password-based Cinev user accounts.

## Data and concurrency

- `cinev_clients`: random client ID, SHA-256 access-token digest, revocation time.
- `cinev_sessions`: per-client/provider AES-256-GCM ciphertext and expiration.
  The encryption key stays outside Postgres. Authenticated encryption binds
  ciphertext to the owner and provider, preventing swaps between accounts.
- `cinev_links`: SHA-256 token digest, stage, owner, provider, expiration,
  attempt count, and in-progress flag. No password or raw connection token.
- `cinev_budgets`: hashed rate-limit keys with a one-minute window.
- `cinev_oauth_apps`: public client registrations and allowed redirect URIs.
- `cinev_oauth_requests`: expiring browser approvals, CSRF/code digests, PKCE,
  exact callback, resource, and state.
- `cinev_oauth_grants`: connection owner, registered client, resource and expiry.
- `cinev_oauth_tokens`: access/refresh digests, expiry and refresh-use timestamps.

All account mutations lock the same client row. Invitation exchange, claim,
session save plus link consumption, cancellation, and revocation use database
transactions. Cinema HTTP login runs outside the transaction. A late response
cannot save after cancellation, replacement, expiration, or revocation.
If a worker dies during login, its link remains busy until expiration; issue a
new link to retry. Database outages fail closed for protected operations.

A daily authenticated Vercel cron deletes expired sessions, links, rate
windows, OAuth requests/access tokens and expired or revoked OAuth principals.
Consumed refresh digests remain until their grant is removed to detect replay.
Client registrations persist so clients can authorize again with saved client IDs. Expiration is enforced during access, independent of cleanup timing.
Manual cleanup: `npm run db:cleanup`. Preserve the encryption key across deploys;
changing it requires reconnecting accounts. Database backups contain ciphertext,
not cinema passwords. Do not enable database parameter or request-body logging.

## Verify locally

`npm run check && npm test && npm run build`

Tests start an isolated temporary PostgreSQL cluster over a private Unix socket
and remove it afterward. Install PostgreSQL (`initdb` and `pg_ctl` in PATH), or
set `TEST_DATABASE_URL` to a dedicated test database. Tests create/drop randomly
named schemas; never point them at production. Tests include a real MCP SDK client performing discovery, dynamic registration,
browser approval, cinema connection, and automatic token refresh. They also exercise real transactions,
concurrent link redemption, cross-instance sessions, cancellation, revocation,
rate limits, and ciphertext tampering. Cinema credentials are synthetic.

## Current deployment

Public MCP URL: https://cinve.vercel.app/mcp

Live smoke: `npm run smoke -- --url https://cinve.vercel.app/mcp`.
This exercises anonymous retrieval and confirms protected routes request login.
