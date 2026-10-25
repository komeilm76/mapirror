# 16 — Documentation changelog

Review passes over the repository — documents first, then the code that implements them. Every entry
is a defect that was found and fixed, kept so a reviewer can see what changed and why.

**Totals:** 9 passes · 92 defects fixed · 0 open (pass 1: 20, pass 2: 18, pass 3: 16, pass 4: 4, pass 5: 4, pass 6: 10, pass 7: 8, pass 8: 6, pass 9: 6).
Scope of a pass: consistency with `PROMPT.md`, consistency between docs, and correctness of the
mechanisms described (SQL, state machines, HTTP semantics).

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
