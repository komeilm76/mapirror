# 16 — Documentation changelog

Review passes over the repository — documents first, then the code that implements them. Every entry
is a defect that was found and fixed, kept so a reviewer can see what changed and why.

**Totals:** 82 passes · 336 defects fixed · 0 open (pass 1: 20, pass 2: 18, pass 3: 16, pass 4: 4, pass 5: 4, pass 6: 10, pass 7: 8, pass 8: 6, pass 9: 6, pass 10: 2, pass 11: 1, pass 12: 1, pass 13: 3, pass 14: 3, pass 15: 2, pass 16: 3, pass 17: 2, pass 18: 2, pass 19: 3, pass 20: 3, pass 21: 2, pass 22: 2, pass 23: 2, pass 24: 1, pass 25: 1, pass 26: 2, pass 27: 2, pass 28: 2, pass 29: 2, pass 30: 2, pass 31: 4, pass 32: 4, pass 33: 7, pass 34: 2, pass 35: 1, pass 36: 3, pass 37: 4, pass 38: 3, pass 39: 2, pass 40: 3, pass 41: 3, pass 42: 4, pass 43: 4, pass 44: 3, pass 45: 1, pass 46: 3, pass 47: 4, pass 48: 1, pass 49: 2, pass 50: 2, pass 51: 3, pass 52: 1, pass 53: 4, pass 54: 1, pass 55: 2, pass 56: 1, pass 57: 2, pass 58: 1, pass 59: 2, pass 60: 5, pass 61: 4, pass 62: 6, pass 63: 3, pass 64: 1, pass 65: 5, pass 66: 8, pass 67: 6, pass 68: 8, pass 69: 5, pass 70: 5, pass 71: 8, pass 72: 7, pass 73: 8, pass 74: 1, pass 75: 4, pass 76: 4, pass 77: 4, pass 78: 4, pass 79: 5, pass 80: 7, pass 81: 7, pass 82: 9).
Scope of a pass: consistency with `PROMPT.md`, consistency between docs, and correctness of the
mechanisms described (SQL, state machines, HTTP semantics).

---

## Pass 65 — 2026-10-27 (catalog synchronization needed TTL, audit, and cooperative cancellation)

P2-SRC-06 implements the catalog job as an upsert-only transaction: fetch and validate before writes, preserve source-id/slug assignments, retain source removals and their cache, and commit `catalog.sync` with the rows. Freshness uses a system-owned `source.catalogSyncedAt` setting committed with the rows/audit (including empty catalogs); explicit jobs are never skipped just because the catalog is fresh.

| # | Bug found in contract review | Fix |
|---|---|---|
| 1 | The TTL decision could request another refresh while a catalog job was already queued or running, duplicating automatic work | `isCatalogSyncDue` suppresses a trigger while an active catalog job exists; a database integration test pins queued/running behavior and the exact TTL boundary |
| 2 | `MapSource.listRegions` and the index fetch had no cancellation/deadline path, so worker cancellation could wait indefinitely on the upstream request or JSON body | Pass the worker `AbortSignal` through the source contract; the index client has a 10 s deadline (30 s cap), aborts transport/body reads, and returns only sanitized status/timeout errors |
| 3 | A blocking transaction advisory-lock call could leave a canceled sync waiting behind another worker | Use `pg_try_advisory_xact_lock` with 25 ms abortable polling; the handler rolls back before the worker can mark cancellation terminal |
| 4 | The model promised collision resolutions in the audit record, but an action/count-only audit could not show which stable slugs differed from current names | Include the deterministic source-id/slug assignments in `catalog.sync` metadata and document that contract |
| 5 | The first TTL clock design read `jobs.finished_at`, but job retention can prune that history before a long configured TTL expires | Persist `source.catalogSyncedAt` in the same transaction as country rows and audit; malformed/missing marker means due, and TTL remains correct after job cleanup |

Eight targeted mutations were killed by tests: remove active-job suppression; overwrite the repository's assigned slug; omit the index request signal; fail to abort the timed-out request; delete source-omitted countries; omit the audit insert; replace the cancelable lock loop with a blocking advisory lock; or rely on prunable job history instead of the sync marker. A slug-overwrite mutation was rejected by the repository contract test (the sync-level caller correctly supplies the preserved slug, so that narrower probe alone was equivalent).

Full non-Docker `bun run check`: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint and formatting; **1,348 passed across 99 files, 7 skipped**. Docker runtime/operator tests remain excluded per operator direction. The development guide's `bun run sync:catalog` was moved from P2-SRC-06 to P2-API-02: the CLI should share that task's idempotent enqueue/worker wiring rather than bypass the durable job contract. The command remained planned at the end of this pass and was completed in pass 67. **Totals after this pass: 65 passes · 236 defects fixed · 0 open.**

## Pass 66 — 2026-10-28 (admin catalog listing needed a contract and consistent projection)

P2-API-01 replaces the catalog `NOT_READY` stub with an authenticated SQL-backed listing. Review checked request validation, route protection, pagination defaults and bounds, count/page consistency, exact int8 serialization, durable sync freshness, and the documented sort vocabulary.

| # | Bug found in contract review | Fix |
|---|---|---|
| 1 | `GET /_admin/api/catalog` was still a `503 NOT_READY` stub, so the first admin data screen had no catalog read path | Add the authenticated handler and retire the stub from the route map and bootstrap tests |
| 2 | Catalog query and response fields existed only as prose; there was no shared schema or explicit projection to keep database internals out of the API | Add shared Zod query/response contracts and map typed repository rows to the documented fields; reject invalid filters/sorts and unknown query keys |
| 3 | The generic list default was 25 while the catalog example promised 50, and the task did not pin the endpoint-specific default | Use a 50-row catalog default, keep the 100-row maximum, and test decimal-only fallback/clamping |
| 4 | PostgreSQL int8 values arrive as decimal strings; coercing byte counts to JS numbers can silently round large values | Emit safe integers as JSON numbers and larger values as exact decimal strings, with matching shared schemas |
| 5 | The successful-sync marker, count, and page were separate reads; a catalog commit between them could produce freshness and rows from different snapshots | Read the marker, filtered count and page in one `REPEATABLE READ` transaction |
| 6 | The public sort contract accepts `created`, but the catalog repository had no safe created-time ordering branch | Add fixed-column `createdAt` ordering with deterministic name/UUID tie-breakers and map the public sort key explicitly |
| 7 | Route tests still treated the now-implemented catalog path as a `503` stub, so the suite failed after the correct handler was registered and did not assert the new response behavior | Update the transport test to require catalog `200` while retaining `503` checks for remaining stubs; rate-limit tests now assert charged catalog requests are not refused with `429`, independent of downstream database errors |
| 8 | ISO search checked only `iso_alpha2`; a query for a stored ISO 3166-2 subdivision code (for example `FI-01`) returned no country even though that code was included in the response | Search both ISO arrays for exact and substring matches; the real-PostgreSQL route test now proves `?q=FI-01` returns Finland |

Real-PostgreSQL route tests exercise authentication, row/cache projection, name and both ISO-array searches, filters, all sort keys, pagination, malformed freshness markers, large int8 values, empty results, and the 400-row latency target. Shared-contract tests pin strict query/response shapes and precision-safe integers. Four targeted implementation mutations were killed: removing strict unknown-query rejection; sorting `size` by the wrong database column; converting all PostgreSQL int8 values to `Number`; and changing the catalog default from 50. Separately, the subdivision-ISO regression failed before the search fix (empty result instead of Finland) and passed afterward. The int8 mutation returned `9223372036854776000` instead of the exact decimal string `9223372036854775807`. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint and formatting; **1,362 passed across 101 files, 0 skipped** with the local PostgreSQL 16.2 test database. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 66 passes · 244 defects fixed · 0 open.**

## Pass 73 — 2026-10-28 (version deletion needed a transactional and stream-safe contract)

P2-API-08 implements `DELETE /_admin/api/cache/:countryId/versions/:versionId`. The review covered strict confirmation and request schemas, country/version ownership, the transaction boundary for the hard delete and `version.delete` audit, cache-state repair, job and stream coordination, and post-commit orphan cleanup.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | The documented per-version delete route had no handler, so there was no way to remove one stored map version without deleting the whole country cache | Register the authenticated route with query or JSON confirmation; missing/false confirmation is `409 CONFIRMATION_REQUIRED` |
| 2 | The destructive request had no strict shared params/query/body contract | Add UUID params and strict confirmation schemas; unknown keys and malformed UUIDs return `400 VALIDATION_ERROR` |
| 3 | A delete needs an auditable transaction boundary, but there was no version-delete audit action or atomic metadata record | Hard-delete the row and write `version.delete` in the same transaction with version, origin/status, exact byte count, MD5/SHA-256, country, and publication metadata |
| 4 | Removing a version could leave a stale ready count, byte total, update offer, or public availability; deleting the last version must not leave an empty cache record | Recompute ready count/size and clear stale availability in-transaction; reset update state; unpublish when no ready version remains; remove `country_cache` when no version rows remain while retaining `countries` |
| 5 | Queued/running country work could race the deletion and recreate or mutate the same version | Reject deletion with `409 JOB_ALREADY_RUNNING` and leave the version/file intact |
| 6 | The shared exclusive advisory lock was released before the post-commit callback finished, allowing download admission or a stream to race the file unlink | Keep the per-country lock until transaction and safe unlink complete; release it in `finally` on success or error |
| 7 | A file unlink failure after the database commit could turn a committed delete into an HTTP failure or hide the orphan | Log the failed storage path for orphan cleanup and still return `204`; never attempt rollback after commit |
| 8 | Audit records did not preserve the complete available checksum set or the documented response did not state removed-version URL behaviour | Include both persisted checksums and document `404 NOT_FOUND` for removed versions; `docs-contract.spec.ts` contains no assertions that audit action names must appear in docs |

Four targeted mutation probes were killed by integration tests: releasing the lock before cleanup, retaining the empty `country_cache` row, failing to unpublish with zero ready versions, and bypassing the active-job guard. The lock regression test was made failure-safe so a deliberate early release fails as an assertion rather than hanging its cleanup. Real-PostgreSQL targeted tests pass: **24 across the cache-delete and credential-transport specs**, including an audit-write failure probe that proves the file and row remain when the transaction rolls back. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, formatting, and **1,419 tests across 109 files, 0 skipped**. Docker runtime/operator tests remain excluded per operator direction. The public download handler itself remains scheduled for P3-API-03; this task removes the persisted version and documents the required 404 behavior for that handler.

**Totals after this pass: 73 passes · 291 defects fixed · 0 open.**

## Pass 79 — 2026-10-28 (the admin cache screen needed a sortable, responsive list)

P2-WEB-03 replaces the S7 placeholder with an authenticated cache table and card layout. The screen validates `GET /_admin/api/cache` against the shared response schema, keeps search/update filter/sort/page in the URL, and distinguishes local cached bytes from catalog source-size hints.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | S7 was still a generic placeholder although the cache-list API and shared schema were available | Register `CachePage.vue` at the existing protected route and provide data-driven table/card states |
| 2 | The page had no URL-backed query controls or useful async states | Add debounced search, update filter, supported server sort/page, schema validation, initial skeletons, retryable errors with request ids, and actionable empty/filter-clear states |
| 3 | Cache `sort=size` reused the catalog source-size hint, so a cache size heading would sort by the wrong metric | Map the cache route to `totalSizeBytes`, document the endpoint distinction, and add a PostgreSQL regression with inverted source/cache ordering |
| 4 | The cache table's catalog-sync column showed the latest source download instead of the catalog synchronization time | Display `lastSyncedAt` in the sync column and the source-download timestamp as separate secondary detail; format nullable timestamps without a misleading `UTC` suffix |
| 5 | Replacing S7 changed route-rendering assumptions, and narrow screens must not inherit a six-column horizontal scroller | Update placeholder/auth/router/theme expectations; add stacked mobile cards, reduced-motion skeleton behavior, and a five-column tablet layout |

Cache-page web tests cover schema-validated authenticated requests, exact large-byte formatting, ready counts/public state/update/date values, URL-backed sorting/filter/search/pagination, loading/retry/empty states, and responsive CSS. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, formatting, and **1,167 passed across 114 files; 284 skipped**. The PostgreSQL cache-route tests, including the new size-order regression, were skipped because this environment has no test database; Docker/operator tests were not run. The Vite production web build succeeds.

**Totals after this pass: 79 passes · 313 defects fixed · 0 open.**

## Pass 80 — 2026-10-28 (cached-country detail needed secure streaming and safe per-version actions)

P2-WEB-04 replaces the S8 placeholder with a UUID-addressed cached-country detail page linked from the cache list. It shows cache/update summary, active work, a URL-paginated version history, authenticated streamed file downloads, and individually confirmed version deletion with optimistic state followed by an authoritative read.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | S8 was still a placeholder, and its `:slug` URL did not match the UUID-scoped cache detail/version APIs | Register the page at `/_site/admin/cache/:countryId`, use the existing UUID path builder, and link cached-country names from the S7 table/cards |
| 2 | The API client still described downloads as links; an anchor cannot attach the Bearer token required by the protected PBF endpoint, while buffering a large extract as a `Blob` is unsafe | Add a no-fixed-timeout authenticated `stream()` client method that pipes response bytes directly into the browser file picker, handles API/session errors and cancellation, and displays a clear unsupported-browser fallback |
| 3 | Mutating `route.meta` after the detail response did not reliably update the already-rendered breadcrumb | Use per-app Pinia state for the API-loaded country name, with the decoded UUID as the interim fallback |
| 4 | A country/page change during a pending file picker, file stream, or version deletion could let stale async work update a different screen or redirect after navigation | Abort active streams on route change/unmount; scope async UI updates and deletion side effects to the country and operation that initiated them |
| 5 | The detail view had no responsive, semantic version table/cards or explicit accessible confirmation/error states | Add summary/job/version layouts, status-aware download availability, a keyboard-operable alert dialog with explicit acknowledgement, request-id errors, and responsive styling from existing theme tokens |
| 6 | The new detail route was absent from route-law, auth, list-link and project-tree expectations; an explanatory paragraph had also split the S8 screen-inventory table | Update the route/auth tests and documentation together, keeping the screen inventory as one valid Markdown table and explicitly deferring whole-country delete, publication switch, and update-check actions |
| 7 | Initial detail styling referenced undefined typography tokens, so some headings/weights would silently fall back to browser defaults | Replace those references with the existing title/weight tokens; the theme and style tests now pass against the actual stylesheet |

Focused client/page/router tests cover Bearer headers and cookie omission, unbuffered byte piping, streams longer than the JSON timeout, expired-token handling, summary/active jobs, pagination, detail breadcrumbs, unsupported file-picker fallback, explicit confirmation, optimistic deletion/refresh, server conflict rollback, malformed UUIDs, route guards and the table-to-detail links. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, formatting, and **1,177 passed across 115 files; 284 skipped**. The PostgreSQL-dependent tests were skipped because this environment has no test database; Docker/operator tests were not run. The Vite production web build succeeds (419 modules; 495.75 kB JS, 139.19 kB CSS).

**Totals after this pass: 80 passes · 320 defects fixed · 0 open.**

## Pass 81 — 2026-10-28 (whole-country cache deletion needed typed, job-aware confirmation)

P2-WEB-05 adds whole-country deletion to the cached-country detail header. It uses the authenticated `DELETE /_admin/api/cache/:countryId` contract and, on `204`, returns to the cache list; the catalog country itself remains. The API’s existing cooperative-cancellation option is exposed only as a separate explicit choice.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | The country-delete API existed, but the admin detail screen offered no whole-cache deletion action | Add the destructive outlined action to the country-detail header, inside a dedicated confirmation dialog |
| 2 | A destructive request could be triggered without proving the administrator intended to remove this exact country | Require the case-sensitive API slug in a labelled text field; keep the final action disabled until it matches exactly |
| 3 | The endpoint rejects active jobs by default and permits cancellation only through `cancelJobs=true`, but the UI had no safe way to discover or opt into that policy | List queued/running jobs in the dialog, require a separate cancellation checkbox, explain the three-second cooperative-cleanup wait, and surface request-id conflicts; if a job appears after loading, offer the explicit cancellation choice after the `409` |
| 4 | A slow deletion response arriving after country navigation could redirect the reader away from the different country they had opened | Scope completion and redirect side effects to the initiating country/operation; a successful response navigates only when still on that country |
| 5 | The confirmation did not communicate the full deletion result or support keyboard dismissal/focus return | State that local versions and public access are removed while catalog identity remains; add an accessible alert dialog, Escape/focus restoration, progress and retryable errors |
| 6 | The destructive button hover filled with the error color, contrary to the design law requiring outlined destructive controls | Retain the error outline and use only a subtle tinted hover background |
| 7 | Eagerly importing the new detail screen pushed the initial production JS chunk past Vite’s 500 kB warning threshold | Lazy-load the UUID detail route; the initial entry chunk is now 481.21 kB, with the 21.83 kB detail chunk fetched only for S8 |

The cached-country page tests now cover exact/case-sensitive slug gating, Bearer-authenticated confirmation query, optional `cancelJobs=true`, active-job conflict/request-id handling, late-job cancellation opt-in, keyboard Escape and focus restoration, success navigation, and navigation during a pending deletion. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint and formatting; **1,181 passed across 115 files; 284 skipped**. PostgreSQL/Docker-gated tests remain skipped because this environment has no test database and per operator direction. The Vite production build succeeds without a chunk-size warning: 481.21 kB initial JS, 21.83 kB lazy detail JS, and 140.23 kB CSS.

**Totals after this pass: 81 passes · 327 defects fixed · 0 open.**

## Pass 82 — 2026-10-28 (job progress needed a persistent, cooperative UI)

P2-WEB-06 replaces the S11 placeholder with the authenticated Jobs screen and a progress drawer hosted by the admin shell. It adds URL-backed job filters and pagination, 2-second job detail polling, progress/speed/ETA, safe error details and cooperative cancellation. A queued Catalog download now opens the same tracked drawer and remains visible across route changes.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | S11 was a placeholder, leaving administrators without a searchable view of queued, running, failed, or completed jobs | Implement the Jobs table/cards with status/type filters, server pagination, retryable states, safe detail links, and query state in the URL |
| 2 | Job progress was only available from route-local state, so leaving the page could discard the active task and its progress | Keep tracked job IDs and detail snapshots in shell-level Pinia state; mount the drawer once in the persistent admin layout |
| 3 | Vuetify's temporary navigation drawer closes on route changes, contradicting the persistence requirement | Use a dialog-based, right-side progress panel that stays open across route navigation; exercise this in the mounted-router test |
| 4 | Polling had no fixed cadence or safe protection from overlapping/stale responses, and could continue after terminal completion | Poll detail every 2 seconds without overlapping requests, reject stale results, refresh list projections, and stop detail polling only at terminal status or unmount |
| 5 | A successful cancel response could be mistaken for completed cleanup, stopping progress while the worker still owns resources | Treat cancellation as a request; retain the live status and poll through cooperative worker cleanup until the terminal projection arrives |
| 6 | Rendering raw job failure text could expose exception or infrastructure details, while large byte counts and ETA were not safe/useful to present | Render only the shared safe error projection; format byte counts without JS precision loss, plus human-readable speed, ETA and phase/progress |
| 7 | Catalog enqueue returned a job id but did not connect it to persistent tracking, and the navigation badge had no data-backed active count | Track the accepted job in the shell drawer immediately and derive the Jobs indicator from queued/running list totals |
| 8 | The new stylesheet was absent from both literal-color token allowlists, and route/screen inventories still treated Jobs as a placeholder | Add the stylesheet to the token checks, update route and documentation expectations, and add page, drawer, cancellation, safe-error, presentation and Catalog enqueue-to-drawer coverage |
| 9 | A failed first detail request left a tracked job out of the drawer because the UI only rendered successfully loaded projections | Keep the tracked id visible with an accessible loading/retryable error card, including its safe message and request id; test recovery after retry |

Focused web tests pass (**16 tests across the Catalog, Jobs, and job-presentation specs**), including the accepted Catalog enqueue opening the persistent drawer. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, formatting, and **1,189 passed across 90 files; 284 skipped**. The skipped database-dependent tests and Docker/operator tests were not run, per operator direction. The production Vite web build succeeds with the Jobs screen split into a lazy-loaded chunk. Existing Vite config, Vuetify theme migration, and jsdom `scrollTo()` notices remain non-fatal.

**Totals after this pass: 82 passes · 336 defects fixed · 0 open.**

## Pass 78 — 2026-10-28 (the catalog needed source-version selection and a working download action)

P2-WEB-02 extends the catalog rows with an uncached-only download flow. It loads current Geofabrik offers through the authenticated API client, validates source and enqueue payloads with the shared contracts, and queues only the chosen `latest` or offered dated version.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | The catalog showed cache status but provided no path to start a download for an uncached region | Add a download action only to uncached table rows/cards; hide it for cached entries and disable it after a local queue acceptance |
| 2 | Choosing a source version from the row's stale catalog hints would not prove that a `latest` or dated snapshot is still offered | Fetch `/catalog/regions/:slug/snapshots` on picker open, validate the response, render current latest and dated offers with exact size/date, and post only a schema-valid selected version |
| 3 | Source outages and API failures could leave the user with a dead action or an unsafe blind retry | Show cached-only/outage guidance, disable unavailable choices, provide retryable list errors with request ids, and keep enqueue errors in the picker with support ids |
| 4 | A modal picker could lose keyboard focus or submit duplicate work without communicating its outcome | Trap focus, support Escape/close and focus restoration, prevent duplicate queue submissions, validate the accepted response, and announce the queued version/job id |

Web tests cover the hidden cached-row action, current snapshot size/date, authenticated snapshot and enqueue requests, selection of a dated version, success/disabled state, source outage, retry, API conflict and request-id presentation. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, package typechecks, ESLint, formatting, and **1,161 passed across 113 files; 283 Docker/operator-dependent tests skipped**. The Vite production web build succeeds. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 78 passes · 308 defects fixed · 0 open.**

## Pass 77 — 2026-10-28 (the admin catalog screen was still a placeholder)

P2-WEB-01 replaces the S6 placeholder with an authenticated, query-driven catalog page. Search reuses the global topbar field; local parent/cache filters, supported server sorting and pagination stay in the URL. The response is parsed against the shared contract, large byte counts remain exact through formatting, and the page provides a skeleton, retryable error and a clear-filter empty state. The table turns into labelled region cards below the documented breakpoint. The download action is left for its explicitly dependent task, P2-WEB-02.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | The catalog API was complete but its S6 route still rendered the generic placeholder | Register `CatalogPage.vue` at the existing admin route and assert that it is no longer marked as a placeholder |
| 2 | Search was submit-only and a direct bookmarked `?q=` value did not populate the shared topbar field | Restore the URL value into the field, debounce typing by 300 ms, and keep Enter as an immediate submit |
| 3 | Local filter/sort/page controls had no screen implementation or bookmarkable query state | Add exact parent-id and cache filters, allow-listed server sort keys, page navigation, and preserve the state in the router query |
| 4 | The missing screen had no truthful loading, error, empty, responsive layout, or safe numeric presentation | Add layout-matched skeletons, retryable errors with support request id, an actionable empty state, mobile cards, UTC labels and BigInt-based size formatting |

Component tests exercise the actual SPA route and API client, Bearer transport, deep-link search, filter/sort/page requests, large-byte formatting, desktop table/mobile card markup, loading, error/retry and empty/clear states. The first full check found two stale test assumptions: the mounted-admin theme test still expected the S6 placeholder, and the token-source allow-list did not include the new catalog stylesheet. Both were corrected; the focused regression tests pass. Final non-Docker `bun run check` passes: **22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, formatting, and 1,158 passed across 113 files; 283 Docker/operator-dependent tests skipped**. The Vite production web build also succeeds. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 77 passes · 304 defects fixed · 0 open.**

## Pass 76 — 2026-10-28 (admin job reads and cancellation needed API contracts)

P2-API-10 adds the authenticated jobs list, detail and cancel endpoints, with shared request/response schemas and PostgreSQL integration coverage. The route reuses the durable cancellation service rather than writing worker terminal state itself.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | The documented job list/detail/cancel paths had no handlers or strict shared contracts | Register all three under the global admin guard; add status/type filters, bounded paging, UUID validation, and explicit cancel acknowledgement/no-op outcomes |
| 2 | Returning arbitrary job JSON or persisted exception text could disclose internal payloads, worker ownership, or raw failures; PostgreSQL `bigint` progress can also exceed JavaScript's exact integer range | Select only response fields, project payload keys by job type, map errors to the safe `JOB_HANDLER_FAILED`/`WORKER_LOST` messages, and serialize large byte counts as decimal strings |
| 3 | A retrying queued row retains its last speed/progress, so applying that speed as an active ETA would mislead the UI | Derive ETA only for a running, non-canceling job and retain the existing 30-day bound; queued and terminal jobs report `null` |
| 4 | The worker progress type included `fetching_index`, but the shared enum and data-model progress list omitted it | Add the phase to the shared `JOB_PHASES` tuple and data-model contract, then derive the worker progress type from that source |

PostgreSQL tests cover newest-first ordering, status/type filtering, pagination and clamping, strict validation/auth/404s, precision-safe progress, active versus queued ETA, safe payload/error projection, queued immediate cancellation, durable running cancellation without stealing the worker lock, idempotent canceled requests and terminal no-op behavior. The focused jobs-schema/route/security-transport run passes **21 tests across 4 files**. Full non-Docker `bun run check` passes: **22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, formatting, and 1,435 tests across 112 files, 0 skipped**. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 76 passes · 300 defects fixed · 0 open.**

## Pass 75 — 2026-10-28 (admin map-version downloads needed a locked stream)

P2-API-09 implements the authenticated version download route with Range/ETag/HEAD support, safe cache storage reads,
admin-channel event logging, and the shared country stream lock. Migration `0003_download_events.sql` brings the event
store into the live schema and Kysely model.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | The documented admin download URL had no handler, so administrators could list and delete cached versions but not retrieve one | Add the authenticated stream route with public-compatible representation headers, single byte ranges, conditional requests, `HEAD`, and `410 VERSION_FILE_MISSING` |
| 2 | The contract required `channel=admin` transfer records, but `download_events` existed only in the data-model document and had no migration or typed table | Add `0003_download_events.sql` and `DownloadEvents`; record completed and interrupted admin streams with bytes sent, user agent, and only a salted IP hash; do not record `HEAD` or `304` |
| 3 | Reusing the public stream's `Cache-Control: public` policy on an admin route could place unpublished maps in a shared cache | Admin streams use `Cache-Control: private, no-store` while retaining representation, Range, and validator headers |
| 4 | The first-transfer salt initializer sent an unquoted hex string to PostgreSQL `jsonb`, and the route transport sweep still expected the new authenticated path to be a `503` stub | JSON-encode the persisted salt, verify that an unavailable client address leaves only `ip_hash` null, and classify the new authenticated route's template-path response as `400` validation |

PostgreSQL integration tests verify authenticated delivery, headers, Range bytes, ETag/HEAD, missing-file 410, salted event metadata, aborted-transfer event logging, and that a real slow client holds the shared lock until it closes before cache deletion can unlink the file. Targeted route/migration/security transport tests pass **30 tests across 3 files**. The first full check exposed the missing route-matrix expectation; it was corrected and the final non-Docker `bun run check` passes: **22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, formatting, and 1,427 tests across 110 files, 0 skipped**. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 75 passes · 296 defects fixed · 0 open.**

## Pass 74 — 2026-10-28 (safe unlink needed to report an ancestor-symlink skip)

Adversarial review found that `StorageFile.remove()` deliberately unlinks an unexpected parent symlink and returns normally without reaching the requested version leaf. A committed delete therefore returned `204` without recording the leftover external target for orphan cleanup.

| # | Bug found in review | Fix |
|---|---|---|
| 1 | Safe storage cleanup could remove an ancestor symlink but silently report success, so admin cache deletions and canceled/failed downloads did not report the unreachable leaf or possible orphan | `remove()` now returns `false` for that case; both cache-delete routes warn and retain the committed `204`, while the download worker warns on incomplete or failed best-effort cleanup and continues the job lifecycle without following symlinks |

The PostgreSQL route regression verifies the ancestor link is removed, the external target is untouched, and the incomplete cleanup warning is emitted. Storage path tests pin the `false` result for both country- and version-directory symlinks. A new PostgreSQL download-worker regression verifies a pre-canceled job removes the ancestor link, leaves the external target untouched, and logs the orphan path; the focused worker suite passes **9 tests**. A mutation that ignored `remove()`'s `false` result was rejected by this regression. The targeted route/storage/credential suite passes: **51 tests across 3 files**. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, formatting, and **1,420 tests across 109 files, 0 skipped**. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 74 passes · 292 defects fixed · 0 open.**

## Pass 72 — 2026-10-28 (cache version reads and pinned downloads needed a strict admin contract)

P2-API-07 implements a paginated stored-version list and a specific dated Geofabrik snapshot admission route. The list explicitly includes ready, pending, and failed rows, while pinned downloads share the source, cache, disk, and queue admission path with the existing generic download endpoint.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | Both documented `/_admin/api/cache/:countryId/versions` endpoints were absent, so version history and pinned admission had no implementation | Register authenticated GET/POST handlers with the required `200`/`202`, validation, not-found, gone, and admission error outcomes |
| 2 | “Same item shape as above” referenced cache detail's `status: ready`, while the existing version repository lists pending/failed rows too; the list projection was ambiguous | Explicitly return all stored states; ready rows sort newest-ready first, pending/failed rows newest-created first, with a strict status union and no storage/failure internals |
| 3 | `listMapVersions` materializes every version and includes internal columns, which is unsuitable for a paginated endpoint and risks accidental data exposure | Add a SQL-limited safe projection plus count; read cache existence, page, and count in one repeatable-read transaction |
| 4 | The version query, item/response, and pinned-date body had no shared strict schemas, leaving unknown query/body keys, `latest`, and large byte counts unpinned | Add exported Zod contracts; accept only six-digit dates on the pinned endpoint and serialize int8 bytes exactly as number-or-decimal-string |
| 5 | Copying the generic download route's source/cache/disk/enqueue logic into the dated route would let two admission paths drift | Factor one admission routine used by both routes; it verifies the source still offers the snapshot, checks cached identity, creates/preflights the cache root, and enqueues with admin attribution |
| 6 | The security sweep still expected every newly added route to be a `503` stub, and no PostgreSQL tests covered statuses, paging, private fields, offered/gone dates, or auth on these paths | Update the credential-transport assertions and add real-PostgreSQL/source-fixture route tests for paging/order, JSON precision, status projection, no leakage, validation, 404/410/409/502/202, and job attribution |
| 7 | Pass 71's footer said 275 defects although its eight review findings raised the correct preceding total of 268 to 276 | Correct the historical footer and keep the changelog's per-pass sum, header total, and latest pass footer aligned |

Three targeted mutation probes were killed: dropping `NULLS LAST` moved pending/failed rows ahead of ready rows; coercing int8 size to `Number` made the strict response fail on an unsafe integer; and bypassing the cached-country guard changed the documented uncached `404` into a `500`. Targeted cache-download and credential-transport suites passed **17 tests**. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint and formatting; **1,410 passed across 109 files, 0 skipped** with local PostgreSQL 16.2. No Docker runtime/operator tests were run. **Totals after this pass: 72 passes · 283 defects fixed · 0 open.**

## Pass 71 — 2026-10-28 (cache removal needed cooperative cleanup and enqueue-safe file deletion)

P2-API-06 adds typed, authenticated cache removal while retaining the catalog country. Version/cache rows and `cache.delete_country` audit commit together; safe storage unlink happens afterward, with orphan logging on failure. Existing workers must finish cooperative cancellation before data/files are removed, and per-country advisory locks serialize download admission, active file streams, and post-commit unlink.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | The documented cache-delete endpoint was absent, so admins could not clear cached bytes or revoke their public listing | Add strict shared query/body contracts, register authenticated `DELETE /_admin/api/cache/:countryId`, preserve the catalog row, and return the documented 204/400/404/409 outcomes |
| 2 | The required typed slug confirmation and `cancelJobs` behavior were not represented as enforceable request/response contracts | Validate exact slug confirmation; refuse active jobs by default; on explicit cancellation, request cooperative stop and wait up to 3 seconds for cleanup before retrying the transactional delete |
| 3 | Removing rows, writing the audit, and removing files could not safely share one transaction; a filesystem error after commit must not falsely report the delete as failed | Delete version/cache rows and write audit atomically, then safe-unlink validated storage paths; log orphan paths and retain `204` after committed deletion |
| 4 | The original delete sequence could unlink a version after another API process had enqueued a download for that country | Share a country advisory-lock namespace across a delete-side session lock held through unlink and transaction-scoped download admission; also key-share lock the country before enqueue |
| 5 | The API prose referenced interval memberships although the current P2 schema has no interval tables | Record the limitation explicitly in API/flow docs and make P4-INT-01 responsible for integrating membership cleanup when those tables exist; issue no SQL against absent tables |
| 6 | The all-admin credential transport sweep still expected the new route to be a `503 NOT_READY` stub | Expect authenticated request validation (`400`) on `DELETE /_admin/api/cache/:countryId`, while preserving rejection of misplaced credentials |
| 7 | CACHE-5 also forbids deleting files used by active HTTP transfers, but admin/public stream routes are scheduled for later tasks | Require P2-API-09 and P3-API-05 streams to hold a shared lock on the same per-country advisory key for the full response lifetime; the delete-side exclusive lock will wait before unlinking |
| 8 | File cleanup and cancellation boundaries lacked PostgreSQL integration coverage for orphan, timeout, and cross-process lock behavior | Add real-PostgreSQL tests for typed confirmation, audit/row/file outcomes, active and queued jobs, running cleanup timeout, unlink failure, active-stream/delete contention, and enqueue/delete contention |

Three targeted mutation probes were killed: omitting download enqueue's advisory lock let the enqueue proceed while the delete-side session lock was held; propagating a file-unlink error changed the expected `204` to `500`; and omitting the delete-side exclusive lock removed a file while a simulated active stream held its shared lock. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint and formatting; **1,397 passed across 109 files, 7 skipped** with local PostgreSQL 16.2. The seven skipped cases are the existing server-absent DB probes, intentionally disabled while the local server is available. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 71 passes · 276 defects fixed · 0 open.**

## Pass 70 — 2026-10-28 (cache reads needed cached-only lists and live detail state)

P2-API-05 adds the authenticated cache list/detail reads, backed by the existing catalog/cache repositories. Both reads use repeatable-read snapshots and explicit shared Zod contracts; the list is SQL-filtered and paginated, and detail includes ready versions and country-scoped active jobs.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | Both documented cache GET routes were absent, leaving the admin cache screen without a read API | Register authenticated list/detail handlers under `/_admin/api/cache` and `/:countryId`; return the documented projections and `NOT_FOUND`/validation envelopes |
| 2 | Cache list/detail had no strict shared schemas or query contract, so row shape, pagination, and large PostgreSQL `int8` values could drift or lose precision | Add shared Zod query/response schemas, strict unknown-key rejection, catalog-consistent filters and paging, and exact integer/string serialization |
| 3 | Detail acceptance required current update state and active jobs, but the response needed a consistent country-scoped view and could otherwise expose terminal or unrelated jobs | Read cache, ready versions and queued/running country jobs in one repeatable-read transaction; tests pin update state, progress, state filtering and country scoping |
| 4 | The detail example promised per-version download counts before `download_events` is introduced by P3-API-06 | Remove the unsupported count from the response contract and explicitly defer it rather than fabricate a value |
| 5 | The Bearer-transport sweep still classified cache reads as `503 NOT_READY`, so a valid token against an implemented route made the full security suite fail | Expect `200` for the cache list and route-validation `400` for a template detail UUID, while retaining `401` for every misplaced credential |

Real-PostgreSQL route tests cover cached-only list behavior, ISO/name filtering, update filtering, paging, timestamps, source-download selection, exact `bigint` encoding, strict query and UUID validation, auth, uncached/unknown 404s, ready versions, update state, active-job scope/status/progress and totals. Four mutation probes were killed: dropping the cached-only restriction; counting uploads or non-ready versions (even one with `ready_at`) as source downloads; and including another country's active jobs. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, typechecking, ESLint and formatting; **1,387 passed across 108 files, 7 skipped** with the local PostgreSQL 16.2 test database. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 70 passes · 268 defects fixed · 0 open.**

## Pass 69 — 2026-10-28 (cache download admission needed source, disk, and queue orchestration)

P2-API-04 adds authenticated `POST /_admin/api/cache/downloads` for `latest` or an explicit Geofabrik date, returning a durable job identity only after source and disk admission checks. It also composes and registers the concrete source-backed download worker.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | The documented download endpoint had no route, strict request/response schema, or admin registration | Add shared Zod schemas, protect and register the route under `/_admin/api/cache/downloads`, validate country and version, and return the documented `202` response |
| 2 | The worker factory was not wired in production, and the existing Geofabrik page adapter could not resolve PBF metadata | Compose index/page/HEAD clients into a concrete `MapSource`; distinguish deleted dated snapshots from upstream failures, carry cancellation into page requests, and register the download worker beside catalog sync |
| 3 | Download admission primitives existed separately, but the route needed a safe sequence and documented error mapping | Perform source resolution, reserve-aware `ceil(size × 1.1)` disk preflight, then call the existing single-insert enqueue helper; only PostgreSQL's named active-download index maps to `JOB_ALREADY_RUNNING` |
| 4 | A ready explicit version was checked only after source resolution, so a source outage returned 502 for a file already cached locally | Check stable dated labels before the network call; an offline probe reproduced 502 before the fix and the PostgreSQL route test now requires 409 `VERSION_ALREADY_CACHED` |
| 5 | The credential-transport sweep assumed every unimplemented admin route returned `503 NOT_READY` | Teach it that the new authenticated route reaches request validation (`400`) with a valid Bearer token, while misplaced credentials remain `401` |

PostgreSQL route tests cover latest/date acceptance and job attribution, ready-cache detection (including latest identity), active-index conflict, missing/deleted source versions, upstream outage, disk-full details and enqueue ordering, auth, and validation. Shared-schema tests cover strictness and response identity. An intentional preflight-bypass mutation was killed by the disk-full route test (`202` instead of `503`); the explicit cached-version outage regression was observed failing before and passing after the fix. Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint and formatting; **1,382 passed / 7 skipped across 107 test files** with the local PostgreSQL 16.2 database. Docker tests remain excluded at the operator's request.

**Totals after this pass: 69 passes · 263 defects fixed · 0 open.**

## Pass 68 — 2026-10-28 (catalog region reads needed local identity, bounded source data, and cached fallback)

P2-API-03 implements the two authenticated region catalog reads. The detail route resolves the local slug, constructs a root-first parent chain, and returns source facts plus ready local versions. Snapshot reads use bounded, path-safe Geofabrik region-page HTTP and degrade to cached Geofabrik versions when upstream is unavailable.

| # | Bug found in contract/code review | Fix |
|---|---|---|
| 1 | The region detail and snapshot routes were still unimplemented, despite the documented source parser and route contracts | Add the authenticated handlers and strict shared-Zod request/response contracts; use the local URL slug to load source identity from PostgreSQL |
| 2 | Region parsing had no production HTTP adapter, so page requests lacked a timeout, body-size bound, and safe handling of source IDs as URL paths | Add a 10-second/2-MiB bounded client (with strict configurable caps), encode validated path components under the configured base URL, and reject redirects |
| 3 | A source outage would otherwise make the version picker unusable, even when usable files were already cached | Return `200` with `sourceReachable:false`, `latest:null`, and only ready cached Geofabrik versions; detail still includes local identity and cache data |
| 4 | The recursive ancestor query returned PostgreSQL `source_id`, while the shared response schema requires `sourceId`; the first real route probe returned `400` for a valid region | Explicitly project database names to the API contract; cycle guard uses `array_position` and the route test pins the root-first parent chain |
| 5 | PostgreSQL sorts nulls first for `DESC`, which placed date-less uploads ahead of real cached snapshots | Order nullable data/ready timestamps with explicit `NULLS LAST`; a route fixture includes an upload and dated rows |
| 6 | A malformed persisted MD5 could fail the strict response schema and turn otherwise valid region/cache data into an error | Normalize valid case-insensitive MD5 digests and expose malformed values as `null`; the PostgreSQL fixture probes malformed MD5 on cached records |
| 7 | The docs claimed `422` for malformed slugs even though the shared error law maps Zod validation to `400`; the snapshot sample also used an invalid ellipsis for an MD5 digest | Correct the status and example digest; update the credential-transport sweep to expect the new live route's validation response instead of `503 NOT_READY` |
| 8 | Unreachable-source behavior was underspecified about `data`/`latest`, so a client could accidentally offer uploads or cached versions as current upstream offers | Pin outage fallback semantics in API/flow/task docs and return only the documented source-cache subset |

Real PostgreSQL route tests cover local-slug resolution, parent/ISO/PBF projection, ready cached versions, current source snapshots, 400/404 validation paths, unreachable-source detail and snapshot behavior, uploaded-version exclusion, and malformed cached checksums. Offline source-client tests cover URL construction/traversal, bounds, upstream status, and timeout. Two targeted mutations were killed: forcing `sourceReachable:true` during a 503 outage, and including uploads in the outage fallback. The first live route probe also caught the snake/camel parent-row mismatch; the cached ordering probe showed null-first order before `NULLS LAST` was added.

Full non-Docker `bun run check` passes: 22 workspace checks, 54 hygiene checks, package typechecks, ESLint, formatting, and **1,373 passed / 7 skipped across 105 test files** with the local PostgreSQL 16.2 test database. The seven skips are the server-absent cases intentionally disabled while the database is available. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 68 passes · 258 defects fixed · 0 open.**

## Pass 67 — 2026-10-28 (catalog sync needed an authenticated, idempotent queue trigger)

P2-API-02 implements `POST /_admin/api/catalog/sync` and `bun run sync:catalog`, both using the same durable enqueue helper. The API returns `202 { jobId }`, records the verified admin on `jobs.created_by`, and reuses queued/running jobs. The production worker registers `createCatalogSyncHandler` with the configured Geofabrik index source; the CLI enqueues but never calls the source itself.

| # | Bug found in contract review | Fix |
|---|---|---|
| 1 | The catalog sync API was not registered, and the request/response contract did not have strict shared schemas | Add the authenticated `POST` route, accept only an empty object, and validate the `202 { jobId }` response with shared Zod contracts |
| 2 | Separate manual triggers could create duplicate active work across API instances or the CLI | Route and CLI share one transaction-scoped PostgreSQL advisory-lock enqueue operation; it returns an existing queued/running job or inserts one queued job |
| 3 | The admin guard discarded the verified identity, preventing the route from attributing the job | Retain the verified `AdminIdentity` on the request and set `jobs.created_by`; prove attribution against PostgreSQL |
| 4 | Worker startup still registered an empty handler map, and no code connected the configured Geofabrik base URL to the catalog handler | Register `createCatalogSyncHandler` using a narrow source adapter that fetches the configured index and forwards cancellation |
| 5 | The documented CLI trigger was still planned and could have bypassed the durable queue | Add `sync:catalog`; it calls the same enqueue helper, handles help/config/database errors, and closes its pool |
| 6 | Route-table credential tests still expected `503 NOT_READY` for the new endpoint, while task, usage, flow, and project-tree docs omitted its finished behavior | Update the transport test and endpoint/job/CLI documentation, including active-job reuse and worker-disabled behavior |

An initial removal-of-lock probe passed the simultaneous-request test once, showing that the race-only assertion was scheduler-dependent. Added a deterministic PostgreSQL lock-wait test: it holds the enqueue advisory lock from a separate database session and verifies that the route waits. Removing the lock then failed that test (no advisory waiter observed); restoring it passed. The route integration suite also checks anonymous refusal, actor attribution, eight concurrent callers sharing one id, running-job reuse, terminal-job replacement, and strict-body rejection. CLI tests cover arguments/help, invalid config without connecting, two invocations reusing one job, and the CLI's null actor. The configured index-source factory and cancellation propagation are covered offline; Docker tests were not run per operator direction.

Full non-Docker `bun run check`: 22 workspace checks, 54 hygiene checks, typechecks, ESLint and formatting; **1,373 passed across 103 files, 0 skipped** with the local PostgreSQL 16.2 test database. The CLI package command was also exercised with `bun run sync:catalog --help`. Docker runtime/operator tests remain excluded per operator direction.

**Totals after this pass: 67 passes · 250 defects fixed · 0 open.**

## Pass 64 — 2026-10-27 (active download uniqueness needed a conflict boundary)

P2-JOB-07 closes the gap between the existing PostgreSQL partial unique index and the documented duplicate-download response.

| # | Bug | Fix |
|---|---|---|
| 1 | **The database rejected a second active download, but there was no safe enqueue operation to translate that exact rejection into the documented `JOB_ALREADY_RUNNING` / 409.** A check-then-insert would still race between API processes, while letting the raw PostgreSQL error escape would become an internal error | Add `modules/jobs/enqueue-download.ts`: make one insert and translate only SQLSTATE `23505` on `jobs_one_active_download` to the safe public `AppError`; preserve all other database failures. The PostgreSQL index remains the concurrency authority |

Four new real-PostgreSQL integration tests cover duplicate queued and running jobs, 409 envelope mapping, simultaneous requests on separate pooled connections, distinct key acceptance, terminal-state key reuse, and preservation of an unrelated foreign-key error. Two mutations were killed: changing the mapped constraint name breaks duplicate-to-409 coverage; narrowing the database predicate to `queued` permits a second request after the first job enters `running`, which the integration test rejects. At this pass, `P2-API-04` still owned HTTP route wiring and end-to-end route coverage; that task completed in pass 69.

Full non-Docker `bun run check`: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint and formatting; **1,335 passed across 98 files, 7 skipped**. Docker runtime/operator tests remain excluded per operator direction. **Totals after this pass: 64 passes · 231 defects fixed · 0 open.**

---

## Pass 63 — 2026-10-27 (cache paths and unlinking needed no-symlink review)

P2-JOB-06 centralizes cache filesystem access behind validated path references. Adversarial review checked attacker-controlled path components, persisted `storage_path` parsing, symlinked parent/leaf entries, atomic installation, deletion behavior, readiness probing, and the JOB-05 streaming integration.

| # | Bug | Fix |
|---|---|---|
| 1 | **Cache operations could traverse a symlinked parent under `CACHE_DIR`.** A planted `.partial` or country/version directory link could redirect download reads, writes, install, or cleanup outside the cache root | Walk each parent with `lstat` + canonical-path checks before access, reject symlink traversal, and open the leaf with `O_NOFOLLOW`. Cleanup unlinks only the first link component or named file, never its target. Tests preserve outside sentinel bytes for `.partial`, country, and version paths |
| 2 | **The readiness probe followed a leaf `.readyz` symlink and could truncate its target.** Its direct `writeFile` bypassed the cache path policy | Move the probe write/remove into the storage module and use the same no-follow open and safe unlink; the symlink probe confirms outside bytes stay unchanged and the link is removed |
| 3 | **A generic storage file reference initially allowed direct truncate/append access to an installed version.** A future consumer could bypass the atomic part-install contract | Make final version references read-only; writes go through a private part and validated atomic install. Tests reject `write` and `append` while preserving installed bytes |

The download handler and readiness probe now use the storage boundary; relative DB storage paths must contain exactly the validated `<slug>/<version>/<filename>` shape. Twenty-six storage tests cover path traversal, malformed stored paths, symlinked parents/leaves, atomic install, outside-target preservation, safe unlink, readiness, and read-only final files. All nine P2-JOB-05 PostgreSQL worker tests and all 14 readiness-probe tests pass with the new storage API. Two adversarial mutations—disabling component validation and disabling symlink-parent checks—were rejected by the focused tests. Full non-Docker `bun run check`: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint and formatting; **1,331 passed across 97 files, 7 skipped**. Docker runtime/operator tests remain excluded per operator direction. **Totals after this pass: 63 passes · 230 defects fixed · 0 open.**

---

## Pass 62 — 2026-10-27 (download streaming, resume, identity, and cleanup needed adversarial review)

P2-JOB-05 implements a worker download handler backed by a bounded-memory streaming helper. Review exercised the real PostgreSQL worker and filesystem against source-byte identity, resume protocol, MD5 mismatch, cancellation, disk-write failure, version-row lifecycle, and the `P2-JOB-05`/`P2-JOB-06` boundary.

| # | Bug | Fix |
|---|---|---|
| 1 | **The documented `latest@<RFC3339>` identifier could not pass the shipped `mv_version_fmt` check.** RFC3339 time colons are excluded by the database constraint, so a latest download would fail at insert time | Encode timestamp colons as hyphens (`latest@2026-10-23T20-20-51Z`) and update the data-model/ADR examples. A real PostgreSQL worker test proves the label inserts and reaches `ready` |
| 2 | **A resumable `latest` alias could combine bytes from different upstream generations.** Weak ETags are not valid `If-Range` validators, and no validator is unsafe for a mutable URL | Resume `latest` only with a strong ETag or Last-Modified; otherwise discard the local prefix and fetch from byte zero. The latest-worker test begins with a partial file and weak ETag, then proves no Range header is sent |
| 3 | **A `206` body could be appended without proving its `Content-Range` starts at the local offset.** A malformed response could poison the part file, and rejecting it without canceling the response would retain the upstream stream | Validate the start, end and known total before opening the part for append; cancel an invalid response body. The PostgreSQL test fails when the offset comparison is mutated and asserts the body was canceled and the prefix unchanged |
| 4 | **Cancellation during country/source/checksum resolution happened before the transfer cleanup scope.** A retry's `.part` and `map_versions.pending` row could survive while the worker recorded `canceled` | Add outer cancellation cleanup that removes the job part and marks any owned pending version failed before returning. Pass the worker signal through source resolution and bounded sidecar requests; a pre-canceled job test proves both filesystem and row cleanup |
| 5 | **Bounded metadata fetches could not promptly honor caller cancellation when injected/native fetch was still pending.** Linking the signal to `fetch` alone did not settle a fetch implementation that ignored it | Race caller abort with the request/deadline and abort the active response reader; a 30-second request budget now rejects promptly on the caller's signal |
| 6 | **A failed first download left a `map_versions` row without the `country_cache` row required by the documented iff invariant.** The cache summary was only created after a successful transfer | Create the country-cache row in the same transaction as the first pending version; completion recomputes ready count/size transactionally. A real-PostgreSQL checksum-failure test verifies the failed version remains and the summary is zero |

Nine real-PostgreSQL worker tests cover byte-identical install + sidecar MD5, Range resume, Range-ignored restart, malformed range cancellation, latest identity/weak-validator fallback, checksum mismatch cleanup, running cancellation, pre-canceled cleanup, and simulated writer `ENOSPC`. Twelve offline source-metadata tests include prompt caller abort. Three mutations were attempted and all were killed: Range offset validation, MD5 comparison, and pre-canceled part cleanup. The handler keeps only the path operations needed for JOB-05; `P2-JOB-06` remains open to centralize storage paths and complete unlink/symlink safety. Production `server.ts` registration was assigned to `P2-API-04` (completed in pass 69), which composes the concrete source adapter; the broader P2-TST fixture-server task remains open.

Full `bun run check`: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint and formatting; **1,312 passed across 96 files** against PostgreSQL 16.2. Docker runtime/operator testing was not run, per operator direction. **Totals after this pass: 62 passes · 227 defects · 0 open.**

---

## Pass 61 — 2026-10-27 (disk preflight needed capacity, boundary and dependency review)

P2-JOB-04 adds a cache-filesystem preflight using the configured reserve and source length. Review checked which `statfs` counter applies to the API process, the exact-fit boundary, large byte values crossing JSON's safe-integer limit, and whether the consuming download tasks actually depend on the helper.

| # | Bug | Fix |
|---|---|---|
| 1 | **Using `bfree` would count root-reserved blocks as usable by the API.** That can approve a download that an unprivileged service cannot fit | Read `bavail` in bigint mode and test different `bavail`/`bfree` values; changing the implementation to `bfree` fails with `69,632` instead of `28,672` available bytes |
| 2 | **An off-by-one reserve comparison could reject a safe exact fit.** `available === padded download + reserve` is sufficient and must not return `DISK_FULL` | Define the comparison as `shortfall > 0`; the exact-fit PostgreSQL-independent test fails when mutated to `>= 0` |
| 3 | **Large bigint byte details cannot safely be emitted as JSON numbers.** `Number()` silently rounds required/free byte values above `Number.MAX_SAFE_INTEGER` | Preserve ordinary values as numbers and serialize larger values as decimal strings; a mutation to unconditional `Number()` fails the high-range test |
| 4 | **The task graph let download creation proceed without depending on disk preflight.** `P2-API-04` and the download handler could be scheduled without `P2-JOB-04` | Add `P2-JOB-04` to the dependencies for both `P2-JOB-05` and `P2-API-04`; architecture, flow, and development docs specify the same inequality |

The preflight requires `ceil(content-length × 1.1) + DISK_RESERVE_BYTES`, reports `requiredBytes`, `freeBytes`, `reserveBytes`, and `shortfallBytes`, and preserves the reserve when content length is unknown. Eight disk-specific unit tests cover the 10% rounding, exact fit, `503 DISK_FULL` envelope, unknown-size reserve, invalid inputs, unsafe JSON integers, root-reserved blocks, and a real temporary filesystem's bigint `statfs` result. The helper does not create or modify files.

Full `bun run check`: 22 workspace checks, 54 hygiene checks, all typechecks, lint and formatting; **1,302 passed across 95 files** with the PostgreSQL-backed suite online (PostgreSQL 16.2). Docker runtime/operator testing was not run, per operator direction. **Totals after this pass: 61 passes · 221 defects · 0 open.**

---

## Pass 60 — 2026-10-27 (job progress and cancellation needed edge-case and timing review)

P2-JOB-03 wires cancellation and progress into the P2-JOB-01 worker. Review focused on first-write arithmetic, PostgreSQL bigint limits, races around an already-canceled handler, monotonic SQL persistence, and whether cleanup completes before the terminal state.

| # | Bug | Fix |
|---|---|---|
| 1 | **The first progress write could throw before reaching PostgreSQL.** `lastWriteAt = -Infinity` made elapsed time infinite, and converting it to `BigInt` raised `RangeError` | Give the first report a finite one-interval baseline. A real-PostgreSQL probe with the original `-Infinity` mutation failed with `BigInt(Infinity)`; the restored code passes |
| 2 | **Progress speed used a wall clock.** `Date.now()` can jump when system time changes, yielding a bogus speed or near-zero elapsed interval | Use monotonic `performance.now()`, floor elapsed milliseconds, and reject non-finite injected clock values |
| 3 | **The progress monotonicity test asserted only the final value.** A later larger report could mask a stale lower write, so a direct-assignment SQL mutation initially survived | Assert the row immediately after a lower stale report and prove throttled updates remain buffered. Mutation to direct assignment fails (`60` observed instead of `100`); production SQL retains `greatest(progress_bytes, candidate)` |
| 4 | **Progress values outside PostgreSQL `bigint` could cause a database write failure.** JavaScript `bigint` itself has no signed-64-bit limit | Reject byte totals beyond PostgreSQL's signed range before SQL and clamp derived speed to the column range; cover the rejected boundary in a unit test |
| 5 | **A worker skipped its registered handler when cancellation was already set at entry.** A retry with an existing `.part` could therefore become canceled without giving its handler a cleanup opportunity | Always invoke the registered handler with an already-aborted signal; the handler contract requires checking on entry and cleaning before return. A pre-aborted `.part` test fails under the old skip behavior |

Running cancellation persists a durable request, polls every 250 ms, aborts the owner handler, and leaves the row `running` until the handler has removed its temporary file and returned. PostgreSQL integration tests cover queued cancellation, a running cancellation held at a cleanup gate, already-aborted cleanup, progress monotonicity/throttling, and the ETA bounds. Mutating the cancellation poll to ignore the durable flag fails the ≤2 s regression. ETA is computed with integer arithmetic and is unknown when inputs are unsafe or the estimate exceeds 30 days.

Full `bun run check`: 22 workspace checks, 54 hygiene checks, all typechecks, lint and formatting; **1,294 passed across 94 files** against PostgreSQL 16.2. Docker runtime/operator testing was not run, per operator direction. The real Geofabrik download handler remains P2-JOB-05; this pass proves the generic cooperative contract with a test handler. **Totals after this pass: 60 passes · 217 defects · 0 open.**

---

## Pass 59 — 2026-10-27 (job recovery timing and retry persistence needed real-PostgreSQL review)

P2-JOB-02 adds session-level job ownership, independent heartbeats, stale-job recovery, and bounded retry/backoff. The review checked both task acceptance and the actual SQL against PostgreSQL 16.2.

| # | Bug | Fix |
|---|---|---|
| 1 | **The documented five-minute stale threshold plus a periodic scan could exceed the task's five-minute recovery acceptance.** A five-minute threshold followed by a 15-second scan can take 5:15 before the reaper even starts recovery | Scan every 15 seconds, consider `locked_at` stale after 4:30, and keep a 15-second processing margin; validate that stale age plus cadence never exceeds five minutes. Architecture, flow, and development docs now agree |
| 2 | **A retry update supplied a PostgreSQL `interval` where `jobs.run_after` requires `timestamptz`.** The real-PostgreSQL recovery test failed with `column "run_after" is of type timestamp with time zone but expression is of type interval` | Use a typed `CASE` expression (`now() + delay * interval` for retry, existing timestamp otherwise). Recovery and handler-retry integration tests now verify queued backoff and terminal exhaustion |

Adversarial tests hold a live worker lock while the row timestamp is forced stale, verify the reaper leaves it running, and mutation-check that removing the lock guard makes the regression fail. A separate retry mutation removing the scheduled delay also fails its test. Heartbeat freshness, one-connection-pool handler use, dead-worker requeue, `WORKER_LOST`, and max-attempt failure all pass against PostgreSQL 16.2. Full `bun run check`: 22 workspace checks, 54 hygiene checks, all typechecks, lint and formatting; **1,278 passed, 7 skipped across 92 files**. Docker runtime/operator testing was not run, per operator direction; standard static configuration tests remained in the repository check. **Totals after this pass: 59 passes · 212 defects · 0 open.**

---

## Pass 58 — 2026-10-27 (worker concurrency accepted an unbounded loop count)

A configuration probe passed `WORKER_CONCURRENCY=999999999` through the environment schema. The worker then uses that value to allocate an independent polling loop per slot, so a typo could exhaust memory and overwhelm PostgreSQL before the API begins listening.

| # | Bug | Fix |
|---|---|---|
| 1 | **Worker concurrency had no practical upper bound.** Before the fix, `parseEnv` returned `999999999` as valid; `startJobWorker` would attempt to create that many asynchronous loops | Set a shared hard limit of 32, enforce it in both the environment schema and the worker entry point, and document the 1–32 range. Regression tests accept 32 and reject 33 and the previously accepted billion-scale value; a direct worker test proves it rejects before allocating slots |

The focused environment and worker suites pass (48 tests), and a post-fix parse probe rejects the formerly accepted value with the documented error. **Totals after this pass: 58 passes · 210 defects · 0 open.**

---

## Pass 57 — 2026-10-27 (job claiming and shutdown needed concurrency safeguards)

The P2-JOB-01 review challenged two independent PostgreSQL-backed workers, a higher-priority candidate locked by another transaction, and the order in which active workers drain relative to pool closure.

| # | Bug | Fix |
|---|---|---|
| 1 | **A claim query without `SKIP LOCKED` can hand the same row to two workers.** Mutation-checking removed the clause against real PostgreSQL: the overlapping workers re-ran some handlers and incremented those jobs' attempts twice. It also blocked a worker behind a locked highest-priority row instead of moving to the next eligible job | Claim each candidate with `FOR UPDATE SKIP LOCKED` inside the same `UPDATE … RETURNING` statement. Real-Postgres regressions prove a locked row is skipped and two independent workers process 24 queued jobs exactly once; removing the clause makes the suite fail |
| 2 | **The graceful shutdown path had no worker-drain stage before closing the API and its database pool.** The reversed-order mutation closed the app first, then ran the worker-stop callback; the new shutdown regression fails on that order | `createShutdown` now awaits `beforeClose` before `app.close()`, and the server uses it to stop claiming and drain active handlers before the database closes. The shutdown-order regression fails when the two calls are reversed |

The queue suite passes four PostgreSQL tests, including safe failure persistence, and the shutdown suite proves active worker draining precedes closing the pool. Both invariants are mutation-checked. **Totals after this pass: 57 passes · 209 defects · 0 open.**

---

## Pass 56 — 2026-10-27 (optional accent fallback poisoned a caller-owned transaction)

A follow-up adversarial probe ran catalog search inside the repository's documented transaction boundary, with the optional `unaccent` extension absent.

| # | Bug | Fix |
|---|---|---|
| 1 | **The missing-extension fallback retried after PostgreSQL had already aborted the enclosing transaction.** The real-Postgres probe dropped `unaccent`, called `listCatalogCountries` inside `withTransaction`, and received `25P02 current transaction is aborted` instead of a usable search result | Check `to_regprocedure('unaccent(text)')` first; it returns availability without raising an error. Build the accent-folding predicate only when the function exists. The regression now passes with `unaccent` absent and the transaction commits |

The focused repository suite passes all five PostgreSQL tests with the extension available, and the transaction-specific regression also passes after dropping it. **Totals after this pass: 56 passes · 207 defects · 0 open.**

---

## Pass 55 — 2026-10-27 (cache sorting and accent search exposed two database-query gaps)

P2-DB-02 adds typed catalog, cache and version repositories. Catalog search, cache/update/continent filters, counts, pagination and whitelisted ordering execute in PostgreSQL; source upserts preserve the slug already assigned to an identity. Real-database probes caught a null-ordering defect and an unused optional accent-folding extension before completion.

| # | Bug | Fix |
|---|---|---|
| 1 | **Descending cached-size sort ranked uncached countries above every cached country.** PostgreSQL sorts `NULL` first for descending order; the probe returned Norway (no cache row) ahead of countries with positive cached sizes | Nullable size sorts now state `NULLS LAST` explicitly. The PostgreSQL regression expects cached countries first, and passes after the fix |
| 2 | **Name search ignored the optional `unaccent` extension even when it was installed.** A PostgreSQL probe showed `Åland Islands ILIKE '%aland%'` was false while the same comparison through `unaccent()` was true, contradicting the migration's documented accent-folding behavior | Search now uses the extension when available. If the server lacks it, only the specific undefined-`unaccent` error triggers a retry with ordinary case-insensitive search; other database errors still propagate. Integration tests pass both with and without the extension |

The repository tests also cover partial name and ISO search, optional accent folding, escaped `%` input, filter/count consistency, pagination, cached-only results, stable-slug upsert, and ready-first version ordering. The full `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, Prettier, and 1,262 tests across 88 files. Docker runtime/operator tests remain excluded as requested. **Totals after this pass: 55 passes · 206 defects · 0 open.**

---

## Pass 54 — 2026-10-27 (UUID casing bypassed the active-download uniqueness guard)

A focused P2 database review challenged the JSONB-backed uniqueness index with two valid string representations of the same UUID. Zod accepts both lowercase and uppercase UUID text.

| # | Bug | Fix |
|---|---|---|
| 1 | **The active-download unique index treated uppercase and lowercase spellings of one UUID as different countries.** Against the pre-fix PostgreSQL migration, inserting `abcdefab-cdef-4abc-8def-abcdefabcdef` and `ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF` for the same version created two queued jobs. The regression failed on the uncast index | The index now casts `payload->>'countryId'` to PostgreSQL `uuid` before uniqueness comparison, so canonical UUID equality closes the case-variant bypass. The normative DDL was updated in `03-data-model.md` |

The real-Postgres migration suite and offline migration-parity suite pass (26 targeted tests). The full `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, Prettier, and 1,258 tests across 87 files. Docker runtime/operator tests remain excluded as requested. **Totals after this pass: 54 passes · 204 defects · 0 open.**

---

## Pass 53 — 2026-10-26 (phase-2 database parity tests lagged the new migration)

A P2-DB-01 review checked the SQL against §§2.3–2.6, the Kysely types, and real PostgreSQL behavior. Docker runtime tests were left to the operator as requested; database tests ran against a temporary PostgreSQL 16.2 server.

| # | Bug | Fix |
|---|---|---|
| 1 | **The schema-parity parser read a wrapped `CHECK` expression as a second `status` column.** The new multiline map-version constraints made `schema.spec.ts` fail with one more documented column than the interface had | Parse only top-level, two-space-indented table entries in both offline and live schema comparisons; the continuation expression is no longer treated as a column |
| 2 | **The unexpected-migration fixture reused sequence `0002` after `0002_catalog` was added.** The migrator rejected the fixture for duplicate sequence numbers before the version checker could assert the intended `unexpectedOnDisk` report | Renamed the synthetic file to `0003_unannounced` and updated its expected report |
| 3 | **The pending-migration integration fixture pre-migrated both shipped migrations.** Its `migrate: true` setup now means “apply all shipped migrations,” so the test had no pending migration left to apply | It now applies a one-file temporary migration set (`0001_init`) first, then checks against the two-file set and proves only `0002_catalog` is applied |
| 4 | **The database-client comment still said phase-2 tables were not in the type map.** That became false as soon as this task added the four table interfaces | Updated the comment to describe the shipped catalog/cache/version/job map and future tables |

The migration now creates `countries`, `country_cache`, `map_versions`, `jobs`, both job enums, and all documented indexes/constraints. Kysely types and offline/live schema parity cover all eight migrated tables; live PostgreSQL tests exercise unique/check/foreign-key constraints, cascade behavior, partial active-download uniqueness, enum values, and int8 string round-trips. The parity test was mutation-checked: changing the slug index to non-unique and changing the running-job index predicate each made it fail; the original migration was restored. `bun run check` passes with 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, Prettier, and **1,258 tests across 87 files**. Docker-specific runtime/operator tests were not run. **Totals after this pass: 53 passes · 203 defects · 0 open.**

---

## Pass 52 — 2026-10-26 (NFKC expansion let a four-character password clear the twelve-character floor)

A Phase 1 password-policy review tested compatibility normalization in both directions instead of assuming NFKC only shortens input.

| # | Bug | Fix |
|---|---|---|
| 1 | **NFKC expansion bypassed the creation-time minimum.** Four typed `ﬃ` ligatures normalize to twelve code points (`ffiffiffiffi`), so the old normalized-only check accepted a four-code-point password. The before-fix probe showed `passwordProblems()` returned no issues while login accepted it | The policy now requires at least 12 code points in both the submitted and NFKC-normalized forms, and reports the shorter count. A regression covers both expansion (`ﬃ`) and contraction (decomposed accents); mutating back to the normalized-only check makes the test fail |

The focused password suite passes 37/37 after the fix. `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, Prettier, and 1,073 tests passed across 75 files (182 skipped across 12 files). `docs/08-tasks.md` and `docs/14-security.md` now describe the two-form minimum. **Totals after this pass: 52 passes · 199 defects · 0 open.**

---

## Pass 51 — 2026-10-26 (a long parent erased the region name, and a new collision could move cache paths)

A hostile-input review of P2-SRC-05 checked slug validity, collision families, and what happens when a later catalog sync adds a conflicting name.

| # | Bug | Fix |
|---|---|---|
| 1 | **A long parent prefix consumed the entire 64-character slug and erased the child region name.** A same-name pair under a long parent produced two indistinguishable parent-only candidates and numeric suffixes. The regression failed before the fix | Prefix construction now budgets the parent component around the child slug, keeping the region-identifying suffix within the database's 64-character format; source-id and numeric tie-breakers remain bounded |
| 2 | **Recomputing the full catalog after a new same-name region appeared could rename an established slug.** A lone `europe/georgia` initially maps to `georgia`; after adding `asia/georgia`, pure recomputation changes it to `europe-georgia`, breaking existing public URLs and storage paths. The before/after scenario was probed | Slug derivation now accepts prior source-id/slug assignments, reserves those values (including absent source rows), and preserves each existing mapping while assigning around it to newcomers. A regression extends an initial catalog and asserts the old slug remains unchanged |
| 3 | **The catalog-sync task omitted its slug-derivation dependency.** `P2-SRC-06` depends on the collision rules from `P2-SRC-05`, but its task row listed only the index client and job worker | The dependency table now includes `P2-SRC-05`; the data model specifies that sync preserves assigned slugs so filesystem paths remain stable |

Slug tests cover 14 cases: normalization, `europe/finland` → `finland`, parent collisions, stable persisted assignments, long prefixes, deterministic fallbacks, and the DB constraint. A separate 1,000-catalog seeded probe also verified order independence, unique/path-safe ≤64-character output, and persisted-assignment stability. `bun run check` passes: 22 workspace checks, 54 hygiene checks, all package typechecks, ESLint, Prettier, and 1,072 tests passed across 75 files (182 skipped across 12 files). The post-update docs-contract suite passes 16/16. **Totals after this pass: 51 passes · 198 defects · 0 open.**

---

## Pass 50 — 2026-10-26 (an impossible HTTP date became March, and a checksum sidecar had no size limit)

A boundary-focused review of P2-SRC-04 exercised invalid source headers and a sidecar response larger than the format requires.

| # | Bug | Fix |
|---|---|---|
| 1 | **An impossible `Last-Modified` date was accepted as a real instant.** `new Date("Mon, 30 Feb 2026 21:00:00 GMT")` normalizes to March 2, and the old header parser returned that fabricated date. A regression first failed with the normalized instant | The parser now accepts only canonical HTTP-date strings whose representation round-trips exactly; malformed or impossible values become `null` |
| 2 | **The `.md5` reader buffered an arbitrary upstream body and accepted it as a checksum line.** A valid digest followed by thousands of characters passed the permissive filename suffix, so a sidecar could consume unbounded memory. The oversized-body regression failed before the fix | The reader now checks declared length and streams at most 4 KiB regardless of missing or false `Content-Length`; an oversized body is canceled and rejected without a retry. Timeout cancellation also cancels an in-progress body reader |

The offline suite covers HEAD headers, `.md5` parsing, transient/permanent statuses, network exhaustion, timeouts (including an injected fetch that ignores abort), invalid options/URLs, oversized bodies, and redacted errors. The malformed-date and oversized-sidecar probes failed before their fixes. Focused Geofabrik tests pass (32 tests); `bun run check` passes with **1,058 tests passed and 182 skipped** across 74 passing and 12 skipped files. Docker-specific operator tests were not run. **Totals after this pass: 50 passes · 195 defects · 0 open.**

---

## Pass 49 — 2026-10-26 (a malformed size became valid bytes, and an impossible date became March)

An adversarial review of P2-SRC-03 exercised malformed-but-plausible upstream values, not only the three saved pages.

| # | Bug | Fix |
|---|---|---|
| 1 | **A malformed comma-decimal size was silently treated as a different, valid size.** `1,23 MB` passed the permissive numeric expression, commas were stripped, and the parser returned `123,000,000` bytes. The focused regression failed with that value before the fix | The amount grammar now accepts either plain digits or correctly grouped thousands, with an optional dot-decimal fraction; the malformed form returns `null`. Valid comma-grouped byte totals and decimal sizes remain covered |
| 2 | **JavaScript normalized impossible calendar dates instead of rejecting the source timestamp.** `new Date("2026-02-30T12:00:00Z")` produces March 2, so the parser's previous invalid-date check accepted an impossible “data up to” value. The normalization was reproduced directly, and regressions now cover both February 30 and hour 25 | The parser validates calendar and clock components before constructing the instant. Invalid timestamps now become `null`, preserving honest unknown metadata |

The fixture suite covers Europe, Finland (no subregion table), and Monaco, plus the moving `latest` alias, dated PBF rows, decimal/binary/grouped sizes, absent values, and invalid timestamps. Both regressions were reproduced before the fixes and are covered afterward. The focused suite passes (16 tests); `bun run check` passes with **1,047 tests passed and 182 skipped** across 73 passing and 12 skipped files. The Docker-specific operator tests were not run. **Totals after this pass: 49 passes · 193 defects · 0 open.**

---

## Pass 48 — 2026-10-26 (CORS configuration accepted values that could never match a browser origin)

A follow-up Phase 1 review tested CORS configuration through both the environment parser and the actual response hook, rather than treating "valid URL" as equivalent to "valid Origin".

| # | Bug | Fix |
|---|---|---|
| 1 | **A valid URL was accepted as a CORS origin even when browsers never send that value in `Origin`.** `CORS_ORIGINS=https://maps.example.org/admin` passed validation, but browsers send only `https://maps.example.org`; exact matching then omitted `Access-Control-Allow-Origin` and made the configured integration unusable. URLs containing credentials or a query/fragment were accepted for the same reason. Probed the parser before the fix and observed all four malformed entries pass; a real pipeline regression with a trailing slash returned no ACAO header | Validation now accepts origin-only HTTP(S) URLs, rejects credentials/path/query/fragment, and canonicalizes an optional trailing slash/default port to `URL.origin`. The env regression rejects invalid components, and the real CORS response test confirms a normalized configured origin matches the browser header. The API env guide now states the contract |

The new cases failed against the old parser and route behavior; after the fix, **62 targeted tests** and API/web/shared TypeScript checks pass. A mutation that returned the raw configured value instead of the canonical origin made the response regression fail again. **Totals after this pass: 48 passes · 191 defects · 0 open.**

---

## Pass 47 — 2026-10-26 (Phase 1 input handling and readiness edge cases)

A focused adversarial review of the completed Phase 1 API foundation followed unusual-but-valid HTTP and filesystem conditions through the real route pipeline. Docker-dependent integration was left for the operator's later clean-machine check.

| # | Bug | Fix |
|---|---|---|
| 1 | **A NUL in a login username became a server error.** `LoginRequestSchema` accepted control characters even though account creation rejects them. Probed `POST /_auth/api/login` with `\u0000admin` against PostgreSQL: PostgreSQL cannot represent NUL in `text`, so the request reached the query and returned `500 INTERNAL_ERROR` instead of input validation | The shared login schema now rejects C0/C1 control characters before SQL; the same exported predicate is used by admin-account creation. `04-api.md` documents the constraint. The real route now returns `400 VALIDATION_ERROR`, and the shared-schema and integration regression tests cover NUL, newline and C1 control input |
| 2 | **Readiness reported a cache as writable when no file data could be written.** `writeFile(path, '')` creates/truncates a zero-byte inode but allocates no file data. Probed the real `GET /readyz` under Linux `RLIMIT_FSIZE=0`: zero-byte creation succeeded and the endpoint incorrectly returned `200 {cache:ok}`, while a one-byte write failed with `EFBIG` | The cache probe now writes one byte before cleanup. A subprocess regression test reproduces the file-size limit and requires `503 {cache:fail}`; it failed with the old zero-byte probe and passes with the fix |
| 3 | **Unmatched auth API URLs missed `Cache-Control: no-store`.** The header was set by a hook scoped inside the auth route plugin, which never runs for an unmatched path. A real `GET /_auth/api/nope` returned `404` without the header, contrary to §1's promise that every auth API answer is non-cacheable | The root security hook now applies `no-store` to the shared auth API scope before route matching; the redundant namespace hook was removed. A regression test checks the unmatched `404` carries the header |
| 4 | **A password reset could be raced by an already-verifying login.** The login read and verified the old hash, then issued its token in a later transaction without checking that the password was still current. A deterministic integration probe paused just after successful old-password verification, committed a reset, then resumed login: the old code returned `200` and left a live token after the reset had supposedly revoked every session | Token issuance now locks and rechecks the admin row inside its transaction. If reset commits first, login returns the generic `401 INVALID_CREDENTIALS` and records the stale attempt; if login obtains the row lock first, the reset waits and its revocation sees the committed token. The new race regression fails on the old service and passes with the fix |

All four findings were first captured by failing probes, then verified after the fixes. The Phase 1-specific tests and full repository gate pass. **Totals after this pass: 47 passes · 190 defects · 0 open.**

---

## Pass 46 — 2026-10-26 (a password prompt that dropped split keystrokes and half an emoji)

The open-ended review followed the operator's real password-prompt path in `scripts/lib/secret-prompt.ts`, rather than assuming a stream delivers one complete line per `data` event.

| # | Bug | Fix |
|---|---|---|
| 1 | **A CRLF paste split across stream chunks lost the repeat password.** With input chunks `"split-one\r"`, `"\nsplit-two\r"`, `"\n"`, the first prompt returned after the CR and removed its `data` listener before the remaining chunks could be retained; the next prompt ended with `no input`. This contradicted the helper's Windows-CRLF support and the property that Readable streams may split data arbitrarily | The prompt now installs its reader before resuming the input, keeps collecting already-arriving chunks after its first line, carries an optional LF after CR across prompt boundaries, and preserves the bounded suffix for the next call. The new segmented-CRLF case fails against the old implementation and passes against the fix |
| 2 | **Backspace deleted half of an emoji.** `String.slice(0, -1)` removes one UTF-16 code unit, not one Unicode code point. Probed with `abc😀`, backspace, then `d`: the prompt returned a lone surrogate between `abc` and `d` (displayed as `�`). A user correcting a visible typo would set a different, unreproducible password | Backspace now removes the last Unicode code point. The new regression case requires `abc😀` + backspace + `d` to return `abcd`; it failed against the old implementation |
| 3 | **The task index understated the actual board by nine.** A row-ID count found **149 unique task rows** (9 + 42 + 36 + 15 + 19 + 19 + 9 across Phases 0–6), while `08-tasks.md`'s TL;DR said 140. The phase counts and task IDs are the source of truth, not the summary number | The TL;DR now says 149; `docs-contract.spec.ts` counts task rows and compares the result to the advertised total. The new contract test failed on 140 and passes on 149 |

The two prompt regression cases were run against the old implementation and failed (2/2), then passed with the fixes. The task-count contract likewise failed against 140 and passes on 149. The complete prompt suite and full repository check pass. **Totals after this pass: 46 passes · 186 defects · 0 open.**

---

## Pass 45 — 2026-10-26 (the task table still said nginx forgets a recreated API)

While documenting the Makefile task, its prerequisite row in `08-tasks.md` was checked against the deployment guide and the live proxy evidence from pass 44. The config had already been fixed; the task table still described the old defect as current behavior.

| # | Bug | Fix |
|---|---|---|
| 1 | **The `P1-DOCK-05` acceptance record contradicted the implementation it was meant to accept.** It said nginx "resolves `api` at startup". Pass 44 measured that exact configuration's failure: a recreated API left nginx dialing the old address and returning `502`. The fix is a Docker DNS resolver plus `server api:3000 resolve`, which was re-probed to follow a recreated API without a reload. The stale task sentence thus described the removed bug as the deployed design | The row now says the dynamic upstream follows recreated API containers; `12-deployment.md` and the task row are guarded against the stale statement by `docs-contract.spec.ts`. Mutation check: restoring the old one-time-resolution claim makes the contract case fail. |

**Totals after this pass: 45 passes · 183 defects · 0 open.** No new runtime behavior changed. The Makefile target tests and the full repository check pass; the pass-44 proxy measurement remains the runtime proof for the corrected sentence.

---

## Pass 44 — 2026-10-26 (a proxy that keeps dialing a container that is gone, and a secret nobody could mount)

The pass started where pass 43 stopped: the deployment. `compose.yaml` now describes the whole install, so the question is
no longer "is it configured" but "what does it do on the second day, after an upgrade or a password rotation". Two of the
answers were wrong, and two of the three findings came from running the pieces rather than reading them.

| # | Bug | Fix |
|---|---|---|
| 1 | **The web container would answer `502` to every API call after the API container was recreated.** `docker/nginx.conf` wrote `proxy_pass http://api:3000`, which nginx resolves **once**, when the configuration loads, from `/etc/hosts` — a file Docker rewrites whenever a container is recreated. `docker compose up -d` recreates `api` on a new address, and the documented password rotation in `12-deployment.md` §2 ends with exactly that command: the mirror keeps serving pages, login fails, and the error log names an address nothing answers on. Measured on a real nginx 1.29.0 with the file unmodified: `200` from the API, then the address changed and `getent hosts api` already returned the new one, then `502` with `connect() failed (111: Connection refused) … upstream: "http://127.0.0.1:3000/"` on every request until `nginx -s reload` — which is the proof the address was read at load time and never again | An `upstream api_upstream { zone api_upstream 64k; server api:3000 resolve; }` and `resolver 127.0.0.11 valid=10s ipv6=off` — Docker's embedded DNS, which every user-defined network has, and a ten-second cap on how long a stale address may outlive its container (without `valid=` nginx honours Docker's 600 s TTL). Re-probed with the same file: the same recreation is followed within ten seconds with **no** reload and no restart. Also probed, because a dynamic upstream can fail in a new way: `web` started while the resolver was unreachable **starts anyway**, answers `502` with `could not be resolved`/`no live upstreams` in the log, and recovers on its own once DNS answers — where the old form refused to start at all |
| 2 | **`.env.example` recommended the one deployment its own compose file refuses.** Line 7 said "In production prefer the `*_FILE` variants below (mounted as Docker secrets) over plain values", and `12-deployment.md` §2 said `POSTGRES_PASSWORD_FILE` "works too (`docker compose` secrets …)", but compose interpolates `POSTGRES_PASSWORD` into **both** `db` and `api`: with only the `_FILE` set, compose stops before starting anything (`required variable POSTGRES_PASSWORD is missing a value`); with both set — the only way to get past that line — the API refuses at boot (`POSTGRES_PASSWORD: cannot be combined with POSTGRES_PASSWORD_FILE; set exactly one of the two`), because `.env` reaches the container whole through `env_file`. So the documented "preferred" production path could not start a single container, in either spelling. Both messages were produced, not guessed | The docs now say which deployment each variable belongs to: `.env.example`'s header, §2's paragraph (a secrets install **replaces** the mechanism — `POSTGRES_PASSWORD_FILE` in both services plus a `secrets:` block — and the password rule survives the swap because it is about the DSN, not about where the secret came from), the §4 table, and the `09-development.md` §5 row. `compose.yaml` says at the line itself why `_FILE` must not be added beside it, and a new case in `compose.spec.ts` holds the invariant: no service sets the file variant, while `db` and `api` read the one interpolation |
| 3 | **The configuration's own summary table described a setting the file argues against.** The header of `docker/nginx.conf` listed the streaming row as "`proxy_request_buffering off`, `proxy_buffering off`, long timeouts", while forty lines below the file spends a paragraph explaining that buffering is deliberately **on** — its temp file removed by `proxy_max_temp_file_size 0` — because with buffering off nginx cannot compress what it forwards (measured, pass 40). A reader who trusted the table would have reintroduced the exact defect pass 40 removed, and the two statements were in the same file | The row now names the pair that is actually there, and says what it costs to get it wrong |

Probed and found sound, so that "no bug here" is a measurement rather than an impression:

- **The API hop itself, through the new upstream.** The requests that matter still arrive intact: `/_auth/api/login?next=%2F_site%2Fadmin`
  reached the backend as that path *and* query, `POST /_admin/api/import` arrived with the body, `X-Forwarded-For`/`X-Real-IP`
  were set, and an outer proxy's `X-Forwarded-Proto: https` was passed through rather than downgraded.
- **Streaming, still.** A 100 MB upload went through the proxy with **zero** files in `/tmp/client_temp` and `/tmp/proxy_temp`
  and the worker at 2.8 MB RSS; a 25 kB JSON answer was `Content-Encoding: gzip` with buffering on and
  `proxy_max_temp_file_size 0`, which is the pass-40 behaviour surviving the switch to an upstream block.
- **The rest of the routing map, re-run against the edited file.** `/` → `302 /_site/` (query string kept), `/_site` →
  `301`, `/_site/admin/cache` → the shell with CSP and `Cache-Control: no-cache`, `/_auth/login` → the shell (the one page
  outside `/_site`), `/assets/index-*.js` → `max-age=31536000` with `nosniff` and no CSP, `/nothing-here` and
  `/_auth/apix` → `404`, `Server: nginx` with no version.
- **`access_log /dev/stdout` with a pipe for stdout**, which the pass-39 note about `/dev/stderr` made worth re-checking: the
  access log arrived on the container's stdout with no permission error, at startup and under load.
- **The boot drill from pass 43, re-read.** `entrypoint.api.sh` + compose's environment + a password-protected PostgreSQL:
  four step lines, admin created, `/healthz`, `/readyz`, `login 200`, a second boot that changes nothing.

Mutations, one at a time, reverted between runs — **8 tested, 8 killed**: one `proxy_pass` put back to `http://api:3000`,
`resolve` dropped, `resolver` dropped, the stale window raised to 600 s, the `zone` dropped, the upstream port drifted to
3001, a `POSTGRES_PASSWORD_FILE` line added to the API service, and a literal password in its place.

Two things about the evidence: there is still **no Docker daemon here**, so the proof is nginx 1.29.0 **built from source**
(PCRE2 and zlib compiled in, no SSL) running this exact file, with Docker's embedded DNS imitated by a 40-line server bound
to `127.0.0.11:53` so `resolver` and `resolve` were exercised as written; and the API side of the same stack was a real
PostgreSQL 16 with a role that demands a password.

**Totals after this pass: 44 passes · 182 defects · 0 open.** Gate: `bun run check` green — 1 189 tests in 81 files,
coverage 98.25 % statements / 96.73 % branches / 98.64 % functions / 98.62 % lines.

---

## Pass 43 — 2026-10-26 (a password that cannot live in a URL, and a secret file nothing read)

`P1-DOCK-05` asks for one thing above all: *changing `POSTGRES_PASSWORD` alone must still connect, with no second copy of
the DSN*. The obvious implementation — `DATABASE_URL: postgres://mapirror:${POSTGRES_PASSWORD}@db:5432/mapirror` — was
written first and then measured against a PostgreSQL that actually demands a password (a SCRAM role, `pg_hba.conf`
rewritten for the probe). It does not survive an operator's password manager.

| # | Bug | Fix |
|---|---|---|
| 1 | **A password with `@`, `:`, `/`, `?`, `#` or `%` could not be used at all.** Measured, one character at a time, with the derived DSN: `p@ss` made `pg` connect with the password **truncated to `p`** (`password authentication failed for user "mm_pw"` — the driver splits the userinfo at the first `@`, so the rest became part of the host); `pa#ss`, `pa?ss` and `pa/ss` made `DATABASE_URL` an invalid URL, so `parseEnv` refused the boot and named **`DATABASE_URL`** — a variable the operator never edited, because compose writes it; `pa%ss` reached the driver's `decodeURIComponent` and threw `URI malformed`. Only a password that is already URL-safe worked, and nothing said so. `openssl rand -base64 32` — the command most people reach for — contains `/` about a third of the time | The password no longer goes into the URL. `compose.yaml` derives `postgres://mapirror@db:5432/mapirror` (user, service, database) and passes `POSTGRES_PASSWORD` beside it; `databaseUrlFor` in `db/client.ts` completes the DSN at boot, percent-encoding what it inserts. `%` is escaped by hand first, because `URL`'s own password setter leaves a bare `%` alone (it is not in the userinfo encode set) — without that, `a%41b` would authenticate as `aAb`. Re-probed against the same SCRAM role: all nine awkward passwords connect, `databaseUrlFor` decodes back to exactly what was set, and the control (the same password typed into the DSN by hand) still fails — which is the point |
| 2 | **`POSTGRES_PASSWORD_FILE` was accepted, validated, redacted — and never read.** `parseEnv` knew the variable (the schema declares it, the cross-field rule refuses it beside `POSTGRES_PASSWORD`, `toJSON` masks it) and no code opened the file, so the docker-secret deployment `.env.example` *recommends* could never authenticate: the API would connect with no password at all and the reason would be an authentication failure three layers away from the cause | `parseEnv` reads it, strips only trailing line breaks (`docker secret` content ends with one), and reports an unreadable or empty file as a configuration problem naming the variable — the same one-line shape as every other boot failure, rather than a stack trace from inside a pool constructor that four call sites would each have to wrap. It is read only when the pair rule accepted it, so setting both halves reports one problem, not two. Probed: the value from the file connects; a missing path prints `POSTGRES_PASSWORD_FILE: cannot be read: ENOENT …` and exits 1 |
| 4 | **A rejected password looked exactly like a slow database.** `wait-for-db.ts` retried every failure to the deadline, so a server that had already answered `28P01` (password rejected) or `3D000` (no such database) produced a minute of silence and then `the database did not answer within 60s (60 attempt(s); 28P01)`. Measured on a SCRAM role with `POSTGRES_PASSWORD=wrong-one`: `--timeout 5` took 5.08 s and the last line named a timeout, not the refusal. In compose that is a minute per restart spent looking at a database that is working, while the answer is a `POSTGRES_PASSWORD` that disagrees with the volume — the fourth defect this task's own subject matter produced | `PERMANENT_FAILURES` names the four SQLSTATEs that waiting cannot fix (`3D000`, `28P01`, `28000`, `42501` — PostgreSQL raises the last two instead of `28P01` depending on the `pg_hba.conf` method); step 1 prints one line, `error: the database refused the connection and will keep refusing it — the server rejected the password (28P01); check DATABASE_URL and POSTGRES_PASSWORD`, and exits `1` on the first attempt. Everything that is genuinely a timing problem still waits: `57P03` while recovering, `ECONNREFUSED` while starting, `ENOTFOUND` while DNS catches up. The pool is closed on the new path too. Re-probed: `28P01` and `3D000` exit `1` in 0.09 s, a closed port still spends its whole deadline |
| 3 | **`.env.example` described a compose file that did not exist, in terms that were not true.** Its header said compose "derives `DATABASE_URL` from `POSTGRES_PASSWORD`", and line 23 showed the derived value as `postgres://mapirror:<POSTGRES_PASSWORD>@db:5432/mapirror` — the form defect 1 proves is unsafe. The same file told operators to "prefer the `*_FILE` variants below (mounted as Docker secrets)", which defect 2 proves was inert | The header now says what happens: compose replaces the DSN with one that carries **no password**, and the API completes it. The derived form no longer shows a password in a URL anywhere in the docs, `09-development.md` §5 states the rule in the `DATABASE_URL` and `POSTGRES_PASSWORD` rows, and `12-deployment.md` §2 explains why (with the three measured failure modes) and shows how to rotate the password on an existing volume — `ALTER ROLE`, because the verifier lives inside the volume and a changed `.env` alone does not change it |

What was probed and found sound, so that "no bug here" is a measurement rather than an impression:

- **The connection string the pool is given.** `databaseUrlFor` returns the DSN untouched when no password is configured
  (native development) and when the DSN already has one (a deliberate value must not be silently replaced), keeps
  `?sslmode=require` and the port, and round-trips nine awkward passwords — `p@ss/word#1`, `a:b;c=d`, `with space`,
  `ünïcode-"quoted"`, `a%41b`, `100%`, `trailing&` — through `new URL(…).password`.
- **The file path end to end.** A SCRAM role whose password is `p@ss/word#1`: `POSTGRES_PASSWORD` connects, a
  `POSTGRES_PASSWORD_FILE` containing it plus a newline connects, a missing file is a config error naming the variable, and
  the same password written into the DSN by hand fails — so the test is measuring the completion, not the server's
  permissiveness.
- **The compose file, read the way compose reads it.** `scripts/tests/compose.spec.ts` parses the YAML, resolves every
  `${…}` with compose's `:?`/`:-` semantics against `.env.example`, and compares the result with the images it starts: the
  DSN's host is the `db` *service* name, its user and database are the container's `POSTGRES_USER`/`POSTGRES_DB`, its port
  is what `nginx.conf` proxies to, the two volume targets are the paths the images write to, and every healthcheck is a
  command that exists in that image (`pg_isready`; `bun` — no `curl`; busybox `wget`). It also holds the four decisions
  that are not obvious: `environment:` overriding `env_file:` for the six values that are wrong inside a container, the
  `readyz`-means-healthy probe, `web` waiting only for the API *container* so a long migration still shows a page, and
  exactly one published port.
- **A health probe that cannot lie.** `wget` on `/index.html` rather than on `/healthz`: asking the API would mark the web
  container unhealthy during a database outage, i.e. remove the page that explains the outage.

Mutations, one at a time, reverted between runs — **22 tested, 22 killed**: the password put back into the DSN, the DSN
pointing at `localhost`, the user disagreeing with the DSN, `MIGRATE_ON_BOOT` dropped, `CACHE_DIR` outside the volume,
`TRUST_PROXY=loopback` alone, `curl` in the API's healthcheck, the web probe asking `/healthz`, the API port published,
`depends_on` weakened to `service_started`, the database volume dropped, a 5 s start period, `restart: always`, a literal
password in the file, `%` not escaped, the completion removed, the secret's trailing newline kept, an unreadable
secret ignored, the permanent-refusal check removed, `28P01` dropped from `PERMANENT_FAILURES`, `57P03` wrongly
classified as permanent, and `driverCode` reading the message instead of the code.

Two things stated rather than assumed: there is **no Docker daemon in this sandbox**, so `docker compose up` itself was not
run — the file is checked by parsing it and against every image it starts, and the drill on a real host belongs to
`P1-DOCK-06`. What *was* run is the layer just below it: the real `docker/entrypoint.api.sh` with exactly the environment
compose gives the API — a `DATABASE_URL` that carries no password, `POSTGRES_PASSWORD=p@ss/word#1`, `MIGRATE_ON_BOOT=false`,
`CACHE_DIR`/`TMP_DIR` on the mounted path — against a real PostgreSQL whose role demands a password: four step lines,
`admin 'admin' created`, `/healthz` `ok`, `/readyz` `{"database":"ok","cache":"ok"}`, `POST /_auth/api/login` `200`, one
`admins` row, a second boot that changes nothing, and `SIGTERM` → exit `0`. That drill is what defect 4 came out of. And the first version of the volume knob was an `MAPIRROR_DATA_DIR` environment variable, which
`env.spec.ts` correctly refused: the project's rule is that every variable in `.env.example` is read by the application,
and a compose-only variable is an exception to it. It became a one-line edit to `compose.yaml` that the guide shows
instead.

**Totals after this pass: 43 passes · 179 defects · 0 open.** Gate: `bun run check` green — 1 185 tests in 81 files,
coverage 98.25 % statements / 96.73 % branches / 98.64 % functions / 98.62 % lines.

---

## Pass 42 — 2026-10-26 (a second boot that refused to start, and the wait nobody could have written in shell)

`P1-DOCK-04` is the task that makes `docker compose up -d` enough on a clean Ubuntu box, so the review started where the
acceptance criterion ends: *does the container actually start, twice, with nothing typed by a human?* It did not — and the
reason was one line away from the code the task was about. The four defects below were each reproduced on a real
PostgreSQL with the real image files before they were fixed, and re-probed after.

| # | Bug | Fix |
|---|---|---|
| 1 | **The second boot refused to start.** `entrypoint.api.sh` runs `init-admin.ts` on *every* boot, and `init-admin` resolved the password before it looked at the database. So the moment an operator did the sensible thing — delete `ADMIN_PASSWORD` from `.env` once the account exists — every restart exited `1` with `no admin password supplied`, and `restart: unless-stopped` turned that into a crash loop on a database that was perfectly fine. Probed on a database that already had its admin: `bun scripts/init-admin.ts` with no password and no TTY → `error: no admin password supplied …`, exit `1`. A container that cannot restart is worse than one that never booted, because it looks healthy in `docker ps` | `--bootstrap` for the entrypoint's mode: the account is looked up **first** (`findExistingAdmin`, next to `ensureAdmin` in `modules/auth/admin-accounts.ts`) and, when it exists, reported as `admin 'admin' already exists — unchanged` and the script returns `0` *before* any password source is touched. A fresh database with no password still exits `1` with the `set ADMIN_PASSWORD` message, so the failure DOCK-2 describes survives as a message rather than a server nobody can log into; a deactivated account is reported and left deactivated. The hand-run path is deliberately unchanged, which is why the flag exists instead of a new default: `bun run admin:init` on an existing install still fails on a missing password and points at `reset-admin-password`. Re-probed: second boot with `ADMIN_PASSWORD` **unset** → `already exists — unchanged`, exit `0`, API serving |
| 2 | **`--bootstrap` blamed the wrong step.** With the database gone between step 1 and step 3 — the exact window a restart-looping PostgreSQL creates — the lookup threw into the outer handler, which printed `error: could not create the admin account: connect ECONNREFUSED 127.0.0.1:1`. Nothing was being created: the sentence sends an operator to look for a failed `INSERT`, a constraint, a permission on `admins`, when the database was simply not there. Measured before the fix, on a closed port | The lookup has its own `try`: `error: could not check the admin account: connect ECONNREFUSED 127.0.0.1:1`, and it is fatal rather than falling through to the create path — an account that cannot be read must not be created again. Two cases pin it (the message, and that the run stops with a password *present*), and both fail if the wrapper is removed. Re-probed after: same command, same closed port, the new sentence |
| 3 | **`05-flows.md` F1 documented a wait the image cannot perform.** The diagram said `pg_isready loop, max 60s`. The runtime image is bare Bun — no `psql`, no `pg_isready`, and `dockerfile.spec.ts` forbids OS packages — so the step as drawn could not exist; worse, a port probe is not the unit even if it did, because a PostgreSQL in recovery accepts TCP and then answers `57P03 the database system is starting up`. The diagram also ended with `start Fastify + worker`, and no worker process is started by anything (the queue arrives in `P2-JOB-01`) | The diagram now draws the four real steps with the four real commands, the `57P03` reason, both bootstrap branches (created / already exists / no password → exit 1 naming the step), and `exec` as the last line. `entrypoint.spec.ts` parses the guide and asserts the same four commands in the same order, so the two cannot drift again; four mutations (a step dropped, two steps swapped, `--bootstrap` dropped, the file name removed) all fail it |
| 4 | **Two documents stated the boot as it was going to be, not as it is.** `12-deployment.md` said "first boot performs, in order: wait for DB → run migrations → create the admin (idempotent) → start the API, worker and scheduler" — no file name, no flag, no failure shape, no deadline, and a third process that does not exist. `09-development.md` §4 said "in compose the migration entrypoint owns the step and the API runs with `MIGRATE_ON_BOOT=false`", as fact — but there is no `compose.yaml` in the repository yet; it is `P1-DOCK-05`. An operator reading either would expect a boot that this build does not have, and look for the cause in the wrong place when it stops | §2 is now a table of the four steps with the reason each is where it is, the exact log lines (success and failure), the `--timeout` flag and why the wait is a query, the second-boot behaviour with its `--bootstrap` explanation, a real failure transcript, and the one-off-command note (`exec "$@"` still gets steps 1–3). The compose sentence is marked as `P1-DOCK-05`'s, with what happens at the default (`MIGRATE_ON_BOOT=true`: the boot check still runs and finds nothing pending — the flag removes a second pass, not the check) |

What was probed and found sound, so that "no bug here" is a measurement rather than an impression:

- **The four steps, on a fresh volume, with the real files.** First boot logged `step 1/4`…`step 4/4`, created the admin,
  and served `/healthz` `{"status":"ok"}` and `/readyz`
  `{"status":"ok","checks":{"database":"ok","cache":"ok"}}`. `ps -o pid,ppid,comm` showed the entrypoint's
  PID equal to `bun`'s with zero children — the `exec` is real — and `SIGTERM` produced `{"signal":"SIGTERM","msg":"shutting
  down"}` with exit `0` well inside the grace period.
- **Two containers at once on one empty database.** Started together against the same fresh database: one applied
  `0001_init`, the other logged `migrations: already up to date`; one printed `created`, the other `already exists —
  unchanged`; neither exited non-zero and `admins` held exactly one row. Kysely's migrator lock and the `lower(username)`
  unique index are doing the work, and nothing in the entrypoint needed to know about it.
- **`MIGRATE_ON_BOOT=false`.** A second boot with the flag off still ran all four steps and served: the entrypoint owns
  the migration, and the API's boot check then finds nothing pending instead of refusing.
- **A database that is not there.** `wait-for-db.ts` against a closed port: four attempts in three seconds, one masked
  reason per line, exit `1`. The entrypoint against a dead database: the full 60 s, `step 1/4 … failed (exit 1); the API
  is not started`, and nothing listening on the port afterwards — the failure DOCK-2 wants instead of a `503` server.
- **The override path.** `… entrypoint.api.sh bun --version` printed `1.4.4` *after* steps 1–3, which is the property that
  makes one-off maintenance commands (`reset-admin-password`, `migrate --reset`) safe in this image.

Mutations, in `scripts` project only, one at a time, reverted between runs — **20 tested, 20 killed**: `#!/bin/bash`,
`set -e` without `-u`, `cd /app` removed, steps 1 and 2 swapped, no `exec` on the API, `"$@"` without `exec`, steps 2
and 3 swapped, `--bootstrap` dropped, a duplicated step number (`step 2/4` twice), `sleep 5 && wait-for-db`, no
`ENTRYPOINT`, a `COPY` destination that disagrees with it, `wait-for-db.ts` missing from the image, the bootstrap lookup
moved after the password, the bootstrap reporting `created`, the bootstrap re-activating a deactivated account — plus four
against the guide (a step dropped, two steps swapped, `--bootstrap` dropped, the file name removed).

One honest survivor from the same batch: an earlier version of the entrypoint case asserted the *line order* of the
locations in `docker/nginx.conf` and was kept for pass 41's file; re-testing it here showed that moving the API block to
the end of the server block leaves every test green — because nginx picks the longest matching prefix whatever the line
order, so only the `^~` modifier is load-bearing. The assertion was replaced by one that reads the guide instead of the
file's layout, which is the property that can actually break (defect 3).

**Totals after this pass: 42 passes · 175 defects · 0 open.** Gate: `bun run check` green — 1 138 tests in 79 files,
coverage 98.23 % statements / 96.37 % branches / 98.64 % functions / 98.61 % lines.

---

## Pass 41 — 2026-10-26 (a redirect that rewrites links, and two documents that state the policy backwards)

This one started from the two files the last task wrote and from a question that task left unanswered: *is the
`TRUST_PROXY` value the guide recommends actually right?* Two of the three answers were no, and one of them is the kind of
mistake a test cannot catch on its own — because the test agreed with the document.

| # | Bug | Fix |
|---|---|---|
| 1 | **Both redirects threw the query string away.** `return 302 /_site/;` sends the target literally; nginx does not re-attach the arguments. Measured against a real nginx 1.29.0 running `docker/nginx.conf`: `GET /?utm_source=newsletter&x=2` answered `Location: /_site/` — a campaign link, a filtered share, anything a person copied out of the address bar arrived with its parameters gone, and `GET /_site?filter=stale&page=2` did the same through the `301`. The page then renders the default view, which reads as "the filter did not work" rather than as a rewrite | `return 302 /_site/$is_args$args;` and `return 301 /_site/$is_args$args;`. `$is_args` is `?` when there are arguments and empty when there are none, so the bare cases stay `/_site/` with no stray `?` — re-measured: `/?utm=1&x=2` → `/_site/?utm=1&x=2`, `/_site?filter=stale&page=2` → `/_site/?filter=stale&page=2`, `/` → `/_site/`, `/_site` → `/_site/`. The guide's snippet carries the same two lines (operators copy it), and the case that catches it asserts the variable, because the failing form looks entirely reasonable |
| 2 | **`14-security.md` §7 described the login throttle backwards.** The row read `10 / 15 min per IP (+ per-username counter)`; the shipped throttle is `10 / 15 min per (IP, username)` **pair** plus `30 / 15 min per IP` (ADR-027 says so in `15-decisions.md`, so the two documents had contradicted each other since the task landed). The document claimed the tight limit was the address, labelled the loose counter as the pair's, and left the 3× out entirely — an operator reading it would expect one address to be capped at ten attempts and would see thirty. Measured, pass 41, against a real API and PostgreSQL: ten failures for one pair from `198.51.100.20` → `429`; the same username from `198.51.100.21` → `401`; ten more from `.20` → `429`, i.e. exactly the code's policy and not the document's | The row now reads `10 / 15 min per (IP, username) pair, and 30 / 15 min per IP`, and `rate-limit.spec.ts` — which already parsed the *other* three rows of that table, which is why this one survived — parses it too: both numbers against `loginThrottleFromConfig(parseEnv({}))`, the window against `AUTH_LOCKOUT_MINUTES`, and the 3× multiplier itself. Moving the code's multiplier now fails the documentation test, and changing the document fails it first |
| 3 | **The `TRUST_PROXY` value the deployment guide recommends silently ignores the proxy.** Pass 40 added "set `TRUST_PROXY=uniquelocal`" to `12-deployment.md` §3, reasoning that `uniquelocal` covers the Compose network. It does — and that is all it covers: in `@fastify/proxy-addr` a preset is a *list*, not an addition to the default, and `uniquelocal` is `10/8`, `172.16/12`, `192.168/16`, `fc00::/7` with **no loopback**. §3's own picture has the outer proxy reaching this container over `127.0.0.1:8080`, and on a host running the API without Compose that is also the API's peer. Measured, pass 41: with `TRUST_PROXY=uniquelocal`, a request from `127.0.0.1` carrying `X-Forwarded-For: 203.0.113.81` was recorded as `127.0.0.1` — every client one address, the exact failure the same paragraph warns about, reached by following its advice. The test added in pass 40 asserted the guide contained that string, so it agreed with the bug | The guide shows a copyable `TRUST_PROXY=loopback,uniquelocal`, explains that a preset *replaces* the default rather than extending it, and records the measurement. Re-measured after the change, with the API restarted on that value: a loopback peer with `X-Forwarded-For: 203.0.113.81` recorded `203.0.113.81`, and a `172.18.0.5` peer with `203.0.113.82` recorded `203.0.113.82` — both hops trusted, in one value. `09-development.md` §5 says the same in its `TRUST_PROXY` row, and the guide case in `nginx-routing.spec.ts` now reads the `.env` block instead of the prose (the prose quotes the broken value on purpose, to explain it), asserts both halves by name, and asserts that the reason is stated |

What was probed and found sound, so that "no bug here" is a measurement rather than an impression:

- **The throttle's own counters.** The pair key really does include the address: ten failures from `198.51.100.20` left
  `198.51.100.21` able to try, and the next attempt from `.20` was `429` with `retry-after: 897` and a `lockedUntil` ~15
  minutes out. A successful login for a *different* account from the same address was `200`, so the per-IP counter is not
  the one that fires first.
- **Every error leaves in the documented envelope**, including the ones Fastify raises before a handler runs: a
  `text/plain` body → `400 VALIDATION_ERROR`; malformed JSON → `400 BAD_REQUEST`; no `Content-Type` → `415
  UNSUPPORTED_FORMAT`; an empty body → `400 BAD_REQUEST`; `PUT /_auth/api/login` → `404 NOT_FOUND`; a 2 MiB login body →
  `413 FILE_TOO_LARGE`. Unknown paths under a public namespace → `404`; under `/_admin/api/` → `401` unauthenticated and
  `404` with a token, which is the guard doing its job before routing.
- **A deactivated account is refused everywhere at once.** `is_active = false` in PostgreSQL: `/me` → `403
  ACCOUNT_DISABLED`, `/_admin/api/*` → `403`, `POST /login` with the right password → `403`, `POST /logout` with the live
  token → `403`. Nothing keeps working and no token is silently extended.
- **Token parsing is strict in the right places.** `Bearer <token>, Bearer junk` → `401`; `bearer <token>` (lowercase
  scheme) and extra spaces → accepted; two `Authorization` headers carrying one valid token → accepted; `Bearer ` with
  nothing after it → `401`.
- **A disallowed origin gets no CORS grant on a real request**, not only on its preflight: `Origin: https://evil.example`
  on a login `POST` → `401` with no `access-control-allow-origin`, and `/healthz` answers `cache-control: no-store`.
- **The proxy hop forwards no empty `X-Forwarded-Proto`**: with no such header upstream, nginx omits it entirely instead of
  sending a blank, which is what the API's http-by-default reasoning depends on.

The mutation batch for this pass: **9 mutations, all 9 killed** — both redirects losing `$is_args$args`, the guide's snippet
teaching the dropping form, the guide recommending `uniquelocal` alone, the guide losing the sentence that explains why, the
policy row in its old shape, the row with the two numbers swapped, the row's window drifting to 20 minutes, and the code's
own multiplier moving 3 → 4. That last one is the point of the documentation test: it fails when the *code* changes, so the
two cannot drift again in either direction.

## Pass 40 — 2026-10-26 (a page with no headers, and advice that costs compression)

All three were found by *running* the config, and two of them are the kind of thing that only shows up in a response: a
header that is missing, and a header that is missing because a directive elsewhere switched it off.

| # | Bug | Fix |
|---|---|---|
| 1 | **The login page would have been served with no security headers and no cache policy.** `docker/nginx.conf` wrote `try_files /index.html =404` for `/_auth/login` — the natural way to say "serve the shell". `try_files` serves a **file** when an argument matches a path, and only its **last** argument is a URI to re-resolve; so the file was served inside that location, which carries no `add_header` and no `expires`. Measured against a real nginx: `GET /_auth/login` returned `200 text/html` with no `Content-Security-Policy` and no `Cache-Control`, while `/_site/` (whose rule ends in a URI) returned both. The one page a signed-out visitor sees was the one page without a CSP | `try_files $uri /index.html;` — there is no file at `/_auth/login`, so the first argument never matches and the request re-enters location matching, landing on the `/index.html` rule that carries the six headers and `expires -1`. Re-measured: both present. The case that catches it asserts the login location's fallback is the URI form, and says why |
| 2 | **`proxy_buffering off` — the standard streaming advice — silently disables compression.** The first draft turned buffering off in both directions, as `12-deployment.md` §3 instructed. With buffering off nginx cannot compress what it forwards, so every JSON answer from the API went out uncompressed: measured, a 10,290-byte list arrived with no `Content-Encoding`, and with `Content-Encoding: gzip` the moment `proxy_buffering on` came back. What made buffering dangerous in the first place is its **temp file**, not the buffering: a 773 MB `.osm.pbf` spooled to `/tmp/proxy_temp` at full speed whether or not the client was reading | `proxy_buffering on` + `proxy_max_temp_file_size 0`: in-memory buffering (which is what makes gzip possible) and no temp file ever (which is what made buffering dangerous) — responses are held for the 32 kB of buffers and then passed through with backpressure. Measured: 200 MB through the proxy, worker RSS unchanged at 2.7 MB, zero files in the temp path, and a 10 kB JSON gzipped. `12-deployment.md` §3 now gives the same pair for the outer proxy, with the reason |
| 3 | **`12-deployment.md` §3 documented the bug from item 1.** The routing table an operator reads said `location = /_auth/login { try_files /index.html =404; }` — so the guide was, precisely, an instruction to serve the login page without headers. A reader copying it into the outer proxy would have reproduced it | The snippet is the file's map, with the URI form, the shell and asset locations the file actually has, and four notes: what a fallback URI is for, why buffering is on with no temp file, why `expires -1` and `1y` are split, and why the CSP's upgrade directive is conditional |

The new cases were mutation-checked the way the code is: **33 mutations, all 33 killed** — the modifiers, each of the five
proxy targets, every timeout and limit, the two redirects, each cache policy, each of the six headers, the CSP's conditional,
`X-Forwarded-Proto` collapsing to `$scheme`, a pbf creeping into `gzip_types`, a header escaping to `server` level, a regex
location appearing, and four edits to the guide. The last four survived the first batch: the guide case only checked that the
values *appeared* somewhere in the document, and they appear more than once. It now compares the documented locations as a
**set** against the file's own — documentation drift is a test failure, not a review note.

Probed and found sound rather than assumed — a real nginx 1.29.0 (built here from source with PCRE2 and zlib, since the
sandbox has no package manager) running **this file, unmodified**, over the real API container:

- **The API is proxied, and not rewritten.** `POST /_auth/api/login` returned the API's own `401 INVALID_CREDENTIALS`
  envelope with its `cache-control: no-store`, a real login returned a token, `GET /_auth/api/me` with that token returned the
  profile, `/_admin/api/catalog` answered `503 NOT_READY` (the guard let it through), `/healthz` and `/readyz` answered their
  bodies, a query string arrived byte-identical (`?q=fin&page=2&sort=name%20asc`), and `/_admin/%61pi/catalog` was proxied
  rather than rendered — the percent-decoded path matched the `^~` prefix, as `10-laws.md` requires.
- **Headers arrive, both ways.** The API saw `X-Forwarded-For: 203.0.113.7, 127.0.0.1` (appended, not replaced),
  `X-Forwarded-Proto: https` (passed through), `X-Forwarded-Host`, `X-Real-IP`, and an application header the SPA might one
  day send. On the way back, `/_auth/api/me` carried exactly **one** `content-security-policy` — the API's — because the six
  headers are in the shell location and not at `server` level, where they would have been added a second time.
- **The CSP conditional works in both directions.** Without `X-Forwarded-Proto` the policy ends at `manifest-src 'self'`; with
  `X-Forwarded-Proto: https` it ends `manifest-src 'self'; upgrade-insecure-requests`. The reason it matters: on the
  documented first run the page is plain HTTP on 8080, and that directive would upgrade the bundle's own requests to a port
  with no TLS.
- **Streaming, measured from both ends.** A 3 MB chunked upload reached the API with all 3,000,000 bytes and no `413`; a 200 MB
  response passed through in 0.13 s with flat memory and no temp file; `Range: bytes=2-5` came back `206` with
  `Content-Range: bytes 2-5/10` intact.
- **A stopped API is a `502`, and pages keep working.** With the API process killed, `/_auth/api/me` answered nginx's own `502`
  (HTML, `Server: nginx` with no version) while `/_site/` still returned `200`. The body is deliberately not the API's error
  envelope — the same decision `dev-proxy.ts` records (pass 37).
- **The access log is for the requests an operator reads.** `/healthz` and `/readyz` never appear in it, nor does an asset
  request; a missing asset still appears in the *error* log, which is where it belongs.

## Pass 39 — 2026-10-26 (a config that a non-root process cannot open, and a comment that named a removed mechanism)

Both were found by *running* the thing rather than reading it: one by starting nginx as an unprivileged user, one by opening
a file to edit it and finding its own explanation out of date.

| # | Bug | Fix |
|---|---|---|
| 1 | **`error_log /dev/stderr` would have failed in the container.** The first draft of `docker/nginx.conf` logged errors to `/dev/stderr` — the pattern every container guide shows. Measured on a locally built nginx 1.29.0 started as a non-root user: `nginx: [emerg] open() "/dev/stderr" failed (13: Permission denied)`, because `/dev/stderr` is a symlink to `/proc/self/fd/2` and opening an fd that the process did not create is refused. In Docker the failure depends on how the log pipe was made, which is exactly the sort of thing that works on one host and not the next | `error_log stderr warn;` — nginx's own token for file descriptor 2, which opens nothing and cannot be refused. `access_log /dev/stdout;` stays, because there is no such token for stdout and the entry is required for request logs; the config comment records the asymmetry and why. The case that would have caught it is the probe, so the config's own test asserts `error_log` is the `stderr` token and not a path |
| 2 | **`vite.config.ts` still explained itself with a mechanism `P1-WEB-08` had removed.** The proxy comment read *"Built from `@mapirror/shared`, so the list cannot drift from the route law"* — true of the first draft, dead since the list became a literal because a Vite config cannot import the workspace package (`ERR_MODULE_NOT_FOUND`, pass 37). A reader editing the proxy list next would believe it regenerates from the shared prefixes | The comment now says what is true: the list is a literal in `dev-proxy.ts`, and a test — not an import — pins it to the route law. Found while opening the file for this task, which is the cheapest way to find a stale comment |

Probed and found sound rather than assumed:

- **The official image's defaults cannot run as uid 101.** Reproduced deliberately: a config with nginx's stock paths fails as
  a non-root user with `mkdir() "/var/cache/nginx/client_temp" failed (13: Permission denied)` (and, with the directories
  pre-created but root-owned, the same refusal). That is the whole reason `docker/nginx.conf` sets the pid, five temp paths
  and the logs itself, and why `nginx-conf.spec.ts` fails if any `/var/` path appears in the file.
- **The config was run, not just linted.** A real nginx 1.29.0, built from source in this environment (no daemon, no apt), was
  given the file and the rehearsed runtime tree: `nginx -t` accepted it, it started as uid 1001, `/` answered `200
  text/html`, `index.js` `application/javascript`, `index.css` `text/css`, the font `font/woff2`, a missing asset and a deep
  link both `404`, and the header read `Server: nginx` with no version — `server_tokens off` visible in a response rather
  than only in a file.
- **Both Dockerfiles were executed stage by stage again**, and the rehearsal caught a bug in the rehearsal: a directory
  `COPY` contributes its **contents** to the destination, so `COPY apps/web ./apps/web` merges rather than nesting — the
  first version of the tool nested it one level too deep and the build failed on `Cannot resolve entry module index.html`.
  Worth recording because the same misunderstanding in a real Dockerfile produces exactly that error.
- **A build needs a dev-dependency install.** Measured: 261 packages with dev dependencies, 65 without; the web stage cannot
  use `--production` at all (no vite), the API stage must (no test runner). Two images, two answers, and each test asserts
  its own.
- **The bundle is 588 kB, 145 kB gzipped** — `index.html` 0.73 kB, the JS 435.64 kB, the CSS 113.29 kB, the font 22.28 kB —
  unchanged from `P1-WEB-08`: this task builds what was already there and adds no code to the browser.

## Pass 38 — 2026-10-26 (a test that failed once in four runs, and two tests that proved nothing)

The defect is in the suite, not the app, and it was found by running the gate rather than by reading anything: the same
commit, the same machine, one red run out of four.

| # | Bug | Fix |
|---|---|---|
| 1 | **The sign-out case passed three times in four.** `admin-layout.spec.ts` clicked the menu's sign-out item, awaited `flushPromises()` twice, then asserted the address bar. But the handler cannot `await` its own `replace()` — the revoke request, the store reset and the navigation are a chain of promises the test has no handle on — so "two flushes" is a guess about how many microtask turns that chain needs. Measured: 1 failure in 4 runs of the file (`expected '/_site/admin/jobs' to be '/_auth/login'`), and the same case passed on every rerun, which is exactly what makes a flake expensive: the next person to see it assumes their own change broke something | The route assertions are inside `vi.waitFor()`, the rule the router cases in this repository already follow for a commit the test does not drive. The state assertions (store empty, storage cleared) stay outside it, because they are true the moment the click returns. 5 consecutive runs of the file, then the whole gate, green |
| 2 | **The credential scan let a database URL through.** The case that forbids baking a secret into `ARG`/`ENV` filtered the *names* for `PASSWORD`, `SECRET`, `TOKEN` and `_FILE` — so `ENV DATABASE_URL=postgres://mapirror:mapirror@db:5432/mapirror` sailed past it, which is precisely the mistake that gets made: the DSN looks like configuration, and it holds the password in the clear. Found by the mutation batch, not by reading: the mutation that adds it changed no test | Two checks instead of one. `DATABASE_URL` and `DSN` join the name list, because compose derives the DSN from `POSTGRES_PASSWORD` at run time and a copy in the image is a copy nobody rotates; and a second check looks at the **shape** of every value — `scheme://user:password@host` is a credential whatever the variable is called. Both mutations now fail |
| 3 | **The `.dockerignore` matcher's `!` rule was untested, so a broken one passed.** `check-hygiene` asserts that secrets are excluded and that the files an image needs are kept; neither list contains the one line that needs a re-include (`!.env.example`), so `excluded = !negated` could be changed to `excluded = true` — every path excluded — with the whole gate green. The gate was not lying; it was answering a question nobody had asked | The matcher now has its own cases (`scripts/tests/dockerignore.spec.ts`, 11): the real file's keep/exclude lists, the template that must survive `*.env`, and the rules themselves — last match wins, `!` re-includes in order, `*` never crosses `/`, `**` does, a trailing slash covers a directory, `?` is one character, dots are escaped, comments are not patterns. Six mutations of the matcher, six failures |

Probed and found sound rather than assumed:

- **`bun install --production` hoists nothing.** The first draft of the Dockerfile copied `/app/node_modules` and nothing else,
  on the assumption that a production install is a flat tree. Measured in a staging copy: the store lands in
  `node_modules/.bun` and the *workspace's* dependencies are symlinked into `apps/api/node_modules` — so the image needs
  three copies, and the version that copied one would have booted and then failed on `Cannot find module 'fastify'`. The
  test now names all three by path.
- **The Dockerfile's stages were executed, not merely read.** With no daemon in this environment, `docker/api.Dockerfile`
  was parsed and its `COPY`/`RUN` lines replayed into a scratch tree (`/tmp/dockersim`): the install ran, the tree came out
  at 27 MB, the API booted from it (`/healthz` 200, `/readyz` 200 with `database`/`cache` ok, `/_auth/api/me` 401), SIGTERM
  produced `{"msg":"shutting down"}`, and `scripts/migrate.ts` and `scripts/init-admin.ts` ran from inside it. That is what
  the "it boots" claim rests on until `P1-DOCK-05` builds the real image on a Docker host.
- **`--frozen-lockfile` tolerates the missing web workspace.** `apps/web/package.json` is deliberately not copied into the
  API image; bun answers with a note (`skipped 1 workspace listed in bun.lock but not on disk: "@mapirror/web"`) and exits 0.
  Worth knowing before someone reads that line in a build log as a failure.
- **`.dockerignore` matching is now one implementation.** The Dockerfile test needs the same answer the hygiene check does
  ("would this path be in the build context?"), so the matcher moved to `scripts/lib/dockerignore.ts` and both import it.
  Two copies of an ignore-file rule is two answers, and the one that disagrees is always the one that is not running.

## Pass 37 — 2026-10-26 (a config that could not load, and two documents that had stopped being true)

Two are in the dev-server config and could not be seen by any unit test — one needed `bun run dev`, the other the warning
printed on that same start — and two are documents that went on describing the world before `P1-WEB-02`…`08` changed it.

| # | Bug | Fix |
|---|---|---|
| 1 | **The proxy map could not be imported from `@mapirror/shared` — the dev server would not start.** The first draft of `dev-proxy.ts` built its contexts the obvious way, `[...API_PREFIXES, PROBE_PATHS.health, PROBE_PATHS.ready]`. Vite bundles `vite.config.ts` but leaves packages in `node_modules` **external**, and a workspace package is one of them: the config loads, then Node's own ESM resolver reads the workspace package's extensionless relative imports (`export * from './auth'`) and gives up. The two halves of `bun run dev` then disagree — the API starts and logs as usual while the web half exits 1 with `ERR_MODULE_NOT_FOUND: Cannot find module '…/packages/shared/src/auth'`. No unit test could see it: vitest *transpiles* the workspace package, so every test that imported the constant passed | The list is a literal in `dev-proxy.ts` with the failure recorded beside it, and the guarantee an import would have given is now a test: `dev-proxy.spec.ts` runs where the workspace package **can** be imported and asserts `PROXY_CONTEXTS` equals `[...API_PREFIXES, PROBE_PATHS.health, PROBE_PATHS.ready]`, so a namespace added to the route law fails until the list follows. And a second, end-to-end spec boots a real Vite dev server against a stub API, which is the only kind of test that runs a config the way Vite does |
| 2 | **The helper imports were extensionless, which Vite 8 warns about and Vite 9 will not load.** `./alias` and `./dev-proxy` in `vite.config.ts` produced, on every dev start, `configLoader: 'native'` is now the default — a warning that the config is being read through a path that is being removed. It is the same class as #1: the config's *module graph* is not the app's | The two imports carry `.ts` (`./alias.ts`, `./dev-proxy.ts`) and `apps/web/tsconfig.json` sets `allowImportingTsExtensions` — safe because the repo is `noEmit`, and `vue-tsc` then typechecks the config exactly as Vite reads it. The start is silent again, and the same warning cannot come back unnoticed |
| 3 | **`09-development.md` described a dev server that talks to nothing.** Its status note still read *"until `P1-WEB-08` wires the dev proxy, the SPA in development talks to nothing"* — true when `P1-WEB-01` was the last task and false since six of them landed: the theme, the router, the guard, the login page and the admin shell are all in, and from this task so is the proxy. A reader would have believed the documented flow was broken, and the guide's own "under 10 minutes" claim with it | The paragraph now says what a reader can actually do — sign in against the real API on `/_auth/login` and walk a shell whose screens are placeholders naming the task that owns them — and names the one stub (`P3-API-03`) that still answers `503 NOT_READY` |
| 4 | **`02-architecture.md`'s deployment diagram proxied the page prefixes.** The nginx hop was labelled `proxy /_auth, /_admin, /_public, /healthz` — the exact shape `09` §3 and the dev proxy's own comment exist to forbid, where `/_auth` swallows the **login page** and only production's location order saves it. `12-deployment.md` lists `^~ /_auth/api/` and `= /_auth/login` separately, so the two documents disagreed | The label (and the browser arrows) name the three `*/api` prefixes plus `/healthz`, which is what the container does |

Probed and found sound rather than assumed:

- **A dev tool refuses to mint the API's error codes.** The error handler was first written to answer `503` with the shared
  error envelope, which is what a "service unavailable" looks like — except `SERVICE_UNAVAILABLE` is not one of the 25 codes
  in `04-api.md` §0.2, so the tool would have invented server behaviour for the browser to parse. It answers `502
  text/plain` with a sentence instead, and the tests assert the body is **not** JSON.
- **The double slash is a test bug, caught by running the test.** `server.resolvedUrls.local[0]` ends in `/`; joining it with
  a path that also begins with `/` produced `//_auth/api/me`, which matches no `startsWith` context, falls through to the SPA
  fallback, and answers `200 text/html` — a test that reads the index page while believing it read the API. One `url()`
  helper does the join, and the server's trailing slash is asserted where it is assumed.
- **The proxy does not slow the suite.** The end-to-end spec is five cases in about 1.5 s on ephemeral ports (`port: 0` for
  Vite, `listen(0, '127.0.0.1')` for the stub), so it cannot collide with a developer's running server or with a CI job.
- **Vite's string contexts are prefix tests, on the raw path.** `/_public/api/countries` matches only because the context is
  the complete prefix; `/_auth/api` does not match `/_auth/login`. The route-table walk that asserts no page path begins
  with a context is therefore the rule, not a decoration.

## Pass 36 — 2026-10-26 (a rule that matched nothing, and two behaviours Vuetify already owned)

All three were found while building the admin shell, and two of them were found *by the process* rather than by reading:
one by a probe that looked for the class a CSS rule hangs on, and one by a mutation that changed nothing.

| # | Bug | Fix |
|---|---|---|
| 1 | **The 360 px rule hid nothing.** `styles/shell.css` hid the breadcrumb trail on the narrowest phone §3 names with `.mm-admin-topbar .mm-breadcrumbs` — an ancestor class the layout never rendered (the app bar has no custom class at all). The selector matched no element, so on a 360 px screen the trail stayed in the topbar beside the menu button, the search field and the user menu: exactly the row that overflows. Measured with a probe: `.mm-admin-topbar` present: **false**, `.mm-breadcrumbs` present: true. Nothing could have caught it — jsdom computes no CSS, and the typecheck sees strings | The rule names `.mm-breadcrumbs`. A new case walks **every class the stylesheet styles** (comments stripped) and asserts the mounted shell renders one, so a rule with no target fails a test; and a second case reads the media query itself and fails if its selector gains an ancestor class again. Mutation — restoring the dead selector — fails both |
| 2 | **Two responsive behaviours were written twice, and the copies were dead.** The drawer passed `:temporary="mobile"` and carried a `watch(mobile)` that re-opened or closed it on a resize, with a comment claiming that watcher is what keeps a phone's page uncovered. Vuetify computes `isTemporary` as `!permanent && (mobile \|\| temporary)`, already closes a temporary drawer on **every navigation** (`watch(router.currentRoute)`), and already re-opens or closes it when the breakpoint is crossed (`watch(isTemporary)`). The mutation that deleted the watcher changed nothing — which is how the duplication surfaced | Both removed. The shell states only what is its own decision (which is open to begin with), and the three behaviours Vuetify supplies are **asserted** — the drawer is closed at 360 px, opens as a temporary overlay, closes after a navigation, and is back on a desktop at 1025 px — so an upgrade that drops one fails a test instead of stranding a phone behind a panel |
| 3 | **`13-ui-ux.md` §3 listed a control that §1 makes dead.** The admin topbar was specified to hold a "theme toggle", while §1 fixes the admin area to the dark theme "always — a control room at 02:00 is not a place for a white page". A toggle there could only do nothing, and "no dead clicks" is §6's first line. The per-visitor theme override §1 does allow belongs to the **public** shell (`P3-WEB-01`) | §3's bullet now says where the toggle lives and why the admin has none, and the shell's topbar carries breadcrumbs, the catalog search and the user menu. `13-ui-ux.md` §3 also records the two **badges** as owed: a dot on Jobs and a counter on Catalog need `P2-WEB-06` and `P2-WEB-01`, and a badge hard-coded to `0` claims the queue is empty |

Probed and found sound rather than assumed:

- **A closed drawer is not a trap.** Vuetify renders `inert` on a drawer that is not active (`VNavigationDrawer`), so the
  nine links inside it are not in the tab order while it is closed — a phone cannot Tab into an invisible panel.
- **`aria-controls` resolves with the drawer closed.** The element stays in the DOM (`<nav id="mm-admin-drawer">`), so the
  menu button never points at an id that is not there.
- **An admin 404 keeps the shell.** `/_site/admin/nope` classifies as the admin area (`theme/policy.ts`), so the not-found
  page renders *inside* the shell with the trail "Dashboard › Not found" and the sidebar still available — the reader can
  see the URL was wrong without losing the way out.
- **The public home grows no shell.** The area branch in `App.vue` renders the bare `v-main` there: measured, no
  `.v-navigation-drawer`, no `.v-app-bar` and no skip link on `/_site/`.
- **The main region is offset by the bar.** With the bar mounted, `v-main` carries `--v-layout-top: 64px` — the number
  §3's diagram gives, asserted against the document in the tests.

## Pass 35 — 2026-10-26 (a button nobody could see)

One defect, found by reading the *built* artefact rather than the source: the page, the tests and the typecheck were all
happy with a control that does not exist on screen.

| # | Bug | Fix |
|---|---|---|
| 1 | **The show/hide control was an icon the app cannot draw.** `LoginPage` used `icon="mdi-eye"` on a `v-btn`. The app has no `@mdi/font`, `index.html` loads no icon set, and the built stylesheet contains **zero** `.mdi` rules — so Vuetify rendered `<i class="mdi mdi-eye">` with nothing inside it: an empty 32 px square beside the password field. The `aria-label` made it discoverable to a screen reader and invisible to everyone else. The same measurement caught Vuetify's **default** icon on the error alert (`mdi-close-circle` in `v-alert__prepend`) — an empty box occupying layout beside the message. The page's own tests passed, because jsdom has no CSS and `button[aria-label="Show password"]` was in the DOM exactly as asked | The toggle is a labelled text button whose visible label says which way it goes ("Show" / "Hide", the same decision `ToastHost.vue` took for its "Dismiss" button and for the same reason), and the alert turns Vuetify's default icon off (`:icon="false"`) instead of leaving a gap. New case: the page must render **no `.mdi` element** in either state — idle, and with a failed sign-in on screen — so the next icon name fails a test instead of shipping an invisible control. Mutation — restoring `icon="mdi-eye"`, or dropping `:icon="false"` — fails it |

Probed and found sound rather than assumed:

- **Enter is structural, and the structure is asserted.** jsdom does not turn a key press into a form submission, so the
  cases drive `form.requestSubmit()` — the exact event a browser fires for Enter and for a click — and a separate case
  asserts what makes it work: both fields inside a `<form>`, a `type="submit"` button inside that form, and no key
  handler to keep in step. The button's own `.click()` path is tested too.
- **`role="alert"` is the page's, not only Vuetify's.** Vuetify's `VAlert` already emits it (measured: three
  `[role="alert"]` nodes — the alert and two empty `v-input__details`), so removing the page's own attribute changes
  nothing. The attribute stays as the page's guarantee, and the mutation is recorded as **provably equivalent** rather
  than counted as killed.
- **The retry clock is a deadline, not a counter.** A `429` carries `retryAfterSeconds`; the page stores the instant it
  lifts and renders `m:ss` from `Date.now()`, so a throttled background tab (timers coalesced to once a minute) cannot
  promise a retry that is still an hour away.
- **A failed sign-in is not a sign-out.** `POST /_auth/api/login` answering `401 INVALID_CREDENTIALS` reaches the page as
  an `ApiError` whose `sessionEnded` is false, and the request carried no credential by rule, so the client's policy does
  not fire: no cleared token, no navigation, the typed pair still in the fields.
- **A leak in the suite, not in the app.** The first run of the end-to-end case failed on the address bar. The cause was
  a `Storage.prototype.setItem` spy installed by the "browser will not keep the session" case and never taken down:
  `vi.restoreAllMocks()` is now in the file's `afterEach`, because a spy on a prototype outlives the case that needed it.

## Pass 34 — 2026-10-26 (two answers that arrived too late, and a token that was already gone)

Both defects are the same shape, and both were found by *writing the code that could have them* rather than by reading
it: a promise is resolved against a session that has moved on in the meantime. The trigger is ordinary — signing out
while the page is still loading — and the damage is silent, because every guard and every request still behaves.

| # | Bug | Fix |
|---|---|---|
| 1 | **A `/me` that landed after a sign-out put the profile back.** `restore()` awaited the request and then wrote `admin`/`expiresAt` unconditionally. A reader who presses "sign out" (or whose token dies) while the boot-time `/me` is in flight got a store with **no token and a full profile**: `isAuthenticated` false, so nothing refused a request or blocked a route, and the topbar cheerfully showed the name of the admin who had just signed out. Measured on the probe: `outcome 'session'`, `token null`, `admin { id, username }` | `restore()` captures the token it asked about and, after the `await`, applies the answer **only if that token is still the session's**. A superseded answer changes nothing and reports what is true now: `signed-out` when the store is empty, `unverified` when a newer token has replaced it. Mutation — making the check a no-op — fails the new case |
| 2 | **A `401` for an old token signed out the new one.** The same race, from the other side, and worse: a request made with token A answers `401` after the reader has signed in again as token B, and the handler called `forget()` — clearing **B**, a credential the server had just issued. The reader is thrown back to the login form for no reason they can see, and a second attempt works, which is exactly the shape of a bug that gets reported as "it sometimes logs me out" | The same guard covers the failure path: a refusal is only acted on when the token it refused is still the token in the store. Two cases (sign-out mid-flight, sign-in mid-flight), and a mutation that removes the guard fails both. The pair is the whole rule: **an answer belongs to the session that asked for it** |

Probed and found sound rather than assumed:

- **A session that cannot be persisted is still a session.** With `Storage.prototype.setItem` throwing (private mode, a
  full quota), `signIn` returns `false` and the tab stays signed in — the store holds the token, the client sends it, and
  a reload is the only thing lost. The alternative (discard the session) turns a successful login into "nothing
  happened", which is what the acceptance criterion's "refresh keeps session" would be read to forbid.
- **An unanswered `/me` is not a refusal.** `NETWORK`/`TIMEOUT`/`MALFORMED` leave the session and the profile intact and
  report `unverified`; only the four `SESSION_ENDED_CODES` (and an unreadable `401`) end it. Signing out because a train
  went into a tunnel is the same bug as #1 with a friendlier cause.
- **The revoke is sent before the state is cleared, and the order is load-bearing.** `createApiClient` reads the token
  from the store while the request is being built, so a sign-out that cleared first would send
  `POST /_auth/api/logout` with **no** `authorization` header — a live session on the server that the screen says is
  over. The test asserts the header on the recorded request, so a future reorder fails instead of passing.
- **A `200` whose body is not a profile is not a sign-out.** The body crossed the network, so it is parsed with the
  shared `MeResponseSchema` (a body with a non-UUID id fails), and the session survives: `unverified`, no invented admin.
- **An existing test asserted the world before this task.** `use-api.spec.ts` wrote `sessionStorage` *after*
  `createWebApp()` and expected the policy to fire. With the store as the source of truth that is a token the session
  never held, so the case now signs in through the store — which is also the only path a reader can take.

## Pass 33 — 2026-10-25 (borrowed colours, a latch on the wrong token, and a handler that could rewrite the verdict)

Three of these are values nobody in this repository chose: two colours Vuetify supplied and one `fetch` default. Two are
seams that did not line up — a predicate comparing the wrong string, and a latch watching a different token than the
request sends. One is a `catch` in the wrong place. The last is a number that had been wrong for seven passes. All
seven passed a green suite, because the suite was asking our own code questions. They were found by probing the running
app — reading `useTheme().themes` out of two mounted apps, calling the client's predicates with real URLs, throwing
from a callback — not by reading the source again.

| # | Bug | Fix |
|---|---|---|
| 1 | **Vuetify's Material palettes shipped *under* ours.** `createVuetify` deep-merges its own light and dark palettes beneath whatever `themeFrom()` returns, so every key the module did not name kept a colour from another design system — invisible to a source scan, because no file in `apps/web/src` contains it. Measured on the two shipped themes: `info` was `#2196F3` in **both**, *and* had no `on-info`, so Vuetify derived the label by APCA — the exact model `tokens.ts` exists to avoid; dark `surface-bright` was **`#ccbfd6`**, a lavender "bright surface" in a control room; `surface-light` was `#EEEEEE`/`#424242`; `on-surface-variant` in the light theme was `#EEEEEE` — near-white ink on a `#F6F7F9` card, **1.04:1**; `secondary-darken-1` was a Material teal (`#018786`/`#48A9A6`) while our `secondary` is indigo | The module now names all seven. The surfaces alias `surface-variant`, the ink aliases `text-primary`, `secondary-darken-1` aliases `secondary`, and `info` — a state §2 does not define — is an **alias of `secondary`** with `on-info = bestOn(secondary)`, rather than a fourteenth colour invented in code. `tokens.spec.ts` walks **every key of every shipped theme** and fails on any value outside §2 (white and black excepted: they are the computed labels), so the next Vuetify default cannot slip back in through a key nobody looked at. Mutation — deleting the alias block — fails 2 cases |
| 2 | **The neutral toast was painted in a colour the document does not define.** `ToastHost`'s `colorFor` answered `'info'` for the neutral kind. `13-ui-ux.md` §2 names thirteen colours and `info` is not one of them, so in practice the fill was Vuetify's blue (finding 1) — the one surface in the app that would have changed hue if Vuetify's defaults ever changed, and the only one §2 could not describe | Now `primary`. `surface-variant` was the other candidate and is 1.05:1 against the page in the light theme, i.e. no toast at all. The test asserts the class each kind renders — `bg-error`, `bg-success`, `bg-primary` — and asserts **`bg-info` is absent**, so re-introducing the undefined name fails. §2 now says the palette is closed and `info` is an alias, and `09-development.md`'s table has the row ("a state §2 does not name → the nearest documented key") |
| 3 | **`needsBearer('/_auth/api/login?next=/x')` was `true`.** The login exception compared the *raw* path with the login path, so the exact shape the router produces — a signed-out visitor sent to the form with `?redirect=…`, whose login then carries `?next=…` — did not match, and the request that **mints** a credential was sent with the stale one it was replacing. A revoked token would therefore be attached to the very call that would have issued a fresh one | `pathOnly()` strips the query and the fragment before classification, so the predicate answers about the endpoint, not about the URL's suffix. Two cases added (query string, fragment), and the Bearer matrix keeps its negative half — the public API still gets no header. Mutation — `pathOnly` → the raw path — fails 1 case |
| 4 | **The API client sent cookies, in a comment's own words it did not.** `api/client.ts` passed `credentials: 'same-origin'` under a comment promising no cookies. Behind nginx the SPA and the API are **one origin**, so `same-origin` means: attach every cookie on every admin call, and accept `set-cookie` from every answer. That is the ambient credential `14-security.md` §6 relies on not existing when it calls CSRF "not applicable" | `credentials: 'omit'`. The test asserts the request init the client actually passes, and `14-security.md` §3 (browser storage) now states the rule and why the default is wrong here. The client's JSDoc says the same, so the next reader does not "restore" the default |
| 5 | **The sign-out latch watched a token the requests do not use.** `createAppApiClient` wrote its "already signed out" latch to `sessionStorage` — while the token it sends comes from the injected `token` provider. Once `P1-WEB-05` backs that provider with the store, a `401` ends a session on screen that has not ended: the latch is set, so no further ending is reported, and the reader gets **no toast and no navigation** — every subsequent request just fails | The factory takes a `clearToken` option paired with `token`: the latch reads `readToken()` (whatever source the client sends from) and the clear goes through `forgetToken()`. Two cases — an injected provider and the `sessionStorage` default — each assert one toast, one navigation and an emptied source. Mutation — `readToken`/`forgetToken` back to the session store — fails both |
| 6 | **A throwing `onSessionExpired` was reported to the caller as `NETWORK`.** The policy call sat inside the same `try` as the fetch, so an exception from the handler was caught by the wrapper and relabelled: a request that answered `401 TOKEN_EXPIRED` arrived at the screen as *"the server could not be reached"*, with the API's code, message and request id gone. The screen would then advise checking the connection about a session that had expired — and the handler, being broken, had not signed anyone out | `notifySessionExpired()` runs the caller's policy **after** the error is already typed, and catches: a bug in a UI callback is reported to the console and nothing else. The test throws from the handler and asserts the caller still receives `TOKEN_EXPIRED`/`401` plus exactly one `console.error`; mutation — the bare call — fails it. The client clears nothing by itself: clearing and navigating belong to the policy in `api/index.ts`, so a throw there is the one failure the client cannot fix and must not conceal |
| 7 | **`00-index.md` advertised a tally seven passes out of date** — "25 passes, 125 defects fixed" against the changelog's 32 and 143. The index is the one page a reader sees before the record, so a stale number there is the record being wrong | The line is now generated by hand at the same time as the changelog's totals, and both say the same thing |

Probed and found sound rather than assumed:

- **A tab or newline smuggled into `redirect` is not an open redirect.** `safeRedirectTarget('/_site/admin/\t//evil.example')`
  keeps the tab and resolves to `https://mirror.example/_site/admin///evil.example` — the same origin, because the value
  is parsed as a path and `//` only becomes a host at the start of a URL. Probed with the real function; no fix, and the
  probe is recorded here so the next pass does not "fix" it into a bug.
- **A success toast does dismiss.** The error path's `timeout: null` (pass 32) is only the error path: under fake timers
  the success toast disappears after its documented 3 s. Two kinds, two policies, both measured.
- **`/_auth/api/login` with no header really is a fresh session.** With finding 3 fixed, the login request carries no
  credential *and* the response is still read as an envelope — the negative half of the bearer matrix, re-run.

## Pass 32 — 2026-10-25 (the API client: an invisible toast, a composable that failed open, and a key that exists nowhere)

Two of these are the kind that a green test suite hides: one made an error message vanish before it could be read, and one
turned the "you forgot to wire this" error into `undefined`.

| # | Bug | Fix |
|---|---|---|
| 1 | **An error toast was marked `timeout: 0`, which Vuetify reads as "dismiss on the next tick".** `13-ui-ux.md` §5 says errors persist with a close button, and `stores/notifications.ts` expressed that as `error: 0` — the obvious spelling, and the wrong one: `VSnackbar`'s `startTimeout()` schedules `setTimeout(…, Number(props.timeout))`, so `0` is *immediate* and only `-1` means "never". The toast therefore existed between the render and the timer: visible in a test that asserted immediately after mounting (which is how it passed its own review), invisible to a person. Caught by probing rather than by reading — five identical probe runs reported `snackbars=0` while a near-identical probe that logged sooner reported `1` | The store now models "until dismissed" as `null` and the host maps it to Vuetify's `-1`, with the framework's magic number kept in the component that uses the framework. The regression test waits **real time** after mounting before looking, and it fails when the `0` is restored (checked: 2 failures — this test and the store's own). 84 client tests now include it |
| 2 | **`useApi()` failed open.** It read `inject(API_CLIENT_KEY, null)` and threw when the result was `null`; Vue returns **`undefined`** for an unprovided key *and* when `inject()` is called outside a component. So the one case the composable exists for — an app assembled without a client — returned `undefined` to the caller, and the failure would have surfaced later as `Cannot read properties of undefined (reading 'get')` in a file nobody was editing | `inject(API_CLIENT_KEY)` with an `undefined` check, and both cases tested (outside a component, and inside an app that forgot `provideApiClient()`). Mutation — restoring the `null` shape — fails both |
| 3 | **`05-flows.md` F2 named a `sessionStorage` key that the code does not use.** The sequence diagram said `sessionStorage.setItem('mm.token')`; `auth/token-storage.ts` writes `mapirror.session.token`, and that name is the one `SESSION_TOKEN_KEY` exports and the tests assert. A reader following F2 would have cleared the wrong key and left the session alive | F2 now names the real key and says where it is defined, and the rules paragraph was extended with the two things the diagram could not carry: which requests get the header, and that `403 ACCOUNT_DISABLED` ends a session |
| 4 | **The documented sign-out rule missed a case that has the same consequence.** F2 said "`401` anywhere ⇒ clear state + redirect". `ACCOUNT_DISABLED` is a **`403`**: the account is deactivated, no retry of that token will ever work, and following the rule literally leaves a deactivated admin on an admin page full of `403`s with a token the app keeps presenting. `FORBIDDEN` shares the status and must *not* sign anyone out | `SESSION_ENDED_CODES` has four members — the three `401` verdicts plus `ACCOUNT_DISABLED` — and the doc says so and why (`05-flows.md` F2, `09-development.md` §9). Tests cover all four endings, the wrong-password non-case, the `FORBIDDEN` non-case, and an unreadable `401` from a proxy (which still ends the session, because the credential is still refused) |

Probed and found sound rather than assumed:

- **The timeout has to cover the body, not just the headers.** `fetch()` resolves when the headers arrive; a server that
  sends `200` and then stalls mid-body is the same outage to the reader as one that never answers. The budget is cleared
  in the `finally` of the whole read, and a mutation that aborts nothing makes the timeout test hang — killed.
- **A cancellation is not an outage.** A screen that navigates away aborts its requests; reporting that as "the server
  could not be reached" would put a false toast on the next page. `ABORTED` is its own code and it never reaches the toast.
- **`204 No Content` is success.** `POST /_auth/api/logout` answers with an empty body; a client that parses it throws,
  and a sign-out that throws is a sign-out nobody believes happened.
- **A query string can already be there.** Pagination and filters are usually added to a path that came with one
  (`?tab=versions`); a second `?` would produce a parameter literally named `?page`, which the server silently ignores.
- **The store's dedupe hides a real difference, so the burst test needed a second assertion.** Five identical refusals
  produce one toast *because the store merges identical sentences* — so the toast count alone cannot prove the sign-out
  handler ran once. The test now also counts `router.replace` calls, and a burst with two *different* refusal codes
  (whose details the store keeps apart) pins it from the other side. Mutating the latch away fails both.
- **Vuetify's overlay is a race in a full-suite run, not in isolation.** `v-snackbar` teleports into
  `.v-overlay-container` and only renders after a frame; a `flushPromises()` and an assertion passed alone and failed
  once among 900 other tests. The host tests poll with `vi.waitFor` instead of guessing a delay, and stayed green over
  repeated full runs.

Mutation-checked: 20 mutations, **all 20 killed** — the Bearer attached to every path (including `/login`), the public API
handed the token, a page path fetched as an API, sign-out fired without a credential, a cancellation reported as an
outage, the budget expiring without aborting, cookies included, a second `?`, `INVALID_CREDENTIALS` in the session-ended
set, an unreadable `401` no longer ending a session, the server's sentence replaced by a generic one, the redirect removed,
the destination dropped from it, the burst latch removed, the `0` timeout restored, the dedupe inverted, the burst cap
removed, `useApi()` failing open again, `bootstrap.ts` no longer providing the client, and the host mapping `0` instead of
`-1`.

---

## Pass 31 — 2026-10-25 (the router tree: a title that named itself twice, and a task board with two holes)

The pass arrived with `P1-WEB-03`, whose whole job is to make `13-ui-ux.md` §4 and the router the same list. Three of the
four defects below were found by writing the tests that claim it; the fourth by a test that had to be *rewritten* because
the world it described had stopped existing.

| # | Bug | Fix |
|---|---|---|
| 1 | **A route with no title put `MapMirror · MapMirror` in the tab.** `installRouteTitles` fell back with `pageTitle(title ?? TITLE_SUFFIX)` — the fallback was passed through the same formatter that appends the suffix, so the product name was appended to itself. Nothing reachable from `APP_ROUTES` has no title (the `RouteMeta` augmentation makes it a type error), which is exactly why it survived review: the branch is only reachable from an un-navigated router or a redirect-only record, and it was caught the first time a test executed it | `title === undefined ? TITLE_SUFFIX : pageTitle(title)`, with the reason in a comment and the branch pinned by `tests/titles.spec.ts` ("writes the fallback for a route with no title", plus the teardown case). Mutation — restoring `pageTitle(title ?? TITLE_SUFFIX)` — fails both |
| 2 | **Two screens had no task.** `13-ui-ux.md` §4 S13 (Settings) and S14 (Audit) were named as owners by nothing: `08-tasks.md` had no `P5-ADM-02` or `P5-ADM-04` row, so the two screens were in the router, in the screen inventory, and owed by nobody. The route meta had to invent the ids to fill its required `owner` field, and the new law test — which asserts that every owner id exists — failed on the first run. The board claimed **136** tasks, `08-tasks.md` held 136 rows, and §4 documented 15 rows of which 13 named an owning task that existed | Four rows added to Phase 5 — `P5-ADM-01`/`P5-ADM-02` (settings API + page) and `P5-ADM-03`/`P5-ADM-04` (audit API + page), because a page whose API is another task's is the same kind of hole — and the totals recounted: **140** tasks in `08-tasks.md` line 3 and `00-index.md` line 42, both verified by counting the status-bearing rows (140 rows, 31 done, no duplicate ids) |
| 3 | **Two tests asserted the world before the router existed.** `bootstrap.spec.ts` carried *"has no catch-all yet, and says so by not matching"* — true when `P1-WEB-01` registered one route, false the moment `P1-WEB-03` added `/_site/:pathMatch(.*)*`, and it would have failed with a message about `matched` being empty that reads like a router bug. Its neighbour, "keeps every route inside the site prefix", would have failed too, on `/_auth/login` — the one page L1 *allows* outside the site | Both rewritten to the contract that now holds: an unknown path under the site renders the not-found page **at the URL that was asked for**; a path outside the site is redirected *into* it; and every route outside `/_site/**` must be a redirect whose target is a page. The rewrite is the interesting part — a test that fails when a planned feature lands is a test that was written as a snapshot of the schedule |
| 4 | **`theme.spec.ts` was about to start testing the login page.** Six of its cases navigated to `/_site/admin/…` through `createAppRouter()` to read the admin theme off `theme.global.name`. Once the router grew its guard, every one of those navigations began landing on `/_auth/login` — a light page — so the cases failed with "expected `light` to be `dark`", a message that points at the palette. Worse in the other direction: had the assertion been written the loose way (`is a theme name`), the whole file would have gone on passing while testing nothing | Those cases now build a router from the real table **without** the guard — the theme is a function of the path, and auth is not this file's subject — and the mounted-app section gained the pairing case that matters: with a token in `sessionStorage`, a deep link to `/_site/admin/catalog` mounts `v-theme--dark` **and** renders screen S6. The two locks are now in two files, each testing its own rule, and the cross-file failure that revealed it is recorded here |

Probed and found sound rather than assumed:

- **`//_site/admin` cannot be a page path, so the `//` check in `safeRedirectTarget` is provably redundant.** The law
  refuses every value beginning `//` (it can never start with `/_site/` or equal `/_auth/login`), so removing the check
  changes no answer — the mutation is *equivalent*, not surviving. Both locks stay, and `tests/redirect.spec.ts` asserts
  the redundancy (`isPagePath('//_site/admin') === false`) rather than leaving a fantasy mutant in the report. The
  backslash check, by contrast, **is** load-bearing — `/_site/admin\..\..\evil` passes the law and fails the check —
  and that case was added after the mutation survived.
- **`/_site` without its slash is a page, because Vue Router says so.** `strict: false` matches it to the `/_site/`
  record, so `safeRedirectTarget` accepting it is correct rather than a hole; the test proves it by resolving it through
  a real router (name `home`) before asserting it survives, instead of writing the expectation I first assumed.
- **The `redirect` parameter is a query parameter, so it is `unknown`, not `string`.** Vue Router parses `?redirect=a&b`
  into an array and `?redirect[x]=y` into an object; `.startsWith` on either throws inside a navigation hook, which is a
  console error and no page. Four non-string cases pin the type check.
- **A blocked `sessionStorage` throws on the property, not on the call.** Driven through both shapes — the global itself
  throwing (privacy mode) and a store whose every method throws (frames) — and the sign-out path is asserted not to throw
  either, because it runs in the same click as a working clear.

Mutation-checked: 12 mutations, 11 killed (the twelfth equivalent, see above) — the admin check deleted from the guard,
`to.path` instead of `to.fullPath`, protocol-relative URLs allowed, the backslash check deleted, the login-page loop
allowed, the length bound widened to 2048, the default redirect moved to the catalog, the double-suffix title restored, a
page moved to an undocumented path, a blank token treated as a token, the read's `catch` removed, and the catch-all moved
outside the site.

---

## Pass 30 — 2026-10-25 (design tokens: a boundary that failed its own rule, and a shared URL)

The first defect is the kind this project exists to catch: a document that states a rule, a token that breaks it, and
no test between them.

| # | Bug | Fix |
|---|---|---|
| 1 | **The token the document named for "input borders" was 1.25:1 — the same document promised ≥ 3:1.** `13-ui-ux.md` §2 listed `border` as "Dividers, input borders" and, two lines later, required "≥ 3:1 for large text and UI borders". Measured: `#E3E6EA` on `#FFFFFF` is **1.25:1**, `#262B35` on `#0F1115` is **1.33:1**. So the palette and the rule disagreed, and the first login form or settings switch built on that token would have had a boundary a third of the required contrast — invisible at 200 % zoom, in bright light, to anyone with low vision. Neither is wrong on its own: a hairline divider *should* be 1.2:1, and WCAG 1.4.11 asks 3:1 only of boundaries "required to identify user interface components and states" | The token is split by meaning rather than by shade. `border` stays 1.2:1 and its documented use is now "Decorative division: table rows, section rules"; `border-strong` is new — **#7C848C** (3.79:1 on the page, 3.54:1 on a card) and **#6B7280** (3.91:1 / 3.60:1 dark) — and is the one for input outlines, switch tracks and focus-adjacent edges. The doc now says which is which and why, with the numbers, and `tests/tokens.spec.ts` asserts both halves: every meaningful boundary ≥ 3:1, and `border` *below* 3:1 **with** the sentence that exempts it — so a future edit cannot quietly promote the hairline to an input, or make the hairline heavy to satisfy a misread rule |
| 2 | **One test's navigation decided the next test's theme.** `createWebHistory()` reads `window.location`, and jsdom has exactly one — so a case that pushed `/_site/admin/catalog` left the following case's brand-new router starting there. Since the theme now follows the route, a fresh app mounted **dark** on the public home page, and the failing assertion ("expected `v-theme--light`") read like a bug in the theme policy. It is a harness defect with teeth: every later route test would inherit whatever URL ran before it | `apps/web/tests/setup.ts` resets the URL in `afterEach` (`history.replaceState({}, '', '/')`) beside the `matchMedia`/`ResizeObserver` stubs. Proved by mutation: deleting that one line fails `wears the light theme on the public page`, and nothing else |

Probed and found sound rather than assumed:

- **The `on-` label colours are ours, not Vuetify's.** Vuetify derives a missing `on-<color>` with `getForeground`, which
  decides by **APCA** against a 50-unit cutoff — not WCAG. Measured: it happens to pick black for the dark theme's
  pastels and white for the light theme's fills, so today's palette would pass either way; but the contract in §7 is
  4.5:1, so `themeFrom` computes every fill's label with `bestOn` and a test asserts the ratio for all six fills in both
  themes. Mutation (always white) fails the dark theme at 1.48:1.
- **The font budget was measured, not assumed.** The rule ("if either adds > 40 kB total … fall back to the system
  stack") needed a number: Inter's Latin variable subset is **48 256 B**, Space Grotesk's is **22 288 B**, together
  **70 544 B**. Inter alone breaks the budget, so the body uses the documented system stack and only the display face
  ships — 22 288 B, self-hosted with its OFL license beside it, `unicode-range` declared so a non-Latin page never
  fetches it. The test reads the file's size and fails above 40 kB, which keeps the exemption earned.
- **Vuetify's two "surface" keys are not the document's two.** `v-app` paints `background`; `v-card`, `v-menu` and
  `v-dialog` paint `surface`. Mapping our `surface` to Vuetify's would have made a menu the same colour as the page it
  opened over — invisible in the dark theme especially. The mapping is code (`background ← surface`,
  `surface ← surface-variant`) and a test asserts all three keys, so the comment cannot rot.
- **A hex scan, not a convention.** `P1-WEB-02`'s criterion is "no hardcoded hex in components"; the test walks every
  `.vue`, `.ts` and `.css` under `apps/web/src` and fails on any colour literal outside the token module and the two
  stylesheets. Mutation (a `style="color: #0F766E"` on one paragraph) fails with the file and line.
- **`/_site/administrators` is not `/_site/admin`.** The theme is chosen by path, so the segment boundary matters:
  `startsWith` would have painted a public page as the dark control room. Four cases pin it.

Mutation-checked: 10 mutations, all caught — a one-hex change in the code, a one-hex change in the document, an
always-white label colour, a boundary weakened to the hairline, a hexed component, an inverted admin/public mapping, a
deleted reduced-motion block, a spacing value changed from 8 to 10, the two surface keys swapped, and the URL reset
deleted.

---

## Pass 29 — 2026-10-25 (the SPA boots: two toolchain defects, both silent)

Both were found by mounting the app and looking at the DOM, not by reading the wiring — and both would have shipped as
"it works": a page that returns `200`, logs nothing, and renders nothing.

| # | Bug | Fix |
|---|---|---|
| 1 | **Vuetify registered no components, so the shell rendered empty.** The first boot produced `<v-app><v-main><!----></v-main></v-app>` — the literal elements, unresolved — with `[Vue warn] Failed to resolve component: v-app` in the console and an empty page underneath. Cause: Vuetify's **bundler** entry does not register components; it expects a build plugin to import the ones an SFC uses. `app.use(createVuetify())` therefore installed a framework with no components in it. A test asserting only "it mounts without throwing" would have passed | `vite-plugin-vuetify` with `autoImport: true`, registered in **both** `apps/web/vite.config.ts` (dev/build) and the root `vitest.config.ts` (tests). The Vitest half was needed for a second reason: Vuetify ships each component's `.css` beside it, and the externalised (node-resolved) copy failed with `TypeError: Unknown file extension ".css"` — `server.deps.inline: ['vuetify']` puts the package through Vite's pipeline. Re-probed: the shell renders `v-application`, the page's own text reaches the DOM, and the production build is 272 modules (292.95 kB JS / 99.20 kB gzip + 38.58 kB CSS) |
| 2 | **Every `.vue` import was an "error typed" value to ESLint.** `bun run lint` failed with `no-unsafe-assignment` / `no-unsafe-argument` on correct code — `src/bootstrap.ts` and `src/router/index.ts` — because ESLint's type-aware service uses plain `tsc`, which cannot open an SFC, and the web `typecheck` had just moved to `vue-tsc` (which can). The lint error was true about the toolchain and false about the code | `apps/web/src/shims-vue.d.ts` declares `*.vue` as `DefineComponent`. The obvious risk — a shim that *overrides* the real component type and silently discards prop checking — was tested for, not hoped against: a probe component with `defineProps<{ count: number }>` misused as `h(Counter, { count: 'x' })` still fails `vue-tsc` with `Type 'string' is not assignable to type 'number'` **with the shim present**, so `vue-tsc` resolves the real SFC and the shim serves only the plain-`tsc` consumers. Without the shim the same probe passes (measured both ways) |

Probed and found sound, rather than assumed, while wiring the boot:

- **HMR is a component swap, not a page reload.** A client on `ws://localhost:5173/` (`vite-hmr`) receives
  `{"type":"update","updates":[{"type":"js-update","path":"/src/pages/public/HomePage.vue",…}]}` when that template
  changes, and `{"type":"full-reload","triggeredBy":"…/plugins/pinia.ts"}` for a module with no HMR boundary — which is
  the correct answer for a module the app imports at boot. A first attempt appeared to show "no HMR at all": the edit
  had appended an HTML comment *outside* the SFC's blocks, so the Vue plugin had nothing to patch. The behaviour was
  right and the probe was wrong, which is why the probe now edits the template text.
- **The alias cannot resolve to two modules.** `@/bootstrap` and `../src/bootstrap` are asserted to be the *same*
  module object in `tests/bootstrap.spec.ts`, not merely to both work: two copies of the Pinia factory would look
  identical at that assertion level and break state isolation in a way only a user would notice.
- **`main.ts` is exercised, not inspected.** The test injects `<div id="app">`, imports the entry point, and asserts
  Vuetify's root wrapper and the page's text are in the document. A test that read the file's text would pass on a file
  whose only failing line was the mount call.
- **The dev server's `allowedHosts: true` is a documented trade, not an oversight.** Vite 6+ refuses unknown `Host`
  headers to blunt DNS rebinding, and a forwarded port has an unknown host; with `host: true` the server is reachable
  from other interfaces, so `09-development.md` §3 now says in as many words that it is a development tool. Production
  is nginx serving `dist/`.

---

## Pass 28 — 2026-10-25 (adversarial review of the whole auth surface)

Two defects, both **concurrency**, both invisible to a sequential test, and both found by running many requests at
once instead of reading the code again:

| # | Bug | Fix |
|---|---|---|
| 1 | **The login throttle could be bypassed by arriving simultaneously.** `check()` counted *recorded* failures, and a failure is only recorded when Argon2 has finished — so forty concurrent logins for one account all read the same empty counter, all passed, and each one paid a 64 MiB, 100 ms verify. Measured on the real route (`app.inject` ×40 through `Promise.all`): `401`×40 in 1 653 ms, **zero** `429`s, and the correct password still worked afterwards. A second identical burst was refused (`429`×40), which is what made the bug look fixed: the allowance was enforced *sequentially*, exactly the shape a password-spraying script avoids. The amplification is aimed at the endpoint the throttle exists to protect | `check()` now **reserves** a slot — one for the pair and one for the address — and the attempt settles it exactly once: `recordFailure` on bad credentials, `recordSuccess` after the token transaction commits, `release` for `403 ACCOUNT_DISABLED` (not a credential failure) and in a `finally` for anything that throws. Slots held by attempts still in progress count against the same limit, so the allowance is atomic inside the process. The refusal is a *different* verdict — `reason: 'in-flight'`, `retryAfterSeconds: 1` — not the fifteen-minute lockout, because the outstanding attempts may succeed. Re-probed: `401`×10 + `429`×30 in 440 ms, then `429`×40 for a second burst |
| 2 | **A password pasted as two lines lost the second one — and the prompt hung.** A terminal delivers a paste as **one** `data` event, newlines included, so the first prompt consumed the whole chunk and the repeat prompt waited for input that had already arrived. Measured in a real PTY (`python3 -c 'pty.fork()…'` against `bun run admin:init`, both lines written in a single `write`): the transcript ended at `Password: \r\nRepeat password: ` and the process had to be killed — no account, no error, an operator staring at a cursor. On a stream that then ends the same code throws `no input: the terminal closed before a line was read` (probed first, in memory) | The characters after the newline are kept in a `WeakMap` keyed by the stream and replayed into the next prompt before it listens, so one paste answers both. `\r\n` is treated as one terminator when the remainder is split off — otherwise the next prompt would start with a bare newline and answer itself with an empty string (caught by writing the test, not by the probe). The map is bounded at 512 characters and dies with the stream. Re-probed in the same PTY: exit `0`, transcript `Password: \r\nRepeat password: \r\nadmin 'admin' created (password from prompt)`, nothing echoed, and the `admins` row plus its `auth.admin_created` audit row confirmed in the database |

Probed and found sound, rather than assumed — the sweep this pass covered the repositories (`admins`,
`admin-tokens`, `audit-logs`), `modules/auth/routes.ts`, `app.ts`, `config/env.ts`, both operator scripts and
`scripts/lib/secret-prompt.ts`:

- **The lockout instant is the instant the lock lifts.** `details.lockedUntil` is the *oldest* failure plus the window,
  and the same window is what `check()` uses, so a client that sleeps to the stated instant is let in (`lockedUntil`)
  and one that retries a millisecond earlier is not. Confirmed with a moving clock against staggered failures, at
  `window−1 ms`, `window` and `window+1 ms`, and now pinned by a test. This was an open candidate from the previous
  pass; it is not a defect.
- **A crash cannot shrink the allowance.** With the throttle reserving, an attempt that dies mid-flight would leak a
  slot forever; the new test drops the `admins` table, runs twelve logins against a limit of ten, and asserts both that
  every attempt is refused and that the pair is still allowed and `inFlight` is `0` afterwards.
- **The double-logout refusal is reachable.** The existing `Promise.all` case usually answers `401` from
  `verifySession` (the second request already sees the committed revocation), so the "lost the race" branch — both
  verifications succeed, then the second `UPDATE` matches no row — was never executed. A `SELECT … FOR UPDATE` on the
  token row from another connection makes both logouts queue behind the gate, so the branch runs every time; five
  consecutive runs, and the mutation that removes the guard fails it.

Mutation-checked: 8 mutations, all caught — the reservation ignored, the reservation never taken, the settle in
`recordFailure` removed, the `finally` release removed, the CRLF split removed, the leftover dropped, the lockout
instant read from the newest failure instead of the oldest, and the logout race guard removed. New tests: 11 across
`login-throttle.spec.ts` (6), `integration/login-route.spec.ts` (1), `integration/login.spec.ts` (1),
`integration/me-logout.spec.ts` (1) and `scripts/tests/secret-prompt.spec.ts` (2). The repository is at **692 tests /
49 files**, coverage **97.6 %** statements. `04-api.md` §1 and `14-security.md` §3 now say a `429` has two meanings,
ADR-027 has the reservation row, and `08-tasks.md` records it against `P1-AUTH-03`.

---

## Pass 27 — 2026-10-25 (adversarial review of `P1-AUTH-07`)

Two defects this pass, and both are the kind that ship without ever failing: **a documented behaviour that no test
could lose.** The product code of this task behaved correctly under every probe — the transaction's three statements,
the revocation count, the per-account scope, the concurrent resets, the printed-once rule, a failed commit printing
nothing — so the findings are in the suite that is supposed to keep it that way.

| # | Bug | Fix |
|---|---|---|
| 1 | **Nothing tested that the reset script targets `ADMIN_USERNAME`.** The variable is documented (`09-development.md` §5) and the script reads it (`args.username ?? config.adminUsername`), but every case passed `--username` or relied on the default — which happens to be `admin`. A regression that hard-coded `'admin'` would have passed the whole suite and reset the wrong account in a deployment that renamed it: the operator's own account untouched, a password they do not control set on an account they may not look at. Found by asking, for each promised behaviour, "which test would fail if this were wrong?" | A case creates `owner` **and** `admin`, runs with `ADMIN_USERNAME=owner` and no flag, and asserts that `owner` has the new password and `admin` still has the old one. Mutation-checked: `args.username ?? 'admin'` fails exactly that test |
| 2 | **The same gap in `init-admin.ts`, from pass 26.** Its suite created `owner` only through `--username`, so `ADMIN_USERNAME` — the default an operator actually relies on in `docker compose` — was equally unpinned | A case sets `ADMIN_USERNAME=owner` with no flag and asserts the single row is `owner`. Mutation-checked the same way |

Three things were probed rather than assumed, and each changed something:

- **The generator's retry loop was unreachable and therefore unprovable.** With the real alphabet a 24-character draw
  cannot be on the 1 000-word blocklist or contain the username, so the `for` loop's exhaustion branch could not be
  executed by any test. The alphabet is now a documented option, and a degenerate one (`'a'`) with the username `'aaa'`
  drives all ten attempts and the throw. The same review added the policy's **upper** bound: a 300-character request now
  fails as a `RangeError` naming the bounds, instead of looping ten times and blaming randomness.
- **`--password-stdin` on a terminal is refused, before the database is opened.** A TTY on stdin means the "pipe" is a
  person typing, and the terminal echoes every character — the one case where a pipe is required. The check was
  originally inside the password step, i.e. after a connection and a lookup; it is now with the other "this run cannot
  succeed" checks, so the operator gets one sentence and no SQL.
- **A printed password is always an applied password.** The generated value is written to stdout only after the
  transaction returns, and a test forces the failure path (drop `audit_logs`) to assert that nothing is printed and the
  old password still works. The accepted cost is stated in the script's docstring: if stdout is lost *after* a
  successful commit, the password is lost with it and the reset must be run again — the alternative, printing before the
  commit, would hand an operator a credential that was never stored.

Mutation-checked: 19 mutations, all caught — revocation removed, the audit action swapped, `metadata.revokedTokens`
dropped, the "account vanished" branch re-thrown as a generic error, the missing-account guard removed, the `UPDATE`'s
`WHERE` removed (every admin would be reset), `withTransaction` replaced by a bare call, the generator's character pick
fixed to one character, its policy check removed, its upper bound removed, the print suppressed, the TTY refusal
removed, stdin not stripped, empty stdin accepted, the plural hard-coded, the two prompts not compared, and the two
`ADMIN_USERNAME` regressions above. `modules/auth/admin-accounts.ts` and `modules/auth/password.ts` are at 100 %
statements, branches, functions and lines; the repository is at 681 tests / 49 files, coverage 97.9 % statements.

---

## Pass 26 — 2026-10-25 (adversarial review of `P1-AUTH-06`)

Two defects, both found by running the code instead of reading it, and both in the category this project keeps
rediscovering: **the code said it was safe, and the machine disagreed.**

| # | Bug | Fix |
|---|---|---|
| 1 | **The concurrent-boot path crashed instead of reporting the account.** `ensureAdmin` caught the `23505` from the `lower(username)` unique index *inside* its transaction and re-read the row there to report it — the natural way to write it, and wrong: PostgreSQL marks a transaction aborted after the first failed statement, so the re-read failed with `current transaction is aborted, commands ignored until end of transaction block`, and two containers booting at once would have failed the second boot instead of logging "already exists". Nothing about the code reads as broken; only two live connections racing can show it | The catch moved **outside** `withTransaction`, so the re-read runs on the base connection after the rollback, and the outcome is `exists` with the winner's row. The test opens a second pool — a single handle serialises its own statements and can never reach the branch — and asserts a sorted `['created', 'exists']`, one admin row, one audit row, and one id either way. Re-probed: both orders pass, repeatedly |
| 2 | **The hidden password prompt echoed the first password typed.** `secret-prompt.ts` used `node:readline` with a discarding `Writable` as its output, so readline itself echoed nothing — and the *terminal* echoed everything, because under Bun the interface's `setRawMode(true)` lands before the TTY is initialised. Measured in a real PTY: the first prompt printed the password, the second and third were silent (once the terminal has been in raw mode, it stays controllable). The unit tests could not see it: an in-memory stream has no terminal driver to echo anything, which is exactly why they passed | The prompt reads the line itself — `setRawMode(true)` **before** the first read, `setEncoding('utf8')`, a loop over the characters — and restores raw mode in a `finally`, so Ctrl-C or Ctrl-D cannot leave a shell without line editing. It handles backspace, Ctrl-C (`cancelled`), Ctrl-D (finish, or `no input` when the line is empty) and drops CSI/SS3 escape sequences so a stray arrow key does not append `[A` to a secret the operator cannot retype. The suite pins the *mechanism* (`raw:on` → `read` → `raw:off`, in that order) and that nothing but the question and a newline is written; the end-to-end check was a PTY driving `bun run admin:init`, whose output is `Password: \r\nRepeat password: \r\nadmin 'admin' created (password from prompt)` with no keystrokes in it. The account and its `auth.admin_created` audit row were confirmed in the database afterwards |

Mutation-checked: 20 mutations, all caught — the audit insert disabled, the race not caught, the policy check removed,
the username not trimmed, the control-character test disabled, the injected clock dropped from the audit row, `exists`
reported as `created`, a foreign `23505` swallowed, `--username` ignored, the prompt-mismatch check disabled, the file's
trailing newline kept, `isTTY` read as truthy, raw mode never set, raw mode never restored, characters written to the
output, and Ctrl-C / backspace / escape-sequence handling removed. `modules/auth/admin-accounts.ts` is at 100 %
statements, branches, functions and lines; `scripts/lib/secret-prompt.ts` and `scripts/init-admin.ts` are covered by
their own suites. The repository is at 633 tests / 47 files, coverage 97.8 % statements.

One thing deliberately *not* fixed: line 203 of `admin-accounts.ts` (`if (raced === null) throw error`) was uncovered
until a test was written for it. The test raises `23505` from a `BEFORE INSERT` trigger — the only way to get the code
with no row behind it — and asserts the original error is re-thrown rather than reported as "already exists".

---

## Pass 25 — 2026-10-25 (adversarial review of `P1-AUTH-05`)

One defect, and it is the worst kind a security control can have: the guard was installed, it ran, it decided correctly,
and **its answer was thrown away**.

| # | Bug | Fix |
|---|---|---|
| 1 | **The Bearer guard's refusal never reached the client.** The hook used Fastify's callback style and did both things: `reply.send(401)` and then `done()`. In that style they are not alternatives — `done()` resumes the lifecycle, so the route handler ran, its reply won, and the guard's `401` was discarded with an `FST_ERR_REP_ALREADY_SENT` logged *after* a `200`/`503` had already gone out. Every `/_admin/api/*` request answered as if it were anonymous-friendly: measured before the fix, `GET /_admin/api/catalog` without a token answered `503 NOT_READY` and the stub's body. The L2 law was, for the length of one afternoon, a comment. Nothing in a *review* of the diff would have shown it: the code reads like a guard, and the only way to see it is to make a request | The hook is `async` and **throws**; there is no `done()` and no `reply.send()` in it. Returning from an async hook stops the chain, and throwing routes the refusal through the single error path — `toErrorEnvelope`, which is the same function that shapes a `500`, so the body, the `requestId` and the id header are the ones every other failure has. Re-probed: no token → `401 UNAUTHENTICATED`; a token the verifier rejects → the verdict's own code; a path with no route → `401` without a token and `404` with one. The regression test that would have caught it is not an assertion on the hook but the **route-table walk**: it calls every admin route the app registered and demands `401`, so a guard whose answer is discarded fails immediately |

Three things came out of the same review and changed the design rather than the notes:

- **The `500` policy had two copies.** The first version caught non-`AppError` failures from the verifier and rewrapped
  them as `INTERNAL_ERROR`. Mutating that away did not fail a test — because the error stage already maps *any* unknown
  error to `INTERNAL_ERROR` with a fixed sentence. The try/catch was therefore deleted rather than tested: one place
  decides what a `500` says, and the guard throws whatever the verifier rejected with. The test that asserts a driver
  message and a port number never appear in the body stayed, and it now pins the error stage's behaviour instead of a
  duplicate of it.
- **The L2 test had to grow with the app.** A hand-written list of admin routes is a list that goes stale exactly when
  it matters — the next route someone adds. The test now collects the routes from `onRoute` during `boot` (through a
  tests-only `routeObserver` seam on `buildApp`, the same pattern as `slots`/`database`) and calls every one of them,
  with and without a token. It also asserts the list is non-empty, because a guard test that checks nothing passes
  silently.
- **`/_admin/api` itself is admin.** Adding the bare prefix to the walk made the fail-closed behaviour explicit: no
  token → `401`, token → `404`. The refusal comes from `onRequest`, which runs before routing, so an anonymous caller
  cannot map the admin surface by watching which paths answer `401` and which `404`.

Mutation-checked: 7 mutations, all caught — the scope test removed, the scope test inverted, the missing-token throw
removed, the missing-token code swapped for `TOKEN_EXPIRED`, the verifier given a truncated token, and the pipeline slot
emptied. `plugins/auth-guard.ts` is at 100 % statements, branches, functions and lines; the suite is 580 tests.

---

## Pass 24 — 2026-10-25 (adversarial review of `P1-AUTH-04`)

One defect, found by probing a race rather than by reading: two requests, one session, and an audit trail that said the
session had ended twice.

| # | Bug | Fix |
|---|---|---|
| 1 | **Concurrent logouts both answered `204` and wrote two `auth.logout` rows for one session.** The handler verified the token, then revoked it, then audited — and the verification says nothing about what happens *after* it. Two logouts arriving together both verify as valid (neither has committed), the first revocation wins, the second updates zero rows, and the handler ignored that result: `204` twice, two audit rows, one session. An audit trail that reports a session ending twice is worse than no audit trail, because the second row is indistinguishable from a real second session. Probed with `Promise.all` on one token before the fix: `204 204`, 2 rows | The **revocation decides the answer**: `revokeToken` returns `false` when `revoked_at` is already set (its `UPDATE … WHERE revoked_at IS NULL` is the atomic arbiter), and that `false` is now thrown as `401 TOKEN_REVOKED` inside the transaction, so nothing is audited. Re-probed: `204 401`, 1 row. The new test asserts the sorted status pair and the single row, which is deterministic whichever request wins — the loser either sees the revocation at verification time or loses the update, and both paths answer the same code |

Three smaller outcomes of the same review, all of which changed code:

- **`readBearerToken` had a condition no input could reach.** After `trim()` and a split on runs of whitespace, a
  malformed header yields `undefined`, never `''` — so `value.length === 0` was a branch no test could cover. Removed,
  with the reasoning in the comment: this is the fifth time in this project that "it looks defensive" turned out to mean
  "it cannot happen", and each time the cost was a coverage gap that hid nothing.
- **The credential is never normalised.** A test asserts `ReadBearerToken` returns the token verbatim; trimming or
  lower-casing it would hash to a digest no row holds, i.e. a `401` for a perfectly good token. The mutation that adds
  `.trim()` is therefore **equivalent** — no input can carry whitespace inside a single credential once the header is
  split — and is recorded here rather than chased with a contrived test.
- **`/me`'s `lastUsedAt` fallback is reachable only under a race** (two first-ever requests: both read `null`, one wins
  the write, the loser reports `null`). It stays, because the value is the honest answer for that request, and it is the
  one branch in the module no test can pin deterministically; the mutation that replaces `?? null` with a fabricated
  instant is therefore not caught, and the coverage gap is stated here instead of being papered over.

Also confirmed by probe and left alone (no change needed): a `401` from `/me` carries `cache-control: no-store` (the
hook is on the namespace, not the handler); a 20 KB `Authorization` header answers `401` rather than `500`; a Unicode
credential is refused without a query; and 300 unauthenticated `/me` requests take ~210 ms end to end in-process — one
indexed digest lookup each, so the route needs no limiter of its own.

---

## Pass 23 — 2026-10-25 (adversarial review of `P1-AUTH-03`, with a measuring tape)

Two defects. The first is the more interesting kind: a fix from an earlier pass that was **confidently wrong**, whose
own tests encoded the wrong belief, so the suite stayed green while the code was stricter than the contract. It was
found by measuring a library instead of assuming what it does.

| # | Bug | Fix |
|---|---|---|
| 1 | **The password ceiling was counted in a unit Zod does not use, so the policy refused passwords the login endpoint accepts.** Pass 20 "fixed" this by changing the ceiling to `password.length` — UTF-16 code units — on the stated grounds that Zod's `.max()` counts units. Measured in this pass: Zod 4 counts **code points**. `'😀'.repeat(200)` is 400 units and 200 code points, and `.max(256)` **accepts** it, while the policy refused it: a person creating a passphrase in emoji (or any astral-plane script) was told it was too long, by a message that counted 400 for something the login form would take. The pass-20 tests asserted the wrong direction and so passed. The other direction of the same confusion was live too: counting the NFKC form would accept 150 × `e` + combining accent (300 code points as sent, 150 normalised) that login then refuses | The ceiling counts **code points of the submitted string** — both halves matter: the unit Zod uses, and the raw value rather than the normalised one. The floor keeps counting the normalised form, which only ever shortens, so it cannot be stricter than the submitted form. Three tests now hold it: the emoji case (policy must **accept** what login accepts), the decomposed case (policy must **refuse** what login refuses), and a property test over seven awkward strings asserting the invariant "anything creation accepts, login accepts" — the test that would have failed in pass 20, since it does not care which unit the mistake is written in. The code comment, `PASSWORD_POLICY`, ADR-025, `14-security.md`, `08-tasks.md`, `09-development.md` and the shared module's JSDoc all said "UTF-16 units" and were corrected; the pass-20 entry below keeps its text and gains a pointer, because rewriting history would hide how the mistake survived a pass |
| 2 | **`04-api.md` did not document the two headers the login route sets.** `cache-control: no-store` (on every answer in the namespace) and the `Retry-After` header on a `429` existed in code and appeared in no document — `14-security.md` §3 said the response "includes" `Retry-After` without saying it is a header, and `04-api.md` §1 listed only the body. A client reading the contract would implement body parsing only and retry immediately | `04-api.md` §1 now states both: a `Headers:` line for `no-store` (and never a `set-cookie`), and `429` with `details.lockedUntil` + `details.retryAfterSeconds` **plus** a matching `Retry-After` header, "whole seconds, ≥ 1; no other answer carries that header". A doc test in `apps/api/tests/auth-contract.spec.ts` now parses the bounds sentence, the response fields, the `29`/`Retry-After`/`retryAfterSeconds`/`no-store` mentions and the stub table out of `04-api.md`, so the next divergence fails the gate rather than a client |

Two further changes came out of the same review, and both removed code rather than adding it:

- `#lockout` ended in `failures[0] ?? now` — a fallback no call could reach, and one that would have invented a
  lockout expiring a window from *now* if it ever had. Replaced by a `nonEmpty()` narrowing helper and a `Failures`
  tuple type, so "a limit is never met by an empty counter" is a type-level fact. That change also made the
  `perIpLimit > 0` guard in `check` redundant (an empty counter now reads as `null`, not as `0 >= 0`, which is how the
  pass-23 lockout-everything bug happened), and the guard was removed rather than kept as unreachable code.
- The throttle was **optional** all the way down (`RouteOptions`, `AuthRouteOptions`, `PipelineContext`), each layer
  able to build its own from the config. Two counters in one process multiply every limit while looking correct. It is
  now required, built once in `app.ts` through one `loginThrottleFromConfig()`, and a test drives a `429` through the
  HTTP route with no test-injected throttle at all — the config-built counter is the one that answers.

Mutation-checked: 23 mutations of the new code each fail at least one test (the `no-store` header, the
`Retry-After` value and the `RATE_LIMITED` branch, the request-schema parse, the dummy-hash verify, the `is_active`
ordering, the audit target and metadata, both throttle comparisons, the window filter, the IP-counter reset on success,
the prune boundary, the minutes→milliseconds conversion, the ceiling's unit and its source string, and four bounds in
`shared`). One mutant was behaviour-equivalent and is recorded as such: changing the capacity early-return from `<=` to
`<` performs the same work one iteration earlier — the *prune* boundary, which is not equivalent, has its own test. The
auth module is at 100 % statements, branches, functions and lines; the suite is 520 tests.

## Pass 22 — 2026-10-25 (adversarial review of the working tree after `P1-AUTH-02`)

Two defects, and both are the kind that a passing test suite cannot show: a code path that was only reached by *not*
having a lock, and a value whose type lies about its trustworthiness. Neither was found by reading; both were found by
reproducing the thing the code assumes cannot happen.

| # | Bug | Fix |
|---|---|---|
| 1 | **Boot-time housekeeping could stop the API from ever listening.** Pass 21 added token pruning and called it from `start()` **before** `listen()`, unbounded. A `DELETE` waits for a row lock, and nothing in the path said otherwise — so one long-lived transaction holding any expired token row kept the process in boot: it had run the schema check, it held its port mapping, and it answered nothing. Reproduced with a real process and a real lock (`begin; select … for update; pg_sleep(30)`): `healthz` returned `000` after 8 s of a 20 s budget, and the log stopped at `database schema matches this build`. Docker would see a container that is up and unhealthy, restart it, and hit the same lock again — a restart loop whose cause is a transaction somewhere else entirely | Two changes, both asserted. The prune now runs through `lib/housekeeping.ts` with `statementTimeoutMs` (via the existing `withTransaction`), so a contended statement is **abandoned** rather than waited on, and it is called **after** `listen` and not awaited — housekeeping is optional work, so nothing a client asks for may wait for it. `runHousekeeping` returns `number \| null`, because "nothing to do" and "we gave up" are different answers and a caller that saw only `0` could not tell them apart. Re-probed with the lock still held: `healthz` 200 within six seconds, `readyz` `{\"status\":\"ok\"}`, a `statement timeout` warning, and the row still present; re-run after the lock released → `{\"pruned\":1}` and the table empty. Dropping the `statementTimeoutMs` option makes the new lock test fail |
| 2 | **`request.ip` was trusted as a fact, and it is a header.** `lib/client-ip` did not exist; `issueToken` wrote `options.ip` straight into an `inet` column. With `trustProxy` on — which this API needs — `request.ip` is whatever the trusted peer forwarded, and `proxy-addr` validates nothing: measured, `X-Forwarded-For: not-an-ip` arrives as the string `not-an-ip`, and so does `<script>`. Postgres refuses those with `22P02`, so `POST /_auth/api/login` answered **`500`** to any request carrying a junk header — an unauthenticated, one-line way to make the login endpoint error. The same value is a rate-limiting key, where a fresh junk string per request is a fresh bucket per request, i.e. no limit at all. And it was not only hostile input: `203.0.113.9:8080`, a form real proxies emit, threw too | `lib/client-ip.ts` parses instead of trusting: a bare IPv4/IPv6 literal is kept, a port is stripped (`203.0.113.9:8080` and `[2001:db8::1]:443` yield the address), and anything else — a hostname, a chain, a payload, an empty string, an over-long value — becomes `null`, which the schema already allows. Losing an address is a diagnostics loss; storing it was a `500` and a bypass. Wired into `issueToken`, with a 27-case table plus an integration case proving a junk address is *stored as null* rather than thrown. Probed before the fix (`22P02` for `not-an-ip`, `<script>` and `203.0.113.9:8080`) and after (all three stored as `null`, addresses kept without the port) |

Two smaller things came out of the same probes and are worth recording because they changed the code rather than just
the notes:

- The first draft of `normaliseIp` used a capture group per form, which needs a `?? ''` fallback for the type checker —
  a branch no input can reach, and coverage said so (85% branches with every case in the table passing). Rewritten with
  `indexOf`/`slice`; the missing cases (half-open bracket, bracket without a port, a non-numeric port, a hostname with a
  port) were added to the table, and the module is now 100% lines and branches. This is the fourth time in this project
  that "the table passes" and "every branch is exercised" turned out to be different statements.
- `housekeeping` was only ever called by tests that passed an explicit clock, so the `now` default — the one production
  uses — was dead in the suite. A test now calls it exactly as `start()` does, with no options at all.

---

## Pass 21 — 2026-10-25 (adversarial review of `P1-AUTH-02`)

Two defects, and neither is a line of wrong logic. One is a document claiming a mechanism the code does not have; the
other is a documented behaviour that no task owned, written down as if it existed.

| # | Bug | Fix |
|---|---|---|
| 1 | **"Constant-time compare" described a mechanism that is not in the design — and should not be.** The task list and `14-security.md` §3 both said token verification uses a constant-time comparison. It does not, and adding one would be ceremony: verification hashes the presented token and lets the unique index on `token_hash` find the row, so there is no secret in application memory to compare *against*. A `timingSafeEqual` there would compare the same 32 bytes the database has just matched, and a reviewer reading the code against the doc would have concluded something was missing | The doc now states the mechanism that exists — "verified by an indexed probe on the digest, so no secret is ever compared in application code" — and ADR-004 carries the reasoning. The property the phrase was reaching for is now *tested* instead of asserted: the digest is the only lookup key, proved by inserting a row whose `token_prefix` equals a known token's prefix while its digest belongs to a different string, and requiring that token not to authenticate. That test is the one that fails if someone later "optimises" verification to look up by prefix |
| 2 | **Boot-time pruning was documented and owned by nobody.** `03-data-model.md` §2.2 says "startup housekeeping deletes rows expired > 30 days ago", and there is no task in `08-tasks.md` that mentions pruning. Written down as a behaviour, absent from the plan, absent from the code: the token table would have grown forever while the docs said otherwise | `pruneExpiredTokens` is part of the token service (`P1-AUTH-02`, which owns the lifecycle) and is called once at boot from `server.ts`, after the pipeline proved the database usable and before the socket opens. **Probed with a real process**, because a stub would only prove that a stub can be called: a database seeded with a 40-day-expired row and a 5-day-expired one, then `bun run apps/api/src/server.ts` → log shows `{"pruned":1}` and `expired tokens pruned`, `healthz` 200, and the 40-day row is gone while the 5-day one survives. A failure there is logged and does not stop the boot — an old row is not a reason to refuse traffic |

Also worth recording, because it shaped the tests rather than the code:

- The `last_used_at` throttle is written **into the `WHERE` clause** (`last_used_at IS NULL OR last_used_at < now -
  60 s`) rather than read-compare-write. Two requests arriving together cannot both decide the write is due, and the
  verdict then has to report what the row *holds* instead of what the request pretended to record — otherwise `/me`
  would claim a `lastUsedAt` that no row has.
- The cheap rejection had to be observable to be testable: the "malformed token never reaches the database" tests pass
  an executor wrapped in a `Proxy` that throws on any property access. Without that, "does not touch the database" is
  a comment, not an assertion.

---

## Pass 20 — 2026-10-25 (adversarial review of `P1-AUTH-01`)

Three defects. The first is the interesting kind: it passes every test written for the feature, passes review, and
fails only on the second login.

| # | Bug | Fix |
|---|---|---|
| 1 | *(Corrected in pass 23 — the fix below picked the wrong unit and made the policy stricter than the login schema. See pass 23, defect 1.)* **The password ceiling was counted in the wrong unit, so an account could be created and never used.** The policy rejected passwords longer than 256 *characters*, and the login schema rejects bodies where the password is longer than 256 *UTF-16 code units* (Zod's `.max()` on a string). The two agree for ASCII and disagree exactly where a user is likely to notice: measured, `'😀'.repeat(200)` is 200 characters and 400 units — accepted by the policy, refused by login, forever, with a `422` that says the request is invalid. The same hole in the other direction: a decomposed string of 300 units normalises (NFKC) to 150 characters, so the *normalised* count would have passed it too. Probing before the fix: `passwordProblems(decomposed)` → `[]` while the login schema refuses it | The ceiling now measures `password.length` — the same unit, on the same string, that the login schema measures — while the floor keeps counting characters (code points of the NFKC form), because that is the unit the policy is expressed in. Both units are named in `PASSWORD_POLICY`, in ADR-025 and in `14-security.md`. Two tests pin the two shapes that fell through (200 emoji, 300 decomposed units), and reverting to the character comparison fails one of them. A doc test also parses the `1–256` limit out of `04-api.md` and compares it to the constant, so the pair cannot drift again |
| 2 | **The security doc advertised a weaker hash than the code builds.** `14-security.md` §3 said "memory 64 MB" while `ARGON2_PARAMS.memoryCost` is `65_536` KiB, i.e. 64 **MiB** — 67.1 MB. Reading the doc, an operator would have sized the container's memory for a hash 5% smaller than the real one; reading it as the source of truth, a reviewer checking "does the code match the docs?" would have found a discrepancy and had to guess which side was wrong | The doc says MiB. More importantly, three tests now **parse** the numbers out of `14-security.md` and `04-api.md` (hash memory, iterations, parallelism, minimum length, blocklist size, login ceiling) and compare them to the code's constants, so a mismatch is a red test rather than a footnote nobody reads. That is the same technique the migrator and schema tasks used for the SQL, applied to the one table whose numbers are security claims |

| 3 | **The username substring rule compared bytes while the password was normalised.** The password is NFKC-normalised before matching — that is the decision that makes a macOS-typed `café` work on Linux — but the username was only trimmed and lower-cased. A username containing an accent (`José`, typed decomposed) therefore never matched a composed password that contains it, so the rule silently did nothing for exactly the accounts whose names are hardest to type | Both sides go through the same normalisation, and a test pins the case: `José-let-me-in-9` against the decomposed username must be rejected. Reverting the fix fails that test |

Also recorded while probing the addon, because each changed a decision rather than just informing one:

- `verify` **throws** (`Error: Decoding failed`) for anything that is not a PHC string — measured on `''`, on a
  truncated hash and on a bcrypt hash. A corrupt row would therefore have answered `500` where the contract
  says `401`, so verification catches and answers `false`.
- The addon runs on the libuv thread pool, not the event loop: four concurrent 64 MiB hashes finished in 131 ms
  with a maximum event-loop gap of 11 ms. That is what makes "hash on the request path, throttled" acceptable
  instead of needing a queue.
- Only **9** of the 1 000 blocklist entries reach a 12-character floor on their own — the measurement that
  turned "exact match" into "match the stem left after trailing digits and symbols", and that made the docs
  state plainly that the list is a floor, not a guarantee.

---

## Pass 19 — 2026-10-25 (adversarial review of `P1-DB-04`)

Three defects: two in the mechanism (found by asking what each check would *not* catch, then by trying to kill the
tests that were supposed to catch them), one in the way a boot-time query reaches the tests.

| # | Bug | Fix |
|---|---|---|
| 1 | **The obvious check would have passed an empty image.** Comparing the migration files on disk against the `kysely_migration` rows — the two things a boot check naturally has — reports "in sync" for a database with no rows and a directory with no files. That is exactly what a truncated image or a bad build context produces, and it would have booted happily against a schema missing every table, then failed at the first request. The same two-way comparison also cannot see a database migrated by a **newer** image: the extra row is simply not among the files | Three sources instead of two: on-disk files, the `EXPECTED_MIGRATIONS` constant compiled into the build, and the rows. Files ≠ constant → refuse; rows ⊄ constant → refuse **without** migrating; rows behind → migrate only when `MIGRATE_ON_BOOT`. The constant is pinned to the directory by a test, so forgetting to register a new migration fails `bun run check` rather than producing a boot check that quietly trusts whatever is there |
| 2 | **The report described the database it found, not the one it left.** After migrating, `checkSchemaVersion` re-read the bookkeeping into `pending` and threw if anything still showed as pending — a branch that cannot be taken, because `migrateToLatest` throws on failure and only returns what it recorded. It cost the coverage gate a permanently unreachable line (97.3%, line ~191), and worse, the report it returned was the *pre-migration* one merged with nothing: `applied` still listed only what existed before this run, so the log line that is supposed to prove the boot migrated the database proved the opposite | The re-read is gone; the report merges this run's own `applied` list and reports `pending: []`, which is true by construction. Probed the honest way: replacing the merge with `[...before.applied]` and running the targeted suites **passed 17/17** — the merge was untested. Assertions on `report.applied` added to both migrating cases (empty database → `EXPECTED_MIGRATIONS`; one pending → `['0001_init', '0002_catalog']`); the same mutant now fails 2 tests. `version-check.ts` is at 100% lines/branches with no unreachable code left |
| 3 | **A boot-time query silently broke every test that supplies a stub handle.** Adding the check to the `db` stage turned six `db-stage` specs red with `TypeError: executorProvider.getExecutor is not a function` — the stage was now querying a handle that is only a shape. The tempting repair is to detect the stub and skip the check, which makes the production path conditional on a test artifact | An explicit injectable seam: `PipelineContext.schemaCheck` and `BuildAppOptions.schemaCheck`, defaulted to the real `checkSchemaVersion` in `plugins/db.ts` and to an in-sync stub in `tests/helpers/test-app.ts`. Specs that assert boot ordering keep passing a spy; specs that do not care get the default. The production path — ping, then check, then listen — stays unconditional, and the two new stage tests (the check runs once *after* the ping; skew closes the handle and rethrows) are the ones that prove it |

Also recorded because it changed the shape of the code: `MIGRATE_ON_BOOT` defaults to **true** for a bare
`docker run`, while compose sets it to `false` because the entrypoint migrates. Both behaviours are pinned by
real-process probes rather than mocks: default + empty database migrates and exits 0 on `SIGTERM`;
`MIGRATE_ON_BOOT=false` + empty database logs `SCHEMA_SKEW`, applies nothing, and exits 1.

---

## Pass 18 — 2026-10-25 (adversarial review of `P1-DB-03`)

Two defects, both found by probing the mechanisms the transaction helper was about to rely on rather than by writing
the helper first. One of them was not a defect in the new code at all.

| # | Bug | Fix |
|---|---|---|
| 1 | **A database failover killed the API.** Passes 14 and 16 both reasoned about "a lost connection" and both tested it the same way: kill an **idle** backend, watch the pool recover, watch a `warn` line appear. But `pg-pool` keeps its `error` listener on a client only while that client sits idle in the pool and **removes it on checkout** (`pg-pool/index.js`: `_acquireClient` → `removeListener('error', idleListener)`). So a connection lost while serving a query or holding a transaction emitted `error` on an emitter with no listener, and Node's answer to that is to throw: measured, `pg_terminate_backend` during a `BEGIN … pg_sleep` produced *both* a clean rejection of the transaction *and* an uncaught exception, i.e. `process.exit` in production. A failover, a restart, or an admin ending a session would have taken the API down — the exact failure pass 14 set out to prevent, through the channel it did not cover | One `error` listener per client, attached on the pool's `connect` event, so it covers checked-out clients too; the pool-level listener stays as a swallow so the same error is reported once instead of twice. Probed before and after: before, `uncaught errors: 2`; after, `uncaught errors: 0`, one report, pool still usable. The test now collects `uncaughtException` explicitly and asserts the collection is empty, rather than trusting the runner to notice — with the listener removed it fails on that assertion (`expected [ …(1) ] to deeply equal []`) |
| 2 | **The idle bound was asserted from the wrong side.** My first test for `idle_in_transaction_session_timeout` expected the promise to reject within the timeout. It did not: the server kills the session asynchronously and the client only finds out at its **next** statement, so the test failed at 1 505 ms against a 1 400 ms bound — while the mechanism was working perfectly. Left unfixed, the honest summary of the behaviour would have been wrong in the documentation as well | The test asserts what actually matters and what actually happens: the backend disappears from `pg_stat_activity` **while the client is still sleeping**, and the next statement then fails. That is the property that frees the row locks, and it is now the one under test |

Also caught by the same pass, and worth recording because the type system turned out to be stricter than the plan:
**Kysely 0.29 cannot nest transactions.** `transaction()` and `startTransaction()` both throw on a `Transaction`, and
savepoints exist only on the `ControlledTransaction` from `startTransaction()`. A first draft advertised nested
savepoints; the test for it failed with Kysely's internal message, and TypeScript rejects the call outright. The helper
now refuses a `Transaction` with an explanation instead, and the alternative — pass the enclosing transaction down —
is documented in `09-development.md`.

---

## Pass 17 — 2026-10-25 (adversarial review of `P1-DB-02`)

Two defects, both in the new schema work, both found by trying to *break* the guarantee rather than by reading it.

| # | Bug | Fix |
|---|---|---|
| 1 | **The type assertions did not run.** The suite asserted `id` is a `string` with `expectTypeOf`, which is a compile-time DSL: at runtime the calls are no-ops, so `bun run test` passed with `AuditLogs.id` changed to `Generated<number>` — a mutation that compiles, reads fine on a small database, and then compares wrong. The test claimed a guarantee that only `tsc` provides, and nothing said so | The compile-time half stays (it *is* enforced — `bun run typecheck` fails with `Expected: string, Actual: number`) with a comment stating exactly that and how it was verified; and the runtime half was added against a real server (`instanceof Date`, `Buffer.isBuffer`, `typeof id === 'string'`), which is the one that catches a type the driver disagrees with |
| 2 | **An insert could supply a generated id.** Ids were `Generated<T>`, whose insert type includes `T` — so `insertInto('audit_logs').values({ id: '7', … })` compiled. For `bigserial` that writes the row without advancing the sequence, and the next generated id collides: a failure that surfaces later, in a different request, far from the insert that caused it | `GeneratedAlways<string>` for all three ids: insert type `never`, so the mistake is a compile error. Pinned with `@ts-expect-error` in the suite |

Neither existed in a released build — both were in uncommitted work, like passes 14 and 15.

Verified while reviewing, with the edit applied and asserted (the first attempt silently no-op'd, which is why the
first result was a false pass): a column added to the SQL only fails 2 tests, a column added to the interface only
fails 1, `user_agent text NOT NULL` in SQL only fails 3, a renamed property fails 1, a stray `any` fails 1, and
`Generated<number>` for the audit id fails `tsc`.

---

## Pass 16 — 2026-10-25 (adversarial review of the working tree after `P1-API-07`)

Three defects, found by asking what the *process* does rather than what the tests assert. The first is the same
leak pass 14 fixed, reached through the other door; the other two are errors being discarded with no trace.

| # | Bug | Fix |
|---|---|---|
| 1 | **A boot refused for an illegal route left the pool open.** `buildApp` gained a `try`/`catch` in pass 14 so a failed `onReady` ping closes the instance — but the route-law check runs *after* a successful boot and sat outside that guard. Measured with a recording handle: `buildApp` rejects with `One route violates the route law`, and `close` had been called **0** times. In production the process exits and the socket dies with it, which is why nothing looked wrong; in any process that builds apps more than once (tests today, a worker entry point later) it leaks `DB_POOL_MAX` connections per attempt | The check moved inside the guard, so both ways a boot can be refused take the same shutdown path. Test asserts `close` ran exactly once after a route-law rejection; the same probe now prints `1` |
| 2 | **A connection lost while idle was discarded in silence.** The pool listener is required — a Node `EventEmitter` that emits `error` with no listener throws, so a Postgres restart would end the process — but it was `() => undefined`: the driver's error went nowhere. A database that drops connections every few minutes would look healthy in the log until a query happened to land on the dead socket and the request failed | `createDatabase` takes an optional `onPoolError`, and the `db` stage passes the app logger, so the drop is a `warn` with the driver error attached. Probed by restarting Postgres under a running API: `10` lines (`one per pooled connection the restart dropped`), `/readyz` stayed `200` because the pool reconnected. Optional on purpose — a test handle that is thrown away does not want a logger |
| 3 | **A killed probe could leave a file in `CACHE_DIR` forever.** The cache check wrote `.readyz-<uuid>` and deleted it; a probe killed between the two — process restart, container stop — leaves a uniquely named empty file, and no later probe will ever touch that name again. `CACHE_DIR` is user-visible: the storage screen reports unknown files as orphans, so this becomes permanent litter that a human has to clear | One fixed name, `.readyz`. The next probe overwrites and removes it, so the directory heals itself, and two concurrent probes still cannot collide in a way that matters (both write an empty file; the second delete is a no-op). Test plants a leftover and asserts the directory is empty afterwards |

Mutation checks: silencing the pool listener fails the new integration test, and restoring per-call file names fails
the leftover test.

Also verified while reviewing, with no defect found: 40 concurrent `/readyz` requests all answer `200` and leave no
files behind; file descriptors plateau at the pool's `DB_POOL_MAX` and drain after the 30 s idle timeout (no leak);
an inbound `x-request-id` is echoed on probe responses; a foreign-origin `OPTIONS /readyz` is refused `403` while
`POST /readyz` answers the `404` envelope; and a second `SIGTERM` while shutting down produces exactly one
`shutting down` line.

---

## Pass 15 — 2026-10-25 (adversarial review of `P1-API-07`)

Two defects, both in the readiness probe, both found **before commit** — and both of the same family: the probe had
two ways to say "this failed" and only one of them was honest.

| # | Bug | Fix |
|---|---|---|
| 1 | **An unwritable cache directory reported itself healthy.** The cache check signalled failure by *returning* `'fail'`, while the helper that bounds every check treated any **fulfilled** promise as success — so the `'fail'` value was mapped to `'ok'` and `/readyz` answered `200 {cache:"ok"}` with `CACHE_DIR` pointing at a regular file. A load balancer would have kept sending traffic to an API that could not store a single download | One rule, stated at the helper: a check resolves when usable and **throws** when not. The cache check now returns `Promise<void>` and propagates its `mkdir`/`writeFile` error; the reason is logged, the body still says only `"fail"`. Test: `CACHE_DIR` set to a *file* (chmod is the obvious way to make a directory unwritable and it does nothing under a root test runner), asserting `503 {database:"ok",cache:"fail"}` |
| 2 | **A check that threw before returning a promise answered `500` instead of `503`.** The bound was applied to a promise, so the call `app.db.check(...)` had already been evaluated — and a pool that has been closed throws synchronously out of it. Measured: `/readyz` → `500 INTERNAL_ERROR`, a status that says the *probe* is broken rather than the dependency, and that a monitoring rule or a load balancer keyed on `503` never fires on | The helper takes a **thunk** and invokes it inside the race, so a synchronous throw becomes a failed check like any other. Test covers a handle that throws on its second call (the boot ping succeeds, the probe does not) and asserts `503` with `database: "fail"` |

Neither could be caught by the suite that existed at the time: both live in the space between "the check returned"
and "the check failed", which is exactly the space a probe's whole existence is about.

A smaller thing in the same pass: `RouteOptions` carried a `probeTimeoutMs` that no caller set — a branch that sat
at 50 % coverage because it could only be taken by a test. Removed rather than tested; tests that need a shorter
budget register `probeRoutes` directly.

Mutation checks, because a probe test that cannot fail is worse than no probe test: making the cache check always
succeed fails 2 tests, making `/healthz` consult the database fails 1, removing the timeout bound fails 1, and
removing `cache-control: no-store` fails 2.

---

## Pass 14 — 2026-10-25 (adversarial review of `P1-API-06`)

Three defects, all found **before the task was committed**, so no released build ever had them — but each one would have
reached `main` if the task had been written the obvious way and merged on the strength of a green suite, which is the
point of reviewing the work in progress. Two of them are the same bug wearing different clothes: nobody closed the pool.

| # | Bug | Fix |
|---|---|---|
| 1 | **A boot option that was accepted and then dropped.** `buildApp({ database })` typed the option, read nothing from it, and passed only `config` into the pipeline — so the `db` stage built its **own** pool from the default DSN while the caller's handle sat unused. Every test passed: the ones that supply a handle assert on `app.db`, which the stage set from its own creation, and the ones that do not never looked at a connection. The failure mode in production is a process quietly connected to `localhost:5432` instead of its configured database | The handle is threaded into the pipeline context. The test that catches it does not go through the factory: `buildApp({ database: handle })` now fails on a handle whose `check` rejects, and an adoption test asserts `app.db` **is** the object it was given |
| 2 | **A failed boot leaked the pool.** The stage's check throws inside `onReady`; Fastify marks the instance failed and `buildApp` rethrows — but the instance is never returned, so its `onClose` hooks have no caller and the pool it just opened stays open until the process exits. Probed: `onReady` rejecting, then `app.close()`, **does** run `onClose` in Fastify 5 — the hook was fine, nothing was calling it. A supervisor retries a failed boot on a loop, so a database that is down for a minute accumulates `DB_POOL_MAX` connections per retry against a server that is already struggling. | `buildApp` closes the instance on any failure inside `registerPipeline` and rethrows the original error. Tested by rejecting from a stub `check` and asserting the handle's `close` ran exactly once (the assertion fails without the fix: `expected +0 to be 1`) |
| 3 | **A shared pool was never closed.** The stage inferred "ownership" from whether the handle was passed in and skipped `close` for caller-supplied handles. That reads as respectful and is the mirror image of bug 2: a caller that hands over a pool still expects `app.close()` to leave nothing behind, and the handle that is not closed here has no other owner. The test that asserted this behaviour was written to match the code, which is how a wrong rule survives a passing suite | One rule: `close()` closes the handle, however it arrived. An app that genuinely shares a handle between instances says so at the call site (`{ ...handle, close: () => Promise.resolve() }`) instead of asking the stage to guess. Test rewritten to assert the close |

Two smaller things in the same pass, neither a defect:

- **A branch nothing could take.** `checkDatabase` guarded its timer cleanup with `if (timer !== undefined)`, but the timer is
  armed before the `race` and cleared in `finally`, so the false arm was unreachable — and therefore untestable, which is
  how it showed up: 75 % branch coverage on a file with no gaps left. The guard is gone, not tested around.
- **A missing test for a deliberate listener.** `pool.on('error', …)` exists because a Node emitter that emits `error` with no
  listener **throws**, so one backend restart would take the process down. Nothing asserted it, so nothing would have
  noticed its removal. Now `pg_terminate_backend` kills the suite's own connection and the pool must still answer — verified
  by deleting the listener, which reports an unhandled `57P01` and fails the run.

---

## Pass 13 — 2026-10-25 (adversarial review across the completed API stages)

Three defects, none of them visible from the tests that existed. Each was found by asking what the *deployment*
does (a proxy, a browser, a malformed packet) rather than what `inject()` does.

| # | Bug | Fix |
|---|---|---|
| 1 | **Every client behind the documented proxy had the same identity.** `trustProxy` was never set, so `request.ip` was the proxy's address for all traffic. Nothing reads `request.ip` yet, which is why no test failed — but `14-security.md` §7 defines per-IP limits and the download design stores salted IP hashes. Shipping as-is would have made 10 login attempts / 15 min a **global** budget (one attacker locks out every administrator) and made every hashed IP identical (per-visitor statistics meaningless). Measured: a request with `X-Forwarded-For: 203.0.113.7` reported `127.0.0.1` | A `TRUST_PROXY` setting (default `loopback`, correct for the same-host proxy `12-deployment.md` mandates) is handed to Fastify, documented in `09` §5, `.env.example` and `14` §6, and covered by tests that use a **real socket** — `inject()` bypasses proxy resolution entirely and reported `remoteAddress` for every setting, so a test written against it would have passed whatever the code did. Probe: `loopback` → `203.0.113.7`; `none` → `127.0.0.1`; a spoofed leading hop is ignored |
| 2 | **A hop count silently disables trust.** The natural value for an operator — `TRUST_PROXY=1`, "one proxy" — makes Fastify return a trust function that is **always false** (`lib/request.js`: "Hop-count-only trust cannot validate the immediate peer. Fail closed"). No error, no warning: the proxy would look configured and do nothing, which is worse than the bug above because it is invisible | Numeric values are refused at boot with a message naming the behaviour and suggesting an address or subnet; `true`/`*` are refused too, since they let any client choose its own address. Both are tested, and the boot message is the documentation |
| 3 | **A malformed request answered in a second response shape.** A bad request line or an oversized header fails in Node's parser, before any hook, so Fastify's default handler replied `{"error":"Bad Request","message":"Client Error","statusCode":400}` — no `code`, no `requestId`, no security headers. `04-api.md` promises the envelope for every non-2xx, and this is the first thing a scanner sends. Measured with raw bytes over a socket | A `clientErrorHandler` answers the documented envelope with a generated id in both the header and the body, logs it at `warn` with the error scrubbed, and closes the connection (the parser has already given up on the stream). The status stays `400 BAD_REQUEST` even for header-overflow and timeout, because the vocabulary has no `408`/`431`. Guarded by tests over a real socket, plus a unit test that the handler never writes to a destroyed or read-only socket — writing there throws inside a Node event handler and kills the process |

One smaller fix in the same pass:

- **A cross-origin client could not read `x-request-id`.** The allowed-origin response carried
  `access-control-allow-origin` but no `access-control-expose-headers`, and a browser hides every non-safelisted
  response header from JavaScript — so the id `04-api.md` §0.2 tells clients to quote in a bug report was
  unreachable from the only place that can read it. Now exposed, and asserted.

Both new tests were verified by restoring the defect: hardcoding `trustProxy: false` fails the two forwarded-address
tests, and deleting the expose-header fails the CORS test. A mutation check is cheap and it is the only evidence
that a test would have caught the bug it describes.

---

## Pass 12 — 2026-10-25 (adversarial review of `P1-API-05`)

One defect, caught by asking what a *browser* sends rather than what curl sends — the tests, the unit probes and
the nine headers all passed while it was present.

| # | Bug | Fix |
|---|---|---|
| 1 | **The CORS rule locked the SPA out of its own API.** The first version refused any request whose `Origin` was not on the allow-list with `403 FORBIDDEN` — including *actual* requests, not just preflights. Browsers send `Origin` on same-origin `POST`/`PATCH`/`DELETE`, so the SPA posting its login form to the API on the same host carried `Origin: http://localhost:8080`, which no allow-list contains (the API is reached through the proxy, and the list is for *other* sites), and was rejected by its own server. Measured with curl: a same-origin login `POST` with `Origin: http://localhost:8080` returned `403 FORBIDDEN`. The unit tests missed it because `inject` sends no `Origin` unless told to, and the one test that did send one used an intentionally hostile origin | Only a **preflight** is refused: it is a question, and the answer is no. An actual request from an unlisted origin is answered without `access-control-allow-origin`, so a browser hides the body and no other client is affected — the behaviour CORS actually specifies. A regression test sends a same-origin `POST` carrying `Origin` and expects the handler's own status, not `403`. Probes after the fix: same-origin POST → `503` from the stub; foreign-origin GET → `503`, no ACAO; foreign-origin preflight → `403`; allowed preflight → `204` |

Worth recording because the same mistake is easy to make again: **CORS is a browser-side read barrier, not an
authorisation mechanism.** Server-side refusal of an `Origin` is either redundant (the browser already blocks the
read) or harmful (it breaks same-origin requests that happen to carry the header). Authorisation is the token
guard's job, in slot 6.

---

## Pass 11 — 2026-10-25 (adversarial review of `P1-API-04`)

One defect, found by running the failure paths on a real process instead of trusting the unit tests — which
passed while it was present.

| # | Bug | Fix |
|---|---|---|
| 1 | **The 500 log leaked the secret the 500 response was hiding.** The handler did everything right for the client: a fixed sentence, no stack, no driver text. Then it logged the exception with `request.log.error({ err: error })`, and the message it wrote was the driver's own — `connect ECONNREFUSED postgres://u:hunter2@db:5432/x`. Pino's `err` serializer prints `message` and `stack` verbatim, and **field redaction cannot see a secret that is a substring of a value**: `*.password` never matches a DSN inside a sentence. Measured: `grep -c hunter2` on the probe log returned 1 | Two layers, both at the logger level. `scrubSecrets` masks URL credentials (`scheme://user:***@host`), `password=`/`token=`/`secret=`/`api_key=` pairs and `Bearer <token>` inside free text; `withRedaction` installs it as the **`err` serializer**, owned over any caller's, so every call site is covered — including `server.ts`'s shutdown handler, which logs a raw exception too. Probe after the fix: `0` occurrences, and the useful text survives as `postgres://u:***@db:5432/x` |

A second finding, fixed in the same pass because it was in the same line of code:

- **Fastify's `err` serializer discards a pre-shaped error's name.** Passing `{ err: describeError(error) }`
  produced `"type":"Object"`, losing `TypeError` vs `RangeError` — the one thing an operator reads first. The
  serializer now receives the raw exception and does the shaping itself, so the name survives *and* the text is
  scrubbed in one place.

Two behaviours confirmed by probe rather than assumed:

- **Client-caused failure codes** were read off a running instance, not guessed: malformed JSON and an empty
  JSON body raise `FST_ERR_CTP_INVALID_JSON_BODY`/`FST_ERR_CTP_EMPTY_JSON_BODY` (400), an unsupported media
  type raises `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415), an oversized body raises `FST_ERR_CTP_BODY_TOO_LARGE`
  (413) — each mapped to its documented code.
- **A wrong method is a 404, not a 405.** Fastify answers `404` for a method a path does not accept, which is
  what the contract's vocabulary allows (there is no 405 code) and what the existing route tests already
  expected. Now asserted explicitly, with a comment, so nobody "fixes" it into a 405 later.

---

## Pass 10 — 2026-10-25 (adversarial review while building `P1-API-02` / `P1-API-03`)

Two defects, both found by writing the test before trusting the feature, and both in code that already had a
green suite.

| # | Bug | Fix |
|---|---|---|
| 1 | **Environment cross-field rules were collected and then discarded.** `parseEnv` appended the mutual-exclusion and production-DSN problems to a list, but only threw when the *schema* had failed (`if (!parsed.success)`). A production boot with **no** `DATABASE_URL`, or with both `ADMIN_PASSWORD` and `ADMIN_PASSWORD_FILE`, was therefore accepted — the rules existed, were documented, and did nothing | Both gates are explicit: the parse result (which also narrows `parsed`) and then the collected issues. A test asserts that a schema problem and a cross-field problem are reported in **one** error, so fixing a `.env` takes one boot rather than two. Probe: before, `parseEnv({NODE_ENV:'production'})` returned a config whose DSN was the localhost default; after, exit 1 with `DATABASE_URL: is required in production` |
| 2 | **Every hook-installing pipeline stage was a silent no-op.** Stages were registered with `app.register(stage)`; Fastify encapsulates hooks added inside a plugin, so slot 1's `onRequest` hook applied to its own empty subtree and nothing else. `x-request-id` was absent from every response while the plugin "was registered" and the pipeline tests passed — they only checked that routes existed. Stages 2–6 (`errors`, `security`, `db`, `rate-limit`, `auth`) have exactly the same shape, so the pipeline would have been five more no-ops | A slot now carries `install: (app) => void` and receives the **root** instance; only `routes` gets encapsulation (`app.register(registerRoutes)`), because routes want it. A regression test installs a hook-carrying stage and asserts the header reaches a real response. Probes: a plugin-registered hook → `x-from-plugin: MISSING`; after the change → header present, and the real process now returns `x-request-id` on 200, 503 **and** 404 |

Two further findings recorded rather than fixed:

- **Fastify's request serializer logs no headers.** `req` is serialized to `{method, url, host, remoteAddress}`,
  so credentials never reached a log line by that route. The redaction list is still enforced at the logger
  level (L9) and now also covers header-shaped objects a handler logs itself (`*.headers.authorization`), which
  is the shape that would actually leak.
- **`req`/`res` are serializer keys, not plain fields.** A hand-built `{ req: { headers: … } }` is passed to
  Fastify's request serializer, which expects a real request and emits `{}` — a dump written that way is
  silently emptied. Discovered by a redaction test that failed for the "wrong" reason (no censor and no value);
  the reasoning is now in the module comment so the next person does not repeat it.

---

## Pass 9 — 2026-10-25 (adversarial review of the bootstrap, `P1-API-01`)

A review of the commit that was supposed to be finished, on the principle that a green test suite proves
the tests agree with the code, not that the code works. Six defects; the first two mean the API as shipped
could not serve a single request, and the fourth means a mis-placed route hung the container instead of
failing it.

| # | Bug | Fix |
|---|---|---|
| 1 | **`buildApp()` never booted anything.** Fastify's `register()` only queues a plugin; the body runs at `ready()`. The returned instance therefore had an empty route table, and the L1 hook had never executed — a booted-looking app that 404s everything. Every test that "passed" against it was reading a queue, not an app | `registerPipeline()` registers the slots and then awaits `ready()` once; `buildApp` awaits it, so its postcondition is now *booted and frozen*. Nine tests assert against the booted instance instead of the queue |
| 2 | **The obvious fix would have failed on the second plugin.** `FastifyInstance` is a thenable: `await app.register(p)` boots the whole instance, so a loop that awaits each registration throws `FST_ERR_INSTANCE_ALREADY_LISTENING` the moment a second slot is implemented — i.e. on `P1-API-03`, not today. A regression test registers two plugins and a third empty slot to keep the loop honest | The loop never awaits a registration; one `await app.ready()` follows the loop. Probe: restoring the per-plugin `await` fails `registers every slot and boots, even with several plugins` |
| 3 | **The L1 guard made boot hang forever.** Measured against Fastify 5.12 + avvio 9.3: an `onRoute` hook that **throws** leaves `app.ready()` unsettled (avvio's boot queue stalls — a container that never starts and never exits; `timeout 12` killed it silently), while one that **returns a rejected promise** lets `ready()` resolve and registers the illegal route anyway. Both were probed directly, so neither is a guess. The original probe had missed it because it injected the illegal route *after* boot, where the hook fires synchronously and looks fine | The hook **collects** offenders and `assertRouteLaw()` throws after the boot. Probed end to end: `/_site/leak` + `/api/also-leak` registered by a plugin → exit 1 in **0 s**, both routes named. The failure lists every offending route at once instead of the first |
| 4 | **One mistake was reported two or three times.** Registering a `GET` route fires `onRoute` twice (`GET`, then the implicit `HEAD`), and a method array fires it again. Deduping by URL collapses these into one line per route, listing its methods (`Route GET,HEAD /_site/leak`) | Violations are keyed by URL and merged; a test registers `GET`+`POST` on one URL and asserts exactly one violation |
| 5 | **Shutdown was unbounded.** `await app.close()` waits for in-flight requests, so one slow request could hold the process past Docker's 10 s grace period and turn a clean restart into `SIGKILL` — losing the very logs that explain the hang | `SHUTDOWN_TIMEOUT_MS = 8_000` (below the 10 s grace) races the close; exit 0 on a clean close, 1 on failure or timeout. `createShutdown()` is injectable (`{timeoutMs, exit}`) so the six tests run on fake timers instead of sleeping |
| 6 | **A second signal was a second shutdown.** Two `SIGTERM`s (a retry, an impatient operator, `docker compose down` twice) started a second `close()` on a closing instance and armed a second timer | The returned handler is re-entrant-safe: a second signal is ignored, the timer is cleared when the close wins, and the exit code is decided once |

Also in this pass:

- **A doc-parity test for the stub routes**, bounded to `04-api.md` §0.3: it compares the three contract paths
  the app registers against the table an integrator reads. Writing it found that a naive
  `indexOf('---', …)` parse lands on the table separator, so the section is cut by heading offsets instead.
- **Hook testing needs a bare instance**: a booted app is frozen, so `addHook`/`register`/route additions
  throw afterwards. The hook is exported from `plugins/route-law.ts` for exactly this.
- **The boot path itself is now under test.** Defect 3 was first caught by a manual probe, which meant nothing
  in the suite failed if a throwing hook came back. `buildApp` takes a `slots` override (documented *tests
  only*, never passed by `server.ts`) so two real tests exist: one asserts `buildApp` rejects with the route
  named, the other that an illegal route leaves `ready()` resolvable — the property whose absence hung the
  boot. Both were proven by restoring each defect: the throwing hook fails both, and deleting the
  `assertRouteLaw` call fails the `buildApp` one, with exactly one failure and no hung suite each time.
- **Two deprecations gone**: `disableRequestLogging` is now passed as a direct option (`FSTDEP023`), and no
  warning remains in the boot output.

---

## Pass 8 — 2026-10-25 (adversarial review of the shared contracts)

A pass over `P1-REPO-07` with the opposite instinct to the one that wrote it: assume every primitive has an
input that breaks it. Six defects, each reproduced before the fix and re-probed after.

| # | Bug | Fix |
|---|---|---|
| 1 | **`offset` left the safe-integer range.** `?page=9007199254740991&limit=100` produced `900719925474099000` — a float that equals neither the requested offset nor its neighbour, and that is exactly what would have been handed to SQL as `OFFSET`. `page` was bounded; the product was not | The product is clamped to `Number.MAX_SAFE_INTEGER`; the test asserts `Number.isSafeInteger(offset)` for three extreme inputs. Probe: removing the clamp fails `never produces an offset outside the safe-integer range` |
| 2 | **`buildPageMeta` divided by zero.** The function is exported and `limit` is a parameter, so `buildPageMeta(1, 0, 10)` produced `totalPages: Infinity` — and `JSON.stringify(Infinity)` is `null`, so the contract's integer field would have shipped as `"totalPages": null`. My first fix only guarded the return value and still divided by the raw `limit`; the test caught that within a minute | `limit` and `page` are normalised inside the function and `totalPages` divides by the normalised value; the test also asserts the serialised object contains no `null` |
| 3 | **Pagination accepted number syntax a URL never carries.** `Number('0x10')` is 16 and `Number('1e3')` is 1000, so `?limit=0x10` silently meant 16 rows and `?limit=1e3` meant 100. Documented input was "a decimal in a query string"; the parser interpreted anything JavaScript could parse | `DECIMAL` (`^[+-]?\d+(?:\.\d+)?$`) replaces `Number()`. Signed and fractional decimals still work (`+5`, `5.9`, `' 5 '`); hex, binary, exponent and `Infinity` fall back to the default |
| 4 | **Encoded paths were not classified as admin.** `apiScopeOf('/_admin/%61pi/cache')` returned `null`, so the guard that keys on it would not have run. Today Fastify's router matches static segments on the encoded form and the request 404s first — but the guard is prefix-based *precisely so that new routes are protected automatically* (L2), which means classification is a security boundary that must not depend on router behaviour | Classification runs over the raw path **and** its decoded form, so the encoded prefix fails closed. Malformed escapes (`%ZZ`) are handled without throwing. Probe: restricting classification to the raw form fails `classifies the decoded form too, so the admin guard fails closed` |
| 5 | **`isPagePath` failed open.** My first implementation of the decoded-form check used `.some()`, so `/_site/%61pi` was *a page* — the raw form is not the reserved segment while the decoded form is, and `some` only needs one. The reserved-segment law held for the spelling nobody uses and not for the one an attacker picks | `.every()`: a path is a page only if no form of it is reserved. Probe: flipping it back to `.some()` fails `still treats an encoded reserved segment as reserved` |
| 6 | **The API re-derived a constant it had just imported.** `apps/api/src/config/prefixes.ts` said in its own doc comment that a second copy was "a second thing to get wrong", then built `API_PREFIXES` from the shared prefixes while `@mapirror/shared` already exported it — a second list whose order also had to match the registration order | Imported from shared and re-exported; probe: pointing the app at its own two-entry list fails the prefix test |

Two further guards added, and two claims verified rather than assumed:

- **Pagination defaults now have a doc-parity test** (`04-api.md` `?page=1&limit=25`, the `meta` shape and
  `limit` (≤ 100) in every table that takes one), the same treatment env vars and error codes already get.
- **A dead branch removed**: `pathForms` compared the decoded path to the raw one, which cannot be equal when
  a `%` was consumed — unreachable code that showed up as uncovered lines, the third instance of this
  pattern in two passes.
- **Verified, not assumed: `packages/shared` really cannot leak runtime globals.** `node:fs`, `process.env`,
  `Bun.version` and `window` were each injected into the package and each failed `typecheck` (exit 2) thanks
  to `types: []` — so the "no globals, no `node:*`" claim in `09` is enforced by the compiler, and now
  recorded as verified.
- **Documented, not changed: probes are exact.** `isPathUnder` tolerates a trailing slash but `isProbePath`
  does not, so `/healthz/` is not a probe and the route-law test would reject it if anyone registered it.
  The asymmetry is deliberate (Fastify does not ignore trailing slashes) and now has a test saying so.

---

## Pass 7 — 2026-10-25 (`P1-REPO-07`, shared contracts)

The primitives are the first code both applications depend on, so the review pressure was on *contract*
mistakes: a name that reads one way and behaves another. All eight were found while writing and probing.

| # | Bug | Fix |
|---|---|---|
| 1 | **`ACCOUNT_LOCKED` was documented as the code for a *deactivated account*** (403), while throttling is `429 RATE_LIMITED`. The name says "lockout", so whoever implements the login limiter emits it and returns 403 — reintroducing pass-1 defect 14 in a form no reviewer would spot, because the doc's own table would agree with them | Renamed to `ACCOUNT_DISABLED` in `04` and `14`, with the reason written down; `errors.spec` asserts no `ACCOUNT_LOCKED` key exists and `docs-contract` asserts it never reappears in an error-table row |
| 2 | **`isPathUnder` matched prefixes as substrings.** `/_auth/apiX` would have counted as inside `/_auth/api`, so the admin guard would treat an unrelated path as protected — or, worse, an attacker-shaped path as an API route | Whole-segment comparison with query stripping and trailing-slash normalisation, plus four tests for the lookalike cases |
| 3 | **The `api` reserved segment was documented but not implemented.** L1 says "`api` may only appear in API prefixes … the docs page is `/_site/api-docs`, never `/_site/api`", yet `isPagePath('/_site/api')` returned `true` — my own forbidden-path test caught it | Encoded in `isPagePath` (first segment only, so `/_site/api-docs` and `/_site/countries/api` stay legal) with tests either side of the boundary |
| 4 | **`interval_run_items.status` had no constant.** `03` defines a fourth `status` vocabulary (`queued/skipped/downloaded/failed`) that the interval-run detail page renders; the shared package would have had the UI hard-code it | Added `RUN_ITEM_STATUSES`, and the docs-contract test now parses all four `status` vocabularies and asserts they stay distinct |
| 5 | **A `status` column exists on three tables with different value sets**, so an unscoped parse silently returns their union — the first version of my docs-contract test asserted against exactly that union and passed for the wrong reason | Parser scoped to `CREATE TABLE <name> (… )`; regression test asserts `jobs.status` (an enum) and `map_versions.status` (a CHECK) are parsed from their own definitions and are not equal |
| 6 | **`bun run test` stayed green after `@mapirror/shared` was deleted from `apps/web`'s dependencies.** Bun leaves the workspace symlink behind, so resolution "works" on a stale link — the acceptance criterion "consumed by both apps" was not actually being checked by the tests | Declarations are asserted by `check:workspaces` (it does fail: `FAIL @mapirror/web depends on @mapirror/shared …`), and resolution is now proved from **both** consumers instead of only `apps/api`; the stale-symlink hazard is written into the script so nobody trusts resolution alone |
| 7 | **Two of my own JSDoc blocks were syntactically invalid.** `` `*/api` `` inside a block comment terminates it, so `routes.ts` failed to parse and took six test files down with a `[PARSE_ERROR]` | Rewritten; the quote is gone from the comment and the reason is obvious in hindsight |
| 8 | **My coverage-driven tests covered nothing.** The first token test asserted `ceil(32 * 4 / 3) - 1 === 43` (it is 42), and the docs-contract test sliced the error table at the first `---`, which is the table's own separator — zero rows parsed, so it compared an empty set and "passed" | Corrected arithmetic (`ceil(32 / 3) * 4 - 1`), and the slice now ends at the next heading. Both now fail loudly when the input is wrong rather than asserting emptiness |

Also removed: two unreachable `?? ''` branches on `split('?')[0]` (impossible under `noUncheckedIndexedAccess`
to be nullish) — they showed up as permanently uncovered lines in the report and were noise, not coverage to
chase.

---

## Pass 6 — 2026-10-25 (adversarial review of the tooling, P1-REPO-01…06)

Every finding below was reproduced with a probe **before** the fix and re-probed **after** it.

| # | Bug | Fix |
|---|---|---|
| 1 | **The two non-negotiable law tests would have been silently skipped.** `04-api`, `09` and `10-laws` all name them `law-routes.test.ts` / `law-router.test.ts`, but every Vitest project included only `tests/**/*.spec.ts`. Probe: a deliberately failing `apps/api/tests/law-routes.test.ts` left `bun run test` at exit 0 — "3 passed". The route law's only automated defence would have been a file that never ran | One project table in `vitest.projects.ts`, including **both** suffixes; the config and the hygiene check both read it. Probe after: the same file fails the run (exit 1, `FAIL api tests/law-routes.test.ts`) |
| 2 | **`scripts/tests/*.spec.ts` belonged to no project.** `05-flows` promises `scripts/tests/init-admin.spec.ts` for the launch script; there was no `scripts` project, so that test would have passed by not existing | Fourth project (`scripts`, node) + `bun run test:scripts`. Probe: the failing file now exits 1 and is named in the output |
| 3 | **Nothing prevented a test from escaping collection again** — the suffix bug above could return with any new package | New hygiene rule: every `*.spec.ts` / `*.test.ts` in the repository must sit under a declared project root. Probe: `tools/tests/x.spec.ts` → `FAIL every test file is collected by a vitest project: tools/tests/x.spec.ts` |
| 4 | **The documented Docker first run could not connect to its own database.** `docs/09` §2 and `docs/12` §2 both say `cp .env.example .env` then `docker compose up`, while the template carried `DATABASE_URL=…@localhost…` and `POSTGRES_PASSWORD` as two independent copies of one secret. Inside the `api` container `localhost` is not the `db` service, and `docs/12` tells the operator to change the password — which the DSN copy would not follow | The password is written once; compose **derives** `postgres://mapirror:<POSTGRES_PASSWORD>@db:5432/mapirror`, which is now an acceptance criterion of `P1-DOCK-05`. The template documents the split, and `12` says plainly not to edit `DATABASE_URL` |
| 5 | **The env template assumed container paths while being prescribed for native dev.** `CACHE_DIR=/data/cache` and `TMP_DIR=/data/tmp` are absolute; `docs/09` §3 tells a developer to copy the same template and run `bun run dev`, which then needs write access to `/`. `data/` was already gitignored and unused | Template defaults are relative (`./data/cache`, `./data/tmp`); compose binds them to the mounted volumes, and both facts are stated in the template header and in `12` |
| 6 | **`.gitignore` did not cover keys that `.dockerignore` did.** Probe: `git check-ignore deploy-key.pem` → not ignored, so a private key could be committed while the image build correctly refused it | `*.pem`, `*.key`, `*.p12`, `secrets/` added to both, plus a hygiene assertion that the two ignore files cover the same credential shapes — the asymmetry cannot come back quietly |
| 7 | **The `.dockerignore` matcher stripped `!`,** so a re-inclusion line could satisfy an exclusion assertion (`!.env` would have made "secrets are excluded" pass while excluding nothing) | Real ignore-file semantics: patterns compiled to regex, **last match wins**, `!` re-includes. Probe: replacing `.env` with `!.env` → `FAIL .dockerignore excludes .env` |
| 8 | **"No ignored artefact is tracked" checked a hardcoded path list, not the rules.** A file ignored by a pattern the list did not know (`*.pem`) would never be reported | Asks git instead: `git ls-files -ci --exclude-standard`, so a newly tracked ignored file is caught by the rule that actually applies |
| 9 | **Env parity compared names only,** so the documented default and the template's default could disagree and both files would still "know" the variable. Probe: `DB_POOL_MAX=25` in the template → `40 hygiene checks passed` | Defaults are compared too (prose cells such as `*(empty = same-origin)*` are skipped). Probe: the same edit now fails, naming both values |
| 10 | `08-tasks` still described the gate as "five stages" after hygiene became stage 2, and `check-workspaces`' header claimed a `@<root-name>/<dir>` convention while the scope was hardcoded | Count corrected to six, and the root manifest is now asserted to be `mapirror` (21 checks, was 20) so the claim is true either way |

Disclosed rather than hidden: while verifying the new matcher, the `secrets/` pattern did not match
`secrets/admin_password` (the trailing slash was left in the regex). The assertion written moments
earlier caught it before commit — the pattern is normalised now, and the probe list keeps cases that
would expose it again.

---

## Pass 5 — 2026-10-24 (test toolchain, P1-REPO-03/04)

| # | Bug | Fix |
|---|---|---|
| 1 | **Test files and root config files belonged to no TypeScript project.** ESLint's type-aware parser refused them ("was not found by the project service"), and — worse — `bun run typecheck` never checked the tests at all | Each package `tsconfig` now includes `tests/**/*.ts`; the root project includes `*.config.ts`. Verified: a deliberate type error inside a spec file now fails `bun run typecheck` |
| 2 | **Coverage reported `All files 0` and passed its thresholds** — `**/index.ts` was excluded and, in Phase 1, those were the only source files. A green coverage gate measuring nothing is worse than no gate | Only `*.d.ts` is excluded now. Verified: an uncovered source file fails the run with `ERROR: Coverage for lines (0%) does not meet global threshold (20%)` |
| 3 | The `api` environment test referenced `window`/`document`, which the server package cannot compile (no DOM lib) — the test asserted the very thing its tsconfig forbids | Probes `globalThis` instead, so the assertion and the compiler agree |
| 4 | Root `tsconfig.json` stopped matching the documented layout (`vitest.workspace.ts`) | Project tree updated to `vitest.config.ts`, and the testing section documents the three projects, their environments and the coverage floor |

---

## Pass 4 — 2026-10-24 (code review of P1-REPO-01 / P1-REPO-02)

First pass over code rather than prose. Findings, all verified by probe before and after the fix:

| # | Bug | Fix |
|---|---|---|
| 1 | **`bun run typecheck` reported success on a broken `.vue` file.** `apps/web/tsconfig.json` listed `src/**/*.vue`, but plain `tsc` does not parse SFCs — it silently skips them, so `--listFilesOnly` showed 0 `.vue` files while the command exited 0. A syntax- or type-error in a component would have shipped as "green" | `.vue` removed from the include list until `vue-tsc` replaces the script in `P1-WEB-01` (same commit adds it back); the reason is written into the tsconfig so it is not "helpfully" restored |
| 2 | **`check-workspaces` crashed with a Bun stack trace** on an unsupported workspace pattern or an unreadable manifest — the exact situation where a CI author needs a readable message | All discovery errors are recorded as `FAIL` lines; the whole run is wrapped so an unexpected throw also prints one line and exits 1 (20 checks now, was 12) |
| 3 | **`packages/shared` inherited `types: ["bun"]`.** Shared is bundled into the browser; a `Bun.*` or `process.*` reference there would type-check and then crash the SPA at runtime | `types: []` for shared, so the compiler rejects either global; verified with a `Bun.version` probe |
| 4 | **`09-development.md` presented 15 scripts as available** (`dev`, `check`, `lint`, `db:migrate`, `admin:init`, …) when only two exist | Table gained a status column naming the task that creates each script, and §3 carries a "where we are today" banner |

The review also confirmed three things *are* correct, so they are not silently assumed: a failing
workspace makes `bun run typecheck` exit non-zero (verified: exit 2), the root project really checks
`scripts/` (verified with a deliberate type error), and `.gitignore` ignores `.env`/`.env.local` while
keeping `.env.example` (verified with `git check-ignore`).

---

## Pass 3 — 2026-10-24 (logic review + refactor)

Focus: correctness of the *mechanisms* (not wording), then structure.

| # | Bug | Fix |
|---|---|---|
| 1 | Reaper claimed to requeue jobs "whose process is gone" — a timestamp cannot tell crashed from slow, so a stalled transfer could be stolen and two workers would write the same `.part` | Ownership is now a `pg_try_advisory_lock` per job; the reaper requeues only rows whose lock it can acquire. Heartbeats moved to a timer independent of the download loop |
| 2 | Scheduler said `day_of_month` is "clamped to the last day" while the schema caps it at 28 — the clamp could never run | Contradiction removed; the cap is the mechanism, documented once |
| 3 | Scheduler claimed a row, then inserted the run and enqueued jobs as separate steps — a failure between them lost the schedule silently | Single transaction: run row + job enqueues + `next_run_at`. Failure rolls back and retries next tick |
| 4 | A slow occurrence still running would collide with `interval_runs_one_active` and error | Explicit `SKIPPED_OVERLAP` path: skip this occurrence, never stack runs |
| 5 | Update detection mixed "data timestamp newer" with "id already cached" without precedence | Ordered decision (id match → timestamp → identity → unknown), documented as 4 rules |
| 6 | `COUNTRY_ALREADY_CACHED` described a *version* condition | Renamed `VERSION_ALREADY_CACHED` |
| 7 | `map_versions.status` carried `downloading`/`verifying`, duplicating `jobs.phase` — two state machines for one concept | Reduced to `pending / ready / failed`; progress lives on the job |
| 8 | Flow F12 pointed at `orphans` in `/system/status`, but the response schema had no such field | `storage.orphans` + `storage.state` (`ok / low / full`) added |
| 9 | Internal/job codes (`WORKER_LOST`, `RUN_INTERRUPTED`, `SKIPPED_OVERLAP`, `INVALID_ENV`, disk `state`) appeared in prose but were undocumented | One table for job/internal codes, explicitly separated from HTTP codes |
| 10 | `WORKER_LOST` and disk-low were listed as if they were HTTP errors | Corrected: job `error_code` / storage state |
| 11 | Path params drifted (`:id` vs `:countryId`, `:id` vs `:jobId`) across four docs | Normalized everywhere |
| 12 | `14-security.md` rate table pointed at `/_public/api/.../download` (not a real path) | Full path |
| 13 | Two docs referenced a task that does not exist (`P2-CACHE-03`) | `P2-JOB-03` |
| 14 | Counts were stale in four places: 145 tasks (real: 136 — 140 since pass 31 added the four Phase 5 admin rows), 11 tables (15), "15 screens" (14 + 404), and a 41-defect total that ignored the table rows | All recomputed from the files themselves before publishing |
| 15 | A duplicated `### Backup` heading and a restore description that claimed to restore map files the backup never contains | Single heading; restore now explains reconciliation (`ready` + missing file → `failed`) instead of a false claim |
| 16 | Deployment used `bun run scripts/reset-admin-password.ts` while the dev guide used `make reset-admin` / `bun run admin:reset` | All three forms documented as equivalent, each noting that tokens are revoked |

**Refactor (documentation structure).**

- The index had accumulated the review logs (56 lines). They now live here; `00-index.md` is an index
  again (95 lines: route map, document table, reading paths, status, conventions).
- `04-api.md` §0 is declared the **normative** route table; `10-laws.md` L1 states rules and points at
  it instead of keeping a third copy that could drift.
- `15-decisions.md` points at `PROMPT.md` §24 for the *what* (D-table, owner-owned) and keeps only the
  *why* (ADRs), so a decision is never edited in two places.
- `05-flows.md` F12 is the single home for recovery behaviour; the architecture doc links to it rather
  than restating it.

---

## Pass 2 — 2026-10-24 (after the login-namespace change)

| # | Bug | Fix |
|---|---|---|
| 1 | Login page at `/_site/login` violated "auth routes live under `/_auth/*`" | Login page → `/_auth/login`; auth JSON → `/_auth/api/*` (D-19, ADR-024) |
| 2 | Splitting page and API by HTTP method on one URL would reintroduce header/method sniffing | Separate paths, same `api` convention as the other namespaces |
| 3 | Nginx could serve `/_auth/api/login` as the SPA (fallback rule ordering) | Location map documented with `^~ /_auth/api/` before `= /_auth/login`; Phase 6 curl check |
| 4 | Vite dev proxy on bare `/_auth` would swallow the login page (works in prod, 404 in dev) | Dev proxy narrowed to the three `*/api` prefixes |
| 5 | Deleting a country erased its interval run history (`ON DELETE CASCADE`) | `interval_run_items.country_id` → `SET NULL` + `country_slug`/`country_name` snapshots; unique key on `(run_id, country_slug)` |
| 6 | A crash mid-run left `interval_runs` `running` forever, and the new unique index would then block the schedule permanently | Reaper closes runs older than 6 h as `RUN_INTERRUPTED` (F12) |
| 7 | Fastify auto-registers `HEAD` for `GET`; every head/preview would create a `download_events` row | `HEAD` returns headers and records nothing |
| 8 | A duplicate import uploaded gigabytes before failing with `409` | UI pre-checks versions; server aborts the stream as soon as country+version are known (409 path stays authoritative) |
| 9 | `metrics_samples` primary key on `sampled_at` could collide (restart/replica) | Sampler writes `ON CONFLICT (sampled_at) DO NOTHING` |
| 10 | A naive settings serializer could leak `privacy.ipHashSalt` | Explicit allow-list projection; secrets never serialized |
| 11 | Error table said `503 SOURCE_UNAVAILABLE` while endpoints said `502` | `502 SOURCE_UNAVAILABLE`, `503 NOT_READY/DB_UNAVAILABLE/DISK_FULL` |
| 12 | `COUNTRY_NOT_PUBLIC` appeared as an error code, contradicting "public always 404 `NOT_FOUND`" | Removed |
| 13 | Deleting a version left a stale `update_state`/size on the cache row | Recompute totals and reset `update_state` in the same transaction |
| 14 | Nginx lacked `proxy_request_buffering off` → an 8 GiB import spooled to disk before forwarding | Added to the deployment snippet with the reason |
| 15 | Interval-created download jobs had no way to say "skip if unchanged" | `onlyIfChanged` added to the job payload |
| 16 | Stale counts ("18 decisions / 23 ADRs", "110 tasks") and a dead `/_site/login` link in the laws table | Corrected (task count was itself wrong again — fixed in pass 3, item 14) |
| 17 | Login schema said password `8–256`, contradicting the 12-character policy | Login accepts 1–256 (never reveal policy to an attacker); 12+ enforced at creation/reset |
| 18 | The DB-extension prerequisite lived in the TLS section, where nobody reads it before first boot | Moved into the install section |

## Pass 1 — 2026-10-24 (docs audit)

Every file was re-read against `PROMPT.md` and the live Geofabrik behaviour. Fixed:

| # | Bug | Fix |
|---|---|---|
| 1 | Pages and APIs shared the same namespaces (`/_admin/<page>` vs `/_admin/api/*`) | **All pages moved to `/_site/*`**; APIs keep their three prefixes (ADR-023, D-18) |
| 2 | `map_versions` had a `deleted_at` tombstone while D-7b requires hard delete | Tombstone removed; `UNIQUE (country_id, version)`; the audit log is the record |
| 3 | `mv_size_positive` would have blocked the `pending` row created before a download | Constraint scoped to `status = 'ready'` |
| 4 | `countries_name_trgm` needs `pg_trgm`, which no migration created | Extensions added to `0001_init.sql`, with an `unaccent` fallback |
| 5 | Region endpoints used `:sourceId` (`europe%2Ffinland`) — encoded slashes break through proxies | `:slug` in the path (`finland`), `sourceId` stays in the payload |
| 6 | `DELETE` required a JSON body — stripped by some clients/proxies | `?confirm=` query is canonical; body still accepted |
| 7 | `?version=latest` was sent with `max-age=31536000, immutable` — it is a moving alias | `latest` → `no-cache`; explicit versions → immutable |
| 8 | A `delete_country` job type existed although deletion is synchronous | Removed; queued deletes behind a long download were a UX trap |
| 9 | `interval_runs` could hold two `running` rows; run items could duplicate | Partial unique indexes added (and ordered after their tables) |
| 10 | Two interval-run routes were ambiguous (`/intervals/:id/runs` vs `/intervals/runs/:runId`) | Run detail moved to `/interval-runs/:runId` |
| 11 | Route-law test claimed to cover page routes, but pages are served by Nginx, not Fastify | Split into an API route-table test + a Vue router-table test + a container check |
| 12 | Update detection called `MapSource.getLatest()`, which the interface never had | Uses `getRegionDetail()` (the documented 4-method interface) |
| 13 | Single-country update check returned `202 {jobId}` while ADR-020 says it is inline | Always `200` (with `unknown` on timeout); only bulk checks are async |
| 14 | Lockout returned both `403` and `429` in different docs | `429` for throttling, `403` only for a deactivated account |
| 15 | Public SPA was described as "light-only" while UX-2 promises light + dark | Light default, dark fully supported and remembered per visitor |
| 16 | Fonts/JS budget claimed < 150 kB gzip for a Vuetify app | Realistic ≤ 220 kB gzip first route, LCP < 2.5 s |
| 17 | Missing env vars (`DATABASE_URL_TEST`, `CORS_ORIGINS`, `IP_HASH_SALT`) | Added to `09` and to `settings` in `03` |
| 18 | CSP lacked `object-src`/`form-action`/`manifest-src`; `style-src 'unsafe-inline'` unexplained | Completed and justified (Vuetify runtime styles) |
| 19 | Broken prose/typos: `/ _admin/`, `/admin/*` leftovers, stale route in F2 | Corrected |
| 20 | Roadmap gantt used numeric effort as epoch seconds | Replaced with a readable phase/gate table |

Verified after changes: **0 broken links or anchors, 0 unbalanced code fences** across all 18 markdown files.

---

---

## Open items

None. Anything new found while building is added here and fixed in the same commit (L12).
