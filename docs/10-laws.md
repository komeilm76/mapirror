# Laws — non-negotiable rules

These are project **laws**, not suggestions. Each law is either enforced by an automated test or
reviewed against a checklist every phase. Anything that cannot be enforced by a test yet must be
listed in `08-tasks.md` as a hardening task.

---

## L1 — Route law (enforced by test)

Pages and APIs have disjoint homes — a path is either a page or an API, never both:

| Kind | Prefix | Examples | Auth |
|---|---|---|---|
| **Website pages** (SPA shells, HTML) | `/_site/*` | `/_site/`, `/_site/countries/:slug`, `/_site/api-docs`, `/_site/admin/cache`, `/_site/admin/cache/:countryId` | None (the admin panel checks its token client-side) |
| **Admin JSON API** | `/_admin/api/*` | `/_admin/api/catalog`, `/_admin/api/cache/:countryId/public` | Bearer token |
| **Public JSON API** | `/_public/api/*` | `/_public/api/countries`, `/_public/api/countries/:slug/download` | None, rate limited |
| **Login page** (SPA) | `/_auth/login` | `GET /_auth/login` | None |
| **Auth JSON API** | `/_auth/api/*` | `POST /_auth/api/login`, `GET /_auth/api/me`, `POST /_auth/api/logout` | Mixed |
| **Probes** | `/healthz`, `/readyz` | — | None |

Rules:

- **Normative route table: `04-api.md` §0.** The rules below constrain it; they never add to it.
- **Every page lives under `/_site/*`, except the login page, which is `/_auth/login`** (D-19). No page
  may be served from `/_admin/*`, `/_public/*` or root.
- **Every API lives under its prefix**, and APIs are JSON only — `/_admin/api/*` and `/_public/api/*`
  never return HTML.
- `api` is a reserved segment **as the first segment below a prefix**: it appears only in API prefixes.
  The human-readable documentation page is `/_site/api-docs` (never `/_site/api`), so no page URL can be
  mistaken for an endpoint. A *later* segment is unaffected, so a country slug that happened to be `api`
  (`/_site/countries/api`) is still a legal page. Classification compares whole segments, and decodes
  percent-escapes first: `/_admin/%61pi/...` is the admin API, not an unknown path.
- `/` returns `302` to `/_site/`.
- SPA deep links (`/_site/admin/cache/00000000-0000-4000-8000-000000000001`) are rewritten by Nginx to `index.html`; unknown
  `/_site/*` paths render the in-app 404 page, not a server error.
- **Who serves what:** Nginx serves the SPA (`/` → `/_site/`, `/_site/*` fallback and the single
  `/_auth/login` page); the API serves only `/_auth/api/*`, `/_admin/api/*`, `/_public/api/*` and the
  probes. **`/_auth/api/*` must be matched before the `/_auth/login` location** so the API is never
  swallowed by the SPA fallback. So the law is enforced in two tests:
  - `apps/api/tests/law-routes.test.ts` — walks the Fastify route table: every URL matches
    `^(/_auth/api/|/_admin/api/|/_public/api/|/healthz$|/readyz$)`, the classifiers the guards use agree with the
    table, no page path is served by the API, and no API route answers `text/html`.
  - `apps/api/tests/integration/admin-guard.spec.ts` — walks the same table and proves every `/_admin/api/*` route
    refuses a request without a Bearer token, and that a valid one is let through (a gate, not a wall).
  - `apps/api/tests/integration/credential-transport.spec.ts` — offers a **live** token in a cookie, the query
    string, a body field, `Basic` credentials and other headers on every admin route, and gets `401` each time:
    the credential is only ever the `Authorization` header (`14-security.md` §3).
  - `apps/web/tests/law-router.test.ts` — walks the Vue router table: every page path starts with
    `/_site/` or is exactly `/_auth/login`, the admin routes are children of `/_site/admin`, and no
    page path collides with an API prefix.
  - Phase 6 adds a container-level check (curl) that: `/_auth/login` returns HTML, `/_auth/api/login`
    returns JSON (not the SPA), `/_site/admin/` returns the shell with no data, and `/` returns
    `302 /_site/`.

## L2 — Deny by default (enforced by test)

- Every `/_admin/api/*` route requires a valid Bearer token; there is **no** opt-out flag. Page shells
  under `/_site/admin/*` are inert HTML — authorization happens on the API, never in the router.
- The guard is a global `onRequest` hook keyed by prefix, so a new route is protected automatically.
- Public routes may only read data the admin explicitly published (`country_cache.is_public = true`
  and `map_versions.status = 'ready'`).
- Test: for each admin route, one request without token must return `401`.

## L3 — Bearer only (enforced by test)

- Admin APIs accept authentication **only** via `Authorization: Bearer <token>`.
- No cookies, no Basic auth, no `?token=` query parameter (query tokens leak into logs).
- Tokens are random 256-bit values; only a SHA-256 hash is stored; comparison is constant-time.
- Test: cookie-authenticated request → `401`; query-string token → `401`.

## L4 — Stack law

Bun, TypeScript (strict), Fastify, Zod, PostgreSQL, Kysely, Vue 3, Vuetify 3, VueUse, Pinia, Vite,
Vitest, JSDoc. **Additions require an ADR.** No second ORM, no second validator, no CSS framework
alongside Vuetify, no state library alongside Pinia.

## L5 — Boundary validation

Every external input — env vars, HTTP body/query/params, multipart fields, DB rows, and source
responses — passes through a Zod schema. No `as` casts on untrusted data. Exported functions and
types carry JSDoc.

## L6 — Storage safety

- Cache files live only under `CACHE_DIR` (`/data/cache`); every path is built from validated,
  slug-safe components; requests can never supply a path.
- Files are written to `<file>.part`, checksum-verified, then atomically `rename()`d into place.
- A DB row is the source of truth: a file without a `ready` row is an orphan (sweepable); a `ready`
  row without a file is corruption (reported, never silently served → `410`/`404`).
- Deletion happens **after** DB state change and must never touch a path outside `CACHE_DIR`.

## L7 — Versions are immutable

- A `map_versions` row is never mutated after it becomes `ready` (except lifecycle status changes).
- The same `(country, version)` may not exist twice while active; replacement is an explicit,
  separately-confirmed action (`D-10`).
- Retention (`D-7`) may delete old rows/files but must **always** keep the newest valid version.

## L8 — Public means published

- `country_cache.is_public = false` ⇒ every public endpoint behaves as if the country does not exist
  (`404`, never `403`, never a hint that it exists).
- Toggling public access takes effect immediately; no cache layer may serve a stale publication list
  for longer than 5 seconds.
- Only `ready` versions are ever offered; `pending`/`failed` versions are admin-only information.

## L9 — Secrets (redaction enforced by test)


- Secrets come from env/secret files only: never committed, never logged, never echoed back by an
  endpoint, never included in error responses or audit metadata.
- The admin password is accepted by the launch/bootstrap script via prompt, env var, or file — and is
  immediately hashed with Argon2id; plaintext is never persisted.
- Logs redact `authorization`, `password`, `token`, `cookie` at the logger level, not per call site. The
  list lives in `apps/api/src/lib/logger.ts` and applies to every logger the API builds; the test that
  keeps it honest captures real log output rather than inspecting the configuration.

## L10 — Destructive actions require confirmation

Deleting a country from cache, deleting a version, replacing a version, and disabling an interval
running now require an explicit confirmation (typed slug for country deletion). Every destructive
action writes an `audit_logs` row with actor, target and before/after metadata.

## L11 — Honest status

- Update checks return `unknown` when the source is unreachable — never `up_to_date`.
- Metrics show real sampled values with their scope (host vs container) documented in the UI tooltip.
- Job progress reflects bytes actually written, not estimated.
- Docs never describe unimplemented behaviour.

## L12 — Docs in sync

Code changes that alter behaviour, API shape, schema, env vars or ops steps update the matching
`docs/` file in the **same commit**. A phase cannot close with stale docs.

## L13 — Verification before "done"

A phase is done only when `bun run check` (typecheck + lint + format + tests) is green, the relevant
acceptance criteria in `08-tasks.md` are ticked, and — for UI phases — the rubric in `13-ui-ux.md`
scores ≥ 45/50 with screenshots.

## L14 — Branch and scope discipline

- Work happens only on `arena/5a1becdd-mapirror`.
- No silent scope changes: a new requirement is first written into `PROMPT.md`/`08-tasks.md` and, if it
  contradicts an earlier decision, into `15-decisions.md` as an ADR.
- Generated artifacts (map files, DB data, `node_modules`, builds) never enter Git.
