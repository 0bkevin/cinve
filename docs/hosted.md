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

For connected accounts, the initial client currently needs an operator-issued
Cinev bearer token. `connect_account` then returns a ten-minute browser link.
The user enters cinema credentials on that page; the agent never receives them.
A browser exchanges the invitation once for a separate temporary capability.
Once connected, the agent retries the original query. `disconnect_account`
removes that client's session and cancels pending links.

Automatic OAuth enrollment/handoff from an anonymous MCP client is not yet
implemented. A browser cookie cannot authenticate an independent agent client.
Do not present the public endpoint as an automatic OAuth connector yet.

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

Run `npm run hosted:admin -- issue` after building, with `DATABASE_URL` set.
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

All account mutations lock the same client row. Invitation exchange, claim,
session save plus link consumption, cancellation, and revocation use database
transactions. Cinema HTTP login runs outside the transaction. A late response
cannot save after cancellation, replacement, expiration, or revocation.
If a worker dies during login, its link remains busy until expiration; issue a
new link to retry. Database outages fail closed for protected operations.

A daily authenticated Vercel cron deletes expired sessions, links, and rate
windows. Expiration is enforced during access, independent of cleanup timing.
Manual cleanup: `npm run db:cleanup`. Preserve the encryption key across deploys;
changing it requires reconnecting accounts. Database backups contain ciphertext,
not cinema passwords. Do not enable database parameter or request-body logging.

## Verify locally

`npm run check && npm test && npm run build`

Tests start an isolated temporary PostgreSQL cluster over a private Unix socket
and remove it afterward. Install PostgreSQL (`initdb` and `pg_ctl` in PATH), or
set `TEST_DATABASE_URL` to a dedicated test database. Tests create/drop randomly
named schemas; never point them at production. Tests exercise real transactions,
concurrent link redemption, cross-instance sessions, cancellation, revocation,
rate limits, and ciphertext tampering. Cinema credentials are synthetic.

## Current deployment

Public MCP URL: https://cinve.vercel.app/mcp

Live smoke: `npm run smoke -- --url https://cinve.vercel.app/mcp`.
This exercises anonymous retrieval and confirms protected routes request login.
