# Technical reference

Cinve's tools, responses and limits.

## MCP tools

| Tool                 | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `list_providers`     | Coverage, capabilities and limits of each cinema.        |
| `get_auth_status`    | Status of Cinex, Cines Unidos and Supercines accounts.   |
| `connect_account`    | Hosted mode only: starts connecting a cinema account.    |
| `disconnect_account` | Hosted mode only: deletes a cinema session from Cinve.   |
| `list_cities`        | A cinema's cities.                                       |
| `list_cinemas`       | A cinema's venues.                                       |
| `list_movies`        | Movies showing, with optional search.                    |
| `get_showtimes`      | Showtimes by venue, city, movie or date.                 |
| `get_ticket_prices`  | Ticket prices for a showtime.                            |
| `get_seats`          | Seat map for a showtime (does not reserve).              |
| `get_concessions`    | A venue's concessions.                                   |

Queries take `provider`: `cinex`, `cinesunidos`, `cinepic`, `supercines` or
`grancine`. Account tools only accept `cinex`, `cinesunidos` or `supercines`;
in local mode, use `npm run login`.

Lists accept `query`, `offset` and `limit` (50 by default, 100 max). To page,
repeat with `next_offset` until it is `null`.

## Recommended flow

1. `list_cities` and `list_cinemas` to get venues.
2. `get_showtimes` to get showtimes.
3. `get_ticket_prices` or `get_seats` with the showtime's IDs.

Only use IDs returned by Cinve, and don't mix them across cinemas. Venues with
`code_status=unverified` can't be queried.

## Arguments by cinema

| Cinema       | What it requires                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Cinex        | `get_showtimes` with `city` reads the whole city; with `cinema_id`, one venue; with `movie_id`, every venue for that movie. `list_movies` is the general catalog, with no date or venue. |
| Cines Unidos | `list_cinemas`, `list_movies` and `get_showtimes` require `city`; add `cinema_id` for one venue.   |
| Cinepic      | Two venues: `123300` (Candelaria) and `123301` (VVIP Lido). Everything except cities and venues requires `cinema_id`. |
| Supercines   | `get_showtimes` requires `cinema_id`, `city` or `movie_id`. Prices and seats require `movie_id` and, if not today, the same `date` used in `get_showtimes`. |
| Gran Cine    | `get_showtimes` with no venue or city reads all its screens.                                       |

## Responses

- `status`: `available`, `empty`, `unavailable`, `auth_required`, `blocked`,
  `rate_limited` or `error`. `empty` means no results, not a failure.
- `items`: the results.
- `partial: true`: Cinve couldn't verify part of the response.
- `warnings`, `sources`, `total`, `next_offset`, `queried_at` and `timezone`.

## Coverage

| Cinema       | Prices | Concessions | Seats | Account required                   |
| ------------ | ------ | ----------- | ----- | ---------------------------------- |
| Cinex        | Yes    | Yes         | Yes   | Prices, concessions and seats      |
| Cines Unidos | Yes    | Yes         | Yes   | Prices and seats                   |
| Cinepic      | Yes    | Yes         | Yes   | No                                 |
| Supercines   | Yes    | Yes         | Yes   | Seats (optional for account fares) |
| Gran Cine    | No     | No          | No    | No                                 |

All of them provide venues, movies and showtimes. Limitations:

- **Cines Unidos:** if its website serves an anti-bot challenge (common from
  cloud servers), Cinve uses its public search API. It can be slower and mark
  results as `partial`.
- **Supercines:** showtimes sold only at the box office appear in `warnings`.
  Accounts created with Google can't be connected.
- **Gran Cine:** arthouse cinema (Paseo Las Mercedes, Cine Ávila and other
  screens); publishes about 20 days ahead.
- **Cinepic:** its concessions API may return an empty catalog.
- **Cinex:** venue discovery and city-wide queries have time limits; venues
  that couldn't be read are listed in the result.
- **Prices:** Cinepic and Supercines compute USD with the rate the cinema
  publishes. No price is the final purchase total.

## Seat maps

`get_seats` requires `cinema_id` and `session_id`; Cinepic and Supercines also
require `movie_id`, and Supercines the same `date` used in `get_showtimes` when
it is not today. Cinex, Cines Unidos and Supercines require a connected account.

```text
O available  X occupied  - restricted/unavailable  ? unknown
```

Returns the `ascii` map and the `available`, `occupied`, `unavailable`,
`unknown` and `total` counters. `include_seats=true` adds each seat.

- `status=available` means the map was retrieved, not that seats are free.
- `availability_complete` is `true` only if the map has seats and none are
  unknown. If `unknown` is greater than zero, the map is partial: zero free
  seats with unknowns does **not** mean sold out.
- No seat is selected or reserved, and nothing is paid.

`layout` says how the ASCII map and the image are oriented, the same way each
cinema's website draws them:

| Cinema       | Screen                                      | Columns                                          |
| ------------ | ------------------------------------------- | ------------------------------------------------ |
| Cinepic      | Top, next to row 1                          | Right to left in rooms marked `invertida`         |
| Cines Unidos | Bottom                                      | Left to right                                    |
| Cinex        | Bottom: its page draws the screen after row A | In page order; shorter rows are centred (`row_shift`) |
| Supercines   | Bottom                                      | As its room plan (`direccionSala`)               |

Wheelchair spaces carry `accessible: true` (Cines Unidos and Cinex mark them);
they keep their status, restricted unless occupied, and the image draws them in
blue with a wheelchair icon.

At Cinepic, a free seat is `available` only if one of the showtime's fares can
sell it; its website shows the others as unavailable. It also sells a quota per
fare, often below the free seats; `get_ticket_prices` returns it as
`tickets_available` and `get_seats` warns when it is lower.

Some cinemas draw a map only inside an order. Cinex does so for regular rooms
on a session that has never opened one, and Supercines always. In those cases
Cinve opens an order of exactly one ticket, never picks a seat, reads the map
and always cancels the order in the same call (Cinex `resetpurchase.php`,
Supercines `/cancelaCompra`, the routes each site uses when its countdown ends),
one order at a time per account. The result's warnings say so. When no map is
published, Cinex's own "available seats" counter is reported instead.

Besides the data, `get_seats` returns the map as a PNG image (up to 1200 px
wide) to show or share, with the legend, counters and lookup time. Its header
names the showtime from `showing` (movie, venue, room, date and time), read from
the same map response at Cinex, Cinepic and Supercines. Cines Unidos' seat API
names only the room, so Cinve also reads that showtime's session (the read ticket
prices use) alongside it; if that read fails, the map is returned without the
names. `image=svg` returns the same map as embedded SVG and `image=none` only
the data. If the image can't be drawn, the response keeps the data and warns.
The image uses Cinve's brand style, with Spanish labels for the people it is
shown to, and is drawn with resvg (WebAssembly) and the Instrument Sans and
Bricolage Grotesque fonts bundled in `src/assets` as static instances.

## Cache and network

- Public responses are cached; `refresh=true` forces a fresh read. Account
  reads and seats are never cached. Only correct answers are kept: an HTTP
  error, an empty body, invalid JSON or a page without the expected structure
  (a maintenance page, for example) is reported and asked for again next time.
- Cache lifetimes: one hour for cities, venue directories and Cinex venue
  identity; 10 minutes for Cinepic's rate and 5 for its concessions; 2 minutes
  for listings, showtimes and Cines Unidos concessions (which publish stock);
  1 minute for Cinepic's purchase page.
- Each read has a 15 s timeout (25 s for Cinepic, whose server sometimes takes
  about 19 s), a 4 MiB body limit, and at most two concurrent reads per site.
  Bodies are decoded with the `charset` the response declares (UTF-8 if none).
- A public read is retried once, after a short pause, if the connection fails
  before any response or the site answers 502 or 504, and only while at least
  half of its timeout remains. 4xx, 429 and 503 answers, timeouts, form posts
  and account reads are never retried.
- A tool call starts no provider read after 60 s, counted from when the hosted
  server received the request; with the read in flight it ends within about
  75 s (85 s at worst for Cinepic), under the hosted 90 s limit.
- A Cinex session check that answers `on` is reused for one minute in the same
  process; any failed Cinex read drops it. An answer other than `on` or `off` is
  reported as Cinex failing, and the session is not marked expired. A provider
  refusing the saved session (HTTP 401 or a redirect to its login) marks it
  `expired`.
- Errors say which side failed: failing to read the saved session is Cinve's
  and never reaches the provider; a timeout or a cut connection is the
  provider's.
- Only allowed pages, APIs and forms are queried. Cinve never buys, pays,
  selects a seat or changes accounts; the only order steps are the one-ticket
  seat-map orders above, always cancelled.
