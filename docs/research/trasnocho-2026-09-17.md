# Trasnocho: browser access and on-demand data investigation

Observed September 17, 2026 using the user's open Chrome tab.

## Confirmed access and content

The homepage, `/cine/`, `/teatro/`, and product details render successfully in this browser session. This supersedes the earlier browser-blocked observation, but does not establish unattended server access.

- The cinema schedule product is ID `395931`. Its URL still contains February, while its visible title and tables say August 13–19. One film's rows instead say August 8–9. Neither URL dates nor the enclosing weekly title can safely date every row.
- `La invitación`, product `396980`, exposes synopsis, technical metadata, poster URL, August day/time pairs, and editorial ticket prices (general $5; Monday/senior $2.50 with conditions). These are source observations, not verified current prices.
- `Sin/Con Secuencias`, product `48562`, exposes theater description, cast, category `Salas Espacio Plural`, August 15–16 at 7 pm, and $12 general admission. The breadcrumb calls even this theater product “Películas”, so breadcrumbs alone cannot classify event type.
- The catalog includes announcements and competitions alongside performances. Cinev currently has no `event` item kind or event-list operation; theater must not silently become a movie.

## Public API discovery

`https://www.trasnochocultural.com/wp-json/` successfully rendered the REST discovery JSON in Chrome. It advertises:

- `GET /wp-json/wp/v2/product`, with published records by default, `orderby=modified`, `order=desc`, `modified_after`, and pagination up to 100 records per page.
- `GET /wp-json/wc/store/v1/products`, a separate storefront collection.
- `GET /wp-json/wp/v2/product_cat`.

Concrete candidate for incremental retrieval:

```text
https://www.trasnochocultural.com/wp-json/wp/v2/product?orderby=modified&order=desc&per_page=10&_fields=id,modified,date,link,title,content,product_cat
```

The product query and storefront collection both produced Chrome `ERR_BLOCKED_BY_CLIENT`. A separate Node fetch of the product query returned HTTP 403 and a Cloudflare challenge. No product API payload, modification timestamp, or current event was recovered. Discovery of a route is not proof that the route is usable. No browser protections were changed or cookies exported.

## Freshness and integration requirements

The concrete candidate is a read-only API adapter with a browser reader as an optional fallback. It remains unvalidated until the product endpoint actually returns data. A reliable unattended integration needs repeatable access to this public endpoint or a provider-supplied feed.

Once access works, fetch on demand; retain source URL and retrieval time separately from source modification time. Parse actual performance dates in America/Caracas, validate weekday/year consistency, and flag missing years, cancellation, reprogramming and conflicting dates. Do not advance old August rows into the current week. A recent fetch or edit timestamp does not establish current performances.

Use stable product IDs rather than mutable titles or date-bearing slugs. Separate catalog metadata from dated performances; keep cinema and other events distinct. Store editorial prices with their conditions and never present them as a verified checkout total. Return `unavailable` with an explicit freshness warning when only expired or ambiguous schedules are available; do not claim there are no performances merely because the source is stale.

## Other official sources inspected

The official Instagram profile `https://www.instagram.com/trasnochocult/` loads, but opening a post requires login. No current post caption was verified.

Product pages link the official ticket-office WhatsApp catalog at `https://wa.me/c/584146913811`. Its public landing page loads and redirects catalog viewing into WhatsApp Web. No message was sent.

The user explicitly prohibited entering WhatsApp. The WhatsApp tab was closed and the original tab returned to Trasnocho's homepage. Do not use WhatsApp for subsequent research or integration.

Production adapter behavior remains unchanged: it must not advertise fresh inventory on the strength of these historical samples or the discovery document alone.
