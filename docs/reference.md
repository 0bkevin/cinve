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
| Supercines   | `get_showtimes` requires `cinema_id`, `city` or `movie_id`. Prices require `movie_id` and, if not today, the same `date` used in `get_showtimes`. |
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
| Supercines   | Yes    | Yes         | No    | No (optional, for account fares)   |
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

`get_seats` requires `cinema_id` and `session_id`; Cinepic also requires
`movie_id`. Cinex and Cines Unidos require a connected account.

```text
O free  X occupied  - unavailable  ? unknown
```

Returns the `ascii` map and the `available`, `occupied`, `unavailable`,
`unknown` and `total` counters. `include_seats=true` adds each seat.

- `status=available` means the map was retrieved, not that seats are free.
- `availability_complete` is `true` only if the map has seats and none are
  unknown. If `unknown` is greater than zero, the map is partial: zero free
  seats with unknowns does **not** mean sold out.
- The query doesn't select or reserve seats.

## Cache and network

- Public responses are cached; `refresh=true` forces a fresh read. Account
  reads and seats are never cached.
- Each read has a 15 s timeout, with at most two concurrent reads per site.
- Only allowed pages, APIs and forms are queried. Cinve never buys, reserves or
  changes accounts.
