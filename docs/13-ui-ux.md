# 13 — UI/UX specification

**TL;DR** — dark admin / light public, two-font system with a pre-approved fallback, 15 screens + a not-found page, strict component and state rules, and a 10-criterion rubric (≥45/50 to close Phase 5).

Target: **5/5** — reviewed against the rubric in §10, scored with evidence, not opinion.
Design intelligence reference: [uupm.cc](https://uupm.cc/) (UI UX Pro Max — styles, palettes, font
pairings, chart types, UX guidelines, Vue stack guidance). We take the *principles*; the palette and
type below are ours, cheap to implement, and Vuetify-native (D-14).

---

## 1. Design direction

A **map/data product**, not a marketing site.

| Area | Feel | Theme |
|---|---|---|
| Admin | Calm "control room": dense tables, quiet chrome, data first | **Dark** (default) |
| Public | Open "catalog": readable, spacious, trustworthy | **Light** (default) |
| Auth | Focused, minimal, single card | Follows system theme |

Principles:

1. **Data first** — numbers, versions and dates are the interface; decoration stays out of the way.
2. **Always know the state** — cached / not cached, published / private, up to date / update available.
3. **One primary action per screen** — never two competing filled buttons.
4. **Destructive actions look different** — outlined + typed confirmation, never a red filled button
   next to a green one.
5. **No lies** — unknown states say "unknown", stale data shows when it was fetched.

## 2. Design tokens

### Color

| Token | Light (public) | Dark (admin) | Use |
|---|---|---|---|
| `primary` | `#0F766E` (teal-700) | `#5EEAD4` (teal-300) | Primary actions, active nav |
| `primary-darken-1` | `#115E59` | `#2DD4BF` | Hover/pressed |
| `secondary` | `#4338CA` (indigo-700) | `#A5B4FC` | Links, secondary emphasis |
| `accent` | `#B45309` (amber-700) | `#FBBF24` | **Update available** only |
| `success` | `#15803D` | `#4ADE80` | Ready / published / up to date |
| `warning` | `#B45309` | `#FBBF24` | Partial run, disk headroom low |
| `error` | `#B91C1C` | `#F87171` | Failed jobs, destructive |
| `surface` | `#FFFFFF` | `#0F1115` | Page background |
| `surface-variant` | `#F6F7F9` | `#171A21` | Cards, table headers |
| `border` | `#E3E6EA` | `#262B35` | Decorative division: table rows, section rules |
| `border-strong` | `#7C848C` | `#6B7280` | Boundaries that carry meaning: input outlines, switch tracks (≥ 3:1) |
| `text-primary` | `#111827` | `#E5E7EB` | Body |
| `text-secondary` | `#4B5563` | `#9CA3AF` | Meta, captions |

Rules: contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and for **meaningful** UI boundaries. Semantic colors are
**never** used decoratively. Amber is reserved for "update available" so the badge is unambiguous.

Two boundaries, not one: WCAG 1.4.11 asks 3:1 of "visual information required to identify user interface components and
states" — an input outline, a switch track — and asks nothing of a row divider, which is decoration. `border` measured
**1.25:1** (light) and **1.33:1** (dark) against the page background, which is right for a hairline and wrong for a
field, so the field gets `border-strong` (**3.79:1** / **3.54:1** light, **3.91:1** / **3.60:1** dark, against the page
and the card). `16-changelog.md` pass 30 records the measurement.

Vuetify's two "surface" keys are mapped from these names, and the mapping is code (`apps/web/src/styles/tokens.ts`):
our `surface` (page background) becomes Vuetify's **`background`**, because `v-app` paints that; our `surface-variant`
(cards) becomes Vuetify's **`surface`**, because `v-card`, `v-menu` and `v-dialog` paint that and a menu the colour of
the page would be invisible. Both themes are built from this table by `styles/tokens.ts` — nothing else in the SPA
holds a colour — and `apps/web/tests/tokens.spec.ts` parses it and fails on any hex that differs.

**Nothing else is in the theme.** Vuetify merges its own Material palettes *under* the two built here, so every key this
table does not name arrives with a colour from another design system. Measured on the shipped themes (pass 33): `info`
`#2196F3` in **both** themes and with no `on-info` — the neutral toast's fill, with a label Vuetify picked by APCA;
`surface-bright` `#ccbfd6` in the dark theme (a lavender "bright surface" in a control room); `secondary-darken-1` a
Material teal while our `secondary` is indigo; and `on-surface-variant` `#EEEEEE` in the light theme — near-white ink on
a `#F6F7F9` card, **1.04:1**. The module therefore names all seven: the surfaces and the ink alias `surface-variant` and
`text-primary`, and `info` — a state this table does not define, so no fourteenth colour is invented — aliases
`secondary` and gets a `bestOn` label. `tokens.spec.ts` asserts that **no colour value in either shipped theme is outside
this table** (white and black excepted: they are the computed labels), which is what makes "no colour outside the token
module" true of the theme and not merely of the source files.

### Typography

| Role | Font | Size / weight |
|---|---|---|
| Display (page titles) | **Space Grotesk** (variable, self-hosted, Latin subset, 22 288 B) | 24–28 px / 600 |
| Section headings / key metrics | display face / system stack | 18 px / 600 |
| UI / body | **System stack** — `-apple-system, "Segoe UI", Roboto, sans-serif` | 14 px / 400, 16 px public body |
| Supporting text / captions | system stack | 12–13 px / 400 |
| Numeric (sizes, dates) | the UI face with `font-variant-numeric: tabular-nums` | — |
| Code / checksums | `ui-monospace, "JetBrains Mono", monospace` | 12–13 px |

The shared weight tokens are 400 regular, 500 medium and 600 semibold. Styles use named typography, spacing and weight
custom properties rather than duplicating numeric values; dense 12 px copy is reserved for metadata and chart labels.

**The budget rule was applied, not just written.** It said: both fonts are variable, subset to Latin, self-hosted woff2
with `font-display: swap`, preloaded only on the public landing page, and **if either adds > 40 kB total or hurts LCP,
fall back to the system stack** (D-14 permits dropping them at zero design cost). Measured on the Latin variable
subsets: **Inter 48 256 B**, **Space Grotesk 22 288 B**, together **70 544 B**. Inter alone exceeds the budget, so the
body falls back to the system stack — which on every platform this targets is a well-hinted, already-installed face,
i.e. the cheapest possible LCP — and Space Grotesk stays for display at 22 288 B, self-hosted from
`apps/web/src/assets/fonts/` with its OFL license beside it. `apps/web/tests/tokens.spec.ts` reads that file's size and
fails above 40 kB, so the exemption stays earned.

`P3-WEB-01` adds a `font/woff2` preload only while the public landing page is mounted; other routes use the self-hosted
`@font-face` with `font-display: swap` and do not receive a preload hint.

### Space, radius, elevation, motion

| Token | Value |
|---|---|
| Spacing scale | 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64 / 80 |
| Radius | `sm 8`, `md 12`, `lg 16`, `pill 999` |
| Border | 1 px `border` token; shadows only for overlays (`0 8px 24px rgba(0,0,0,.16)`) |
| Motion | 150 ms ease-out for hover/focus, 200 ms for dialogs; **respects `prefers-reduced-motion`** |
| Focus ring | 2 px `primary` outline + 2 px offset, always visible on keyboard focus |
| Touch target | ≥ 44 × 44 px |
| Container | Admin max 1440 px (fluid tables), public max 1120 px |

## 3. Layout

### Admin shell (desktop ≥ 1024 px)

```
┌────────────┬──────────────────────────────────────────────────────────┐
│ MapMirror  │  Dashboard › Cache                          [search] [·] │  ← topbar 64px
│            ├──────────────────────────────────────────────────────────┤
│ Dashboard  │  Page title                            [primary action]  │
│ Catalog    │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐         │
│ Cache      │  │ stat    │ │ stat    │ │ stat    │ │ stat    │         │
│ Intervals  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘         │
│ Import     │  ┌──────────────────────────────────────────────────────┐│
│ Jobs    •2 │  │ table / charts / content                             ││
│ System     │  └──────────────────────────────────────────────────────┘│
│ Settings   │                                                          │
│ Network    │                                                          │
│ Audit      │                                                          │
└────────────┴──────────────────────────────────────────────────────────┘
```

- Sidebar 248 px, collapsible; on `< 1024 px` it becomes a temporary drawer with a hamburger. The numbers live in
  `apps/web/src/layouts/adminShell.ts` (248 / 64 / 1024) and `plugins/vuetify.ts` hands the last one to Vuetify as
  `display.mobileBreakpoint`, so "mobile" means this document's boundary and not the framework's 1280 px. A temporary
  drawer closes itself on navigation and re-opens on a desktop when the boundary is crossed — Vuetify does both, and
  `tests/admin-layout.spec.ts` asserts them so an upgrade cannot quietly take them away (pass 36).
- A dot badge on **Jobs** shows queued/running work. The shell polls validated totals from `P2-API-10` every 2 s and
  shows the dot only for a non-zero count; it does not claim an empty queue before the first successful response. The
  Catalog updates counter remains owned by `P2-WEB-01`.
- Topbar holds the menu button, breadcrumbs, global search (catalog), a persistent **Jobs** progress-drawer trigger and
  the user menu (logout). The Jobs drawer is mounted by `AdminLayout`, so tracked progress remains open and polling while
  the reader navigates between admin pages. **No theme toggle**: §1
  fixes the admin area to the dark theme, so a toggle there could only do nothing — the per-visitor override §1 allows is
  the public shell's (`P3-WEB-01`). The menu button says "Menu" / "Hide menu" rather than wearing a hamburger icon,
  because an explicit action label is clearer than a bare glyph. The trail is `<nav aria-label="Breadcrumb">` with `aria-current="page"`
  on the last step, and it is hidden below 600 px where the topbar has no room for it; the page's own `h1` says the same
  thing a line lower. The first focusable element on every admin page is a skip link to `#mm-main` (§7).

### Public shell

- Header: wordmark, "Browse maps", "API", theme toggle. **Light is the default** on the public site;
  dark is fully supported and remembered per visitor through VueUse storage, as an explicit visitor choice.
- Home: a compact intro (one line + license note), then **search + continent chips + country grid**.
- Country page: name + ISO flag, primary **Download** button, then a versions table, then the
  attribution/license block.

## 4. Screen inventory

| # | Route | Purpose | Key elements | Empty state |
|---|---|---|---|---|
| S1 | `/_auth/login` | Sign in | username, password, submit, error | — |
| S2 | `/_site/` | Public catalog | search, continent chips, country cards, license note | Centered map illustration, honest no-published-maps message, and a refresh action; filtered no-match stays distinct with a clear-filters action |
| S3 | `/_site/countries/:slug` | Country detail | Latest download + copyable exact-version cURL command, versions table, md5, size, updated | (always has a version if visible) |
| S4 | `/_site/api-docs` | API documentation | public endpoints, response shapes, copyable same-origin cURL examples, error codes and rate limits | — |
| S5 | `/_site/admin/` | Dashboard | sampled cached size and cached/public/catalog counts; updates; active, queued and failed jobs; storage headroom; next scheduled interval; source-sync freshness; CPU, memory, cache-volume disk, cache growth and load-average charts with 5m/1h/24h/7d windows. Every overview widget links to its owning admin page. | "No data yet — sampling…" |
| S6 | `/_site/admin/catalog` | Search Geofabrik | search, continent and cache filters, table with Download, **Sync Geofabrik catalog** action for newly listed regions | "No country matches" |
| S7 | `/_site/admin/cache` | Cached countries | search/update filter; sortable, paginated table: name, ready versions, local size, public/private state, update badge, catalog sync/source-download times; per-country update check, confirmed update action, and background "Check all" | "Nothing cached yet — browse catalog" |
| S8 | `/_site/admin/cache/:countryId` | Cached-country detail | cache summary, active work, paginated version table with download/delete, delete-country action | "No versions stored" |
| S9 | `/_site/admin/intervals` | Schedules and run history | list + create/edit form, frequency and multi-country selection, pause/delete actions, next run, readable last status, next-five UTC preview, confirmed manual run (works while paused), paginated run history with active-run polling, per-country outcomes and safe failure details | "No intervals yet" / "No runs yet" |
| S10 | `/_site/admin/import` | Upload | dropzone, country select, version, submit, progress | — |
| S11 | `/_site/admin/jobs` | Job queue | URL-backed status/type filters, paginated progress rows/cards; persistent detail drawer with phase, speed/ETA, cooperative cancel and safe error detail | "No jobs" |
| S12 | `/_site/admin/system` | Status | disk, counts, source freshness, orphan report | — |
| S13 | `/_site/admin/settings` | Settings | display name; cache version retention and disk reserve; public download limit; Geofabrik catalog refresh interval; validated save/discard flow | — |
| S14 | `/_site/admin/audit` | Audit log | exact action filter, URL-backed pagination, current-page CSV export | "No audit entries yet" / "No entries match this action" |
| S16 | `/_site/admin/network` | Outbound proxy | validated HTTP(S)/SOCKS5 endpoint, draft test and post-apply health checks for every Geofabrik operation, per-check HTTP status/reason, remove-to-direct action | Direct outbound requests; no proxy configured |
| S15 | `/_site/*` (unmatched) | Not found | Decorative map/route illustration, 404, requested address, concise guidance and a primary catalog link | — |

S16 accepts only an `http://`, `https://`, or `socks5://` host and optional port; URL credentials, paths, query strings, and fragments are rejected, and authenticated proxies are not supported. The bounded health report exercises the Geofabrik catalog JSON, Finland region page, PBF `HEAD` metadata, MD5 sidecar, and a one-byte PBF range (cancelling the body immediately). Applying persists and activates the endpoint before running the five checks through that live transport; failed checks remain visible while the proxy stays active, so the admin can remove or replace it. Removal deletes the setting and routes new requests directly. The checks intentionally use the same live outbound transport as admin source reads and startup workers, not a separate health-only proxy path.

The admin detail URL carries the local country UUID because the cache detail/version APIs are UUID-scoped. The page reads the country name from the API for its heading and breadcrumb. Version download/delete belongs to P2-WEB-04; whole-country deletion is P2-WEB-05 and requires exact slug typing, with explicit opt-in before canceling active work. The publication switch is P3-WEB-06. P4-UPD-03 places update-check and confirmed update actions on each cached-country row in S7.

## 5. Component rules

| Component | Rules |
|---|---|
| **Cache table** | Sticky header; columns: Country · Ready versions · Local size · Public state · Update · Catalog synced · Actions. Sort and pagination state live in the URL; `size` means local cached bytes. Row hover reveals a subtle background. On `< 768 px` it becomes stacked cards, never a horizontal scroller. Public/private remains informational here; the switch belongs to P3-WEB-06. Each row offers an update check and, when available, a confirmed update action. A page-level "Check all" queues the bulk worker and exposes progress in the shell drawer. |
| **Public switch** | Cached-country detail uses `v-switch` with an inline Public/Private label + immediate optimistic update; `POST /_admin/api/cache/:countryId/public` uses the shared strict body/response schemas, and the validated response is authoritative. On failure, restore the previous state and show a persistent actionable toast (including request id when supplied). Disabled with a tooltip and visible explanation when no ready version exists; the API's `422 NO_READY_VERSION` remains authoritative if readiness changes concurrently. Unpublishing closes public access without deleting cached data. |
| **Update badge** | Persisted update state is shown with its checked time; the available state is an amber pill "Update available · 261024". Its row action "Update" opens a confirm with the estimated additional space for the new retained snapshot, estimated cache total when known, and the retention effect (older ready versions are kept; this manual action does not prune them). A check may return honest `Unknown` when the source cannot be compared. |
| **Source catalog sync** | The Geofabrik catalog page offers an authenticated refresh action for newly listed regions, tracks the durable job in the shell drawer, and reloads the list only after success. Clearly state that arbitrary custom sources are not supported; show retryable errors and request ids. |
| **Download button** | Present only when not cached (catalog) or for a specific uncached version. Destructive/disabled states explained by tooltip, never silently invisible without a reason on hover. |
| **Version table** | Version · Source date · Size · Checksum (truncated, copyable) · Status · Created · Actions (download, delete). "Latest" is a chip, not a separate row. |
| **Delete dialogs** | Country: type the exact slug to enable; show retained catalog identity, closed public access and every active job, with a separate explicit opt-in to cooperative cancellation. Version: checkbox "I understand" + shows what will be deleted. Always state consequences (public access closes). |
| **Job progress** | Indeterminate → determinate bar, `12.3 MB/s · 35 s left`, phase label, cancel button. On failure: a human explanation and next step; keep machine codes out of the primary message. |
| **Charts** | One y-axis, gridlines at 25 %, area fill at 12 % opacity, tooltip on hover showing exact values + time. Colors from the palette; never rely on color alone (label + value). |
| **Empty states** | Icon + one sentence + the next action as a button. Never a bare table with "No data". |
| **Error states** | What failed, why (if known), what to do. Retry button. Request id in small mono text for support. `apps/web/src/api/error-copy.ts` maps every documented HTTP, browser, job and operational code to human copy plus a next step; inline errors, login refusals and job failure details use that map. |
| **Toasts** | Bottom-right (admin), success 3 s, error persists with a close button; one toast at a time per action. `notifyApiError()` uses the same code map and carries the request id in small monospace text. |
| **Skeletons** | Match final layout (same heights) to avoid shift; no spinners for tables. Intervals reserves schedule-card structure, while Jobs preserves the semantic table header and uses matching desktop rows/mobile cards. Skeletons are decorative (`aria-hidden`) beside a separate loading announcement and busy region; their pulse stops for reduced motion. |
| **Icons** | Material Design Icons from the self-hosted `@mdi/font` 7.4.47 set only; 20/24 px via `--mm-icon-size-20` / `--mm-icon-size-24`; **never emoji** as UI icons. The toast dismiss and password visibility controls use named MDI glyphs; custom artwork is semantic-free SVG, and country identity is shown as ISO text rather than platform-specific flag emoji. Decorative Vuetify defaults stay disabled when they add no information. `tests/icon-audit.spec.ts` rejects emoji code points in Vue/CSS UI and verifies the installed MDI font, size tokens, and control sizing. |

## 6. Interaction standards

- Every async action: disabled button → inline progress → success toast or inline error. No dead clicks.
- Optimistic updates only for the public switch and settings toggles, always with rollback.
- Destructive actions never auto-confirm; Enter does not trigger them by default.
- Small, fully loaded tables sort client-side; paginated admin catalog/cache tables use server-side sorting, with sort state in the URL query.
- Search is debounced 300 ms; the URL reflects filters so a view can be bookmarked/shared.
- Forms validate on blur + on submit, show a summary if multiple fields fail, and never lose typed data.
- Keyboard: `Tab` order follows visual order; `Esc` closes dialogs/drawers; `/` focuses search in admin.
- Copy-to-clipboard always confirms with a checkmark for 1.5 s.

## 7. Accessibility

| Check | Requirement |
|---|---|
| Contrast | ≥ 4.5:1 body, ≥ 3:1 large text and meaningful boundaries — asserted, not sampled: `apps/web/tests/tokens.spec.ts` parses §2 and computes every ratio (25 pairs per theme, including the `on-` label colour Vuetify derives for each fill) |
| Focus | `:focus-visible` ring on native and custom keyboard-focusable controls; skip-to-content link is the first admin focus target and moves focus to `main` |
| Keyboard | Tab order follows visual order; Enter submits the login form; Escape closes dialogs; regression tests pin the skip link, password control and dialog behavior |
| Semantics | One `h1` per page, landmark regions, labelled inputs, `aria-live` for toasts/progress; form errors are connected with `aria-describedby` |
| Motion | `prefers-reduced-motion` reduces transitions and animations to 0.01 ms, limits animations to one iteration, zeroes motion tokens, and disables smooth scrolling |
| Charts | Textual summary/table alternative for every chart ("CPU 12 % at 08:00 …") |
| Forms | Errors tied with `aria-describedby`; required fields marked in text, not color only |
| Targets | ≥ 44 px; switches have generous hit area |
| Zoom | Usable at 200 % zoom without horizontal scroll on 1280 px |
| Automated | `axe-core` checks the loaded public catalog in light/dark themes plus login, API docs, country detail, admin screens and not-found (WCAG 2.0/2.1/2.2 AA + best practices); zero serious/critical violations. API-dependent admin routes are audited in their service-error state. jsdom axe does not reliably measure rendered color contrast, so token-palette contrast assertions remain separate and are not a substitute for browser/manual visual review. |

## 8. Responsive rules

| Breakpoint | Behaviour |
|---|---|
| `< 640` | Single-column content and cards; public country/version details stack with labels; filters and page actions use full-width controls where needed. |
| `640–1023` | Catalog, cache, cached-version and job results use two-column cards rather than compressed tables; dashboard overview stays two columns. The admin sidebar remains a temporary drawer below 1024 px. |
| `1024–1440` | Full admin sidebar and data tables; page containers stay fluid within the 1440 px admin cap. |
| `> 1440` | Content remains centered within max-width caps; charts retain their own row. |

System-metric charts stack below 768 px; the dashboard overview becomes one column below 600 px. Admin catalog/cache/job/version tables switch to responsive cards below 1024 px, with two columns from 640–1023 px and one below 640 px (facts become one column on the narrowest cards). Cards retain the row's primary label (country, version or job type/status) and expose actions directly rather than hiding them in a hover-only menu. The public API error-reference table may scroll **inside its own wrapper** on a narrow screen; it must not create page-level horizontal scrolling. Buttons and inputs retain the shared 44 px minimum touch target.

**P5-UX-03 / P5-UX-07 evidence:** `responsive-layout.spec.ts` pins the table/card, tablet two-column, phone one-column, and contained public-table rules; `admin-layout.spec.ts` mounts the real shell at 390, 768, and 1440 px and checks drawer state. The existing catalog/cache/jobs/cached-version DOM tests cover the corresponding content. The historical screenshot review in `docs/evidence/p5-ux-07/` covers the original 15 screens at 390 × 844 and 1440 × 900 in every theme supported by the UI policy (40 captures total; the admin is intentionally dark-only). P6-OPS-04 adds S16 after that review; its screenshot and browser-level responsive/accessibility review are not yet recorded, and the old 40-capture result must not be read as covering S16.

## 9. Copy standards

- Sentence case everywhere; no ALL CAPS labels (except 11 px table headers with letter-spacing).
- Buttons are verbs: "Download", "Delete version", "Check for update", "Publish", "Run now".
- Errors: **what happened + what to do**, e.g. *"Not enough disk space. 1.2 GB needed, 400 MB free.
  Free space or raise the reserve in Settings."*
- Unknown states say so: *"Couldn't reach Geofabrik — retry in a moment."* If a request may have succeeded but its reply was lost, say the outcome is unconfirmed and tell the reader how to check before retrying.
- Translate status enums and error codes into human labels; machine codes do not appear in primary user-facing copy. Keep request IDs only as support references. Incomplete screens explain what is unavailable and where to go next without exposing internal screen/task IDs or route paths.
- Dates as `24 Oct 2026, 03:00 UTC`; sizes as `737 MB` with exact bytes in a tooltip.
- No exclamation marks, no "Oops", no jokes, no placeholder Lorem Ipsum in any state.

## 10. Rubric (target 50/50)

**Reviewed:** 2 Nov 2026 against the live Vite app, route/state tests, screenshot matrix and production-bundle performance evidence. The historical screenshot set is `docs/evidence/p5-ux-07/README.md` (40 PNGs plus `capture-diagnostics.json`); the P5-UX-08 LCP and bundle report is `docs/evidence/p5-ux-08/performance-report.md`. That review captured the then-existing 15 screens (S1–S15, including not-found) at 390 × 844 and 1440 × 900 in every theme each supported: auth and public screens in light and dark; admin in dark only, as required by §1/§3. P6-OPS-04 subsequently added S16 (outbound proxy), which is not in those captures. Its browser screenshot, rendered-overflow, and accessibility review remain open; the historical 49/50 P5 score is not a review score for S16. The historical captures use deterministic API fixtures and reduced motion; they recorded the intended theme, zero browser page/console errors, and no horizontal overflow for the screens they actually covered.

| # | Criterion | Score | Review basis |
|---|---|---:|---|
| 1 | Visual hierarchy | 5/5 | Each of S1–S15 has a clear page heading and ordered content/action hierarchy at both widths; reviewed examples include the operational dashboard (S5), schedule editor (S9), and import form (S10). |
| 2 | Consistency | 5/5 | The admin shell, public header, forms, cards, status treatments, spacing and labels remain consistent across the 15 screens; the active nav highlight was corrected during visual review. |
| 3 | Typography | 4/5 | Shared type roles and tabular data styling are consistent, with no clipped text in the final captures. Dense API reference material and data-heavy admin screens remain information-dense on mobile, so this is not a perfect score. |
| 4 | Color & contrast | 5/5 | Both shipped palettes are used in the supported theme matrix; token tests compute the documented WCAG ratios across palette pairs, and screenshot review found no unreadable active-state treatment after correction. |
| 5 | State coverage | 5/5 | The S1–S15 state audit (§12) and route-level regressions cover loading/pending, empty, failure/recovery and success where applicable; static documentation, forms, and deliberate placeholders are identified rather than mislabeled as data screens. |
| 6 | Feedback | 5/5 | Async progress, success/error feedback, rollback and confirmation behavior are covered by the interaction tests and reviewed in the live app; no dead-end action was found in the captured flows. |
| 7 | Accessibility | 5/5 | Existing axe audits report zero serious/critical violations; keyboard focus, skip navigation, labels, reduced motion and semantic status announcements are covered by automated and component tests. |
| 8 | Responsiveness | 5/5 | Every screen was reviewed at both required widths. Browser diagnostics confirm document width equals viewport width for all 40 captures; responsive card/table rules and 44 px target contracts are tested. |
| 9 | Performance perception | 5/5 | The production Vite bundle was measured in a cold mobile lab run with 4× CPU slowdown and 150 ms / 1.6 Mbps network shaping: public catalog LCP p75 1.136 s across five runs (maximum 1.272 s), below the 2.5 s target. The lab report records the mocked catalog and server-compression method; it does not claim field-user telemetry. Lazy routes and the first-load transfer budget are also enforced by `bun run check:web-budget`. |
| 10 | Trust & clarity | 5/5 | Reviewed data screens show freshness/timestamps, checksums and license attribution where applicable; errors and unfinished screens use actionable user-facing copy rather than internal codes or task IDs. |
|  | **Total** | **49/50** | **Gate passed:** ≥ 45/50 and no criterion below 3/5. |

**Gate:** ≥ 45/50 to close Phase 5; any criterion below 3/5 blocks the phase regardless of total. Evidence is linked above and indexed in `docs/evidence/p5-ux-07/README.md`.

## 11. What we deliberately avoid

| Anti-pattern | Why |
|---|---|
| Dashboard full of gauges and gradients | Noise; hides the numbers admins need |
| Emoji icons | Inconsistent across platforms, poor a11y |
| Cards inside cards inside cards | Visual debt, slow rendering |
| Auto-playing animations / parallax | Distracting, hurts performance and motion sensitivity |
| Hidden destructive actions in hover-only menus | Discoverability + safety |
| Hero sections on the public catalog | The data is the hero; keep it above the fold |
| Toast for everything | Users stop reading; reserve for async confirmations |
| Modal for a form that fits inline | Extra click, keyboard trap risk |

## 12. State coverage audit (P5-UX-01)

**Reviewed:** 31 Oct 2026 for the original S1–S15 routes. P6-OPS-04 adds the S16 row below from implementation and focused test evidence; it has not received browser screenshot/accessibility sign-off. “N/A” is reserved for static/form-only screens with no asynchronous page data; the form’s own validation, pending, failure, and completion paths are still checked. “Placeholder” means the route intentionally has no page data implementation yet and is not represented as a completed data-screen audit. Source paths and component tests below are the evidence; interaction-level tests do not replace later screenshot, responsive, or accessibility sign-off (P5-UX-03/04/07).

| Screen | Loading / pending | Empty | Error + recovery | Success | Evidence / sign-off |
|---|---|---|---|---|---|
| S1 Login | Submit disables the form and announces progress | Blank submit gives summary + field errors | Server/network refusal stays actionable; edit and submit again | Valid session continues to the intended route | `LoginPage.vue`; `login-page.spec.ts`. **Checked** |
| S2 Public catalog | Initial card skeleton; URL filter changes reload | Distinguishes no published maps from no filter matches; clear/retry actions | Actionable request error + retry | Public cards, metadata and filters render | `HomePage.vue`; `public-home-page.spec.ts`. **Checked** |
| S3 Country detail | Detail and version-history loading announcements | Defensive no-ready-version fallback (public contract normally hides such countries) | Detail failure offers retry or catalog return for not-found; history failure is isolated and retryable | Country, latest artifact and paginated history render | `CountryDetailPage.vue`; `public-country-detail.spec.ts`. **Checked** |
| S4 API documentation | N/A — static contract content | N/A — documentation is always populated | Clipboard failure gives manual-copy guidance; no API-data request to recover | Endpoints, examples and error reference render | `ApiDocsPage.vue`; `public-api-docs.spec.ts`. **Checked** |
| S5 Dashboard | Overview loading status and metrics sampling state | Zero counts remain honest; empty charts say “No data yet — sampling…” | Per-endpoint errors preserve good readings and offer refresh | Widgets and charts render validated data | `DashboardWidgets.vue`, `SystemMetricsPanel.vue`; dashboard status/metrics specs. **Checked** |
| S6 Catalog | Table/card skeleton | “No regions match” with filter reset | Request ID + retry; source/download failures remain local to the action | Searchable, sorted, paginated catalog | `CatalogPage.vue`; `catalog-page.spec.ts`. **Checked** |
| S7 Cache | Table/card skeleton | Distinguishes an empty cache from filters with no matches; links to catalog | Request id + retry; update/check errors stay inline | Cache rows and operational actions render | `CachePage.vue`; `cache-page.spec.ts`. **Checked** |
| S8 Cached-country detail | Summary/version skeleton | “No versions stored” fallback | Detail error + retry; download, publication and delete failures are scoped and recoverable | Summary, active work and version records render | `CacheCountryPage.vue`; `cache-country-page.spec.ts`. **Checked** |
| S9 Intervals | Two schedule-card skeletons beside an announced busy region | No schedules, no run history, and no country matches are distinct | List error has retry; country search, form, manual run and mutations have scoped errors | Schedule cards, previews and run history render | `IntervalsPage.vue`; `intervals-page.spec.ts` pins skeleton → error/retry → empty, plus success and run states. **Checked** |
| S10 Import | Country selector and upload progress expose pending states; submit is disabled while busy | Empty form explains the required file/country/version; empty country search has guidance | Field and preflight errors preserve input; uncertain upload acceptance directs the reader to check Jobs before retrying | Accepted job has a human-readable success state and job link | `ImportPage.vue`; `import-page.spec.ts` covers ambiguous upload replies and ready/failed replacement copy. **Checked** |
| S11 Jobs | Five desktop table-row skeletons or three mobile-card skeletons beside an announced busy region; refresh preserves prior rows | Filtered “No jobs match these filters” state | Initial error has retry; refresh error keeps last successful list | Paginated jobs, progress and drawer render | `JobsPage.vue`, `JobProgressDrawer.vue`; `jobs-page.spec.ts` pins both responsive skeleton structures. **Checked** |
| S12 System | Placeholder only | N/A until a system page exists | N/A until a system page exists | Dashboard already surfaces system status; direct page is not built | `PlaceholderPage.vue`, route owner `P5-MON-02`. **Deferred: route owner task delivered API only; page needs explicit ownership before claiming UX-3 coverage.** |
| S13 Settings | Loads safe API values; validated form and optimistic save | Not applicable: editable configuration form | Retryable load/save errors include request IDs; save failure rolls back the confirmed snapshot and retains the draft | Validated settings form, authoritative save response and success status | `SettingsPage.vue`, `settings-page.spec.ts`, `P5-ADM-02`. **Covered** |
| S14 Audit | Responsive table/card skeleton; URL-backed action/page changes load a validated API page | Distinguishes a genuinely empty log from a filter with no matches; clear-filter action | Initial failure has retry and request ID; stale-page refresh errors preserve the last successful page | Safe actor/action/target/time details, expandable metadata, page navigation and current-page CSV download | `AuditPage.vue`, `audit-page.spec.ts`, `P5-ADM-03/04`. **Covered** |
| S16 Outbound proxy | Loads current safe configuration; test/apply/remove announce pending state | No proxy configured means direct egress; health results appear only after a check | Load and operation failures are retryable and preserve request IDs; rejected drafts remain editable; failed post-apply checks stay visible while the configured proxy remains active | Current routing, five per-operation HTTP status/reason results, successful apply, and immediate remove-to-direct confirmation | `OutboundProxyPage.vue`, `outbound-proxy-page.spec.ts`, API/shared proxy tests, `P6-OPS-04`. **Interaction coverage; browser screenshot/a11y review pending** |
| S15 Not found | N/A — static route result | N/A | Clear 404 guidance and public-catalog action | N/A — not a data screen | `NotFoundPage.vue`; `not-found-page.spec.ts`. **Checked** |

**Audit result:** implemented data screens S2/S3/S5–S11 and S14 expose loading, empty, error/recovery, and success paths; S1 and static S4/S15 have appropriate form/static equivalents, S13 has a validated configuration form, and S16 has test/apply/remove interaction coverage. System remains the deferred direct-page placeholder: P5-MON-02 delivered its API but no System UI owner task is assigned. S16's browser screenshot, rendered-overflow, and accessibility sign-off remains pending.

**P5-UX-06 copy review:** reviewed visible route/component copy against §9. Job and interval states now use human labels, interval errors use safe mapped guidance rather than raw codes, and singular/plural country and job counts are grammatical. Import errors distinguish a rejected upload from an unconfirmed response and direct the reader to check Jobs before retrying; replacement prompts distinguish ready from failed prior versions. Login cooldowns use spelled-out durations, cancellation copy explains the wait and cleanup outcome, and request references consistently read “Request ID.” The incomplete System screen does not show internal task/screen IDs or route paths, and links back to the dashboard; Settings and Audit now render their task-owned pages. Focused regressions cover job labels/errors, interval outcomes, import retry/replacement copy, cooldown copy, unknown error-code fallback, and placeholder guidance.

## 13. Performance budgets and verification (P5-UX-08)

The public catalog is the first route for anonymous visitors. Its home page stays eager to avoid an extra route-chunk round trip before first paint; other screens, the admin shell, and the toast host are loaded only when needed. Route-owned CSS follows the same split. The public landing page does not fetch the Material Design Icons stylesheet/font; it is needed only by the lazy login page or a toast that actually appears.

| Measure | Budget | Enforced / measured as |
|---|---:|---|
| Public first-load JavaScript | ≤ 130 KiB gzip | Static import closure of the Vite `index.html` manifest entry, compressed at nginx's default gzip level 1 |
| Public first-load CSS | ≤ 15 KiB gzip | CSS reachable from that same static entry graph |
| Preloaded/display fonts | ≤ 24 KiB | Emitted WOFF/TTF/OTF bytes in the initial graph; the self-hosted Space Grotesk WOFF2 is 22.28 kB |
| Total first-load transfer | ≤ 165 KiB | Gzipped HTML + initial JS/CSS + already-compressed font assets; excludes API response data |
| Largest single async page JS chunk | ≤ 20 KiB gzip | Largest emitted JavaScript file among the entry's lazy imports |
| Public catalog LCP | p75 < 2.5 s | Five or more cold mobile lab navigations with a schema-valid small catalog fixture, 4× CPU slowdown, 150 ms RTT, 1.6 Mbps down / 768 Kbps up, and production compression |

`bun run check` builds the production web bundle and then runs `scripts/check-web-budget.ts`; that script reads Vite's emitted manifest, walks only static imports for first-load totals, uses the Ubuntu `gzip -1` utility to match nginx's default compression level, checks lazy route chunks, and fails on a budget breach. This keeps the budgets executable without adding a browser or measurement dependency to the application.

The recorded production-bundle lab measurement and exact methodology are in `docs/evidence/p5-ux-08/performance-report.md`. Lab LCP is a repeatable regression signal, not field telemetry: device CPU, browser version, proxy/CDN behavior, API latency and visitor geography can change real-user results. The report labels its fixture and local production-compression harness rather than claiming an end-user RUM measurement.
