# 15 — Architecture Decision Records

**TL;DR** — 27 ADRs recording *why*. The owner's decision table (D-1…D-19) lives in `PROMPT.md` §24 and
is the authority on *what*; each ADR below explains the reasoning and consequences. If a doc contradicts
`PROMPT.md` §24, that table wins; if two docs disagree with each other, the ADR decides.

One entry per decision that constrains the build. `D-n` entries are the owner's resolutions from
2026-10-24 (`PROMPT.md` §24). Phase 0 additions are marked **ADR (Phase 0)** and need only a glance —
they are implementation consequences of those decisions, not new product scope.

Format: **Context → Decision → Consequences**.

---

## ADR-001 — JSON APIs stay inside the three required prefixes *(page part superseded: ADR-023, ADR-024)*

**Context.** The requirement fixes the API namespaces: `/_auth/*`, `/_admin/*`, `/_public/*`.

**Decision (still valid).** JSON APIs live exactly there: `/_auth/*` (login/logout/me),
`/_admin/api/*`, `/_public/api/*`. The reserved segment `api` distinguishes JSON from pages, so a
`curl` can never accidentally receive HTML.

**Superseded part.** The original version of this ADR also put *pages* under `/_admin/<page>` and
`/_public/<page>`. The owner has since required all website pages to live under `/_site/*` — see
**ADR-023**, which is the current rule for pages.

---

## ADR-002 — Geofabrik is the only source, behind a four-method interface (D-1)

**Context.** The owner reads "geofabric" as Geofabrik and wants future providers possible without
speculative abstraction.

**Decision.** `MapSource` with exactly `listRegions`, `getRegionDetail`, `listSnapshots`,
`resolveDownload`. One implementation (`geofabrik`). No registry, no plugin system, no provider UI.

**Consequences.** A second provider costs one class + one construction site. Catalog sync, downloads
and update checks depend on the interface, so they stay provider-agnostic without extra machinery.

---

## ADR-003 — `.osm.pbf` only (D-2)

**Decision.** Accept and store `.osm.pbf` only; other formats are rejected at import and never
offered by the source adapter.

**Consequences.** Smaller cache, one MIME type, one validation path, simpler checksums. SHP/GPKG would
multiply storage and add zip-safety concerns; revisit only with a real requirement.

---

## ADR-004 — Opaque bearer tokens in PostgreSQL (D-3)

**Context.** The requirement is Bearer tokens, plus a reset-password script that must cut off existing
sessions.

**Decision.** 256-bit random token (`mm_…`), SHA-256 hash stored, TTL 12 h, revocable individually or
in bulk. No JWT, no refresh endpoint.

**Consequences.** Instant revocation and a database round-trip per admin request (negligible at this
scale). The client cannot introspect claims — it calls `/_auth/api/me`.

**How verification actually works** (`P1-AUTH-02`): the presented token is hashed and matched against the
unique index on `token_hash`, in one join that also brings back the account's `is_active`. There is no
comparison of a secret in application code, so "constant-time compare" — the phrase the task list used —
describes a mechanism this design does not have and does not need: a `timingSafeEqual` would compare the
same bytes the database has just matched. What matters instead is that the digest is the only lookup key:
`token_prefix` is display-only, and a test keeps it that way by presenting a token that shares a prefix
with a live row. `last_used_at` is written at most once a minute, with the throttle in the `WHERE` clause so
two concurrent requests cannot both decide the write is due.

---

## ADR-005 — One admin in the UI, multi-admin schema (D-4)

**Decision.** `admins` is a normal table; the UI shows one account and a "coming later" note in
Settings. Bootstrap and reset scripts act on a username, so adding a second admin later is a UI task.

---

## ADR-006 — Local disk storage at `/data/cache` (D-5)

**Decision.** Files live on a named Docker volume mounted at `/data/cache`, addressed by
`<slug>/<version>/<filename>`; the `modules/storage/storage.ts` boundary owns every path and filesystem operation. It accepts validated identity components or validated three-component persisted paths, isolates worker parts under `.partial/<uuid>.part`, installs them by same-volume rename, rejects symlink traversal beneath the canonicalized root, and unlinks only the named leaf or an encountered link component.

**Consequences.** No S3 credentials, no network latency on public downloads (Nginx streams the API response). The storage module is the only place to change for object storage later. The cache volume must be writable only by the API service/operator because portable path walks cannot be made atomic against a hostile concurrent writer.

---

## ADR-007 — Schedules are daily/weekly/monthly, UTC (D-6)

**Decision.** `frequency` + `timeOfDay` (default 03:00), `weekday` (Monday) for weekly, `dayOfMonth`
(default 1) for monthly. `dayOfMonth` is capped at **28** so every month has the day.

**Consequences.** No cron expressions in the API or UI (fewer footguns, better validation messages).
Timezone is fixed to UTC — schedules are predictable and DST-free; the UI labels times "UTC".

---

## ADR-008 — Retention keeps the newest 3 ready versions (D-7)

**Decision.** After a successful update, prune to `keep_versions` (default 3, per-interval override),
never deleting the newest ready version. Manual deletion is always allowed and can go below 3.

**Consequences.** Bounded disk growth; the archive of dated snapshots upstream deletes is preserved
for the last few updates. Pruning is a separate, audited operation.

---

## ADR-009 — Hard delete with typed confirmation (D-7b)

**Decision.** Country deletion requires typing the slug; version deletion requires an explicit confirm.
Files are unlinked through the storage boundary after the DB transaction commits; cleanup removes only named files or the encountered symlink itself, never recursively following paths.

**Consequences.** No trash UI or restore path; a failed unlink leaves an orphan that the sweep reports
(it never becomes a broken download). Simpler code, smaller storage footprint, unambiguous state.

---

## ADR-010 — Public access is opt-in per country, all ready versions exposed (D-9)

**Decision.** `is_public` defaults to false. Publishing requires ≥ 1 ready version. Public pages list
all ready versions of a published country and default to `latest`.

**Consequences.** One switch per country, no per-version publication (kept simple). Unpublishing never
deletes data.

---

## ADR-011 — Duplicate versions rejected; replacement explicit (D-10)

**Decision.** `UNIQUE (country_id, version)` for non-deleted rows. A duplicate import returns `409`
with a hint; the client can retry with `replace: true` after confirmation, which deletes and re-creates
the version atomically. No merging, no partial diffs.

---

## ADR-012 — PostgreSQL job queue, single worker loop (D-11)

**Context.** Downloads are long-running; the UI needs progress and cancellation; deployment must stay
three containers.

**Decision.** `jobs` table claimed with `SELECT … FOR UPDATE SKIP LOCKED`, an in-process worker with
concurrency 2, heartbeats and a reaper, cooperative cancellation. No Redis, no separate worker image.

**Consequences.** One less service to run and monitor; queue throughput is bounded but far above what a
single mirror needs. Horizontal scaling would need a review (documented as out of scope).

---

## ADR-013 — SQL migrations + Kysely + Zod only (D-12)

**Decision.** Hand-written SQL migrations, Kysely for typed queries/transactions, Zod for all I/O.

**Consequences.** No schema-generation magic, explicit indexes and constraints (which the invariants
depend on), one validation library shared by API and SPA.

---

## ADR-014 — Token in `sessionStorage`, no `v-html` (D-13)

**Decision.** Pinia holds auth state; the token lives in `sessionStorage`; the API client attaches it;
any `401` clears state and redirects. Rendering is escape-only (no `v-html`), CSP blocks inline script.

**Consequences.** A refresh in the same tab keeps the session; closing the tab signs out. XSS surface is
minimized rather than mitigated by storage choice alone.

---

## ADR-015 — Dark admin, light public, self-hosted fonts (D-14)

**Decision.** Two Vuetify themes with shared tokens; Space Grotesk + Inter, **self-hosted subset and
dropped if they cost > 40 kB or hurt LCP**; teal primary, amber reserved for "update available".

**Consequences.** Strong visual identity at near-zero runtime cost; fallback to system fonts is
pre-approved and invisible to functionality.

---

## ADR-016 — Nginx on :8080, TLS upstream (D-15)

**Decision.** The `web` container serves the SPA (all pages under `/_site/*`, other paths → 404 shell)
and proxies `/_auth`, `/_admin/api`, `/_public/api`, `/healthz`, `/readyz` to the API. TLS is the operator's proxy (Caddy/Nginx examples in
`12-deployment.md`).

**Consequences.** No certificate management inside the stack; `PUBLIC_BASE_URL` must be set so
generated links match the public hostname.

---

## ADR-017 — English only, centralized strings (D-16)

**Decision.** All UI copy lives in `apps/web/src/locales/en.ts` (a plain object, typed). No vue-i18n
dependency yet.

**Consequences.** Adding i18n later is mechanical. Docs and code comments are English only.

---

## ADR-018 — Catalog comes from `index-v1-nogeom.json`, snapshots from the region page
**Phase 0** · implementation detail of GEO-1/GEO-4

**Context.** Geofabrik publishes a stable JSON index with ids, parents, ISO codes and pbf URLs, but it
contains **no sizes, dates, or dated snapshots**. Those only exist in each region's HTML page.

**Decision.** Two paths:

1. **Catalog sync** (scheduled/TTL/manual): parse `index-v1-nogeom.json` → `countries`.
2. **Region detail / snapshots** (on demand, cached 10 min): fetch `<region>.html`, extract the file
   table (`<id>-YYMMDD.osm.pbf` + size + date) and the "contains all OSM data up to" timestamp.

**Consequences.** Search is fast and offline-capable; snapshot lists are inherently point-in-time and
may age. Catalog sync is an upsert-only transaction: source omissions do not delete local countries or their cache,
existing slugs stay stable, and `catalog.sync` (including any non-name-derived slug assignments) commits with the rows.
Freshness is measured from the system-owned `source.catalogSyncedAt` setting, written with the country rows and audit in
one transaction; it covers an empty catalog and survives job-history pruning. A rolled-back attempt does not refresh it,
and an explicit manual job is never skipped because the cache is still fresh. The index request has a
10-second deadline (30-second hard cap) and honors worker cancellation. The parser is isolated with saved HTML fixtures,
and a parse failure degrades to `sourceReachable: false` / "only latest available" instead of wrong data. HTML changes
at Geofabrik are an operational risk, mitigated by fixtures + typed parse results + a visible warning.

---

## ADR-019 — Version identity: `YYMMDD`, `latest@<data timestamp>`, or an upload label
**Phase 0** · implementation detail of CACHE-1/CACHE-4/UPD-1

**Context.** Upstream overwrites `-latest.osm.pbf` and eventually deletes dated snapshots. "A version"
must mean *what we actually stored*, not a mutable URL.

**Decision.**

| Origin | `version` | Meaning |
|---|---|---|
| Dated snapshot | `260101` | The upstream snapshot date |
| Latest download | `latest@2026-10-23T20-20-51Z` | The source's "data up to" timestamp at fetch time (fallback: fetch time); time colons become hyphens to satisfy the database version-format constraint |
| Upload | admin text, default `YYYY-MM-DD` | Local artifact |

Every version stores `source_url`, `source_filename`, `file_size_bytes`, `checksum_md5`,
`data_timestamp` and `origin`, so update comparison and re-verification never depend on upstream state.

**Consequences.** Re-downloading `latest` a day later creates a new immutable version instead of
mutating one; "check for update" compares data timestamps and reports `unknown` when the source can't be
read. Public URLs accept `latest` or an explicit version id.

---

## ADR-020 — Synchronous single-country update checks, job-based bulk checks
**Phase 0** · implementation detail of UPD-1/UPD-3

**Decision.** One country check runs inline with a 5 s budget (returns `unknown` on timeout); bulk
checks enqueue `update_check` jobs. Per-country results are persisting on `country_cache`.

**Consequences.** The row button feels instant in the common case; the "check all" action never blocks
a request. Both paths write the same state, so the badge is consistent.

---

## ADR-021 — No OpenAPI generation in v1
**Phase 0** · implementation detail of ENG-2

**Decision.** `packages/shared` Zod schemas are the contract; `docs/04-api.md` is the human reference;
the public API docs page renders from the same schema metadata.

**Consequences.** Fewer dependencies and no diverging generated artifacts. If an external consumer
needs a machine-readable spec later, `@fastify/swagger` + `zod-to-json-schema` can be added in one place.

---

## ADR-022 — Metrics sampled in-process, no cAdvisor
**Phase 0** · implementation detail of MON-1

**Decision.** Sample `os.cpus()`, `os.loadavg()`, `os.totalmem/freemem`, `statfs(CACHE_DIR)` and the
cache-size aggregate every 10 s; retention 7 days with server-side downsampling.

**Consequences.** Three containers stay three containers. Numbers describe the container/host as seen
from the API process; the UI labels the scope explicitly rather than pretending to be host-exact.

---

## ADR-023 — Every non-auth website page lives under `/_site/*` *(login page: see ADR-024)*

**Context.** The owner requires the website to live under `/_site/*`. The API namespaces
(`/_auth/*`, `/_admin/*`, `/_public/*`) remain fixed by the original requirement. Serving pages and
JSON on the same URLs would need content negotiation and make `curl` output depend on headers.

**Decision.** Split pages from APIs completely:

| Kind | Path |
|---|---|
| Public pages | `/_site/`, `/_site/countries/:slug`, `/_site/api-docs`, `/_site/not-found` |
| Admin pages | `/_site/admin/`, `/_site/admin/catalog`, `/_site/admin/cache`, `/_site/admin/cache/:countryId`, `/_site/admin/intervals`, `/_site/admin/import`, `/_site/admin/jobs`, `/_site/admin/system`, `/_site/admin/settings`, `/_site/admin/audit` |
| Login page | `/_auth/login` — the single exception, owned by the auth namespace (ADR-024) |
| APIs | `/_auth/api/*`, `/_admin/api/*`, `/_public/api/*` |
| Root | `GET /` → `302 /_site/` |

Consequences:

- **One deployable SPA** serves both the public site and the admin panel; the router decides which
  shell to render. Static assets stay at `/assets/*`.
- Nginx rewrites any unmatched `/_site/*` to `index.html`; unknown paths render the in-app 404 page.
- Admin pages are inert HTML — all authorization stays on `/_admin/api/*` (L2). A visitor who types
  `/_site/admin/` sees the login screen, never data.
- The route-law tests assert four things: APIs stay in their three prefixes (`/_auth/api/*`,
  `/_admin/api/*`, `/_public/api/*`), every page is under `/_site/` except `/_auth/login`, API routes
  never return HTML, and page routes never return JSON.
- Deep links keep working for both audiences (`/_site/countries/finland` is shareable; the admin URL is
  bookmarkable).

---

## ADR-024 — Login lives under `/_auth/*` (page and API)

**Context.** The owner requires the login route to live under `/_auth/*` (the auth namespace), and the
original requirement already put auth APIs there. A page and a JSON API on the same URL would force
method-or-header sniffing, which is exactly what ADR-023 removed for the other namespaces.

**Decision.** The auth namespace hosts both, split the same way the others are:

| Kind | Path |
|---|---|
| Login **page** (HTML shell) | `GET /_auth/login` |
| Auth **API** (JSON) | `POST /_auth/api/login`, `POST /_auth/api/logout`, `GET /_auth/api/me` |

Everything else follows ADR-023: non-auth pages under `/_site/*`, admin API under `/_admin/api/*`,
public API under `/_public/api/*`, `/` → `/_site/`.

**Consequences.**

- One exception in the route law: `/_site/*` **plus** `/_auth/login`, and `/_auth/api/*` for JSON.
- Nginx must match `^~ /_auth/api/` **before** the `= /_auth/login` page rule; the law doc calls this
  out explicitly and Phase 6 verifies it with `curl`.
- Session-expiry redirects go to `/_auth/login` (not `/_site/login`), so the redirect target is inside
  the auth namespace too.
- The SPA still owns the login screen (same bundle); it just lives at a different prefix.

---

## ADR-025 — Password policy: length and a blocklist, no composition rules

**Context.** AUTH-5 requires Argon2id, and AUTH-1 requires "password policy enforced (min length, not in a
small weak-password list)" with input hidden and never logged. The obvious additions — "must contain a
digit, a symbol, mixed case" — are what most policies do, and they are measurably counter-productive:
people answer them with `Passw0rd!` and then `Passw0rd2!` at the next rotation, which is a *smaller*
effective space than a long passphrase. NIST SP 800-63B §5.1.1.2 drops composition rules for that reason.

**Decision.**

| Rule | Value | Why |
|---|---|---|
| Hash | Argon2id, 64 MiB, 3 passes, parallelism 1, 16-byte random salt, PHC-encoded | The reference algorithm, from the Rust reference implementation; the stored string carries its own parameters |
| Floor | 12 characters, counted as Unicode code points of the NFKC form | What a person counts; `'😀'.length` is 2 and would let six emoji through |
| Ceiling | 256 code points of the submitted string | The login schema's own `.max()`. A ceiling in different units creates an account that can be set and never used |
| Blocklist | 1 000 most-used passwords (Django's list, verbatim), matched case-folded and with trailing digits/symbols stripped | A floor against the first thing anyone tries; the stem rule is what makes it fire at a 12-character floor |
| Username | Rejected as a substring, when the username is ≥ 3 characters | Short usernames appear inside ordinary words |
| Whitespace | Surrounding whitespace rejected, not trimmed | Trimming changes the password that was set |
| Normalisation | NFKC, in both hashing and verification | `café` from a macOS keyboard must log in on Linux |
| Composition rules | **None** | See the context: they produce predictable passwords |

**Consequences.**

- The policy is enforced only where a password is **created** (the launch script, the reset script). Login
  verifies whatever the account was created with, so tightening the policy later cannot lock anyone out, and
  a login attempt cannot be used to learn the policy.
- The blocklist is a floor, not a guarantee: substitutions (`p@ssw0rd`) and repetitions (`adminadmin`) pass.
  A breached-password API (HIBP k-anonymity) would close most of that gap and is deliberately **not** used —
  it would make password creation depend on a third-party service being reachable, in a self-hosted app that
  has to work offline.
- Argon2 cost is bounded by the login throttle (10 failures / 15 min per ip+username): each hash holds 64 MiB
  and one libuv thread for ~74 ms, so an unthrottled endpoint would be a memory-amplification lever.
- Raising `ARGON2_PARAMS` later does not invalidate existing rows — verification reads the parameters from
  each stored hash.

---

## ADR-026 — The login contract lives in `@mapirror/shared`, which now depends on `zod`

**Context.** `P1-AUTH-03` has two consumers for the same shape: the SPA's login form and the API's login route. Both
must agree about the bounds (username 1–64, password 1–256) and about the response envelope, and they must agree
*before* either is written. `09-development.md` had stated a rule for `packages/shared`: no runtime dependencies, so it
stays trivially bundleable for the browser.

**Decision.** The contract is a Zod schema in `packages/shared/src/auth.ts`, and `zod` becomes that package's only
runtime dependency. The API parses `LoginRequestSchema` in the handler (throwing the `ZodError`, which the one error
handler already maps to `400 VALIDATION_ERROR` with `details.issues[].path`); the SPA parses the same object. The
package keeps `types: []`, so `node:*`, `process`, `Bun` and `window` remain compile errors — `zod` is the single
exception, and it is a pure ESM library with no platform globals.

**Consequences.**

- Adding a runtime dependency to `shared` is no longer forbidden outright, but it is now an ADR per dependency: the
  default stays "none", and the exception has to buy agreement between two consumers. A form validator written by hand
  in the SPA and a hand-rolled check in the route is exactly the drift this prevents.
- The API does not use Fastify's JSON-Schema validation. Translating Zod to JSON Schema needs a type provider this
  project does not depend on (ADR-021 keeps the contract in one place), so validation is a parse in the handler — one
  mechanism for both sides rather than two that have to be kept equal.
- `zod` is pinned (`4.6.7`) like every other dependency, and a measured fact is recorded with it: Zod 4's `.max()`
  counts **code points**, not UTF-16 units (see `16-changelog.md`, pass 23 — an assumption to the contrary cost a
  defect in the password policy).
- The `shared` package's `types: []` is why the test that compares a schema with the prose in `04-api.md` lives in
  `apps/api/tests/auth-contract.spec.ts`: reading a file needs `node:fs`.

---

## ADR-027 — Login throttling is in memory, sliding, doubly keyed, and one per process

**Context.** AUTH-2 requires a lockout after N failed attempts and a `Retry-After` header. The obvious
implementations differ in three places that matter: where the counters live (memory, Redis, a table), how the window
moves (fixed or sliding), and what the key is (address, username, or both).

**Decision.**

| Question | Answer | Why |
|---|---|---|
| Storage | In memory, per process | `14-security.md` §7 already documents that limiter for every limiter in this app. A Redis or a table buys durability the threat model does not need, at the cost of a write on every failed login — and puts an availability dependency on the login path |
| Window | Sliding (the instants of the failures, pruned on read) | A fixed window gives an attacker `2N` attempts around every boundary |
| Keys | `(ip, username)` at 10 / 15 min **and** `ip` alone at 30 | The pair counter stops guessing one password; spraying one password across many usernames fails each pair once, so only the per-IP counter can see it. 3× the pair limit so three colleagues behind one office address are not locked out by each other |
| On success | Clear the **pair** counter, keep the IP counter | A valid login says nothing about attempts on other accounts from that address |
| Bound | 10 000 keys; expired keys pruned, then the oldest evicted | An unbounded counter is a memory-exhaustion lever aimed at the endpoint it protects. The cost of eviction is a resettable counter for someone already failing |
| `0` limits | Rejected at construction (`RangeError`) | A `0` limit is silence, not safety — and a comparison of `0 >= 0` once locked every login out |
| Instances | Exactly one, built in `app.ts` and required by the pipeline | Two counters in one process would double every limit while looking correct; the option is required so it cannot be passed only sometimes |
| Counting | A refusal *and* an **in-flight reservation**: `check` takes a slot and the attempt gives it back with `recordFailure`, `recordSuccess` or `release` | A counter that only sees finished failures is a check-then-act race: forty simultaneous requests read the same empty counter, all pass, and each one pays a 64 MiB Argon2 verify (measured, pass 28). The reservation makes the allowance atomic inside the process, and it is released in a `finally`, so a crashed request cannot shrink it |

**Consequences.**

- The limits reset on restart and are not shared between replicas. The design is a single container; a second replica
  makes this ADR wrong before it makes the limits wrong, and the revisit trigger is "more than one API container".
- The state is per-process, so a restart during an attack forgives the attacker up to N attempts. Accepted: the
  alternative is a durable write on the unauthenticated path.
- Counters are keyed on the **normalised** address (`lib/client-ip.ts`), so a junk `X-Forwarded-For` cannot mint a new
  bucket per request — the pass 22 defect.
- A `429` has two meanings and says which: `retryAfterSeconds` in the window is a lockout, `1` is "every attempt this
  allowance permits is in progress right now". The second is not a promise of a lockout — the outstanding attempts may
  succeed — which is why a client is told to wait a second rather than fifteen minutes.

---

## Deferred decisions (deliberately open)

| Topic | Trigger to revisit |
|---|---|
| S3/object storage | > 500 GB or multi-node deployment |
| Multi-admin UI + roles | A second operator needs access |
| i18n runtime | A non-English operator |
| Diff (`.osc.gz`) application | Users ask for incremental updates instead of full files |
| Vector tiles / other formats | A real downstream requirement |
| External worker/queue | Job volume exceeds one worker loop |
| OpenAPI export | An external consumer needs a spec |
| Trash/soft-delete | An accidental deletion needs recovery |
