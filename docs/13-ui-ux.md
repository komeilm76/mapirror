# 13 — UI/UX specification

**TL;DR** — dark admin / light public, two-font system with a pre-approved fallback, 14 screens + a not-found page, strict component and state rules, and a 10-criterion rubric (≥45/50 to close Phase 5).

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
| UI / body | **System stack** — `-apple-system, "Segoe UI", Roboto, sans-serif` | 14 px / 400, 16 px public body |
| Numeric (sizes, dates) | the UI face with `font-variant-numeric: tabular-nums` | — |
| Code / checksums | `ui-monospace, "JetBrains Mono", monospace` | 12–13 px |

**The budget rule was applied, not just written.** It said: both fonts are variable, subset to Latin, self-hosted woff2
with `font-display: swap`, preloaded only on the public landing page, and **if either adds > 40 kB total or hurts LCP,
fall back to the system stack** (D-14 permits dropping them at zero design cost). Measured on the Latin variable
subsets: **Inter 48 256 B**, **Space Grotesk 22 288 B**, together **70 544 B**. Inter alone exceeds the budget, so the
body falls back to the system stack — which on every platform this targets is a well-hinted, already-installed face,
i.e. the cheapest possible LCP — and Space Grotesk stays for display at 22 288 B, self-hosted from
`apps/web/src/assets/fonts/` with its OFL license beside it. `apps/web/tests/tokens.spec.ts` reads that file's size and
fails above 40 kB, so the exemption stays earned.

Preloading is still owed to `P3-WEB-01`: the rule is "only on the public landing page", and that page does not exist
yet. Until then `font-display: swap` means text paints in the fallback face first, which is the LCP-safe order anyway.

### Space, radius, elevation, motion

| Token | Value |
|---|---|
| Spacing scale | 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 |
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
│ Audit      │                                                          │
└────────────┴──────────────────────────────────────────────────────────┘
```

- Sidebar 248 px, collapsible; on `< 1024 px` it becomes a temporary drawer with a hamburger.
- A dot badge on **Jobs** shows running jobs; a counter on **Catalog** shows updates available.
- Topbar holds breadcrumbs, global search (catalog), theme toggle, user menu (logout).

### Public shell

- Header: wordmark, "Browse maps", "API", theme toggle. **Light is the default** on the public site;
  dark is fully supported and remembered per visitor (`usePreferredDark` → VueUse, overridable).
- Home: a compact intro (one line + license note), then **search + continent chips + country grid**.
- Country page: name + ISO flag, primary **Download** button, then a versions table, then the
  attribution/license block.

## 4. Screen inventory

| # | Route | Purpose | Key elements | Empty state |
|---|---|---|---|---|
| S1 | `/_auth/login` | Sign in | username, password, submit, error | — |
| S2 | `/_site/` | Public catalog | search, continent chips, country cards, license note | "No maps published yet" |
| S3 | `/_site/countries/:slug` | Country detail | Download, versions table, md5, size, updated | (always has a version if visible) |
| S4 | `/_site/api-docs` | API documentation | endpoint list, copyable curl, error codes | — |
| S5 | `/_site/admin/` | Dashboard | 4 stat cards, CPU/RAM/disk charts, updates, jobs | "No data yet — sampling…" |
| S6 | `/_site/admin/catalog` | Search Geofabrik | search, continent, cache filter, table with Download | "No country matches" |
| S7 | `/_site/admin/cache` | Cached countries | table: name, versions, size, public switch, update badge, actions | "Nothing cached yet — pick a country" |
| S8 | `/_site/admin/cache/:slug` | Country detail | versions table, public toggle, check update, active jobs | — |
| S9 | `/_site/admin/intervals` | Schedules | list + create button, next run, last status | "No intervals yet" |
| S10 | `/_site/admin/import` | Upload | dropzone, country select, version, submit, progress | — |
| S11 | `/_site/admin/jobs` | Job queue | filters, progress rows, cancel | "No jobs" |
| S12 | `/_site/admin/system` | Status | disk, counts, source freshness, orphan report | — |
| S13 | `/_site/admin/settings` | Settings | display name, retention, limits | — |
| S14 | `/_site/admin/audit` | Audit log | filter by action, paginated | "No entries" |
| S15 | `/_site/*` (unmatched) | Not found | friendly 404 + link home | — |

## 5. Component rules

| Component | Rules |
|---|---|
| **Cache table** | Sticky header; columns: Country · Versions · Size · Public · Update · Actions. Row hover reveals a subtle background; actions are icon buttons with tooltips + aria-labels. On `< 768 px` it becomes stacked cards. |
| **Public switch** | `v-switch` with an inline label + immediate optimistic update; on failure, revert + toast. Disabled with a tooltip when no ready version. |
| **Update badge** | Amber pill "Update available · 261024"; row action "Update" opens a confirm showing size delta and retention effect. |
| **Download button** | Present only when not cached (catalog) or for a specific uncached version. Destructive/disabled states explained by tooltip, never silently invisible without a reason on hover. |
| **Version table** | Version · Source date · Size · Checksum (truncated, copyable) · Status · Created · Actions (download, delete). "Latest" is a chip, not a separate row. |
| **Delete dialogs** | Country: type the slug to enable. Version: checkbox "I understand" + shows what will be deleted. Always state consequences (public access closes). |
| **Job progress** | Indeterminate → determinate bar, `12.3 MB/s · 35 s left`, phase label, cancel button. On failure: error code + human message + retry. |
| **Charts** | One y-axis, gridlines at 25 %, area fill at 12 % opacity, tooltip on hover showing exact values + time. Colors from the palette; never rely on color alone (label + value). |
| **Empty states** | Icon + one sentence + the next action as a button. Never a bare table with "No data". |
| **Error states** | What failed, why (if known), what to do. Retry button. Request id in small mono text for support. |
| **Toasts** | Bottom-right (admin), success 3 s, error persists with a close button; one toast at a time per action. |
| **Skeletons** | Match final layout (same heights) to avoid shift; no spinners for tables. |
| **Icons** | Material Design Icons only, 20/24 px, consistent stroke; **never emoji** as UI icons. **Not installed yet** (`P1-WEB-07`/`P5-UX-05` choose and add the set): the built CSS has no `.mdi` rule, so an icon name renders an empty `<i>` — an invisible control, or a gap where a glyph should be. Until then, controls that would wear an icon carry a visible text label ("Dismiss", "Show"/"Hide"), Vuetify's default icons are turned off (`:icon="false"`), and a `.mdi` element in the DOM is a **defect** — `tests/login-page.spec.ts` asserts its page renders none (pass 35). |

## 6. Interaction standards

- Every async action: disabled button → inline progress → success toast or inline error. No dead clicks.
- Optimistic updates only for the public switch and settings toggles, always with rollback.
- Destructive actions never auto-confirm; Enter does not trigger them by default.
- Tables sort client-side for < 200 rows, server-side beyond; sort state lives in the URL query.
- Search is debounced 300 ms; the URL reflects filters so a view can be bookmarked/shared.
- Forms validate on blur + on submit, show a summary if multiple fields fail, and never lose typed data.
- Keyboard: `Tab` order follows visual order; `Esc` closes dialogs/drawers; `/` focuses search in admin.
- Copy-to-clipboard always confirms with a checkmark for 1.5 s.

## 7. Accessibility

| Check | Requirement |
|---|---|
| Contrast | ≥ 4.5:1 body, ≥ 3:1 large text and meaningful boundaries — asserted, not sampled: `apps/web/tests/tokens.spec.ts` parses §2 and computes every ratio (25 pairs per theme, including the `on-` label colour Vuetify derives for each fill) |
| Focus | Visible ring on all interactive elements; skip-to-content link in admin |
| Semantics | One `h1` per page, landmark regions, labelled inputs, `aria-live` for toasts/progress |
| Motion | `prefers-reduced-motion` disables transitions and chart animation |
| Charts | Textual summary/table alternative for every chart ("CPU 12 % at 08:00 …") |
| Forms | Errors tied with `aria-describedby`; required fields marked in text, not color only |
| Targets | ≥ 44 px; switches have generous hit area |
| Zoom | Usable at 200 % zoom without horizontal scroll on 1280 px |
| Automated | `axe-core` run in component tests; zero serious violations |

## 8. Responsive rules

| Breakpoint | Behaviour |
|---|---|
| `< 640` | Single column; tables → cards; charts stack; sidebar becomes drawer; page actions move to a sticky bottom bar |
| `640–1024` | Two-column cards; table shows 5 most important columns |
| `1024–1440` | Full sidebar, full tables |
| `> 1440` | Content centered, max-width caps; charts gain their own row |

Admin tables on mobile use a "row → card" pattern with the primary metric as the card title and actions
in an overflow menu — never a horizontally scrolling table.

## 9. Copy standards

- Sentence case everywhere; no ALL CAPS labels (except 11 px table headers with letter-spacing).
- Buttons are verbs: "Download", "Delete version", "Check for update", "Publish", "Run now".
- Errors: **what happened + what to do**, e.g. *"Not enough disk space. 1.2 GB needed, 400 MB free.
  Free space or raise the reserve in Settings."*
- Unknown states say so: *"Couldn't reach Geofabrik — retry in a moment."*
- Dates as `24 Oct 2026, 03:00 UTC`; sizes as `737 MB` with exact bytes in a tooltip.
- No exclamation marks, no "Oops", no jokes, no placeholder Lorem Ipsum in any state.

## 10. Rubric (target 50/50)

Scored at the end of Phase 5 by reviewing screenshots (light + dark, 390 px + 1440 px) and the live app.

| # | Criterion | What earns 5/5 |
|---|---|---|
| 1 | Visual hierarchy | Clear title → action → content on every screen; one primary button |
| 2 | Consistency | Same components, spacing and labels across all 15 screens (incl. not-found) |
| 3 | Typography | Consistent scale, tabular numbers for data, no orphans/overflow |
| 4 | Color & contrast | Tokens only, AA everywhere, semantic colors used deliberately |
| 5 | State coverage | Loading/empty/error/success on every data screen, no dead ends |
| 6 | Feedback | Progress, toasts, optimistic updates with rollback, confirmations |
| 7 | Accessibility | Keyboard-complete, focus rings, aria, 0 axe violations, reduced motion |
| 8 | Responsiveness | Genuinely usable at 390 px; no horizontal scroll; 44 px targets |
| 9 | Performance perception | Skeletons, no layout shift, LCP < 2.5 s public, fast route transitions |
| 10 | Trust & clarity | Freshness/dates visible, checksums shown, license clear, errors actionable |

**Gate:** ≥ 45/50 to close Phase 5; any criterion below 3/5 blocks the phase regardless of total.
Evidence required: screenshot per screen per theme, rubric table filled in, `docs/13-ui-ux.md` updated
with the scores.

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
