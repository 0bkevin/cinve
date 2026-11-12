# Cinve: map for coding agents

Cinve is a read-only MCP server for Venezuelan cinema data (Cinex, Cines
Unidos, Cinepic): cities, venues, films, showtimes, ticket prices,
concessions and seat maps. It runs locally over stdio, as a stdio bridge to a
hosted instance, and hosted on Vercel with Postgres. TypeScript, ESM, Node 22+.
User-facing text is Spanish; code and comments are English.

## Layout

```
server.ts            Vercel entry: the hosted HTTP handler (build:hosted -> .hosted/)
migrations/          Postgres DDL for the hosted service, applied in order
                     (only by npm run db:migrate, hosted:admin or scripts/migrate-neon.ts,
                     never by the Vercel function, so build:hosted does not copy it)
src/
  index.ts           entry: local stdio MCP server (package bin: dist/index.js)
  remote-main.ts     entry: stdio bridge to a hosted Cinve (npm run start:remote)
  hosted-main.ts     entry: standalone hosted HTTP server (npm run start:hosted)
  hosted-admin.ts    entry: hosted DB admin: migrate | issue | revoke | cleanup
  auth-cli.ts        entry: npm run login | logout | auth:status
  core.ts            shared contract: zod schemas (Query, Item, Result), DataError, value helpers
  service.ts         CinemaService: runs an adapter, validates, dedupes, filters, pages results
  mcp/               server.ts: tools, argument schemas, instructions; bridge.ts: stdio proxy
  providers/         one folder per chain, each with adapter.ts = <chain>(op, query, ctx)
    cinex/           adapter, public-pages (HTML parsers), venues (discovery), account-pages
    cinesunidos/     adapter (+ search-API fallback), directory, prices
    cinepic/         adapter, sites (the two venues and their purchase page)
    parsing.ts       bounded Next.js Flight reader and payload checks
    diagnostics.ts   bounded parser warnings; read-policy.ts: cache lifetimes
  http/              client.ts: HttpClient (cache, queue, retries); read-context.ts: one
                     call's sources/warnings/deadline; allow-list.ts: every URL Cinve may
                     fetch; redirects.ts, response.ts, account-lock.ts
  seats/             seat-map.ts: getSeatMap; parsers, schema (SeatResult), ascii, image
                     (SVG/PNG), guidance (the seat rules text)
  auth/              sessions.ts: local session files; login.ts: website logins;
                     credentials-prompt.ts: hidden terminal input
  hosted/            app.ts: HTTP app; oauth, client-metadata, store (encrypted sessions),
                     connection-links, http-client, migrations, auth-guidance
  web/               HTML for the hosted site: site (layout, assets), install, connect-page;
                     /site.js and /app.js are plain strings that test/web runs in a fake DOM
  assets/            fonts, og.png, favicon; both builds copy them next to the output
test/                mirrors src/: test/http/client.test.ts tests src/http/client.ts,
                     test/providers/cinex-venues.test.ts tests providers/cinex/venues.ts;
                     test/helpers/ holds fixtures and subprocess helpers; assert.ts has
                     nth/defined/capture, which fail the test instead of reading undefined;
                     terminal-probe.py stays Python: Node has no built-in pty or termios,
                     and node-pty would be a native dependency
scripts/             test-postgres.ts (npm test), smoke.ts (live), migrate-neon.ts
docs/                reference.md (tools, statuses, limits), hosted.md (deployment)
```

## Request flow

1. `mcp/server.ts` registers each tool; `inputSchema(op)` validates arguments.
2. `CinemaService.query` (`service.ts`) creates a `ReadContext` and calls the
   adapter `providers/<chain>/adapter.ts`.
3. The adapter reads through the context (`get`, `json`, `page`,
   `authenticated`). Each URL is checked by `http/allow-list.ts`, then fetched
   by `HttpClient` (`http/client.ts`): per-origin queue, deadline, public cache.
   Authenticated reads add the saved session's headers and are never cached.
4. The service validates every item against `core.ts`, drops conflicting
   showtimes, filters, pages and bounds the warnings.

`get_seats` goes from `mcp/server.ts` to `seats/seat-map.ts`, then to the
seat parsers, the ASCII map and the PNG/SVG image. In hosted mode,
`hosted/app.ts` builds a `CinemaService` per request. Its HTTP client shares
the public cache, and an encrypted per-user session store backs the account
reads.

## Commands

```sh
npm ci
npm run check                 # typecheck src, test, scripts and server.ts (strict, plus
                              # noUncheckedIndexedAccess and exactOptionalPropertyTypes)
npx tsc -p tsconfig.hosted.json --noEmit
npm test                      # all test/**/*.test.ts; needs initdb/pg_ctl or TEST_DATABASE_URL
npm run build                 # dist/ (+ dist/assets, resvg.wasm)
npm run build:hosted          # .hosted/ (Vercel output)
npm run dev                   # stdio server from source
```

`npm run smoke` queries the real cinema sites. Run it only when asked.

## Hard rules

- Never buy, pay or select a seat. One exception, approved by the owner: a
  seat map a cinema shows only inside an order may be read by opening an order
  of exactly one ticket, which the same call always resets. On Cinex that is
  `boletos_data.php` (only when a regular room's seat page has no grid; see
  `seats/seat-map.ts`) reset with `resetpurchase.php`. Never call Cinex
  `boletos_datadev.php` or `asientos_datadevx.php`. A new provider URL must be
  added on purpose to `http/allow-list.ts`.
- Seats are never cached: `getSeatMap` always reads fresh.
- Never commit credentials, cookies, tokens, session files
  (`~/.config/cinev/*.json`), `.env*`, or real authenticated responses. Test
  fixtures are synthetic.
- Never ask for passwords in chat or in tool arguments. Accounts connect only
  through `npm run login` in a local terminal or through the hosted connect page.
- Never present an unknown seat state as free. Keep "empty" distinct from a
  failure, and mark unverified data as partial. Never evade anti-bot challenges.
- The public contract is fixed: tool names, schemas and Spanish messages, and
  the entry paths under `dist/` (`bin`, npm scripts, client configs).
- Use plain relative imports with `.js` extensions; there are no path aliases.
  Modules that read files resolve them from `import.meta.url`: `seats/image.ts`
  and `web/site.ts` read `../assets/`, and `hosted/migrations.ts` reads
  `../../migrations/`.
