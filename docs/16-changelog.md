# 16 — Documentation changelog

Review passes over the repository — documents first, then the code that implements them. Every entry
is a defect that was found and fixed, kept so a reviewer can see what changed and why.

**Totals:** 5 passes · 62 defects fixed · 0 open (pass 1: 20, pass 2: 18, pass 3: 16, pass 4: 4, pass 5: 4).
Scope of a pass: consistency with `PROMPT.md`, consistency between docs, and correctness of the
mechanisms described (SQL, state machines, HTTP semantics).

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
| 14 | Counts were stale in four places: 145 tasks (real: 136), 11 tables (15), "15 screens" (14 + 404), and a 41-defect total that ignored the table rows | All recomputed from the files themselves before publishing |
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
