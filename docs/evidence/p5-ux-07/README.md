# P5-UX-07 screenshot evidence

Reviewed 31 Oct 2026 against the running Vite app at 390 × 844 and 1440 × 900 CSS pixels. Each PNG is a full-page Chromium capture; API responses are deterministic visual fixtures, not live database or production data. Reduced motion was enabled. `capture-diagnostics.json` records the rendered heading, Vuetify theme, viewport/document widths, file size, and browser console/page errors for each capture.

All 15 screens (S1–S15, including not-found) are represented at both widths in every theme supported by the UI policy. The admin is intentionally dark-only (`13-ui-ux.md` §1/§3), while public screens support light and dark and login follows the system preference. This produces 40 valid captures: 20 dark-only admin captures, and 20 across auth/public screens. All captures rendered the requested theme, reported zero console/page errors, and had document width equal to viewport width (no horizontal overflow).

| Screen | Route | Supported theme(s) | 390 px captures | 1440 px captures |
|---|---|---|---|---|
| S1 Login | `/_auth/login` | Light, dark | [light](S01-login-light-390x844.png) · [dark](S01-login-dark-390x844.png) | [light](S01-login-light-1440x900.png) · [dark](S01-login-dark-1440x900.png) |
| S2 Public catalog | `/_site/` | Light, dark | [light](S02-public-catalog-light-390x844.png) · [dark](S02-public-catalog-dark-390x844.png) | [light](S02-public-catalog-light-1440x900.png) · [dark](S02-public-catalog-dark-1440x900.png) |
| S3 Country detail | `/_site/countries/finland` | Light, dark | [light](S03-country-detail-light-390x844.png) · [dark](S03-country-detail-dark-390x844.png) | [light](S03-country-detail-light-1440x900.png) · [dark](S03-country-detail-dark-1440x900.png) |
| S4 API documentation | `/_site/api-docs` | Light, dark | [light](S04-api-docs-light-390x844.png) · [dark](S04-api-docs-dark-390x844.png) | [light](S04-api-docs-light-1440x900.png) · [dark](S04-api-docs-dark-1440x900.png) |
| S5 Dashboard | `/_site/admin/` | Dark | [dark](S05-dashboard-dark-390x844.png) | [dark](S05-dashboard-dark-1440x900.png) |
| S6 Admin catalog | `/_site/admin/catalog` | Dark | [dark](S06-admin-catalog-dark-390x844.png) | [dark](S06-admin-catalog-dark-1440x900.png) |
| S7 Cache | `/_site/admin/cache` | Dark | [dark](S07-cache-dark-390x844.png) | [dark](S07-cache-dark-1440x900.png) |
| S8 Cached-country detail | `/_site/admin/cache/{countryId}` | Dark | [dark](S08-cache-country-dark-390x844.png) | [dark](S08-cache-country-dark-1440x900.png) |
| S9 Intervals | `/_site/admin/intervals` | Dark | [dark](S09-intervals-dark-390x844.png) | [dark](S09-intervals-dark-1440x900.png) |
| S10 Import | `/_site/admin/import` | Dark | [dark](S10-import-dark-390x844.png) | [dark](S10-import-dark-1440x900.png) |
| S11 Jobs | `/_site/admin/jobs` | Dark | [dark](S11-jobs-dark-390x844.png) | [dark](S11-jobs-dark-1440x900.png) |
| S12 System | `/_site/admin/system` | Dark | [dark](S12-system-placeholder-dark-390x844.png) | [dark](S12-system-placeholder-dark-1440x900.png) |
| S13 Settings | `/_site/admin/settings` | Dark | [dark](S13-settings-placeholder-dark-390x844.png) | [dark](S13-settings-placeholder-dark-1440x900.png) |
| S14 Audit log | `/_site/admin/audit` | Dark | [dark](S14-audit-placeholder-dark-390x844.png) | [dark](S14-audit-placeholder-dark-1440x900.png) |
| S15 Not found | `/_site/not-a-real-page` | Light, dark | [light](S15-not-found-light-390x844.png) · [dark](S15-not-found-dark-390x844.png) | [light](S15-not-found-light-1440x900.png) · [dark](S15-not-found-dark-1440x900.png) |

## Findings fixed during review

- Removed the Dashboard's internal screen/document caption and corrected the active admin navigation treatment: primary-colored text with the activated opacity, rather than an opaque overlay.
- Widened the global admin search from its clipped 59 px rendering to 260 px on desktop and 120 px on mobile.
- Measured all rendered routes at 390 px and found horizontal overflow on login, the System/Settings/Audit placeholders, and the not-found action. Contained Vuetify container/grid gutters on auth and placeholder pages and made the not-found action border-box sized. The final capture pass confirms no page-level overflow at either review width.

The screenshots are the visual evidence; diagnostics are capture checks, not performance measurements. The §10 performance score therefore does not claim a measured production LCP.
