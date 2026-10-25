# MapMirror — Documentation Index

> **Phase 0 released as [`v0.1.0`](../CHANGELOG.md) — docs approved 2026-10-24.** Phase 1 is in
> progress (`0.2.0-dev`). Source of truth for requirements:
> [`../PROMPT.md`](../PROMPT.md) (approved v1.1 + D-1…D-19).

MapMirror is a self-hosted **map cache and download mirror** for OpenStreetMap country extracts
(Geofabrik). An admin caches, versions, publishes, schedules and monitors downloads; visitors download
the countries the admin made public.

---

## Route map (memorize this)

| Kind | Path | Auth |
|---|---|---|
| Public pages | `/_site/`, `/_site/countries/:slug`, `/_site/api-docs` | — |
| Admin pages | `/_site/admin/*` (dashboard, catalog, cache, intervals, import, jobs, system, settings, audit) | UI checks token |
| Login page | `/_auth/login` | — |
| Admin API | `/_admin/api/*` | **Bearer** |
| Public API | `/_public/api/*` | — (rate limited) |
| Auth API | `/_auth/api/login`, `/_auth/api/logout`, `/_auth/api/me` | mixed |
| Probes | `/healthz`, `/readyz` | — |

`/` → `302 /_site/`. API routes never return HTML; page routes never return JSON.
The only page outside `/_site/` is the login page, `/_auth/login` (D-19, ADR-024). Law `L1` enforces this.

---

## Documents

| # | Document | Read it when you need… |
|---|---|---|
| — | [`../PROMPT.md`](../PROMPT.md) | The full requirement set + decision log (§24) |
| 01 | [01-overview.md](01-overview.md) | Scope, personas, product rules, **out of scope** |
| 02 | [02-architecture.md](02-architecture.md) | Containers, modules, job queue, scheduler, failure behaviour |
| 03 | [03-data-model.md](03-data-model.md) | Tables, DDL, indexes, invariants, ERD |
| 04 | [04-api.md](04-api.md) | Every endpoint, error codes, `curl`, download headers |
| 05 | [05-flows.md](05-flows.md) | Sequence diagrams for 12 journeys |
| 06 | [06-diagrams.md](06-diagrams.md) | Context, containers, deployment, state machines |
| 07 | [07-roadmap.md](07-roadmap.md) | Phases and exit gates |
| 08 | [08-tasks.md](08-tasks.md) | 136 tasks with IDs, deps, acceptance criteria |
| 09 | [09-development.md](09-development.md) | Setup, commands, env vars, testing, debugging |
| 10 | [10-laws.md](10-laws.md) | Non-negotiable rules (most are test-enforced) |
| 11 | [11-project-tree.md](11-project-tree.md) | Target repo tree, storage layout, naming |
| 12 | [12-deployment.md](12-deployment.md) | Ubuntu 24.04 + Docker runbook, TLS, backup, upgrades |
| 13 | [13-ui-ux.md](13-ui-ux.md) | Tokens, 14 screens + 404, component rules, 5/5 rubric |
| 14 | [14-security.md](14-security.md) | Threat model + sign-off checklist |
| 15 | [15-decisions.md](15-decisions.md) | ADRs (the *why*; the decision table lives in `PROMPT.md` §24) |
| 16 | [16-changelog.md](16-changelog.md) | Review passes: what was found and fixed |

### Reading paths

| You are | Read |
|---|---|
| Approving the plan | 01 → 07 → 13 → 04 |
| Starting to code | 10 → 11 → 09 → 08 (your phase) |
| Deploying | 12 → 09 §5 (env) |
| Reviewing security | 14 → 04 §3 (public API) → 10 |

---

## Current status

| Item | State |
|---|---|
| Prompt / requirements | ✅ Approved (v1.1, owner decisions D-1…D-19) |
| Phase 0 — documentation | ✅ **Released as `v0.1.0`** |
| Phase 1 — skeleton, Docker, auth, admin shell | 🟨 In progress (`0.2.0-dev`) |
| Phases 2–6 | ⬜ |

---

## Documentation history

Every review pass, its findings and the fixes are in **[16-changelog.md](16-changelog.md)** — kept out
of this file so the index stays an index. Current: 21 passes, 119 defects fixed, 0 open.

---

## Conventions

- **Requirement IDs** (`AUTH-1`, `CACHE-4`, `UPD-2`, `INT-1`, `PUB-1`, …) come from `PROMPT.md` §6–§16
  and are the traceability keys for tasks in `08-tasks.md`.
- **Task IDs**: `P<phase>-<AREA>-<nn>` (e.g. `P2-JOB-05`). **ADRs**: `ADR-00N`. **Laws**: `L1…L14`.
- Diagrams are Mermaid (render on GitHub). Times are UTC. API byte counts are integers; the UI
  formats them for humans.
- Where a doc states a rule that code must enforce, the enforcement is named (a test or a DB
  constraint). "Convention only" is called out as such.

## Documentation rules (see `10-laws.md` L12)

1. A behaviour change updates its doc in the **same commit**.
2. No doc describes something that does not exist; unfinished work is ⬜ or "planned".
3. A new endpoint appears in `04-api.md` **before** it is implemented.
4. A deviation from `PROMPT.md` needs an ADR with a one-line rationale.
5. Diagrams and DDL are code: if they drift, the doc is wrong, not "roughly right".
