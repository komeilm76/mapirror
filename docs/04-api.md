# 04 — API contract

**TL;DR** — pages under `/_site/*`, JSON under `/_auth/*`, `/_admin/api/*` (Bearer), `/_public/api/*` (anonymous); one error envelope; downloads stream with `Range`/`ETag`; unpublished countries are indistinguishable from nonexistent ones.

JSON APIs only, no versioning prefix (the app is self-hosted and upgraded with its UI). All bodies are
`application/json` unless stated. All responses are typed with Zod schemas from `packages/shared`, so
this document and the code cannot drift silently.

## 0. Route map (normative)

This table is the single normative source for route placement. `00-index.md` summarises it and
`10-laws.md` L1 states the rules; neither may introduce a route that is missing here.

| Kind | Prefix | Example | Auth |
|---|---|---|---|
| Website pages (SPA) | `/_site/*` | `/_site/`, `/_site/countries/finland`, `/_site/admin/cache` | — |
| Login page (SPA) | `/_auth/login` | `GET /_auth/login` → HTML | — |
| Admin API | `/_admin/api/*` | `/_admin/api/cache/:countryId/public` | Bearer |
| Public API | `/_public/api/*` | `/_public/api/countries/finland/download` | — (rate limited) |
| Auth API | `/_auth/api/*` | `POST /_auth/api/login` | mixed |
| Probes | `/healthz`, `/readyz` | — | — |

`GET /` → `302 /_site/`. Page routes never return JSON; API routes never return HTML (L1).

### 0.3 Bootstrap state (temporary)

No `503 NOT_READY` routes are currently registered. Implemented endpoints answer their contract; planned endpoints
remain absent until their task registers them, so unknown paths return the standard `404 NOT_FOUND` envelope. The
bootstrap test asserts this table stays empty rather than exposing placeholder routes.

| Route | Replaced by |
|---|---|

`POST /_auth/api/login` and `GET /_public/api/countries` used to be bootstrap stubs; they are now implemented and
documented in §§1 and 3.1. No stub is registered at a bare prefix: `/_auth/api` with no trailing slash is not a route,
which keeps the route table exactly as wide as the law allows.

## 0.2 Conventions

| Topic | Rule |
|---|---|
| Base | `http://<host>:8080` (Nginx) → proxies to the API |
| Namespaces | APIs: `/_auth/*`, `/_admin/api/*`, `/_public/api/*`. Pages: **all** under `/_site/*` (`/_site/admin/*` for the panel). See §0.1 |
| Auth (admin) | `Authorization: Bearer mm_…` on **every** `/_admin/api/*` request |
| Auth (public) | none |
| IDs | UUIDv4 strings; `countryId` is the local UUID; `sourceId` is the Geofabrik id (`europe/finland`) |
| Pagination | `?page=1&limit=25` → envelope `{ data, meta: { page, limit, total, totalPages } }`; `limit` (≤ 100) values are **clamped** (never rejected) and only plain decimals are read — `?limit=0x10` or `?page=1e3` fall back to the defaults |
| Sorting | `?sort=name|size|updated|created&order=asc|desc` |
| Time | ISO-8601 UTC strings; byte counts are integers |
| Nullability | absent/null means "unknown", never 0 |
| Request id | UUIDv4, returned in `x-request-id`, echoed in every error and used as `reqId` in every log line. An inbound `x-request-id` is repeated only if it matches `[A-Za-z0-9._-]{8,64}`; anything else is replaced, so a caller cannot write into our log stream |
| CORS | same-origin by default. `CORS_ORIGINS` is an explicit allow-list: an allowed origin gets `access-control-allow-origin` (plus `access-control-expose-headers: x-request-id`, so the browser can read the id this table tells clients to quote) and a `204` preflight; a preflight from any other origin is `403 FORBIDDEN`; an actual request from any other origin is answered without the header. Never `*` |
| Rate limits | `429` + `retry-after`; login and public downloads are limited |

### Error envelope

Every non-2xx response is this shape — including `404` for an unknown path and for a method a path does not
accept (the contract has no `405`), and including `500`. A `500` carries one fixed sentence and no detail: the
exception's message and stack go to the log under the same `requestId`, so a bug report can be answered without
the response ever describing the server's internals. `details` is omitted entirely when there is nothing to say.


```json
{
  "error": {
    "code": "VERSION_DUPLICATE",
    "message": "Version 260101 already exists for this country.",
    "details": { "countryId": "…", "version": "260101" },
    "requestId": "9f1c2d1e-4b7a-4c2f-9e3a-1a2b3c4d5e6f"
  }
}
```

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_ERROR`, `BAD_REQUEST` |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN`, `ACCOUNT_DISABLED` |
| 404 | `NOT_FOUND` (public paths use it even when the country exists but is unpublished — no existence leak) |
| 409 | `VERSION_DUPLICATE`, `VERSION_ALREADY_CACHED`, `JOB_ALREADY_RUNNING`, `CONFIRMATION_REQUIRED` |
| 410 | `VERSION_FILE_MISSING`, `SOURCE_VERSION_GONE` |
| 413 | `FILE_TOO_LARGE` |
| 415 | `UNSUPPORTED_FORMAT` |
| 422 | `SEMANTIC_ERROR`, `NO_READY_VERSION` (publish without a ready version) |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |
| 502 | `SOURCE_UNAVAILABLE` (upstream failed — retryable) |
| 503 | `DB_UNAVAILABLE`, `DISK_FULL`, `NOT_READY` |

The same envelope is used for a request that never became a valid HTTP request — a malformed request line or an
oversized header, which Node reports before any route exists. There is no route context to log it against, so the
id is generated for that response and appears in the header and in the log line, and the connection is closed
afterwards. Its code is `BAD_REQUEST`/`400` even for the timeout and header-overflow cases, because `ERROR_STATUS`
has no `408`/`431` and a status outside the documented vocabulary is the defect this rule removes.

`VALIDATION_ERROR` puts the failing fields in `details.issues`, each with a dotted `path` and the rule it broke —
what a form needs to mark the right input:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed.",
  "details": { "issues": [{ "path": "username", "message": "Too small: expected string to have >=3 characters" }] },
  "requestId": "…" } }
```

**Job & internal codes** (never HTTP status codes; they appear as `error_code` on a job or as a
`storage` state. Job messages are generic and safe for the admin UI):

| Code | Where | Meaning |
|---|---|---|
| `JOB_HANDLER_FAILED` | job `error_code` | A handler attempt failed; generic safe message, retried with backoff while attempts remain |
| `WORKER_LOST` | job `error_code` | The worker died mid-job; retried with backoff or terminal after attempts are exhausted |
| `RUN_INTERRUPTED` | `interval_runs.error_message` | A run was open when the process died; closed by the reaper |
| `SKIPPED_OVERLAP` | `interval_runs` log | The previous occurrence was still running; this one was skipped |
| `SOURCE_VERSION_GONE` | job `error_code` + HTTP 410 | The upstream dated snapshot no longer exists |
| `VERSION_FILE_MISSING` | HTTP 410 | The DB row is ready but the file is gone from disk |
| `INVALID_ENV` | startup | Config validation failed; the process exits with a readable message |
| `storage.state` = `ok \| low \| full` | `/system/status` | Disk headroom vs `DISK_RESERVE_BYTES`; `low` is what the dashboard warns about |

---

## 1. `/_auth/api/*` — authentication (the login page is `GET /_auth/login`)

Rate limited per IP; all responses are JSON.

### `POST /_auth/api/login`

Body: `{ "username": "admin", "password": "…" }` (Zod: username 1–64 chars, password 1–256 chars). Username control characters are rejected.

> The **login** schema deliberately does not enforce the 12-character minimum: it must accept any
> existing password and must not reveal the policy to an attacker. The minimum is enforced where
> passwords are **created** — bootstrap (`init-admin`) and reset (`reset-admin-password`).

```json
200 {
  "token": "mm_8Jk…",           // shown once, never retrievable again
  "expiresAt": "2026-10-25T03:21:00.000Z",
  "admin": { "id": "…", "username": "admin" }
}
```

Headers: `cache-control: no-store` on **every** answer in this namespace, and never a `set-cookie` — the token
travels in the body and nowhere else (a token in a shared cache is a session handed to the next caller).

Errors: `400 VALIDATION_ERROR` with `details.issues[]` naming the field, `401 INVALID_CREDENTIALS` (generic, no
user enumeration), `429 RATE_LIMITED` with `details.lockedUntil` + `details.retryAfterSeconds` **and** a matching
`Retry-After` header (whole seconds, ≥ 1; no other answer carries that header) after N failures (default 10
attempts / 15 min, per IP + username, 30 / IP). The same `429` also answers `retryAfterSeconds: 1` while N attempts
for that pair are **still being verified** — an allowance that is busy, not a lockout, so a client that waits a
second may well succeed; `lockedUntil` is then one second ahead, not the end of the window. And
`403 ACCOUNT_DISABLED` only when the admin account itself is deactivated (rate limiting is **not** a 403,
and the code name says what it means — an earlier `ACCOUNT_LOCKED` read like a lockout and invited emitting
403 for throttling).

```bash
curl -sX POST http://localhost:8080/_auth/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"'"$ADMIN_PASSWORD"'"}'
```

Side effects: audit `auth.login` / `auth.login_failed`; `last_login_at`; token row (hash only).

### `GET /_auth/api/me`

Bearer required. The SPA's boot check: is the token in `sessionStorage` still worth holding, and for how long. The
metadata is the **token's**, not the account's — a token minted on another device has its own expiry.

```json
200 {
  "admin": { "id": "…", "username": "admin" },
  "expiresAt": "2026-10-25T21:00:00.000Z",
  "lastUsedAt": "2026-10-25T09:00:00.000Z"   // null until the first request made with this token
}
```

Errors: `401 UNAUTHENTICATED` (no header, a scheme other than `Bearer`, an unknown or malformed token),
`401 TOKEN_EXPIRED`, `401 TOKEN_REVOKED`, `403 ACCOUNT_DISABLED`. Header: `cache-control: no-store`. Side effect:
`last_used_at` is recorded, at most once per minute (`03-data-model.md` §2.2).

### `POST /_auth/api/logout`

Bearer required. Revokes **only the presented token** — closing a tab on a phone does not sign the desktop out.
"Sign out everywhere" is not an endpoint: it is what a password reset does (`P1-AUTH-07`).

`204 No Content`, empty body. The revocation and its `auth.logout` audit row commit in one transaction, so a failed
audit write leaves the session alive and answers `500` rather than ending it unrecorded.

Errors: the same four as `/me`. An already-revoked token answers `401 TOKEN_REVOKED`; the second logout does not
pretend to have ended anything, and the original `revoked_at` is never rewritten.

> Token TTL: `AUTH_TOKEN_TTL_HOURS` (default 12). No refresh endpoint by design (D-3): the SPA
> redirects to the login page on `401 TOKEN_EXPIRED`. Password reset revokes all tokens.

---

## 2. `/_admin/api/*` — admin (Bearer required, deny by default)

### 2.1 Catalog

#### `GET /_admin/api/catalog`

Query: `q` (trimmed name or ISO alpha-2/3166-2 substring, up to 128 characters), `continent` (non-empty parent id, up to 255 characters),
`cache` = `all|uncached|cached` (default `all`), `update` = `any|available` (default `any`), `page`, `limit` (≤ 100), default 50,
`sort=name|size|updated|created` (default `name`), and `order=asc|desc` (default `asc`). `size` orders by upstream size hint,
`updated` by the last catalog sync for each row, and `created` by the row's first local insertion. Unknown query keys and invalid enum values return
`400 VALIDATION_ERROR`; page/limit follow §0.2's decimal-only clamping. An empty filtered result reports `totalPages: 0`.

`iso` contains the deduplicated ISO alpha-2 and ISO 3166-2 codes. Byte counts are JSON integers when safe and decimal strings otherwise.
`catalogSyncedAt` is the durable successful-sync time, or `null` before the first committed sync.

```json
200 {
  "data": [{
    "countryId": "…", "sourceId": "europe/finland", "name": "Finland",
    "slug": "finland", "continent": "europe", "iso": ["FI"],
    "sourceSizeHintBytes": 773465008,
    "cache": { "cached": true, "versionsReady": 3, "totalSizeBytes": 2319000000,
               "isPublic": true, "updateState": "update_available",
               "availableVersion": "261024", "availableSizeBytes": 774000000 },
    "lastSyncedAt": "2026-10-24T06:00:00.000Z"
  }],
  "meta": { "page": 1, "limit": 50, "total": 389, "totalPages": 8 },
  "catalogSyncedAt": "2026-10-24T06:00:00.000Z"
}
```

The **Download** action is rendered when `cache.cached === false` (GEO-3). Cached rows show
version/public actions instead.

#### `POST /_admin/api/catalog/sync`

Accepts no body (or `{}`); unknown fields return `400 VALIDATION_ERROR`. Queues a `catalog_sync` job and returns
`202 { "jobId": "…" }`. A second or concurrent call while one is queued/running returns that same job id; a transaction-scoped PostgreSQL
advisory lock serializes API and CLI triggers across processes. The job records the requesting
admin, and the worker fetches the configured Geofabrik index with its bounded, cancelable request. `bun run sync:catalog`
uses the same queue operation; it does not bypass the job handler or fetch the source directly. With
`WORKER_ENABLED=true`, the configured worker runs the committed job; otherwise it remains queued for an enabled worker.

The handler always performs an explicitly queued sync; freshness is a separate trigger policy based on the
transactionally written `source.catalogSyncedAt` marker. `source.catalogTtlMinutes` (initially from `CATALOG_TTL_MINUTES`,
default 360 minutes) sets the window; a missing/invalid marker or an age at/over the TTL is stale. The marker commits
with country upserts and audit, so empty catalogs and job-history pruning are handled. An existing queued/running
catalog job suppresses a duplicate TTL-triggered enqueue. A successful sync audits `catalog.sync` in the same
transaction as country upserts; source removals do not delete local catalog or cache rows.

#### `GET /_admin/api/catalog/regions/:slug`

Uses the **local slug** (`finland`, `europe-finland`), never the raw `europe/finland` id — an encoded
slash (`%2F`) in a path segment is normalized differently by proxies and can 404 unpredictably.
The `sourceId` is still returned in the payload for reference.

Returns the local catalog identity plus its parent chain (root first), ISO codes, source PBF URL and catalog size hint,
current source version/size/“data up to” timestamp, and every ready cached version. Source-page fields are `null` when
Geofabrik cannot be reached; `sourceReachable` is `false` and locally cached versions remain available. The response is
`{ country: { countryId, sourceId, slug, name, parentChain, iso, pbfUrl, sizeHintBytes }, source:
{ version, sizeBytes, dataTimestamp }, sourceReachable, cachedVersions }`. `parentChain` entries have `sourceId`,
`slug` and `name`; cached versions include `id`, `version`, `origin`, `dataTimestamp`, `sizeBytes`, `checksumMd5` and
`createdAt`. Unknown valid slugs return `404 NOT_FOUND`; malformed slugs return `400 VALIDATION_ERROR`.

#### `GET /_admin/api/catalog/regions/:slug/snapshots`

Lists what the source offers **right now** (GEO-4):

```json
200 {
  "data": [
    { "version": "261024", "dataTimestamp": "2026-10-23T20:20:51.000Z",
      "sizeBytes": 774000000, "checksumMd5": null, "cached": false },
    { "version": "261023", "dataTimestamp": "2026-10-22T20:19:04.000Z",
      "sizeBytes": 773465008, "checksumMd5": "0123456789abcdef0123456789abcdef", "cached": true }
  ],
  "latest": { "version": "261024", "sizeBytes": 774000000 },
  "fetchedAt": "2026-10-24T09:12:00.000Z",
  "sourceReachable": true
}
```

`sourceReachable: false` ⇒ UI shows a warning and offers only already-cached versions. In that case `data` contains the
ready, locally cached Geofabrik versions (uploads are not source snapshots), `latest` is `null`, and the response is
still `200`; when reachable, `data` contains the current source offers and `cached` indicates which are ready locally.
A cached MD5 is included when the upstream page does not advertise one. `fetchedAt` is the completion time of the
upstream attempt. Missing valid slugs return `404 NOT_FOUND`; malformed slugs return `400 VALIDATION_ERROR`.

#### `POST /_admin/api/cache/downloads`

```json
{ "countryId": "…", "version": "latest" }   // or "261023"
```
`202 { "jobId": "…", "resolvedVersion": "261024" | null }`

Errors: `409 VERSION_ALREADY_CACHED` (the resolved source identity is already `ready`), `409 JOB_ALREADY_RUNNING`,
`503 DISK_FULL` (`details.requiredBytes` is the padded download estimate, `freeBytes` is filesystem space
available to the API process, and `reserveBytes` / `shortfallBytes` explain the configured floor). Values are JSON
integers when safe, otherwise decimal strings; `410 SOURCE_VERSION_GONE` (the dated snapshot was deleted upstream —
offer `latest` instead), `502 SOURCE_UNAVAILABLE` (source metadata could not be fetched, safe to retry). For a dated
request the API rejects an already-ready local label before contacting Geofabrik, so a cached file remains recognizable
during an upstream outage. For `latest`, it first resolves the current Geofabrik region page and PBF headers, then rejects
an already-ready matching source identity. It creates the configured cache root if needed, checks
`available >= ceil(size × 1.1) + reserve`, and inserts only after all preflights succeed. A missing PBF length is treated as unknown (zero known transfer bytes) while the configured reserve is
still enforced; the worker validates actual streamed length and checksum. `resolvedVersion` is the current dated source
label for `latest`, the requested date for an explicit snapshot, or `null` only when upstream metadata cannot identify
the latest dated label. The partial unique index on active `download` jobs is authoritative for `(countryId, version)`:
concurrent requests cannot both enqueue, and its named constraint maps to `JOB_ALREADY_RUNNING` rather than a generic
database error.

---

### 2.2 Cache & versions

#### `GET /_admin/api/cache`

Returns cached countries only, using the same row projection and pagination metadata as the catalog list. It accepts
`q`, `continent`, `update=any|available`, `page`, `limit` (default 50, maximum 100),
`sort=name|size|updated|created`, and `order=asc|desc`; `cache` is not accepted because the route is always cached-only. Here `size` sorts by total local cached bytes (the catalog endpoint's `size` is the source-size hint); `updated` sorts by catalog sync time.
Unknown keys and invalid filters return `400 VALIDATION_ERROR`. Each row adds `lastCheckedAt` (the last upstream
update-check time), `createdAt` (the cache-row creation time), and `mostRecentDownloadAt` (the latest successful
Geofabrik version install; uploads and non-ready versions do not count). Timestamps without a matching event are `null`.
As in catalog rows, byte counts are JSON integers when safe and decimal strings otherwise.

```json
200 {
  "data": [{
    "countryId": "…", "sourceId": "europe/finland", "name": "Finland",
    "slug": "finland", "continent": "europe", "iso": ["FI"],
    "sourceSizeHintBytes": 773465008,
    "cache": { "cached": true, "versionsReady": 3, "totalSizeBytes": 2319000000,
               "isPublic": true, "updateState": "update_available",
               "availableVersion": "261024", "availableSizeBytes": 774000000 },
    "lastSyncedAt": "2026-10-24T06:00:00.000Z",
    "lastCheckedAt": "2026-10-24T06:00:00.000Z",
    "createdAt": "2026-10-20T12:00:00.000Z",
    "mostRecentDownloadAt": "2026-10-23T20:20:51.000Z"
  }],
  "meta": { "page": 1, "limit": 50, "total": 12, "totalPages": 1 }
}
```

#### `GET /_admin/api/cache/:countryId`

`:countryId` is a local UUID. The detail response includes the current cache/publication summary and update-check state,
ready versions, and only queued/running jobs whose payload identifies this country. An uncached or unknown UUID returns
`404 NOT_FOUND`; a malformed UUID returns `400 VALIDATION_ERROR`.

```json
200 {
  "country": { "countryId": "…", "name": "Finland", "slug": "finland", "sourceId": "europe/finland", "iso": ["FI"] },
  "cache": { "isPublic": true, "publicSince": "…", "totalSizeBytes": 2319000000, "versionsReady": 3,
             "updateState": "update_available", "availableVersion": "261024",
             "availableSizeBytes": 774000000, "updateCheckedAt": "…" },
  "versions": [ { "id": "…", "version": "261023", "origin": "geofabrik_snapshot",
                  "dataTimestamp": "…", "sizeBytes": 773465008, "checksumMd5": "…",
                  "status": "ready", "createdAt": "…" } ],
  "activeJobs": [ { "id": "…", "type": "download", "status": "running", "progressBytes": 123456789, "totalBytes": 774000000 } ]
}
```

Download events are recorded for completed or interrupted admin streams, but per-version counts are not exposed here;
that read model remains part of the later public-download analytics task (P3-API-06).

#### `DELETE /_admin/api/cache/:countryId?confirm=<slug>`

`confirm` must exactly equal the country slug (typed confirmation, L10). A JSON body `{ "confirm": "finland" }`
is also accepted, but the query form is canonical: `DELETE` bodies are stripped by some proxies and HTTP clients.
Missing or mismatched confirmation returns `409 CONFIRMATION_REQUIRED`; malformed UUIDs return `400 VALIDATION_ERROR`,
and uncached/unknown countries return `404 NOT_FOUND`.

- Deletes all map-version rows and the `country_cache` row, removing public access; the catalog `countries` row remains.
- By default, an active queued/running country job returns `409 JOB_ALREADY_RUNNING`. `?cancelJobs=true` requests
  cooperative cancellation and waits for worker cleanup (queued jobs cancel immediately). If a running job has not
  reached a terminal state within 3 seconds, the endpoint still returns `409` and leaves cache rows/files intact.
- Download admission and deletion share a per-country PostgreSQL advisory lock through post-commit file cleanup, so a
  new download cannot install a file at a path being unlinked. If another cache mutation/stream still holds its lock
  after 5 seconds, deletion returns `409 JOB_ALREADY_RUNNING` without changing data. The admin and public streams (P2-API-09/P3-API-05) take a shared lock on the same country key before opening a file
  and hold it until the response closes. The delete-side exclusive lock then waits for active transfers,
  preserving CACHE-5.
- The database deletes and audit `cache.delete_country` commit together; validated version paths are unlinked afterward
  through the storage boundary. An unlink failure is logged as an orphan for the sweep and does not turn a committed
  deletion into a `500`.
- `204 No Content`. The current P2 schema has no interval-membership tables; when P4-INT-01 adds them, its integration
  must also remove a country from those memberships when this cache-delete operation runs.

#### `POST /_admin/api/cache/:countryId/public`

Body: strict `{ "isPublic": true|false }` → `200 { "isPublic": true, "publicSince": "…" }` when opening access, or
`200 { "isPublic": false, "publicSince": null }` when closing it. Publishing requires at least one `ready` version;
otherwise the endpoint returns `422 NO_READY_VERSION` without changing state. An unknown or uncached country is `404`.

Each actual state transition appends `cache.publish` or `cache.unpublish` in the same transaction as the cache-row
update; the audit records the admin snapshot, country, and before/after visibility. Repeating the already-current state
is idempotent and does not create a second audit event. Closing access clears `public_since` but does not delete cache
or version data. The route remains covered by the global admin Bearer guard.

#### `POST /_admin/api/cache/:countryId/check-update`

Runs **inline** with a 5 s budget and always answers `200` — a slow or unreachable source returns
`state: "unknown"` rather than a job handle (ADR-020). Bulk checks (§ below) are the asynchronous path.

```json
200 {
  "state": "update_available",
  "cached": { "newestVersion": "261023", "dataTimestamp": "2026-10-22T20:19:04.000Z" },
  "source":  { "version": "261024", "dataTimestamp": "2026-10-23T20:20:51.000Z", "sizeBytes": 774000000 },
  "checkedAt": "2026-10-24T09:15:00.000Z"
}
```
`state: "unknown"` + `reason` when the source is unreachable (L11).

#### `POST /_admin/api/cache/check-updates`

Body: `{ "countryIds": ["…"] }` (omit ⇒ all cached). `202 { "jobId": "…" }`, progress in the job.

#### `GET /_admin/api/cache/:countryId/versions`

Returns all stored version rows for a cached country (ready, pending, and failed), paginated with `page` and `limit`
(default 25, maximum 100). Unknown query keys return `400 VALIDATION_ERROR`; malformed UUIDs return `400`, and an
uncached or unknown country returns `404 NOT_FOUND`. Rows use the same base item fields as cache detail, with `status`
set to the stored state (`pending|ready|failed`): `id`, `version`, `origin`, `dataTimestamp`, `sizeBytes`, `checksumMd5`,
`status`, and `createdAt`. Ready versions sort newest-ready first; pending/failed versions follow newest-created first.
The response contains `{ data, meta: { page, limit, total, totalPages } }`. Storage paths and failure details are not
returned. Byte counts are JSON integers when safe and decimal strings otherwise.

#### `POST /_admin/api/cache/:countryId/versions`

Download **one specific Geofabrik snapshot** (GEO-4 / CACHE-1): body `{ "version": "261023" }` → `202 { "jobId": "…" }`.
The country must exist in the Geofabrik catalog (otherwise `404 NOT_FOUND`); it need not already have a cache row, so
the first dated version can be admitted here. The version must be a six-digit date and currently offered by the source. This endpoint refuses `latest`
with `400 VALIDATION_ERROR` (use `POST /cache/downloads` for that); a dated snapshot no longer offered returns
`410 SOURCE_VERSION_GONE`. A ready local version returns `409 VERSION_ALREADY_CACHED`; an active duplicate returns
`409 JOB_ALREADY_RUNNING`; upstream failure returns `502 SOURCE_UNAVAILABLE`; disk preflight failure returns
`503 DISK_FULL`. Admission shares the generic download route's cache identity check, source resolution, reserve-aware
disk preflight, and race-safe queue insert.

#### `DELETE /_admin/api/cache/:countryId/versions/:versionId?confirm=true`

Requires explicit confirmation (`?confirm=true` → `204 No Content`); JSON `{ "confirm": true }` is an alternative.
Missing/false confirmation returns `409 CONFIRMATION_REQUIRED`;
unknown query/body keys and malformed UUIDs return `400 VALIDATION_ERROR`; uncached countries, unknown versions, and version IDs belonging to
another country return `404 NOT_FOUND`. A queued/running job for the country returns `409 JOB_ALREADY_RUNNING`;
the request does not cancel work.

The API hard-deletes the selected version row and writes audit action `version.delete` in the same transaction; audit
metadata records the version label, origin/status, exact byte count, and stored MD5/SHA-256 checksums. Its safe storage path is unlinked only
after commit. An unlink failure is logged for orphan cleanup but still returns `204`. A country with no remaining
version rows loses its `country_cache` row (the catalog country remains). Otherwise the API recomputes ready counts and
size, clears stale source-update offers, and resets `update_state` to `unknown`. If no ready versions remain, public
access is automatically closed and `public_since` cleared even when pending/failed rows remain.

A per-country exclusive advisory lock is held from before the transaction through file unlinking. It serializes the
delete with download admission and admin/public file streams; if a stream or another mutation holds the lock for more
than five seconds, the request returns `409 JOB_ALREADY_RUNNING` without deleting data. Any public or admin URL
for the removed version subsequently returns `404 NOT_FOUND`.

#### `GET /_admin/api/cache/:countryId/versions/:versionId/download`

Admin-only file download (default access, PUB-3). Uses the public representation headers and single-range/conditional
semantics (§3.4), but sends `Cache-Control: private, no-store`: this endpoint can return unpublished files, which must
never enter a shared cache. Completed and interrupted transfers record `channel=admin` and bytes sent in
`download_events`; raw IP addresses are never stored. A shared per-country advisory lock is acquired before the file is
opened and held until the response closes, so cache deletion cannot unlink an active transfer.
`410 VERSION_FILE_MISSING` if the ready row exists but the file is gone (L6). HEAD and `304` responses do not create events.

---

### 2.3 Import (upload)

#### `POST /_admin/api/imports`

`multipart/form-data`:

| Field | Type | Required | Rules |
|---|---|---|---|
| `file` | file | ✅ | `.osm.pbf`, magic/header check, ≤ `MAX_UPLOAD_BYTES` (default 8 GiB) |
| `countryId` | uuid | ✅ | must exist in the catalog |
| `version` | string | ✅ | `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`, unique per country |
| `replace` | `"true"` / `"false"` | ❌ | Multipart fields are strings; the server coerces to boolean via Zod and rejects anything else. Explicit replacement of an existing version (D-10). |

```json
202 { "uploadId": "…", "jobId": "…", "version": "2026-09-01" }
```

Errors: `409 VERSION_DUPLICATE` (retry with `replace=true` to overwrite intentionally),
`413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FORMAT`.

**Avoid the wasted upload:** the UI calls `GET /_admin/api/cache/:countryId/versions` first and, when
the version already exists, asks "replace?" *before* sending any bytes. On the server, the duplicate
check runs as soon as `countryId` + `version` have been parsed and destroys the request stream early,
so a conflicting upload does not transfer a multi-gigabyte file to fail at the end. Multipart field
order is not guaranteed, so this is an optimisation, not a guarantee — the 409 path stays correct.

```bash
curl -X POST http://localhost:8080/_admin/api/imports \
  -H "Authorization: Bearer $TOKEN" \
  -F file=@finland-261001.osm.pbf \
  -F countryId=6f1c… -F version=261001
```

#### `GET /_admin/api/imports/:uploadId`

`{ "status": "received|installing|installed|failed|expired", "sizeBytes": …, "checksumMd5": "…",
   "jobId": "…", "error": null }`

The UI switches to a job progress view after `202`; the upload itself shows a browser progress bar
(XHR `upload.onprogress`).

---

### 2.4 Jobs

| Method | Path | Notes |
|---|---|---|
| `GET` | `/_admin/api/jobs?status=&type=&page=&limit=` | Newest first; optional exact status/type filters |
| `GET` | `/_admin/api/jobs/:jobId` | Returns the same safe job projection as one list item |
| `POST` | `/_admin/api/jobs/:jobId/cancel` | `202` when accepted; queued jobs cancel immediately and running jobs cooperate with the owner worker |

The list returns `{data, meta}` with page 1/limit 25 by default and a maximum limit of 100; values clamp using the
shared pagination law. Unknown query keys and invalid `status`/`type` values are `400 VALIDATION_ERROR`. Results sort by
`createdAt DESC, id DESC`; rows and total come from one repeatable-read snapshot. Progress bytes are monotonic and
writes are throttled to one database write per second. When known, `phase` is `fetching_index`, `downloading`,
`verifying`, or `installing`. Progress byte fields preserve large PostgreSQL integers as decimal strings instead of rounding.
`etaSeconds` is derived from progress and speed, only shown
for a running job that is not canceling, and is `null` when unknown, stale on queued work, or beyond 30 days. `payload`
is a type-specific allow-list (unknown fields are omitted), `error` contains only the safe `JOB_HANDLER_FAILED` or
`WORKER_LOST` message, and worker ownership or raw exception text is never returned. A missing detail id returns `404` with `NOT_FOUND`.

Cancellation accepts an empty JSON body (or no body). `202 {jobId,status,accepted:true,cancelRequested:true}` means
the request was accepted, not that running cleanup has finished. For queued work the row becomes `canceled` immediately;
for running work it stays `running` with the durable request flag and its owner lock until the handler has cleaned up and
returned, after which the worker marks it canceled. Repeating cancellation on a canceled job is idempotently `202`. A
succeeded or failed job cannot be canceled: the route returns `200 {jobId,status,accepted:false,cancelRequested:false}`
without changing it. An unknown job returns `404 NOT_FOUND`.

```json
200 {
  "id": "…", "type": "download", "status": "running",
  "phase": "downloading", "progressBytes": 402653184, "totalBytes": 774000000,
  "speedBps": 10485760, "etaSeconds": 35,
  "payload": { "countryId": "…", "version": "261024" },
  "cancelRequested": false, "attempts": 1, "maxAttempts": 3,
  "createdAt": "…", "startedAt": "…", "finishedAt": null, "error": null
}
```

Errors on a retrying job remain visible with the generic safe message; `WORKER_LOST` distinguishes recovered process
loss and may remain on a queued retry or become terminal when attempts are exhausted.

---

### 2.5 Intervals

#### `GET /_admin/api/intervals` → list with `countries: [{countryId,name,slug}]`, `nextRunAt`, `lastRun`.

#### `POST /_admin/api/intervals`

```json
{
  "name": "Nordics nightly",
  "frequency": "daily",              // 'daily' | 'weekly' | 'monthly'
  "timeOfDay": "03:00",              // HH:mm, UTC
  "weekday": 1,                      // required if weekly (1=Mon … 7=Sun)
  "dayOfMonth": 1,                   // required if monthly (1…28)
  "countryIds": ["…", "…"],          // ≥ 1, max 200
  "keepVersions": 3,                 // 1…10, default from settings
  "onlyIfChanged": true,
  "enabled": true
}
```

`201 { interval }` (includes computed `nextRunAt`).
Validation: `422 SEMANTIC_ERROR` if `weekday` is sent for daily, or `countryIds` is empty.

#### `PATCH /_admin/api/intervals/:id`
Partial update; any schedule field recomputes `nextRunAt`. Re-enabling a paused interval recomputes
from **now** (never fires a backlog).

#### `DELETE /_admin/api/intervals/:id`
`409 JOB_ALREADY_RUNNING` if a run is in progress unless `?force=true` (which marks the run failed).

#### `POST /_admin/api/intervals/:id/run`
`202 { "runId": "…", "jobIds": ["…"] }` — manual trigger, `triggered_by='manual'`.

#### `POST /_admin/api/intervals/preview`

Body: the schedule fields → `{ "nextRuns": ["2026-10-25T03:00:00Z", …5 items] }`.
Used by the create/edit form so the admin sees exactly when it will fire.

#### `GET /_admin/api/intervals/:id/runs?page=` → run history.
#### `GET /_admin/api/interval-runs/:runId` → run + per-country items.

A sibling route (`/intervals/runs/:runId`) would be ambiguous with `/intervals/:id/runs`, so run
history lives at its own top-level path.

---

### 2.6 System, metrics, settings, audit

#### `GET /_admin/api/system/status`

```json
{
  "version": "0.1.0", "uptimeSeconds": 84213, "worker": { "enabled": true, "concurrency": 2, "running": 1 },
  "storage": { "cacheDir": "/data/cache", "usedBytes": 2319000000, "freeBytes": 48000000000,
               "reserveBytes": 2147483648, "state": "ok",
               "orphans": { "count": 0, "bytes": 0 } },
  "counts": { "countries": 389, "cachedCountries": 12, "publicCountries": 5,
              "versions": 31, "updatesAvailable": 2, "jobsRunning": 1, "jobsQueued": 0 },
  "source": { "id": "geofabrik", "lastSyncAt": "…", "reachable": true },
  "branding": { "displayName": "MapMirror" }
}
```

#### `GET /_admin/api/system/metrics?window=5m|1h|24h|7d`

```json
{
  "window": "1h", "stepSeconds": 10,
  "samples": [ { "t": "2026-10-24T08:00:00Z", "cpuPercent": 12.4, "load1": 0.6,
                 "memUsedBytes": 512000000, "memTotalBytes": 2048000000,
                 "diskUsedBytes": 12300000000, "diskTotalBytes": 50000000000,
                 "cacheSizeBytes": 2319000000 } ],
  "scope": "container"
}
```
Server-side downsampling: `5m`→10 s, `1h`→30 s, `24h`→5 min, `7d`→30 min.

#### `GET /_admin/api/settings` / `PATCH /_admin/api/settings`
Editable: `branding.displayName`, `cache.keepVersions`, `cache.diskReserveBytes`,
`public.downloadsPerMinute`, `source.catalogTtlMinutes`. Secret-ish values (`privacy.ipHashSalt`, DB
credentials, token settings) come from env or are write-only: they are **never** serialised in a
response — the settings serializer projects an explicit allow-list of keys.

#### `GET /_admin/api/audit?action=&page=`
Paginated audit log (`auth.*`, `cache.*`, `catalog.*`, `version.*`, `interval.*`, `settings.*`), including `catalog.sync` after each successful catalog transaction.

---

## 3. `/_public/api/*` — public (anonymous, rate limited)

### 3.1 `GET /_public/api/countries`

Query: `q` (trimmed partial country-name or ISO-code match, up to 128 characters), `continent` (exact source parent id, up to 255 characters), `page`, `limit` (default 25, maximum 100), and `sort=name|size|updated` (default `name`). Pagination values follow §0.2's decimal-only clamping; unknown keys, invalid sort values, and NUL characters in `q` or `continent` return `400 VALIDATION_ERROR`. Names sort A–Z; `size` sorts by the newest ready version's size, largest first; `updated` sorts by its data timestamp, newest first with null timestamps last. Ties are stable. `updatedAt` is that newest ready version's data timestamp, or `null` when absent. The public projection does not expose internal country/version ids, publication state, cache internals, or storage paths.

```json
200 {
  "data": [{
    "slug": "finland", "name": "Finland", "continent": "europe", "iso": ["FI"],
    "newestVersion": "261023", "sizeBytes": 773465008,
    "updatedAt": "2026-10-22T20:19:04.000Z",
    "downloadUrl": "/_public/api/countries/finland/download?version=latest"
  }],
  "meta": { "page": 1, "limit": 25, "total": 5, "totalPages": 1 },
  "license": { "name": "ODbL 1.0", "attribution": "© OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright" }
}
```

Only countries with `is_public = true` **and** ≥ 1 `ready` version appear. Unpublished ⇒ invisible.

### 3.2 `GET /_public/api/countries/:slug`

Returns the published country and its newest ready version. `versions` embeds up to the 100 newest ready versions; use §3.3 to page through a longer history. `updatedAt` is the newest ready version's `dataTimestamp`, or `null` when that timestamp is unknown. Version byte counts use a JSON integer when safe, otherwise a canonical decimal string; an unavailable/invalid MD5 is `null`.

```json
200 {
  "slug": "finland", "name": "Finland", "iso": ["FI"],
  "versions": [ { "version": "261023", "dataTimestamp": "2026-10-22T20:19:04.000Z", "sizeBytes": 773465008,
                  "checksumMd5": "d41d8cd98f00b204e9800998ecf8427e",
                  "downloadUrl": "/_public/api/countries/finland/download?version=261023", "isLatest": true } ],
  "latest": "261023", "updatedAt": "2026-10-22T20:19:04.000Z",
  "license": { "name": "ODbL 1.0", "attribution": "© OpenStreetMap contributors",
               "url": "https://www.openstreetmap.org/copyright",
               "source": "Geofabrik GmbH", "sourceUrl": "https://download.geofabrik.de" }
}
```

Only countries with `is_public = true` and at least one ready version are visible. Unknown and unpublished slugs return `404 NOT_FOUND` with the same safe message; malformed slugs are also hidden as `404`. The request id remains unique per response.

### 3.3 `GET /_public/api/countries/:slug/versions`

Query: `page` and `limit` (default 25, maximum 100), with §0.2's decimal-only clamping. Unknown query keys return `400 VALIDATION_ERROR`. The endpoint returns only ready versions, newest first using the same timestamp/ready-time ordering as `latest`; `isLatest` identifies the selected latest version. Unknown, unpublished, or malformed slugs return the same `404 NOT_FOUND` as §3.2.

```json
200 {
  "data": [{
    "version": "261023", "dataTimestamp": "2026-10-22T20:19:04.000Z", "sizeBytes": 773465008,
    "checksumMd5": "d41d8cd98f00b204e9800998ecf8427e",
    "downloadUrl": "/_public/api/countries/finland/download?version=261023", "isLatest": true
  }],
  "meta": { "page": 1, "limit": 25, "total": 2, "totalPages": 1 },
  "license": { "name": "ODbL 1.0", "attribution": "© OpenStreetMap contributors",
               "url": "https://www.openstreetmap.org/copyright",
               "source": "Geofabrik GmbH", "sourceUrl": "https://download.geofabrik.de" }
}
```

No internal ids, job ids, or storage paths are exposed. Invalid MD5 values are represented as `null` rather than labeled as MD5.

### 3.4 `GET /_public/api/countries/:slug/download?version=latest|260101`

Streams one ready version (no JSON body). The country must be explicitly published; unknown, unpublished, and
published-without-a-ready-version countries all return the same `404 NOT_FOUND`. An unknown or not-ready version also
returns `404`. `version` defaults to `latest`; other values must be safe version labels, and unknown query keys or an
invalid label return `400 VALIDATION_ERROR`.

| Header / case | Handling |
|---|---|
| `version` omitted or `latest` | Streams the newest ready version, ordered by data timestamp, ready time, then row id |
| `version=<label>` | Streams that exact ready version |
| `Range: bytes=1000-` (also closed or suffix single ranges) | `206 Partial Content`, exact `Content-Range` and selected `Content-Length` |
| Malformed, multiple, or unsatisfiable `Range` | Ignored; sends the complete `200` representation |
| Matching `If-None-Match` (weak comparison or `*`) | `304 Not Modified`, no body or content length |
| `If-Range` matches the strong ETag or a current HTTP date | Honors `Range`; otherwise sends the complete `200` representation |
| `HEAD` | Same representation headers as `GET`, no body |
| Missing file for a ready row | `410 VERSION_FILE_MISSING`, without exposing the storage path |

Response headers (an ETag and checksum header are omitted when the stored MD5 is absent or invalid):

```
Content-Type: application/x-protobuf
Content-Disposition: attachment; filename="finland-261023.osm.pbf"
Content-Length: 773465008
Accept-Ranges: bytes
ETag: "md5:5d41402abc4b2a76b9719d911017c592"
Last-Modified: Thu, 23 Oct 2026 20:20:51 GMT
X-Checksum-Md5: 5d41402abc4b2a76b9719d911017c592
Cache-Control: public, max-age=31536000, immutable   # explicit version label
# …for ?version=latest (the default) instead:
Cache-Control: no-cache                              # the alias moves; revalidate every time
```

```bash
curl -sS http://localhost:8080/_public/api/countries
curl -L -o finland.osm.pbf http://localhost:8080/_public/api/countries/finland/download
curl -r 0-1048575 -o part.bin 'http://localhost:8080/_public/api/countries/finland/download?version=261023'
md5sum finland.osm.pbf   # verify against the version's checksumMd5
```

The public stream takes the same shared per-country advisory lock as the admin stream and holds it from before the file
is opened until the HTTP response closes, so cache deletion cannot unlink an active transfer (CACHE-5). Public GET
transfers are recorded by the later analytics task (P3-API-06); `HEAD` and `304` are not downloads and create no event.
Rate limit: `PUBLIC_DOWNLOADS_PER_MINUTE` (default 10 per IP per minute, `Retry-After` on refusal), **applied per
request start**, not per byte — a large transfer is never interrupted mid-stream. The read endpoints have their own
allowance (60 per IP per minute), so a client downloading files cannot lock itself out of the catalog (`14-security.md`
§7).

### 3.5 `GET /_public/api/stats`

Anonymous aggregate only; this route accepts no query parameters and responds with `Cache-Control: no-store`.

```json
{ "countries": 5, "totalSizeBytes": 2319000000, "downloads30d": 128,
  "totalDownloads": 1420, "lastPublishedAt": "2026-10-23T20:20:51.000Z" }
```

- `countries`: currently published countries with at least one ready version.
- `totalSizeBytes`: the sum of **all** ready versions downloadable from those countries (not just each newest version, and not pending/failed versions).
- `lastPublishedAt`: most recent `public_since` among those currently visible countries, or `null` when none are public.
- `downloads30d`: public-channel event rows created in the last 30 days; `totalDownloads` is all-time public-channel events. Events are recorded after a body-bearing response closes, including interrupted transfers, and `bytes_sent` is the number of body bytes actually transferred. Counts therefore include aborted body transfers, exclude `HEAD` and `304`, and remain historical if a country is later unpublished.

The response contains no IP, IP hash, user-agent, country id, version id, or per-user data. Event rows store only a salted SHA-256 hash of a normalized IP (or `null` if unavailable); the raw IP is never persisted. Aggregate bigint values are JSON numbers while safe, otherwise decimal strings.

---

## 4. Infrastructure

| Path | Purpose | Response |
|---|---|---|
| `GET /healthz` | Liveness | `200 {"status":"ok"}` always if the process is up |
| `GET /readyz` | DB + cache dir writable | `200` or `503` with failing checks |

Neither is under the three API prefixes; both are allow-listed in the route-law test (L1). Both answer `GET`
and `HEAD`, require no credentials (a container cannot hold a Bearer token), are exempt from the admin guard
and from the rate limiter, and send `cache-control: no-store` — a probe answer describes *now*, and a proxy
that replays a five-minute-old `200` during an incident is worse than no probe.

**`/healthz` touches nothing.** No database, no filesystem. It answers as long as the process can answer, so
Docker's restart policy reacts to a dead process rather than to a dead dependency: a liveness probe that pings
Postgres turns one database outage into a restart loop.

**`/readyz` runs two checks concurrently, each bounded at 2 s** (`READY_PROBE_TIMEOUT_MS`). A probe that can
hang is worse than a missing one — the load balancer waits, requests queue, and the outage looks total.

| Check | What it proves |
|---|---|
| `database` | `select 1` through the pool used to serve requests |
| `cache` | `CACHE_DIR` accepts a write: a `.readyz` file is created and removed (the directory is created if missing — a fresh volume is empty). One fixed name, so a probe killed between the write and the delete cannot leave a file that nothing will ever clean up — the next probe overwrites and removes it |

```json
// 200
{ "status": "ok",          "checks": { "database": "ok",   "cache": "ok" } }
// 503
{ "status": "unavailable", "checks": { "database": "fail", "cache": "ok" } }
```

The body names the checks and **nothing else**. A driver's error text can contain the DSN, and the cache path is
an internal detail; the reason for each failure goes to the log at `warn`, under the request id in
`x-request-id`, one line per failing check.

**The probes are the one documented exception to the §0.2 envelope.** `{"status","checks"}` answers `200` and
`503` alike, because a machine reads it: an orchestrator wants to know *which* dependency is unhealthy, not a
code and a sentence. Everything else — a wrong method, an unknown path — still answers the envelope, and the
security headers and `x-request-id` are on probe responses exactly as everywhere else.

---

## 5. Route law verification

```
apps/api/tests/law-routes.test.ts                 (Fastify route table, no database)
  ├─ every route matches ^(/_auth/api/|/_admin/api/|/_public/api/|healthz$|readyz$)
  ├─ the guard classifiers (isApiPath / isProbePath) agree with the table
  ├─ no page path (/, /_site/*, /_auth/login) is served by the API
  └─ no API route returns text/html

apps/api/tests/integration/admin-guard.spec.ts    (the same table, walked again)
  ├─ every /_admin/api/* route returns 401 without a Bearer token
  └─ every one of them is reachable with a valid one

apps/api/tests/integration/credential-transport.spec.ts   (a live token, in the wrong places)
  ├─ cookie-only request to an admin route → 401 UNAUTHENTICATED
  ├─ ?token= / ?access_token= query auth → 401
  ├─ Basic, X-Api-Key, a bare header value, a body field → 401
  └─ the same token in `Authorization: Bearer` → let through

apps/web/tests/law-router.test.ts        (Vue router table — `P1-WEB-03`)
  └─ every page path starts with /_site/ (admin pages under /_site/admin)
```

Pages are served by Nginx, not Fastify, so the page side of L1 is asserted on the router table plus a
container check in Phase 6 (`P6-DOC-01`).

## 6. Contract tooling

- `packages/shared/src/schemas/*` is the single definition; API handlers validate with the same
  schemas the SPA parses responses with (catch drift at both ends).
- A test asserts every registered route has a matching schema export and a heading in this document
  (`docs/04-api.md` contains the route string).
- No OpenAPI generation in v1 (keeps dependencies low); the public API docs page is rendered from
  `packages/shared` metadata so it cannot go stale.
