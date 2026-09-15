# Trasnocho access review — 2026-09-15

## Direct HTTP

The homepage and `/cine/` return HTTP 403 from this machine. A homepage HEAD request explicitly included `cf-mitigated: challenge`. Public discovery probes to `/robots.txt`, `/wp-json/`, and `/sitemap_index.xml` also returned 403; no API schema was retrieved. These probes do not establish that WordPress REST is enabled or disabled behind the access restriction.

## Indexed evidence (not current live data)

Search results for the provider expose `/product-category/salas-cine/` and product detail pages, including:

- https://www.trasnochocultural.com/product/la-invitacion/
- https://www.trasnochocultural.com/product/la-odisea-estreno-16-de-junio/

Indexed detail text has separate film metadata, synopsis, showtimes, and prices. The observed schedules refer to August 13–19, not September 15. Search freshness labels are not evidence that those showtimes are current. This supports feasibility of extracting structured fields from accessible detail HTML, but does not validate a parser against a live response or establish full catalog coverage. No indexed prices or schedules were inserted into MCP results.

## Implementation decision

Keep the existing adapter's `blocked` response. Do not substitute historical search snippets as current inventory. A working integration requires repeatable access to an authorized public source and current dated samples, followed by parser tests covering mixed cinema/event listings, weekly date boundaries, missing years, promotional restrictions, pagination, and stale schedules. Concessions availability remains unverified.

## Delegated real-browser inspection

A delegated agent used T3 collaborative browser tools (`preview_open`, navigation and `preview_evaluate`) on the homepage, `/cine/`, `/product/la-invitacion/`, and `/product-category/salas-cine/`. All displayed Cloudflare “Performing security verification” / “Just a moment...”, with no programming content in the DOM. Resource inspection on the detail page showed challenge resources and no programming API. Browser screenshots could not be obtained because `preview_snapshot` raised `PreviewAutomationExecutionError`; this is DOM/browser evidence, not a successful visual screenshot. No challenge bypass was attempted.

Conclusion: browser navigation did not establish live scraping access in this environment. No production provider code was changed and no claim of complete coverage is made.
