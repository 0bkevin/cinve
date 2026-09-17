# Adversarial review — 2026-09-12

The review reproduced defects, fixed them, and expanded the suite from 36 to **52 passing tests**. The most consequential finding was a terminal password disclosure when both credential fields were pasted together. Live authenticated reads succeeded for Cinex and Cines Unidos. The complete live run was **not green**: Cinepic Candelaria had provider-side failures. This is a scoped code review and regression exercise, not an independent security certification or a guarantee of complete cinema coverage.

## Scope and method

Reviewed the local stdio MCP, terminal onboarding, session files, HTTP requests/redirects, public and authenticated parsers, output validation, and live-check scripts. Used synthetic hostile payloads and real POSIX pseudo-terminals, then the existing authorized accounts for normal HTTP reads. No browser, purchases, seat reservations, or payment operations were used. No passwords, tokens, profiles, or raw authenticated HTML were added to this report or its evidence file.

Runtime: Node.js **v24.20.0**, Linux/POSIX. The tests for credential input run the actual prompt implementation through a PTY, including a multi-line paste, separate entry, Ctrl+C, and SIGTERM.

## Findings and fixes

Priority describes impact within this local application; these are not CVSS scores. All code findings below were addressed in the workspace.

| Priority | Finding and reproduction | Fix and regression evidence |
|---|---|---|
| High | **Password echoed during a combined paste.** Sending synthetic email plus password in one terminal write printed the password while switching between two readline interfaces. The prompt could also be displayed before OS echo was disabled. | [credentials-prompt.ts](../../src/credentials-prompt.ts) uses one raw-mode reader for both fields, disables echo before displaying the first prompt, and never echoes either field. PTY tests confirm no credential text appears and terminal echo is restored on normal completion and tested cancellation paths. A real Cinex login also succeeded through this flow. |
| Medium | **Unbounded queue wait and excessive cache retention.** The 15-second timeout started after queue admission; callers could accumulate without a queue cap. The 64-entry cache had no byte budget. | [http.ts](../../src/http.ts) counts queue wait toward the deadline, allows two active plus 32 queued reads per origin, and limits cached strings to 16 MiB as well as 64 entries. Tests saturate the queue, expire queued work, and verify byte-budget eviction. Login redirect chains share a deadline rather than restarting it at each hop. |
| Medium | **Queued requests captured credentials too early.** A request waiting for capacity retained the previous account's token after local logout. | Credentials are loaded after queue admission. A regression fills both active slots, queues an authenticated read, logs out, and verifies the queued read makes no HTTP request. Reads already sent can still finish; local logout is not remote token revocation. |
| Medium | **Untrusted output could escape the normal error contract or carry unsafe links.** A Cinepic conversion rate of `1e-320` produced a non-finite price, throwing a ZodError outside the result handler. Provider image fields could emit `javascript:`, `data:`, or credential-bearing URLs. No browser execution was performed or claimed. | [service.ts](../../src/service.ts) validates every record inside the guarded path, before filtering/pagination. Invalid records return structured `error` with no items. Unsafe links are omitted with a warning while retaining useful data. Tests cover non-finite conversion, out-of-page bad records, executable URL schemes, and embedded URL credentials. |
| Medium | **Malformed Flight data could cause disproportionate parsing work.** Unterminated, repeated call markers caused overlapping suffix scans; recursive JSON traversal could exhaust the stack. | [parsers.ts](../../src/parsers.ts) advances past consumed calls and stops on an unterminated call. Traversal is iterative and limited to depth 64 and 100,000 visited/pending nodes. Tests also verify that markers inside a JSON string are not parsed as another call. These limits complement the HTTP body limit; they are not a global process memory or CPU sandbox. |
| Medium/Low | **Filesystem edge cases could hang reads or redirect logout.** A FIFO at the session path could block before the file-type check. Logout did not reject a symlinked session directory. These require local filesystem manipulation and are not remote privilege escalation claims. | [auth.ts](../../src/auth.ts) opens with `O_NONBLOCK` before checking for a regular private file, validates serialized cookie jars, bounds token/expiry fields, and rejects symlinked logout directories. Tests use a synthetic FIFO and verify an outside sentinel file survives logout. |
| Medium | **Authentication boundary and error-reporting gaps.** Cinex authenticated routes accepted additional/duplicate parameters at the HTTP layer. Login exceptions were passed through based on a text prefix. A real expired Cinex session redirected to `/clearsession.html` and was classified as a generic error. | Exact Cinex query keys/values are checked. Login headers are reconstructed from the cookie jar; caller-supplied Cookie/Authorization headers are removed. Only internally constructed login errors are exposed. MCP transport logging is generic. Recognized login redirects become `auth_required` without being followed. Tests exercise each boundary. |
| Medium | **Some filters and upstream values were accepted without meaningful validation.** Cinex price queries accepted `movie_id` but ignored it; Cines Unidos accepted impossible clock values. Unusable upstream IDs could be returned to an agent that could not pass them back to the tools. | Cinex rejects that unsupported price filter. Provider dates, clock values and reusable IDs are checked, and numeric parsing rejects non-decimal formats such as hex. Tests use a 29:99:99 showtime and a traversal-like ID. Unrecognized Cinex detail links are omitted without following them. |
| Medium | **The validation process could miss important failures.** Tests/scripts were excluded from type checking. The live smoke test could choose an upcoming release with no showtimes and never exercise authenticated Cinex pricing. | [tsconfig.check.json](../../tsconfig.check.json) includes source, tests and scripts; enabling it found and corrected a smoke-script type error. [smoke.ts](../../scripts/smoke.ts) samples up to eight movies and offers `--require-auth`, which fails if required authenticated coverage is missing or unsuccessful. |

The terminal implementation is consistent with Node's documented [raw-mode behavior](https://nodejs.org/api/tty.html#readstreamsetrawmodemode): raw mode disables input echo and changes Ctrl+C handling, so cancellation is handled explicitly. The network deadline uses Node's [AbortSignal timeout API](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay), passed to fetch for both response headers and body consumption. The PTY and queue tests validate the application behavior independently of these documentation references.

## Live observations

The full authenticated smoke run occurred on September 12, around 06:54 UTC. The safe metadata and focused follow-ups are summarized below; counts are observations, not constants or nationwide coverage claims.

| Check | Observation |
|---|---|
| Cinex login | Existing remote session had expired before its local 24-hour cap. The new login prompt reconnected successfully. |
| Cinex authenticated fares | `available`: Múltiplaza Paraíso (`MPP`), session `26346`, two fares. |
| Cinex candy | `available`: Tolón (`TLN`), 86 unique listings. |
| Cines Unidos authenticated fares | `available`: cinema `1009`, session `53947`, two fares. |
| Cines Unidos candy | `available`: Sambil Caracas (`1005`), 74 listings. |
| Cinepic VVIP fares/candy | Fares `available`; candy `empty` in this sample. |
| Cinepic Candelaria catalog | Movies and showtimes `available`. |
| Cinepic Candelaria purchase page | First request failed within the HTTP deadline. A focused retry returned the provider's visible error: “No pudimos mostrar la función”, reference `AC-001`, without function data. The adapter now recognizes this explicit provider failure as `unavailable`, distinct from an unknown schema. |
| Cinepic Candelaria candy | Timed out again on a focused retry at approximately 15 seconds. No stale catalog or invented prices were substituted. |
| Trasnocho | HTTP 403, reported as `blocked`. |

The Candelaria message was verified directly in the visible HTML of its [purchase page](https://cinepiccandelaria.com/es-AR/compra?cid=123300&fid=23257&pid=913), with script/style text excluded. The page can change as the provider recovers or the function expires. The full live run exited nonzero because of provider errors; successful unit tests do not erase those observations.

A final MCP request to that purchase page also hit the 15-second deadline. The `AC-001` classification is covered by a regression fixture matching the observed page; intermittent timeouts prevented confirming that classification in the final live request. Both observations are retained in the evidence file.

## Verification

- `npm run check`: passes for source, tests and scripts.
- `npm test`: **52 passed, zero failed or skipped** in this environment.
- `npm run build`: passes.
- `npm audit --json`: zero reported advisories for the installed dependency graph at review time. This is not proof that dependencies have no vulnerabilities.
- Real MCP stdio reads exercised Cinex/Cines Unidos authenticated fares and candy. Other provider outcomes are listed above.
- Synthetic tests never use live credentials. The PTY probe requires Python 3; on a system without it, the suite reports that test as skipped. The special-file test requires POSIX `mkfifo`.

## Remaining limits and judgment

The implementation is improved for continued **local, single-OS-user use**. Session files still rely on filesystem permissions, not encryption or an OS keychain. Processes running as the same user can read them; the MCP process is not a security boundary against that user. A shared remote deployment still needs its own authentication, encrypted per-user session storage and tenant isolation.

Provider sessions may expire early, endpoints and HTML may change, and Cinepic/Trasnocho failures remain outside the adapter's control. There is no guarantee that every cinema, combo variant, seat, fee or purchase total is covered. Returned cinema text remains untrusted data for the consuming agent. No automated password refresh, OTP/CAPTCHA flow, purchase, or reservation capability was added.
