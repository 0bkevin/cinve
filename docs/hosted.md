# Hosting Cinve

How to deploy your own Cinve HTTP server. You don't need any of this to use the
public service.

## Requirements

- Node.js 22 or later.
- A dedicated PostgreSQL database (for example, Neon).
- A domain with HTTPS.

## Environment variables

| Variable                | Required  | Description                                         |
| ----------------------- | --------- | --------------------------------------------------- |
| `DATABASE_URL`          | Yes       | PostgreSQL connection with TLS.                     |
| `DATABASE_URL_UNPOOLED` | No        | Direct connection used for migrations.              |
| `CINEV_PUBLIC_URL`      | Yes       | HTTPS origin, no path: `https://cine.example.com`.  |
| `CINEV_ENCRYPTION_KEY`  | Yes       | Generate it with `openssl rand -hex 32`.            |
| `CRON_SECRET`           | On Vercel | Protects the daily cleanup. Generate it the same way. |
| `PORT`                  | No        | Port outside Vercel (default `3000`).               |

Keep `CINEV_ENCRYPTION_KEY` stable: if it changes, everyone must reconnect
their accounts.

## Deploy on Vercel

1. Create a project and connect a PostgreSQL database in the same region.
2. Set the environment variables.
3. Run the migrations: `npm run db:migrate`. If your network blocks direct
   PostgreSQL connections to Neon:

   ```sh
   node --env-file=.env.production.local --import tsx scripts/migrate-neon.ts
   ```

4. Deploy and check: `vercel --prod` and `curl https://<domain>/health`.

`vercel.json` already includes the routes and the daily cleanup.

## Deploy on another server

```sh
npm ci
npm run build
npm run db:migrate
npm run start:hosted
```

Schedule `npm run db:cleanup` once a day (for example, with cron).

Put it behind an HTTPS reverse proxy, keeping in mind that:

- The proxy must preserve the `Host` header; if it doesn't match
  `CINEV_PUBLIC_URL`, the server responds 403. In Nginx:
  `proxy_set_header Host $host;`.
- Cinve doesn't read `X-Forwarded-For`: all users share the proxy IP's rate
  limits (for example, 20 sign-ins per minute). It suits personal or small-group
  use.
- Don't install with `--omit=dev`: migrations and cleanup use `tsx`.

## Protect the service

- Rate-limit requests per IP in your firewall or CDN for `/mcp`, `/oauth/*` and
  `/connect/*`.
- Set a maximum compute size for the database.
- Don't log SQL parameters or request bodies.

## Verify

```sh
npm run smoke -- --url https://<domain>/mcp
```

Runs real queries and checks that protected routes require authentication.

## Update

Run `npm run db:migrate` before deploying a version with new migrations. They
are idempotent.

## Manual tokens

For clients without OAuth (requires `npm run build`):

```sh
npm run hosted:admin -- issue              # shows the token only once
npm run hosted:admin -- revoke <client-id>
```

## Web languages and discovery

Browser pages support Spanish and English. `?lang=es` or `?lang=en` overrides
`Accept-Language`; unsupported or missing preferences fall back to Spanish.
Public pages that negotiate English redirect temporarily, with no caching, to
`?lang=en` so shared links and social crawlers keep the selected language.
Responses vary by `Accept-Language` and declare `Content-Language`. Internal
links keep the chosen language.

`/install` also varies by `Accept`. An explicit `lang` serves HTML even without
an HTML Accept header; `?format=text` always serves the English agent guide.
MCP instructions and results remain independent of the web language; the
assistant is instructed to answer in the language of the user's prompt.

Typed catalogs live in `src/web/locales/es.ts` and `en.ts`. `/connect` switches
languages in place to retain its single-use invitation or exchanged token.
Indexable pages have localized canonical URLs, reciprocal `hreflang` links,
social metadata and sitemap entries. Landing-page JSON-LD matches the visible
content and Venezuelan coverage. Private pages and errors remain `noindex`.

Regenerate the two 1200 × 630 social PNGs with `npm run build:og`. They share
`scripts/build-og.ts` and the vendored fonts and logos; only catalog copy differs.
