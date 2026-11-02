# P5-TST-01 Core Coverage Report — complete

**Generated:** 2026-11-02

**Status:** Acceptance met for all three required scopes and all four coverage metrics.

## Scope and acceptance target

The report counts every production TypeScript file under `apps/api/src/modules/**`, `packages/shared/src/**`, and `apps/web/src/stores/**`. The 80% requirement is applied to each complete scoped aggregate (not to a selected subset of modules, routes, files, or metrics). Lines, statements, branches, and functions are all included.

## Scoped results

| Scope | Lines | Statements | Branches | Functions |
|---|---:|---:|---:|---:|
| `apps/api/src/modules/**` | **90.72%** (3,325 / 3,665) | **89.11%** (3,634 / 4,078) | **81.39%** (2,480 / 3,047) | **91.55%** (639 / 698) |
| `packages/shared/src/**` | **99.26%** (269 / 271) | **99.30%** (283 / 285) | **98.17%** (107 / 109) | **100.00%** (42 / 42) |
| `apps/web/src/stores/**` | **100.00%** (71 / 71) | **100.00%** (83 / 83) | **100.00%** (42 / 42) | **100.00%** (27 / 27) |

All three complete scopes exceed the 80% threshold for every metric. Within the API aggregate, lower-coverage areas remain and are not hidden: the `jobs` folder is at 74.58% branches and `auth` at 79.15% branches. These are included in the API-wide totals above; the acceptance criterion is scoped to the complete API-modules aggregate.

## Validation and method

Command: `npm exec --yes bun@1.4.4 -- run test:coverage` (Vitest V8 coverage). The full run passed **168 test files and 1,699 tests**; 44 files and 340 tests were skipped because they require the user-managed fresh PostgreSQL/Docker test database. Typechecks passed for shared, API, and web packages. ESLint passed for the added and adjusted unit-test files.

Scoped totals were calculated from the generated V8/Istanbul counters in `coverage/coverage-final.json`, using the exact three source prefixes listed above. Line totals count unique source lines represented in the V8 statement map; statement, branch, and function totals use their corresponding counters. The generated `coverage/` directory is ignored; this versioned report is the attached P5-TST-01 evidence.

The run also reports **85.45% statements, 79.18% branches, 85.58% functions, and 86.64% lines** across all repository files. This repository-wide figure is supplementary; acceptance is based on the scoped aggregates above.
