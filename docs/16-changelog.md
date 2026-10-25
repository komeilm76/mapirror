# 16 — Documentation changelog

Review passes over the repository — documents first, then the code that implements them. Every entry
is a defect that was found and fixed, kept so a reviewer can see what changed and why.

**Totals:** 33 passes · 150 defects fixed · 0 open (pass 1: 20, pass 2: 18, pass 3: 16, pass 4: 4, pass 5: 4, pass 6: 10, pass 7: 8, pass 8: 6, pass 9: 6, pass 10: 2, pass 11: 1, pass 12: 1, pass 13: 3, pass 14: 3, pass 15: 2, pass 16: 3, pass 17: 2, pass 18: 2, pass 19: 3, pass 20: 3, pass 21: 2, pass 22: 2, pass 23: 2, pass 24: 1, pass 25: 1, pass 26: 2, pass 27: 2, pass 28: 2, pass 29: 2, pass 30: 2, pass 31: 4, pass 32: 4, pass 33: 7).
Scope of a pass: consistency with `PROMPT.md`, consistency between docs, and correctness of the
mechanisms described (SQL, state machines, HTTP semantics).

---

## Pass 33 — 2026-10-25 (borrowed colours, a latch on the wrong token, and a handler that could rewrite the verdict)

Three of these are values nobody in this repository chose: two colours Vuetify supplied and one `fetch` default. Two are
seams that did not line up — a predicate comparing the wrong string, and a latch watching a different token than the
request sends. One is a `catch` in the wrong place. The last is a number that had been wrong for seven passes. All
seven passed a green suite, because the suite was asking our own code questions. They were found by probing the running
app — reading `useTheme().themes` out of two mounted apps, calling the client's predicates with real URLs, throwing
from a callback — not by reading the source again.

| # | Bug | Fix |
|---|---|---|
| 1 | **Vuetify's Material palettes shipped *under* ours.** `createVuetify` deep-merges its own light and dark palettes beneath whatever `themeFrom()` returns, so every key the module did not name kept a colour from another design system — invisible to a source scan, because no file in `apps/web/src` contains it. Measured on the two shipped themes: `info` was `#2196F3` in **both**, *and* had no `on-info`, so Vuetify derived the label by APCA — the exact model `tokens.ts` exists to avoid; dark `surface-bright` was **`#ccbfd6`**, a lavender "bright surface" in a control room; `surface-light` was `#EEEEEE`/`#424242`; `on-surface-variant` in the light theme was `#EEEEEE` — near-white ink on a `#F6F7F9` card, **1.04:1**; `secondary-darken-1` was a Material teal (`#018786`/`#48A9A6`) while our `secondary` is indigo | The module now names all seven. The surfaces alias `surface-variant`, the ink aliases `text-primary`, `secondary-darken-1` aliases `secondary`, and `info` — a state §2 does not define — is an **alias of `secondary`** with `on-info = bestOn(secondary)`, rather than a fourteenth colour invented in code. `tokens.spec.ts` walks **every key of every shipped theme** and fails on any value outside §2 (white and black excepted: they are the computed labels), so the next Vuetify default cannot slip back in through a key nobody looked at. Mutation — deleting the alias block — fails 2 cases |
| 2 | **The neutral toast was painted in a colour the document does not define.** `ToastHost`'s `colorFor` answered `'info'` for the neutral kind. `13-ui-ux.md` §2 names thirteen colours and `info` is not one of them, so in practice the fill was Vuetify's blue (finding 1) — the one surface in the app that would have changed hue if Vuetify's defaults ever changed, and the only one §2 could not describe | Now `primary`. `surface-variant` was the other candidate and is 1.05:1 against the page in the light theme, i.e. no toast at all. The test asserts the class each kind renders — `bg-error`, `bg-success`, `bg-primary` — and asserts **`bg-info` is absent**, so re-introducing the undefined name fails. §2 now says the palette is closed and `info` is an alias, and `09-development.md`'s table has the row ("a state §2 does not name → the nearest documented key") |
| 3 | **`needsBearer('/_auth/api/login?next=/x')` was `true`.** The login exception compared the *raw* path with the login path, so the exact shape the router produces — a signed-out visitor sent to the form with `?redirect=…`, whose login then carries `?next=…` — did not match, and the request that **mints** a credential was sent with the stale one it was replacing. A revoked token would therefore be attached to the very call that would have issued a fresh one | `pathOnly()` strips the query and the fragment before classification, so the predicate answers about the endpoint, not about the URL's suffix. Two cases added (query string, fragment), and the Bearer matrix keeps its negative half — the public API still gets no header. Mutation — `pathOnly` → the raw path — fails 1 case |
| 4 | **The API client sent cookies, in a comment's own words it did not.** `api/client.ts` passed `credentials: 'same-origin'` under a comment promising no cookies. Behind nginx the SPA and the API are **one origin**, so `same-origin` means: attach every cookie on every admin call, and accept `set-cookie` from every answer. That is the ambient credential `14-security.md` §6 relies on not existing when it calls CSRF "not applicable" | `credentials: 'omit'`. The test asserts the request init the client actually passes, and `14-security.md` §3 (browser storage) now states the rule and why the default is wrong here. The client's JSDoc says the same, so the next reader does not "restore" the default |
| 5 | **The sign-out latch watched a token the requests do not use.** `createAppApiClient` wrote its "already signed out" latch to `sessionStorage` — while the token it sends comes from the injected `token` provider. Once `P1-WEB-05` backs that provider with the store, a `401` ends a session on screen that has not ended: the latch is set, so no further ending is reported, and the reader gets **no toast and no navigation** — every subsequent request just fails | The factory takes a `clearToken` option paired with `token`: the latch reads `readToken()` (whatever source the client sends from) and the clear goes through `forgetToken()`. Two cases — an injected provider and the `sessionStorage` default — each assert one toast, one navigation and an emptied source. Mutation — `readToken`/`forgetToken` back to the session store — fails both |
| 6 | **A throwing `onSessionExpired` was reported to the caller as `NETWORK`.** The policy call sat inside the same `try` as the fetch, so an exception from the handler was caught by the wrapper and relabelled: a request that answered `401 TOKEN_EXPIRED` arrived at the screen as *"the server could not be reached"*, with the API's code, message and request id gone. The screen would then advise checking the connection about a session that had expired — and the handler, being broken, had not signed anyone out | `notifySessionExpired()` runs the caller's policy **after** the error is already typed, and catches: a bug in a UI callback is reported to the console and nothing else. The test throws from the handler and asserts the caller still receives `TOKEN_EXPIRED`/`401` plus exactly one `console.error`; mutation — the bare call — fails it. The client clears nothing by itself: clearing and navigating belong to the policy in `api/index.ts`, so a throw there is the one failure the client cannot fix and must not conceal |
| 7 | **`00-index.md` advertised a tally seven passes out of date** — "25 passes, 125 defects fixed" against the changelog's 32 and 143. The index is the one page a reader sees before the record, so a stale number there is the record being wrong | The line is now generated by hand at the same time as the changelog's totals, and both say the same thing |

Probed and found sound rather than assumed:

- **A tab or newline smuggled into `redirect` is not an open redirect.** `safeRedirectTarget('/_site/admin/\t//evil.example')`
  keeps the tab and resolves to `https://mirror.example/_site/admin///evil.example` — the same origin, because the value
  is parsed as a path and `//` only becomes a host at the start of a URL. Probed with the real function; no fix, and the
  probe is recorded here so the next pass does not "fix" it into a bug.
- **A success toast does dismiss.** The error path's `timeout: null` (pass 32) is only the error path: under fake timers
  the success toast disappears after its documented 3 s. Two kinds, two policies, both measured.
- **`/_auth/api/login` with no header really is a fresh session.** With finding 3 fixed, the login request carries no
  credential *and* the response is still read as an envelope — the negative half of the bearer matrix, re-run.

## Pass 32 — 2026-10-25 (the API client: an invisible toast, a composable that failed open, and a key that exists nowhere)

Two of these are the kind that a green test suite hides: one made an error message vanish before it could be read, and one
turned the "you forgot to wire this" error into `undefined`.

| # | Bug | Fix |
|---|---|---|
| 1 | **An error toast was marked `timeout: 0`, which Vuetify reads as "dismiss on the next tick".** `13-ui-ux.md` §5 says errors persist with a close button, and `stores/notifications.ts` expressed that as `error: 0` — the obvious spelling, and the wrong one: `VSnackbar`'s `startTimeout()` schedules `setTimeout(…, Number(props.timeout))`, so `0` is *immediate* and only `-1` means "never". The toast therefore existed between the render and the timer: visible in a test that asserted immediately after mounting (which is how it passed its own review), invisible to a person. Caught by probing rather than by reading — five identical probe runs reported `snackbars=0` while a near-identical probe that logged sooner reported `1` | The store now models "until dismissed" as `null` and the host maps it to Vuetify's `-1`, with the framework's magic number kept in the component that uses the framework. The regression test waits **real time** after mounting before looking, and it fails when the `0` is restored (checked: 2 failures — this test and the store's own). 84 client tests now include it |
| 2 | **`useApi()` failed open.** It read `inject(API_CLIENT_KEY, null)` and threw when the result was `null`; Vue returns **`undefined`** for an unprovided key *and* when `inject()` is called outside a component. So the one case the composable exists for — an app assembled without a client — returned `undefined` to the caller, and the failure would have surfaced later as `Cannot read properties of undefined (reading 'get')` in a file nobody was editing | `inject(API_CLIENT_KEY)` with an `undefined` check, and both cases tested (outside a component, and inside an app that forgot `provideApiClient()`). Mutation — restoring the `null` shape — fails both |
| 3 | **`05-flows.md` F2 named a `sessionStorage` key that the code does not use.** The sequence diagram said `sessionStorage.setItem('mm.token')`; `auth/token-storage.ts` writes `mapirror.session.token`, and that name is the one `SESSION_TOKEN_KEY` exports and the tests assert. A reader following F2 would have cleared the wrong key and left the session alive | F2 now names the real key and says where it is defined, and the rules paragraph was extended with the two things the diagram could not carry: which requests get the header, and that `403 ACCOUNT_DISABLED` ends a session |
| 4 | **The documented sign-out rule missed a case that has the same consequence.** F2 said "`401` anywhere ⇒ clear state + redirect". `ACCOUNT_DISABLED` is a **`403`**: the account is deactivated, no retry of that token will ever work, and following the rule literally leaves a deactivated admin on an admin page full of `403`s with a token the app keeps presenting. `FORBIDDEN` shares the status and must *not* sign anyone out | `SESSION_ENDED_CODES` has four members — the three `401` verdicts plus `ACCOUNT_DISABLED` — and the doc says so and why (`05-flows.md` F2, `09-development.md` §9). Tests cover all four endings, the wrong-password non-case, the `FORBIDDEN` non-case, and an unreadable `401` from a proxy (which still ends the session, because the credential is still refused) |

Probed and found sound rather than assumed:

- **The timeout has to cover the body, not just the headers.** `fetch()` resolves when the headers arrive; a server that
  sends `200` and then stalls mid-body is the same outage to the reader as one that never answers. The budget is cleared
  in the `finally` of the whole read, and a mutation that aborts nothing makes the timeout test hang — killed.
- **A cancellation is not an outage.** A screen that navigates away aborts its requests; reporting that as "the server
  could not be reached" would put a false toast on the next page. `ABORTED` is its own code and it never reaches the toast.
- **`204 No Content` is success.** `POST /_auth/api/logout` answers with an empty body; a client that parses it throws,
  and a sign-out that throws is a sign-out nobody believes happened.
- **A query string can already be there.** Pagination and filters are usually added to a path that came with one
  (`?tab=versions`); a second `?` would produce a parameter literally named `?page`, which the server silently ignores.
- **The store's dedupe hides a real difference, so the burst test needed a second assertion.** Five identical refusals
  produce one toast *because the store merges identical sentences* — so the toast count alone cannot prove the sign-out
  handler ran once. The test now also counts `router.replace` calls, and a burst with two *different* refusal codes
  (whose details the store keeps apart) pins it from the other side. Mutating the latch away fails both.
- **Vuetify's overlay is a race in a full-suite run, not in isolation.** `v-snackbar` teleports into
  `.v-overlay-container` and only renders after a frame; a `flushPromises()` and an assertion passed alone and failed
  once among 900 other tests. The host tests poll with `vi.waitFor` instead of guessing a delay, and stayed green over
  repeated full runs.

Mutation-checked: 20 mutations, **all 20 killed** — the Bearer attached to every path (including `/login`), the public API
handed the token, a page path fetched as an API, sign-out fired without a credential, a cancellation reported as an
outage, the budget expiring without aborting, cookies included, a second `?`, `INVALID_CREDENTIALS` in the session-ended
set, an unreadable `401` no longer ending a session, the server's sentence replaced by a generic one, the redirect removed,
the destination dropped from it, the burst latch removed, the `0` timeout restored, the dedupe inverted, the burst cap
removed, `useApi()` failing open again, `bootstrap.ts` no longer providing the client, and the host mapping `0` instead of
`-1`.

---

## Pass 31 — 2026-10-25 (the router tree: a title that named itself twice, and a task board with two holes)

The pass arrived with `P1-WEB-03`, whose whole job is to make `13-ui-ux.md` §4 and the router the same list. Three of the
four defects below were found by writing the tests that claim it; the fourth by a test that had to be *rewritten* because
the world it described had stopped existing.

| # | Bug | Fix |
|---|---|---|
| 1 | **A route with no title put `MapMirror · MapMirror` in the tab.** `installRouteTitles` fell back with `pageTitle(title ?? TITLE_SUFFIX)` — the fallback was passed through the same formatter that appends the suffix, so the product name was appended to itself. Nothing reachable from `APP_ROUTES` has no title (the `RouteMeta` augmentation makes it a type error), which is exactly why it survived review: the branch is only reachable from an un-navigated router or a redirect-only record, and it was caught the first time a test executed it | `title === undefined ? TITLE_SUFFIX : pageTitle(title)`, with the reason in a comment and the branch pinned by `tests/titles.spec.ts` ("writes the fallback for a route with no title", plus the teardown case). Mutation — restoring `pageTitle(title ?? TITLE_SUFFIX)` — fails both |
| 2 | **Two screens had no task.** `13-ui-ux.md` §4 S13 (Settings) and S14 (Audit) were named as owners by nothing: `08-tasks.md` had no `P5-ADM-02` or `P5-ADM-04` row, so the two screens were in the router, in the screen inventory, and owed by nobody. The route meta had to invent the ids to fill its required `owner` field, and the new law test — which asserts that every owner id exists — failed on the first run. The board claimed **136** tasks, `08-tasks.md` held 136 rows, and §4 documented 15 rows of which 13 named an owning task that existed | Four rows added to Phase 5 — `P5-ADM-01`/`P5-ADM-02` (settings API + page) and `P5-ADM-03`/`P5-ADM-04` (audit API + page), because a page whose API is another task's is the same kind of hole — and the totals recounted: **140** tasks in `08-tasks.md` line 3 and `00-index.md` line 42, both verified by counting the status-bearing rows (140 rows, 31 done, no duplicate ids) |
| 3 | **Two tests asserted the world before the router existed.** `bootstrap.spec.ts` carried *"has no catch-all yet, and says so by not matching"* — true when `P1-WEB-01` registered one route, false the moment `P1-WEB-03` added `/_site/:pathMatch(.*)*`, and it would have failed with a message about `matched` being empty that reads like a router bug. Its neighbour, "keeps every route inside the site prefix", would have failed too, on `/_auth/login` — the one page L1 *allows* outside the site | Both rewritten to the contract that now holds: an unknown path under the site renders the not-found page **at the URL that was asked for**; a path outside the site is redirected *into* it; and every route outside `/_site/**` must be a redirect whose target is a page. The rewrite is the interesting part — a test that fails when a planned feature lands is a test that was written as a snapshot of the schedule |
| 4 | **`theme.spec.ts` was about to start testing the login page.** Six of its cases navigated to `/_site/admin/…` through `createAppRouter()` to read the admin theme off `theme.global.name`. Once the router grew its guard, every one of those navigations began landing on `/_auth/login` — a light page — so the cases failed with "expected `light` to be `dark`", a message that points at the palette. Worse in the other direction: had the assertion been written the loose way (`is a theme name`), the whole file would have gone on passing while testing nothing | Those cases now build a router from the real table **without** the guard — the theme is a function of the path, and auth is not this file's subject — and the mounted-app section gained the pairing case that matters: with a token in `sessionStorage`, a deep link to `/_site/admin/catalog` mounts `v-theme--dark` **and** renders screen S6. The two locks are now in two files, each testing its own rule, and the cross-file failure that revealed it is recorded here |

Probed and found sound rather than assumed:

- **`//_site/admin` cannot be a page path, so the `//` check in `safeRedirectTarget` is provably redundant.** The law
  refuses every value beginning `//` (it can never start with `/_site/` or equal `/_auth/login`), so removing the check
  changes no answer — the mutation is *equivalent*, not surviving. Both locks stay, and `tests/redirect.spec.ts` asserts
  the redundancy (`isPagePath('//_site/admin') === false`) rather than leaving a fantasy mutant in the report. The
  backslash check, by contrast, **is** load-bearing — `/_site/admin\..\..\evil` passes the law and fails the check —
  and that case was added after the mutation survived.
- **`/_site` without its slash is a page, because Vue Router says so.** `strict: false` matches it to the `/_site/`
  record, so `safeRedirectTarget` accepting it is correct rather than a hole; the test proves it by resolving it through
  a real router (name `home`) before asserting it survives, instead of writing the expectation I first assumed.
- **The `redirect` parameter is a query parameter, so it is `unknown`, not `string`.** Vue Router parses `?redirect=a&b`
  into an array and `?redirect[x]=y` into an object; `.startsWith` on either throws inside a navigation hook, which is a
  console error and no page. Four non-string cases pin the type check.
- **A blocked `sessionStorage` throws on the property, not on the call.** Driven through both shapes — the global itself
  throwing (privacy mode) and a store whose every method throws (frames) — and the sign-out path is asserted not to throw
  either, because it runs in the same click as a working clear.

Mutation-checked: 12 mutations, 11 killed (the twelfth equivalent, see above) — the admin check deleted from the guard,
`to.path` instead of `to.fullPath`, protocol-relative URLs allowed, the backslash check deleted, the login-page loop
allowed, the length bound widened to 2048, the default redirect moved to the catalog, the double-suffix title restored, a
page moved to an undocumented path, a blank token treated as a token, the read's `catch` removed, and the catch-all moved
outside the site.

---

## Pass 30 — 2026-10-25 (design tokens: a boundary that failed its own rule, and a shared URL)

The first defect is the kind this project exists to catch: a document that states a rule, a token that breaks it, and
no test between them.

| # | Bug | Fix |
|---|---|---|
| 1 | **The token the document named for "input borders" was 1.25:1 — the same document promised ≥ 3:1.** `13-ui-ux.md` §2 listed `border` as "Dividers, input borders" and, two lines later, required "≥ 3:1 for large text and UI borders". Measured: `#E3E6EA` on `#FFFFFF` is **1.25:1**, `#262B35` on `#0F1115` is **1.33:1**. So the palette and the rule disagreed, and the first login form or settings switch built on that token would have had a boundary a third of the required contrast — invisible at 200 % zoom, in bright light, to anyone with low vision. Neither is wrong on its own: a hairline divider *should* be 1.2:1, and WCAG 1.4.11 asks 3:1 only of boundaries "required to identify user interface components and states" | The token is split by meaning rather than by shade. `border` stays 1.2:1 and its documented use is now "Decorative division: table rows, section rules"; `border-strong` is new — **#7C848C** (3.79:1 on the page, 3.54:1 on a card) and **#6B7280** (3.91:1 / 3.60:1 dark) — and is the one for input outlines, switch tracks and focus-adjacent edges. The doc now says which is which and why, with the numbers, and `tests/tokens.spec.ts` asserts both halves: every meaningful boundary ≥ 3:1, and `border` *below* 3:1 **with** the sentence that exempts it — so a future edit cannot quietly promote the hairline to an input, or make the hairline heavy to satisfy a misread rule |
| 2 | **One test's navigation decided the next test's theme.** `createWebHistory()` reads `window.location`, and jsdom has exactly one — so a case that pushed `/_site/admin/catalog` left the following case's brand-new router starting there. Since the theme now follows the route, a fresh app mounted **dark** on the public home page, and the failing assertion ("expected `v-theme--light`") read like a bug in the theme policy. It is a harness defect with teeth: every later route test would inherit whatever URL ran before it | `apps/web/tests/setup.ts` resets the URL in `afterEach` (`history.replaceState({}, '', '/')`) beside the `matchMedia`/`ResizeObserver` stubs. Proved by mutation: deleting that one line fails `wears the light theme on the public page`, and nothing else |

Probed and found sound rather than assumed:

- **The `on-` label colours are ours, not Vuetify's.** Vuetify derives a missing `on-<color>` with `getForeground`, which
  decides by **APCA** against a 50-unit cutoff — not WCAG. Measured: it happens to pick black for the dark theme's
  pastels and white for the light theme's fills, so today's palette would pass either way; but the contract in §7 is
  4.5:1, so `themeFrom` computes every fill's label with `bestOn` and a test asserts the ratio for all six fills in both
  themes. Mutation (always white) fails the dark theme at 1.48:1.
- **The font budget was measured, not assumed.** The rule ("if either adds > 40 kB total … fall back to the system
  stack") needed a number: Inter's Latin variable subset is **48 256 B**, Space Grotesk's is **22 288 B**, together
  **70 544 B**. Inter alone breaks the budget, so the body uses the documented system stack and only the display face
  ships — 22 288 B, self-hosted with its OFL license beside it, `unicode-range` declared so a non-Latin page never
  fetches it. The test reads the file's size and fails above 40 kB, which keeps the exemption earned.
- **Vuetify's two "surface" keys are not the document's two.** `v-app` paints `background`; `v-card`, `v-menu` and
  `v-dialog` paint `surface`. Mapping our `surface` to Vuetify's would have made a menu the same colour as the page it
  opened over — invisible in the dark theme especially. The mapping is code (`background ← surface`,
  `surface ← surface-variant`) and a test asserts all three keys, so the comment cannot rot.
- **A hex scan, not a convention.** `P1-WEB-02`'s criterion is "no hardcoded hex in components"; the test walks every
  `.vue`, `.ts` and `.css` under `apps/web/src` and fails on any colour literal outside the token module and the two
  stylesheets. Mutation (a `style="color: #0F766E"` on one paragraph) fails with the file and line.
- **`/_site/administrators` is not `/_site/admin`.** The theme is chosen by path, so the segment boundary matters:
  `startsWith` would have painted a public page as the dark control room. Four cases pin it.

Mutation-checked: 10 mutations, all caught — a one-hex change in the code, a one-hex change in the document, an
always-white label colour, a boundary weakened to the hairline, a hexed component, an inverted admin/public mapping, a
deleted reduced-motion block, a spacing value changed from 8 to 10, the two surface keys swapped, and the URL reset
deleted.

---

## Pass 29 — 2026-10-25 (the SPA boots: two toolchain defects, both silent)

Both were found by mounting the app and looking at the DOM, not by reading the wiring — and both would have shipped as
"it works": a page that returns `200`, logs nothing, and renders nothing.

| # | Bug | Fix |
|---|---|---|
| 1 | **Vuetify registered no components, so the shell rendered empty.** The first boot produced `<v-app><v-main><!----></v-main></v-app>` — the literal elements, unresolved — with `[Vue warn] Failed to resolve component: v-app` in the console and an empty page underneath. Cause: Vuetify's **bundler** entry does not register components; it expects a build plugin to import the ones an SFC uses. `app.use(createVuetify())` therefore installed a framework with no components in it. A test asserting only "it mounts without throwing" would have passed | `vite-plugin-vuetify` with `autoImport: true`, registered in **both** `apps/web/vite.config.ts` (dev/build) and the root `vitest.config.ts` (tests). The Vitest half was needed for a second reason: Vuetify ships each component's `.css` beside it, and the externalised (node-resolved) copy failed with `TypeError: Unknown file extension ".css"` — `server.deps.inline: ['vuetify']` puts the package through Vite's pipeline. Re-probed: the shell renders `v-application`, the page's own text reaches the DOM, and the production build is 272 modules (292.95 kB JS / 99.20 kB gzip + 38.58 kB CSS) |
| 2 | **Every `.vue` import was an "error typed" value to ESLint.** `bun run lint` failed with `no-unsafe-assignment` / `no-unsafe-argument` on correct code — `src/bootstrap.ts` and `src/router/index.ts` — because ESLint's type-aware service uses plain `tsc`, which cannot open an SFC, and the web `typecheck` had just moved to `vue-tsc` (which can). The lint error was true about the toolchain and false about the code | `apps/web/src/shims-vue.d.ts` declares `*.vue` as `DefineComponent`. The obvious risk — a shim that *overrides* the real component type and silently discards prop checking — was tested for, not hoped against: a probe component with `defineProps<{ count: number }>` misused as `h(Counter, { count: 'x' })` still fails `vue-tsc` with `Type 'string' is not assignable to type 'number'` **with the shim present**, so `vue-tsc` resolves the real SFC and the shim serves only the plain-`tsc` consumers. Without the shim the same probe passes (measured both ways) |

Probed and found sound, rather than assumed, while wiring the boot:

- **HMR is a component swap, not a page reload.** A client on `ws://localhost:5173/` (`vite-hmr`) receives
  `{"type":"update","updates":[{"type":"js-update","path":"/src/pages/public/HomePage.vue",…}]}` when that template
  changes, and `{"type":"full-reload","triggeredBy":"…/plugins/pinia.ts"}` for a module with no HMR boundary — which is
  the correct answer for a module the app imports at boot. A first attempt appeared to show "no HMR at all": the edit
  had appended an HTML comment *outside* the SFC's blocks, so the Vue plugin had nothing to patch. The behaviour was
  right and the probe was wrong, which is why the probe now edits the template text.
- **The alias cannot resolve to two modules.** `@/bootstrap` and `../src/bootstrap` are asserted to be the *same*
  module object in `tests/bootstrap.spec.ts`, not merely to both work: two copies of the Pinia factory would look
  identical at that assertion level and break state isolation in a way only a user would notice.
- **`main.ts` is exercised, not inspected.** The test injects `<div id="app">`, imports the entry point, and asserts
  Vuetify's root wrapper and the page's text are in the document. A test that read the file's text would pass on a file
  whose only failing line was the mount call.
- **The dev server's `allowedHosts: true` is a documented trade, not an oversight.** Vite 6+ refuses unknown `Host`
  headers to blunt DNS rebinding, and a forwarded port has an unknown host; with `host: true` the server is reachable
  from other interfaces, so `09-development.md` §3 now says in as many words that it is a development tool. Production
  is nginx serving `dist/`.

---

## Pass 28 — 2026-10-25 (adversarial review of the whole auth surface)

Two defects, both **concurrency**, both invisible to a sequential test, and both found by running many requests at
once instead of reading the code again:

| # | Bug | Fix |
|---|---|---|
| 1 | **The login throttle could be bypassed by arriving simultaneously.** `check()` counted *recorded* failures, and a failure is only recorded when Argon2 has finished — so forty concurrent logins for one account all read the same empty counter, all passed, and each one paid a 64 MiB, 100 ms verify. Measured on the real route (`app.inject` ×40 through `Promise.all`): `401`×40 in 1 653 ms, **zero** `429`s, and the correct password still worked afterwards. A second identical burst was refused (`429`×40), which is what made the bug look fixed: the allowance was enforced *sequentially*, exactly the shape a password-spraying script avoids. The amplification is aimed at the endpoint the throttle exists to protect | `check()` now **reserves** a slot — one for the pair and one for the address — and the attempt settles it exactly once: `recordFailure` on bad credentials, `recordSuccess` after the token transaction commits, `release` for `403 ACCOUNT_DISABLED` (not a credential failure) and in a `finally` for anything that throws. Slots held by attempts still in progress count against the same limit, so the allowance is atomic inside the process. The refusal is a *different* verdict — `reason: 'in-flight'`, `retryAfterSeconds: 1` — not the fifteen-minute lockout, because the outstanding attempts may succeed. Re-probed: `401`×10 + `429`×30 in 440 ms, then `429`×40 for a second burst |
| 2 | **A password pasted as two lines lost the second one — and the prompt hung.** A terminal delivers a paste as **one** `data` event, newlines included, so the first prompt consumed the whole chunk and the repeat prompt waited for input that had already arrived. Measured in a real PTY (`python3 -c 'pty.fork()…'` against `bun run admin:init`, both lines written in a single `write`): the transcript ended at `Password: \r\nRepeat password: ` and the process had to be killed — no account, no error, an operator staring at a cursor. On a stream that then ends the same code throws `no input: the terminal closed before a line was read` (probed first, in memory) | The characters after the newline are kept in a `WeakMap` keyed by the stream and replayed into the next prompt before it listens, so one paste answers both. `\r\n` is treated as one terminator when the remainder is split off — otherwise the next prompt would start with a bare newline and answer itself with an empty string (caught by writing the test, not by the probe). The map is bounded at 512 characters and dies with the stream. Re-probed in the same PTY: exit `0`, transcript `Password: \r\nRepeat password: \r\nadmin 'admin' created (password from prompt)`, nothing echoed, and the `admins` row plus its `auth.admin_created` audit row confirmed in the database |

Probed and found sound, rather than assumed — the sweep this pass covered the repositories (`admins`,
`admin-tokens`, `audit-logs`), `modules/auth/routes.ts`, `app.ts`, `config/env.ts`, both operator scripts and
`scripts/lib/secret-prompt.ts`:

- **The lockout instant is the instant the lock lifts.** `details.lockedUntil` is the *oldest* failure plus the window,
  and the same window is what `check()` uses, so a client that sleeps to the stated instant is let in (`lockedUntil`)
  and one that retries a millisecond earlier is not. Confirmed with a moving clock against staggered failures, at
  `window−1 ms`, `window` and `window+1 ms`, and now pinned by a test. This was an open candidate from the previous
  pass; it is not a defect.
- **A crash cannot shrink the allowance.** With the throttle reserving, an attempt that dies mid-flight would leak a
  slot forever; the new test drops the `admins` table, runs twelve logins against a limit of ten, and asserts both that
  every attempt is refused and that the pair is still allowed and `inFlight` is `0` afterwards.
- **The double-logout refusal is reachable.** The existing `Promise.all` case usually answers `401` from
  `verifySession` (the second request already sees the committed revocation), so the "lost the race" branch — both
  verifications succeed, then the second `UPDATE` matches no row — was never executed. A `SELECT … FOR UPDATE` on the
  token row from another connection makes both logouts queue behind the gate, so the branch runs every time; five
  consecutive runs, and the mutation that removes the guard fails it.

Mutation-checked: 8 mutations, all caught — the reservation ignored, the reservation never taken, the settle in
`recordFailure` removed, the `finally` release removed, the CRLF split removed, the leftover dropped, the lockout
instant read from the newest failure instead of the oldest, and the logout race guard removed. New tests: 11 across
`login-throttle.spec.ts` (6), `integration/login-route.spec.ts` (1), `integration/login.spec.ts` (1),
`integration/me-logout.spec.ts` (1) and `scripts/tests/secret-prompt.spec.ts` (2). The repository is at **692 tests /
49 files**, coverage **97.6 %** statements. `04-api.md` §1 and `14-security.md` §3 now say a `429` has two meanings,
ADR-027 has the reservation row, and `08-tasks.md` records it against `P1-AUTH-03`.

---

## Pass 27 — 2026-10-25 (adversarial review of `P1-AUTH-07`)

Two defects this pass, and both are the kind that ship without ever failing: **a documented behaviour that no test
could lose.** The product code of this task behaved correctly under every probe — the transaction's three statements,
the revocation count, the per-account scope, the concurrent resets, the printed-once rule, a failed commit printing
nothing — so the findings are in the suite that is supposed to keep it that way.

| # | Bug | Fix |
|---|---|---|
| 1 | **Nothing tested that the reset script targets `ADMIN_USERNAME`.** The variable is documented (`09-development.md` §5) and the script reads it (`args.username ?? config.adminUsername`), but every case passed `--username` or relied on the default — which happens to be `admin`. A regression that hard-coded `'admin'` would have passed the whole suite and reset the wrong account in a deployment that renamed it: the operator's own account untouched, a password they do not control set on an account they may not look at. Found by asking, for each promised behaviour, "which test would fail if this were wrong?" | A case creates `owner` **and** `admin`, runs with `ADMIN_USERNAME=owner` and no flag, and asserts that `owner` has the new password and `admin` still has the old one. Mutation-checked: `args.username ?? 'admin'` fails exactly that test |
| 2 | **The same gap in `init-admin.ts`, from pass 26.** Its suite created `owner` only through `--username`, so `ADMIN_USERNAME` — the default an operator actually relies on in `docker compose` — was equally unpinned | A case sets `ADMIN_USERNAME=owner` with no flag and asserts the single row is `owner`. Mutation-checked the same way |

Three things were probed rather than assumed, and each changed something:

- **The generator's retry loop was unreachable and therefore unprovable.** With the real alphabet a 24-character draw
  cannot be on the 1 000-word blocklist or contain the username, so the `for` loop's exhaustion branch could not be
  executed by any test. The alphabet is now a documented option, and a degenerate one (`'a'`) with the username `'aaa'`
  drives all ten attempts and the throw. The same review added the policy's **upper** bound: a 300-character request now
  fails as a `RangeError` naming the bounds, instead of looping ten times and blaming randomness.
- **`--password-stdin` on a terminal is refused, before the database is opened.** A TTY on stdin means the "pipe" is a
  person typing, and the terminal echoes every character — the one case where a pipe is required. The check was
  originally inside the password step, i.e. after a connection and a lookup; it is now with the other "this run cannot
  succeed" checks, so the operator gets one sentence and no SQL.
- **A printed password is always an applied password.** The generated value is written to stdout only after the
  transaction returns, and a test forces the failure path (drop `audit_logs`) to assert that nothing is printed and the
  old password still works. The accepted cost is stated in the script's docstring: if stdout is lost *after* a
  successful commit, the password is lost with it and the reset must be run again — the alternative, printing before the
  commit, would hand an operator a credential that was never stored.

Mutation-checked: 19 mutations, all caught — revocation removed, the audit action swapped, `metadata.revokedTokens`
dropped, the "account vanished" branch re-thrown as a generic error, the missing-account guard removed, the `UPDATE`'s
`WHERE` removed (every admin would be reset), `withTransaction` replaced by a bare call, the generator's character pick
fixed to one character, its policy check removed, its upper bound removed, the print suppressed, the TTY refusal
removed, stdin not stripped, empty stdin accepted, the plural hard-coded, the two prompts not compared, and the two
`ADMIN_USERNAME` regressions above. `modules/auth/admin-accounts.ts` and `modules/auth/password.ts` are at 100 %
statements, branches, functions and lines; the repository is at 681 tests / 49 files, coverage 97.9 % statements.

---

## Pass 26 — 2026-10-25 (adversarial review of `P1-AUTH-06`)

Two defects, both found by running the code instead of reading it, and both in the category this project keeps
rediscovering: **the code said it was safe, and the machine disagreed.**

| # | Bug | Fix |
|---|---|---|
| 1 | **The concurrent-boot path crashed instead of reporting the account.** `ensureAdmin` caught the `23505` from the `lower(username)` unique index *inside* its transaction and re-read the row there to report it — the natural way to write it, and wrong: PostgreSQL marks a transaction aborted after the first failed statement, so the re-read failed with `current transaction is aborted, commands ignored until end of transaction block`, and two containers booting at once would have failed the second boot instead of logging "already exists". Nothing about the code reads as broken; only two live connections racing can show it | The catch moved **outside** `withTransaction`, so the re-read runs on the base connection after the rollback, and the outcome is `exists` with the winner's row. The test opens a second pool — a single handle serialises its own statements and can never reach the branch — and asserts a sorted `['created', 'exists']`, one admin row, one audit row, and one id either way. Re-probed: both orders pass, repeatedly |
| 2 | **The hidden password prompt echoed the first password typed.** `secret-prompt.ts` used `node:readline` with a discarding `Writable` as its output, so readline itself echoed nothing — and the *terminal* echoed everything, because under Bun the interface's `setRawMode(true)` lands before the TTY is initialised. Measured in a real PTY: the first prompt printed the password, the second and third were silent (once the terminal has been in raw mode, it stays controllable). The unit tests could not see it: an in-memory stream has no terminal driver to echo anything, which is exactly why they passed | The prompt reads the line itself — `setRawMode(true)` **before** the first read, `setEncoding('utf8')`, a loop over the characters — and restores raw mode in a `finally`, so Ctrl-C or Ctrl-D cannot leave a shell without line editing. It handles backspace, Ctrl-C (`cancelled`), Ctrl-D (finish, or `no input` when the line is empty) and drops CSI/SS3 escape sequences so a stray arrow key does not append `[A` to a secret the operator cannot retype. The suite pins the *mechanism* (`raw:on` → `read` → `raw:off`, in that order) and that nothing but the question and a newline is written; the end-to-end check was a PTY driving `bun run admin:init`, whose output is `Password: \r\nRepeat password: \r\nadmin 'admin' created (password from prompt)` with no keystrokes in it. The account and its `auth.admin_created` audit row were confirmed in the database afterwards |

Mutation-checked: 20 mutations, all caught — the audit insert disabled, the race not caught, the policy check removed,
the username not trimmed, the control-character test disabled, the injected clock dropped from the audit row, `exists`
reported as `created`, a foreign `23505` swallowed, `--username` ignored, the prompt-mismatch check disabled, the file's
trailing newline kept, `isTTY` read as truthy, raw mode never set, raw mode never restored, characters written to the
output, and Ctrl-C / backspace / escape-sequence handling removed. `modules/auth/admin-accounts.ts` is at 100 %
statements, branches, functions and lines; `scripts/lib/secret-prompt.ts` and `scripts/init-admin.ts` are covered by
their own suites. The repository is at 633 tests / 47 files, coverage 97.8 % statements.

One thing deliberately *not* fixed: line 203 of `admin-accounts.ts` (`if (raced === null) throw error`) was uncovered
until a test was written for it. The test raises `23505` from a `BEFORE INSERT` trigger — the only way to get the code
with no row behind it — and asserts the original error is re-thrown rather than reported as "already exists".

---

## Pass 25 — 2026-10-25 (adversarial review of `P1-AUTH-05`)

One defect, and it is the worst kind a security control can have: the guard was installed, it ran, it decided correctly,
and **its answer was thrown away**.

| # | Bug | Fix |
|---|---|---|
| 1 | **The Bearer guard's refusal never reached the client.** The hook used Fastify's callback style and did both things: `reply.send(401)` and then `done()`. In that style they are not alternatives — `done()` resumes the lifecycle, so the route handler ran, its reply won, and the guard's `401` was discarded with an `FST_ERR_REP_ALREADY_SENT` logged *after* a `200`/`503` had already gone out. Every `/_admin/api/*` request answered as if it were anonymous-friendly: measured before the fix, `GET /_admin/api/catalog` without a token answered `503 NOT_READY` and the stub's body. The L2 law was, for the length of one afternoon, a comment. Nothing in a *review* of the diff would have shown it: the code reads like a guard, and the only way to see it is to make a request | The hook is `async` and **throws**; there is no `done()` and no `reply.send()` in it. Returning from an async hook stops the chain, and throwing routes the refusal through the single error path — `toErrorEnvelope`, which is the same function that shapes a `500`, so the body, the `requestId` and the id header are the ones every other failure has. Re-probed: no token → `401 UNAUTHENTICATED`; a token the verifier rejects → the verdict's own code; a path with no route → `401` without a token and `404` with one. The regression test that would have caught it is not an assertion on the hook but the **route-table walk**: it calls every admin route the app registered and demands `401`, so a guard whose answer is discarded fails immediately |

Three things came out of the same review and changed the design rather than the notes:

- **The `500` policy had two copies.** The first version caught non-`AppError` failures from the verifier and rewrapped
  them as `INTERNAL_ERROR`. Mutating that away did not fail a test — because the error stage already maps *any* unknown
  error to `INTERNAL_ERROR` with a fixed sentence. The try/catch was therefore deleted rather than tested: one place
  decides what a `500` says, and the guard throws whatever the verifier rejected with. The test that asserts a driver
  message and a port number never appear in the body stayed, and it now pins the error stage's behaviour instead of a
  duplicate of it.
- **The L2 test had to grow with the app.** A hand-written list of admin routes is a list that goes stale exactly when
  it matters — the next route someone adds. The test now collects the routes from `onRoute` during `boot` (through a
  tests-only `routeObserver` seam on `buildApp`, the same pattern as `slots`/`database`) and calls every one of them,
  with and without a token. It also asserts the list is non-empty, because a guard test that checks nothing passes
  silently.
- **`/_admin/api` itself is admin.** Adding the bare prefix to the walk made the fail-closed behaviour explicit: no
  token → `401`, token → `404`. The refusal comes from `onRequest`, which runs before routing, so an anonymous caller
  cannot map the admin surface by watching which paths answer `401` and which `404`.

Mutation-checked: 7 mutations, all caught — the scope test removed, the scope test inverted, the missing-token throw
removed, the missing-token code swapped for `TOKEN_EXPIRED`, the verifier given a truncated token, and the pipeline slot
emptied. `plugins/auth-guard.ts` is at 100 % statements, branches, functions and lines; the suite is 580 tests.

---

## Pass 24 — 2026-10-25 (adversarial review of `P1-AUTH-04`)

One defect, found by probing a race rather than by reading: two requests, one session, and an audit trail that said the
session had ended twice.

| # | Bug | Fix |
|---|---|---|
| 1 | **Concurrent logouts both answered `204` and wrote two `auth.logout` rows for one session.** The handler verified the token, then revoked it, then audited — and the verification says nothing about what happens *after* it. Two logouts arriving together both verify as valid (neither has committed), the first revocation wins, the second updates zero rows, and the handler ignored that result: `204` twice, two audit rows, one session. An audit trail that reports a session ending twice is worse than no audit trail, because the second row is indistinguishable from a real second session. Probed with `Promise.all` on one token before the fix: `204 204`, 2 rows | The **revocation decides the answer**: `revokeToken` returns `false` when `revoked_at` is already set (its `UPDATE … WHERE revoked_at IS NULL` is the atomic arbiter), and that `false` is now thrown as `401 TOKEN_REVOKED` inside the transaction, so nothing is audited. Re-probed: `204 401`, 1 row. The new test asserts the sorted status pair and the single row, which is deterministic whichever request wins — the loser either sees the revocation at verification time or loses the update, and both paths answer the same code |

Three smaller outcomes of the same review, all of which changed code:

- **`readBearerToken` had a condition no input could reach.** After `trim()` and a split on runs of whitespace, a
  malformed header yields `undefined`, never `''` — so `value.length === 0` was a branch no test could cover. Removed,
  with the reasoning in the comment: this is the fifth time in this project that "it looks defensive" turned out to mean
  "it cannot happen", and each time the cost was a coverage gap that hid nothing.
- **The credential is never normalised.** A test asserts `ReadBearerToken` returns the token verbatim; trimming or
  lower-casing it would hash to a digest no row holds, i.e. a `401` for a perfectly good token. The mutation that adds
  `.trim()` is therefore **equivalent** — no input can carry whitespace inside a single credential once the header is
  split — and is recorded here rather than chased with a contrived test.
- **`/me`'s `lastUsedAt` fallback is reachable only under a race** (two first-ever requests: both read `null`, one wins
  the write, the loser reports `null`). It stays, because the value is the honest answer for that request, and it is the
  one branch in the module no test can pin deterministically; the mutation that replaces `?? null` with a fabricated
  instant is therefore not caught, and the coverage gap is stated here instead of being papered over.

Also confirmed by probe and left alone (no change needed): a `401` from `/me` carries `cache-control: no-store` (the
hook is on the namespace, not the handler); a 20 KB `Authorization` header answers `401` rather than `500`; a Unicode
credential is refused without a query; and 300 unauthenticated `/me` requests take ~210 ms end to end in-process — one
indexed digest lookup each, so the route needs no limiter of its own.

---

## Pass 23 — 2026-10-25 (adversarial review of `P1-AUTH-03`, with a measuring tape)

Two defects. The first is the more interesting kind: a fix from an earlier pass that was **confidently wrong**, whose
own tests encoded the wrong belief, so the suite stayed green while the code was stricter than the contract. It was
found by measuring a library instead of assuming what it does.

| # | Bug | Fix |
|---|---|---|
| 1 | **The password ceiling was counted in a unit Zod does not use, so the policy refused passwords the login endpoint accepts.** Pass 20 "fixed" this by changing the ceiling to `password.length` — UTF-16 code units — on the stated grounds that Zod's `.max()` counts units. Measured in this pass: Zod 4 counts **code points**. `'😀'.repeat(200)` is 400 units and 200 code points, and `.max(256)` **accepts** it, while the policy refused it: a person creating a passphrase in emoji (or any astral-plane script) was told it was too long, by a message that counted 400 for something the login form would take. The pass-20 tests asserted the wrong direction and so passed. The other direction of the same confusion was live too: counting the NFKC form would accept 150 × `e` + combining accent (300 code points as sent, 150 normalised) that login then refuses | The ceiling counts **code points of the submitted string** — both halves matter: the unit Zod uses, and the raw value rather than the normalised one. The floor keeps counting the normalised form, which only ever shortens, so it cannot be stricter than the submitted form. Three tests now hold it: the emoji case (policy must **accept** what login accepts), the decomposed case (policy must **refuse** what login refuses), and a property test over seven awkward strings asserting the invariant "anything creation accepts, login accepts" — the test that would have failed in pass 20, since it does not care which unit the mistake is written in. The code comment, `PASSWORD_POLICY`, ADR-025, `14-security.md`, `08-tasks.md`, `09-development.md` and the shared module's JSDoc all said "UTF-16 units" and were corrected; the pass-20 entry below keeps its text and gains a pointer, because rewriting history would hide how the mistake survived a pass |
| 2 | **`04-api.md` did not document the two headers the login route sets.** `cache-control: no-store` (on every answer in the namespace) and the `Retry-After` header on a `429` existed in code and appeared in no document — `14-security.md` §3 said the response "includes" `Retry-After` without saying it is a header, and `04-api.md` §1 listed only the body. A client reading the contract would implement body parsing only and retry immediately | `04-api.md` §1 now states both: a `Headers:` line for `no-store` (and never a `set-cookie`), and `429` with `details.lockedUntil` + `details.retryAfterSeconds` **plus** a matching `Retry-After` header, "whole seconds, ≥ 1; no other answer carries that header". A doc test in `apps/api/tests/auth-contract.spec.ts` now parses the bounds sentence, the response fields, the `29`/`Retry-After`/`retryAfterSeconds`/`no-store` mentions and the stub table out of `04-api.md`, so the next divergence fails the gate rather than a client |

Two further changes came out of the same review, and both removed code rather than adding it:

- `#lockout` ended in `failures[0] ?? now` — a fallback no call could reach, and one that would have invented a
  lockout expiring a window from *now* if it ever had. Replaced by a `nonEmpty()` narrowing helper and a `Failures`
  tuple type, so "a limit is never met by an empty counter" is a type-level fact. That change also made the
  `perIpLimit > 0` guard in `check` redundant (an empty counter now reads as `null`, not as `0 >= 0`, which is how the
  pass-23 lockout-everything bug happened), and the guard was removed rather than kept as unreachable code.
- The throttle was **optional** all the way down (`RouteOptions`, `AuthRouteOptions`, `PipelineContext`), each layer
  able to build its own from the config. Two counters in one process multiply every limit while looking correct. It is
  now required, built once in `app.ts` through one `loginThrottleFromConfig()`, and a test drives a `429` through the
  HTTP route with no test-injected throttle at all — the config-built counter is the one that answers.

Mutation-checked: 23 mutations of the new code each fail at least one test (the `no-store` header, the
`Retry-After` value and the `RATE_LIMITED` branch, the request-schema parse, the dummy-hash verify, the `is_active`
ordering, the audit target and metadata, both throttle comparisons, the window filter, the IP-counter reset on success,
the prune boundary, the minutes→milliseconds conversion, the ceiling's unit and its source string, and four bounds in
`shared`). One mutant was behaviour-equivalent and is recorded as such: changing the capacity early-return from `<=` to
`<` performs the same work one iteration earlier — the *prune* boundary, which is not equivalent, has its own test. The
auth module is at 100 % statements, branches, functions and lines; the suite is 520 tests.

## Pass 22 — 2026-10-25 (adversarial review of the working tree after `P1-AUTH-02`)

Two defects, and both are the kind that a passing test suite cannot show: a code path that was only reached by *not*
having a lock, and a value whose type lies about its trustworthiness. Neither was found by reading; both were found by
reproducing the thing the code assumes cannot happen.

| # | Bug | Fix |
|---|---|---|
| 1 | **Boot-time housekeeping could stop the API from ever listening.** Pass 21 added token pruning and called it from `start()` **before** `listen()`, unbounded. A `DELETE` waits for a row lock, and nothing in the path said otherwise — so one long-lived transaction holding any expired token row kept the process in boot: it had run the schema check, it held its port mapping, and it answered nothing. Reproduced with a real process and a real lock (`begin; select … for update; pg_sleep(30)`): `healthz` returned `000` after 8 s of a 20 s budget, and the log stopped at `database schema matches this build`. Docker would see a container that is up and unhealthy, restart it, and hit the same lock again — a restart loop whose cause is a transaction somewhere else entirely | Two changes, both asserted. The prune now runs through `lib/housekeeping.ts` with `statementTimeoutMs` (via the existing `withTransaction`), so a contended statement is **abandoned** rather than waited on, and it is called **after** `listen` and not awaited — housekeeping is optional work, so nothing a client asks for may wait for it. `runHousekeeping` returns `number \| null`, because "nothing to do" and "we gave up" are different answers and a caller that saw only `0` could not tell them apart. Re-probed with the lock still held: `healthz` 200 within six seconds, `readyz` `{\"status\":\"ok\"}`, a `statement timeout` warning, and the row still present; re-run after the lock released → `{\"pruned\":1}` and the table empty. Dropping the `statementTimeoutMs` option makes the new lock test fail |
| 2 | **`request.ip` was trusted as a fact, and it is a header.** `lib/client-ip` did not exist; `issueToken` wrote `options.ip` straight into an `inet` column. With `trustProxy` on — which this API needs — `request.ip` is whatever the trusted peer forwarded, and `proxy-addr` validates nothing: measured, `X-Forwarded-For: not-an-ip` arrives as the string `not-an-ip`, and so does `<script>`. Postgres refuses those with `22P02`, so `POST /_auth/api/login` answered **`500`** to any request carrying a junk header — an unauthenticated, one-line way to make the login endpoint error. The same value is a rate-limiting key, where a fresh junk string per request is a fresh bucket per request, i.e. no limit at all. And it was not only hostile input: `203.0.113.9:8080`, a form real proxies emit, threw too | `lib/client-ip.ts` parses instead of trusting: a bare IPv4/IPv6 literal is kept, a port is stripped (`203.0.113.9:8080` and `[2001:db8::1]:443` yield the address), and anything else — a hostname, a chain, a payload, an empty string, an over-long value — becomes `null`, which the schema already allows. Losing an address is a diagnostics loss; storing it was a `500` and a bypass. Wired into `issueToken`, with a 27-case table plus an integration case proving a junk address is *stored as null* rather than thrown. Probed before the fix (`22P02` for `not-an-ip`, `<script>` and `203.0.113.9:8080`) and after (all three stored as `null`, addresses kept without the port) |

Two smaller things came out of the same probes and are worth recording because they changed the code rather than just
the notes:

- The first draft of `normaliseIp` used a capture group per form, which needs a `?? ''` fallback for the type checker —
  a branch no input can reach, and coverage said so (85% branches with every case in the table passing). Rewritten with
  `indexOf`/`slice`; the missing cases (half-open bracket, bracket without a port, a non-numeric port, a hostname with a
  port) were added to the table, and the module is now 100% lines and branches. This is the fourth time in this project
  that "the table passes" and "every branch is exercised" turned out to be different statements.
- `housekeeping` was only ever called by tests that passed an explicit clock, so the `now` default — the one production
  uses — was dead in the suite. A test now calls it exactly as `start()` does, with no options at all.

---

## Pass 21 — 2026-10-25 (adversarial review of `P1-AUTH-02`)

Two defects, and neither is a line of wrong logic. One is a document claiming a mechanism the code does not have; the
other is a documented behaviour that no task owned, written down as if it existed.

| # | Bug | Fix |
|---|---|---|
| 1 | **"Constant-time compare" described a mechanism that is not in the design — and should not be.** The task list and `14-security.md` §3 both said token verification uses a constant-time comparison. It does not, and adding one would be ceremony: verification hashes the presented token and lets the unique index on `token_hash` find the row, so there is no secret in application memory to compare *against*. A `timingSafeEqual` there would compare the same 32 bytes the database has just matched, and a reviewer reading the code against the doc would have concluded something was missing | The doc now states the mechanism that exists — "verified by an indexed probe on the digest, so no secret is ever compared in application code" — and ADR-004 carries the reasoning. The property the phrase was reaching for is now *tested* instead of asserted: the digest is the only lookup key, proved by inserting a row whose `token_prefix` equals a known token's prefix while its digest belongs to a different string, and requiring that token not to authenticate. That test is the one that fails if someone later "optimises" verification to look up by prefix |
| 2 | **Boot-time pruning was documented and owned by nobody.** `03-data-model.md` §2.2 says "startup housekeeping deletes rows expired > 30 days ago", and there is no task in `08-tasks.md` that mentions pruning. Written down as a behaviour, absent from the plan, absent from the code: the token table would have grown forever while the docs said otherwise | `pruneExpiredTokens` is part of the token service (`P1-AUTH-02`, which owns the lifecycle) and is called once at boot from `server.ts`, after the pipeline proved the database usable and before the socket opens. **Probed with a real process**, because a stub would only prove that a stub can be called: a database seeded with a 40-day-expired row and a 5-day-expired one, then `bun run apps/api/src/server.ts` → log shows `{"pruned":1}` and `expired tokens pruned`, `healthz` 200, and the 40-day row is gone while the 5-day one survives. A failure there is logged and does not stop the boot — an old row is not a reason to refuse traffic |

Also worth recording, because it shaped the tests rather than the code:

- The `last_used_at` throttle is written **into the `WHERE` clause** (`last_used_at IS NULL OR last_used_at < now -
  60 s`) rather than read-compare-write. Two requests arriving together cannot both decide the write is due, and the
  verdict then has to report what the row *holds* instead of what the request pretended to record — otherwise `/me`
  would claim a `lastUsedAt` that no row has.
- The cheap rejection had to be observable to be testable: the "malformed token never reaches the database" tests pass
  an executor wrapped in a `Proxy` that throws on any property access. Without that, "does not touch the database" is
  a comment, not an assertion.

---

## Pass 20 — 2026-10-25 (adversarial review of `P1-AUTH-01`)

Three defects. The first is the interesting kind: it passes every test written for the feature, passes review, and
fails only on the second login.

| # | Bug | Fix |
|---|---|---|
| 1 | *(Corrected in pass 23 — the fix below picked the wrong unit and made the policy stricter than the login schema. See pass 23, defect 1.)* **The password ceiling was counted in the wrong unit, so an account could be created and never used.** The policy rejected passwords longer than 256 *characters*, and the login schema rejects bodies where the password is longer than 256 *UTF-16 code units* (Zod's `.max()` on a string). The two agree for ASCII and disagree exactly where a user is likely to notice: measured, `'😀'.repeat(200)` is 200 characters and 400 units — accepted by the policy, refused by login, forever, with a `422` that says the request is invalid. The same hole in the other direction: a decomposed string of 300 units normalises (NFKC) to 150 characters, so the *normalised* count would have passed it too. Probing before the fix: `passwordProblems(decomposed)` → `[]` while the login schema refuses it | The ceiling now measures `password.length` — the same unit, on the same string, that the login schema measures — while the floor keeps counting characters (code points of the NFKC form), because that is the unit the policy is expressed in. Both units are named in `PASSWORD_POLICY`, in ADR-025 and in `14-security.md`. Two tests pin the two shapes that fell through (200 emoji, 300 decomposed units), and reverting to the character comparison fails one of them. A doc test also parses the `1–256` limit out of `04-api.md` and compares it to the constant, so the pair cannot drift again |
| 2 | **The security doc advertised a weaker hash than the code builds.** `14-security.md` §3 said "memory 64 MB" while `ARGON2_PARAMS.memoryCost` is `65_536` KiB, i.e. 64 **MiB** — 67.1 MB. Reading the doc, an operator would have sized the container's memory for a hash 5% smaller than the real one; reading it as the source of truth, a reviewer checking "does the code match the docs?" would have found a discrepancy and had to guess which side was wrong | The doc says MiB. More importantly, three tests now **parse** the numbers out of `14-security.md` and `04-api.md` (hash memory, iterations, parallelism, minimum length, blocklist size, login ceiling) and compare them to the code's constants, so a mismatch is a red test rather than a footnote nobody reads. That is the same technique the migrator and schema tasks used for the SQL, applied to the one table whose numbers are security claims |

| 3 | **The username substring rule compared bytes while the password was normalised.** The password is NFKC-normalised before matching — that is the decision that makes a macOS-typed `café` work on Linux — but the username was only trimmed and lower-cased. A username containing an accent (`José`, typed decomposed) therefore never matched a composed password that contains it, so the rule silently did nothing for exactly the accounts whose names are hardest to type | Both sides go through the same normalisation, and a test pins the case: `José-let-me-in-9` against the decomposed username must be rejected. Reverting the fix fails that test |

Also recorded while probing the addon, because each changed a decision rather than just informing one:

- `verify` **throws** (`Error: Decoding failed`) for anything that is not a PHC string — measured on `''`, on a
  truncated hash and on a bcrypt hash. A corrupt row would therefore have answered `500` where the contract
  says `401`, so verification catches and answers `false`.
- The addon runs on the libuv thread pool, not the event loop: four concurrent 64 MiB hashes finished in 131 ms
  with a maximum event-loop gap of 11 ms. That is what makes "hash on the request path, throttled" acceptable
  instead of needing a queue.
- Only **9** of the 1 000 blocklist entries reach a 12-character floor on their own — the measurement that
  turned "exact match" into "match the stem left after trailing digits and symbols", and that made the docs
  state plainly that the list is a floor, not a guarantee.

---

## Pass 19 — 2026-10-25 (adversarial review of `P1-DB-04`)

Three defects: two in the mechanism (found by asking what each check would *not* catch, then by trying to kill the
tests that were supposed to catch them), one in the way a boot-time query reaches the tests.

| # | Bug | Fix |
|---|---|---|
| 1 | **The obvious check would have passed an empty image.** Comparing the migration files on disk against the `kysely_migration` rows — the two things a boot check naturally has — reports "in sync" for a database with no rows and a directory with no files. That is exactly what a truncated image or a bad build context produces, and it would have booted happily against a schema missing every table, then failed at the first request. The same two-way comparison also cannot see a database migrated by a **newer** image: the extra row is simply not among the files | Three sources instead of two: on-disk files, the `EXPECTED_MIGRATIONS` constant compiled into the build, and the rows. Files ≠ constant → refuse; rows ⊄ constant → refuse **without** migrating; rows behind → migrate only when `MIGRATE_ON_BOOT`. The constant is pinned to the directory by a test, so forgetting to register a new migration fails `bun run check` rather than producing a boot check that quietly trusts whatever is there |
| 2 | **The report described the database it found, not the one it left.** After migrating, `checkSchemaVersion` re-read the bookkeeping into `pending` and threw if anything still showed as pending — a branch that cannot be taken, because `migrateToLatest` throws on failure and only returns what it recorded. It cost the coverage gate a permanently unreachable line (97.3%, line ~191), and worse, the report it returned was the *pre-migration* one merged with nothing: `applied` still listed only what existed before this run, so the log line that is supposed to prove the boot migrated the database proved the opposite | The re-read is gone; the report merges this run's own `applied` list and reports `pending: []`, which is true by construction. Probed the honest way: replacing the merge with `[...before.applied]` and running the targeted suites **passed 17/17** — the merge was untested. Assertions on `report.applied` added to both migrating cases (empty database → `EXPECTED_MIGRATIONS`; one pending → `['0001_init', '0002_catalog']`); the same mutant now fails 2 tests. `version-check.ts` is at 100% lines/branches with no unreachable code left |
| 3 | **A boot-time query silently broke every test that supplies a stub handle.** Adding the check to the `db` stage turned six `db-stage` specs red with `TypeError: executorProvider.getExecutor is not a function` — the stage was now querying a handle that is only a shape. The tempting repair is to detect the stub and skip the check, which makes the production path conditional on a test artifact | An explicit injectable seam: `PipelineContext.schemaCheck` and `BuildAppOptions.schemaCheck`, defaulted to the real `checkSchemaVersion` in `plugins/db.ts` and to an in-sync stub in `tests/helpers/test-app.ts`. Specs that assert boot ordering keep passing a spy; specs that do not care get the default. The production path — ping, then check, then listen — stays unconditional, and the two new stage tests (the check runs once *after* the ping; skew closes the handle and rethrows) are the ones that prove it |

Also recorded because it changed the shape of the code: `MIGRATE_ON_BOOT` defaults to **true** for a bare
`docker run`, while compose sets it to `false` because the entrypoint migrates. Both behaviours are pinned by
real-process probes rather than mocks: default + empty database migrates and exits 0 on `SIGTERM`;
`MIGRATE_ON_BOOT=false` + empty database logs `SCHEMA_SKEW`, applies nothing, and exits 1.

---

## Pass 18 — 2026-10-25 (adversarial review of `P1-DB-03`)

Two defects, both found by probing the mechanisms the transaction helper was about to rely on rather than by writing
the helper first. One of them was not a defect in the new code at all.

| # | Bug | Fix |
|---|---|---|
| 1 | **A database failover killed the API.** Passes 14 and 16 both reasoned about "a lost connection" and both tested it the same way: kill an **idle** backend, watch the pool recover, watch a `warn` line appear. But `pg-pool` keeps its `error` listener on a client only while that client sits idle in the pool and **removes it on checkout** (`pg-pool/index.js`: `_acquireClient` → `removeListener('error', idleListener)`). So a connection lost while serving a query or holding a transaction emitted `error` on an emitter with no listener, and Node's answer to that is to throw: measured, `pg_terminate_backend` during a `BEGIN … pg_sleep` produced *both* a clean rejection of the transaction *and* an uncaught exception, i.e. `process.exit` in production. A failover, a restart, or an admin ending a session would have taken the API down — the exact failure pass 14 set out to prevent, through the channel it did not cover | One `error` listener per client, attached on the pool's `connect` event, so it covers checked-out clients too; the pool-level listener stays as a swallow so the same error is reported once instead of twice. Probed before and after: before, `uncaught errors: 2`; after, `uncaught errors: 0`, one report, pool still usable. The test now collects `uncaughtException` explicitly and asserts the collection is empty, rather than trusting the runner to notice — with the listener removed it fails on that assertion (`expected [ …(1) ] to deeply equal []`) |
| 2 | **The idle bound was asserted from the wrong side.** My first test for `idle_in_transaction_session_timeout` expected the promise to reject within the timeout. It did not: the server kills the session asynchronously and the client only finds out at its **next** statement, so the test failed at 1 505 ms against a 1 400 ms bound — while the mechanism was working perfectly. Left unfixed, the honest summary of the behaviour would have been wrong in the documentation as well | The test asserts what actually matters and what actually happens: the backend disappears from `pg_stat_activity` **while the client is still sleeping**, and the next statement then fails. That is the property that frees the row locks, and it is now the one under test |

Also caught by the same pass, and worth recording because the type system turned out to be stricter than the plan:
**Kysely 0.29 cannot nest transactions.** `transaction()` and `startTransaction()` both throw on a `Transaction`, and
savepoints exist only on the `ControlledTransaction` from `startTransaction()`. A first draft advertised nested
savepoints; the test for it failed with Kysely's internal message, and TypeScript rejects the call outright. The helper
now refuses a `Transaction` with an explanation instead, and the alternative — pass the enclosing transaction down —
is documented in `09-development.md`.

---

## Pass 17 — 2026-10-25 (adversarial review of `P1-DB-02`)

Two defects, both in the new schema work, both found by trying to *break* the guarantee rather than by reading it.

| # | Bug | Fix |
|---|---|---|
| 1 | **The type assertions did not run.** The suite asserted `id` is a `string` with `expectTypeOf`, which is a compile-time DSL: at runtime the calls are no-ops, so `bun run test` passed with `AuditLogs.id` changed to `Generated<number>` — a mutation that compiles, reads fine on a small database, and then compares wrong. The test claimed a guarantee that only `tsc` provides, and nothing said so | The compile-time half stays (it *is* enforced — `bun run typecheck` fails with `Expected: string, Actual: number`) with a comment stating exactly that and how it was verified; and the runtime half was added against a real server (`instanceof Date`, `Buffer.isBuffer`, `typeof id === 'string'`), which is the one that catches a type the driver disagrees with |
| 2 | **An insert could supply a generated id.** Ids were `Generated<T>`, whose insert type includes `T` — so `insertInto('audit_logs').values({ id: '7', … })` compiled. For `bigserial` that writes the row without advancing the sequence, and the next generated id collides: a failure that surfaces later, in a different request, far from the insert that caused it | `GeneratedAlways<string>` for all three ids: insert type `never`, so the mistake is a compile error. Pinned with `@ts-expect-error` in the suite |

Neither existed in a released build — both were in uncommitted work, like passes 14 and 15.

Verified while reviewing, with the edit applied and asserted (the first attempt silently no-op'd, which is why the
first result was a false pass): a column added to the SQL only fails 2 tests, a column added to the interface only
fails 1, `user_agent text NOT NULL` in SQL only fails 3, a renamed property fails 1, a stray `any` fails 1, and
`Generated<number>` for the audit id fails `tsc`.

---

## Pass 16 — 2026-10-25 (adversarial review of the working tree after `P1-API-07`)

Three defects, found by asking what the *process* does rather than what the tests assert. The first is the same
leak pass 14 fixed, reached through the other door; the other two are errors being discarded with no trace.

| # | Bug | Fix |
|---|---|---|
| 1 | **A boot refused for an illegal route left the pool open.** `buildApp` gained a `try`/`catch` in pass 14 so a failed `onReady` ping closes the instance — but the route-law check runs *after* a successful boot and sat outside that guard. Measured with a recording handle: `buildApp` rejects with `One route violates the route law`, and `close` had been called **0** times. In production the process exits and the socket dies with it, which is why nothing looked wrong; in any process that builds apps more than once (tests today, a worker entry point later) it leaks `DB_POOL_MAX` connections per attempt | The check moved inside the guard, so both ways a boot can be refused take the same shutdown path. Test asserts `close` ran exactly once after a route-law rejection; the same probe now prints `1` |
| 2 | **A connection lost while idle was discarded in silence.** The pool listener is required — a Node `EventEmitter` that emits `error` with no listener throws, so a Postgres restart would end the process — but it was `() => undefined`: the driver's error went nowhere. A database that drops connections every few minutes would look healthy in the log until a query happened to land on the dead socket and the request failed | `createDatabase` takes an optional `onPoolError`, and the `db` stage passes the app logger, so the drop is a `warn` with the driver error attached. Probed by restarting Postgres under a running API: `10` lines (`one per pooled connection the restart dropped`), `/readyz` stayed `200` because the pool reconnected. Optional on purpose — a test handle that is thrown away does not want a logger |
| 3 | **A killed probe could leave a file in `CACHE_DIR` forever.** The cache check wrote `.readyz-<uuid>` and deleted it; a probe killed between the two — process restart, container stop — leaves a uniquely named empty file, and no later probe will ever touch that name again. `CACHE_DIR` is user-visible: the storage screen reports unknown files as orphans, so this becomes permanent litter that a human has to clear | One fixed name, `.readyz`. The next probe overwrites and removes it, so the directory heals itself, and two concurrent probes still cannot collide in a way that matters (both write an empty file; the second delete is a no-op). Test plants a leftover and asserts the directory is empty afterwards |

Mutation checks: silencing the pool listener fails the new integration test, and restoring per-call file names fails
the leftover test.

Also verified while reviewing, with no defect found: 40 concurrent `/readyz` requests all answer `200` and leave no
files behind; file descriptors plateau at the pool's `DB_POOL_MAX` and drain after the 30 s idle timeout (no leak);
an inbound `x-request-id` is echoed on probe responses; a foreign-origin `OPTIONS /readyz` is refused `403` while
`POST /readyz` answers the `404` envelope; and a second `SIGTERM` while shutting down produces exactly one
`shutting down` line.

---

## Pass 15 — 2026-10-25 (adversarial review of `P1-API-07`)

Two defects, both in the readiness probe, both found **before commit** — and both of the same family: the probe had
two ways to say "this failed" and only one of them was honest.

| # | Bug | Fix |
|---|---|---|
| 1 | **An unwritable cache directory reported itself healthy.** The cache check signalled failure by *returning* `'fail'`, while the helper that bounds every check treated any **fulfilled** promise as success — so the `'fail'` value was mapped to `'ok'` and `/readyz` answered `200 {cache:"ok"}` with `CACHE_DIR` pointing at a regular file. A load balancer would have kept sending traffic to an API that could not store a single download | One rule, stated at the helper: a check resolves when usable and **throws** when not. The cache check now returns `Promise<void>` and propagates its `mkdir`/`writeFile` error; the reason is logged, the body still says only `"fail"`. Test: `CACHE_DIR` set to a *file* (chmod is the obvious way to make a directory unwritable and it does nothing under a root test runner), asserting `503 {database:"ok",cache:"fail"}` |
| 2 | **A check that threw before returning a promise answered `500` instead of `503`.** The bound was applied to a promise, so the call `app.db.check(...)` had already been evaluated — and a pool that has been closed throws synchronously out of it. Measured: `/readyz` → `500 INTERNAL_ERROR`, a status that says the *probe* is broken rather than the dependency, and that a monitoring rule or a load balancer keyed on `503` never fires on | The helper takes a **thunk** and invokes it inside the race, so a synchronous throw becomes a failed check like any other. Test covers a handle that throws on its second call (the boot ping succeeds, the probe does not) and asserts `503` with `database: "fail"` |

Neither could be caught by the suite that existed at the time: both live in the space between "the check returned"
and "the check failed", which is exactly the space a probe's whole existence is about.

A smaller thing in the same pass: `RouteOptions` carried a `probeTimeoutMs` that no caller set — a branch that sat
at 50 % coverage because it could only be taken by a test. Removed rather than tested; tests that need a shorter
budget register `probeRoutes` directly.

Mutation checks, because a probe test that cannot fail is worse than no probe test: making the cache check always
succeed fails 2 tests, making `/healthz` consult the database fails 1, removing the timeout bound fails 1, and
removing `cache-control: no-store` fails 2.

---

## Pass 14 — 2026-10-25 (adversarial review of `P1-API-06`)

Three defects, all found **before the task was committed**, so no released build ever had them — but each one would have
reached `main` if the task had been written the obvious way and merged on the strength of a green suite, which is the
point of reviewing the work in progress. Two of them are the same bug wearing different clothes: nobody closed the pool.

| # | Bug | Fix |
|---|---|---|
| 1 | **A boot option that was accepted and then dropped.** `buildApp({ database })` typed the option, read nothing from it, and passed only `config` into the pipeline — so the `db` stage built its **own** pool from the default DSN while the caller's handle sat unused. Every test passed: the ones that supply a handle assert on `app.db`, which the stage set from its own creation, and the ones that do not never looked at a connection. The failure mode in production is a process quietly connected to `localhost:5432` instead of its configured database | The handle is threaded into the pipeline context. The test that catches it does not go through the factory: `buildApp({ database: handle })` now fails on a handle whose `check` rejects, and an adoption test asserts `app.db` **is** the object it was given |
| 2 | **A failed boot leaked the pool.** The stage's check throws inside `onReady`; Fastify marks the instance failed and `buildApp` rethrows — but the instance is never returned, so its `onClose` hooks have no caller and the pool it just opened stays open until the process exits. Probed: `onReady` rejecting, then `app.close()`, **does** run `onClose` in Fastify 5 — the hook was fine, nothing was calling it. A supervisor retries a failed boot on a loop, so a database that is down for a minute accumulates `DB_POOL_MAX` connections per retry against a server that is already struggling. | `buildApp` closes the instance on any failure inside `registerPipeline` and rethrows the original error. Tested by rejecting from a stub `check` and asserting the handle's `close` ran exactly once (the assertion fails without the fix: `expected +0 to be 1`) |
| 3 | **A shared pool was never closed.** The stage inferred "ownership" from whether the handle was passed in and skipped `close` for caller-supplied handles. That reads as respectful and is the mirror image of bug 2: a caller that hands over a pool still expects `app.close()` to leave nothing behind, and the handle that is not closed here has no other owner. The test that asserted this behaviour was written to match the code, which is how a wrong rule survives a passing suite | One rule: `close()` closes the handle, however it arrived. An app that genuinely shares a handle between instances says so at the call site (`{ ...handle, close: () => Promise.resolve() }`) instead of asking the stage to guess. Test rewritten to assert the close |

Two smaller things in the same pass, neither a defect:

- **A branch nothing could take.** `checkDatabase` guarded its timer cleanup with `if (timer !== undefined)`, but the timer is
  armed before the `race` and cleared in `finally`, so the false arm was unreachable — and therefore untestable, which is
  how it showed up: 75 % branch coverage on a file with no gaps left. The guard is gone, not tested around.
- **A missing test for a deliberate listener.** `pool.on('error', …)` exists because a Node emitter that emits `error` with no
  listener **throws**, so one backend restart would take the process down. Nothing asserted it, so nothing would have
  noticed its removal. Now `pg_terminate_backend` kills the suite's own connection and the pool must still answer — verified
  by deleting the listener, which reports an unhandled `57P01` and fails the run.

---

## Pass 13 — 2026-10-25 (adversarial review across the completed API stages)

Three defects, none of them visible from the tests that existed. Each was found by asking what the *deployment*
does (a proxy, a browser, a malformed packet) rather than what `inject()` does.

| # | Bug | Fix |
|---|---|---|
| 1 | **Every client behind the documented proxy had the same identity.** `trustProxy` was never set, so `request.ip` was the proxy's address for all traffic. Nothing reads `request.ip` yet, which is why no test failed — but `14-security.md` §7 defines per-IP limits and the download design stores salted IP hashes. Shipping as-is would have made 10 login attempts / 15 min a **global** budget (one attacker locks out every administrator) and made every hashed IP identical (per-visitor statistics meaningless). Measured: a request with `X-Forwarded-For: 203.0.113.7` reported `127.0.0.1` | A `TRUST_PROXY` setting (default `loopback`, correct for the same-host proxy `12-deployment.md` mandates) is handed to Fastify, documented in `09` §5, `.env.example` and `14` §6, and covered by tests that use a **real socket** — `inject()` bypasses proxy resolution entirely and reported `remoteAddress` for every setting, so a test written against it would have passed whatever the code did. Probe: `loopback` → `203.0.113.7`; `none` → `127.0.0.1`; a spoofed leading hop is ignored |
| 2 | **A hop count silently disables trust.** The natural value for an operator — `TRUST_PROXY=1`, "one proxy" — makes Fastify return a trust function that is **always false** (`lib/request.js`: "Hop-count-only trust cannot validate the immediate peer. Fail closed"). No error, no warning: the proxy would look configured and do nothing, which is worse than the bug above because it is invisible | Numeric values are refused at boot with a message naming the behaviour and suggesting an address or subnet; `true`/`*` are refused too, since they let any client choose its own address. Both are tested, and the boot message is the documentation |
| 3 | **A malformed request answered in a second response shape.** A bad request line or an oversized header fails in Node's parser, before any hook, so Fastify's default handler replied `{"error":"Bad Request","message":"Client Error","statusCode":400}` — no `code`, no `requestId`, no security headers. `04-api.md` promises the envelope for every non-2xx, and this is the first thing a scanner sends. Measured with raw bytes over a socket | A `clientErrorHandler` answers the documented envelope with a generated id in both the header and the body, logs it at `warn` with the error scrubbed, and closes the connection (the parser has already given up on the stream). The status stays `400 BAD_REQUEST` even for header-overflow and timeout, because the vocabulary has no `408`/`431`. Guarded by tests over a real socket, plus a unit test that the handler never writes to a destroyed or read-only socket — writing there throws inside a Node event handler and kills the process |

One smaller fix in the same pass:

- **A cross-origin client could not read `x-request-id`.** The allowed-origin response carried
  `access-control-allow-origin` but no `access-control-expose-headers`, and a browser hides every non-safelisted
  response header from JavaScript — so the id `04-api.md` §0.2 tells clients to quote in a bug report was
  unreachable from the only place that can read it. Now exposed, and asserted.

Both new tests were verified by restoring the defect: hardcoding `trustProxy: false` fails the two forwarded-address
tests, and deleting the expose-header fails the CORS test. A mutation check is cheap and it is the only evidence
that a test would have caught the bug it describes.

---

## Pass 12 — 2026-10-25 (adversarial review of `P1-API-05`)

One defect, caught by asking what a *browser* sends rather than what curl sends — the tests, the unit probes and
the nine headers all passed while it was present.

| # | Bug | Fix |
|---|---|---|
| 1 | **The CORS rule locked the SPA out of its own API.** The first version refused any request whose `Origin` was not on the allow-list with `403 FORBIDDEN` — including *actual* requests, not just preflights. Browsers send `Origin` on same-origin `POST`/`PATCH`/`DELETE`, so the SPA posting its login form to the API on the same host carried `Origin: http://localhost:8080`, which no allow-list contains (the API is reached through the proxy, and the list is for *other* sites), and was rejected by its own server. Measured with curl: a same-origin login `POST` with `Origin: http://localhost:8080` returned `403 FORBIDDEN`. The unit tests missed it because `inject` sends no `Origin` unless told to, and the one test that did send one used an intentionally hostile origin | Only a **preflight** is refused: it is a question, and the answer is no. An actual request from an unlisted origin is answered without `access-control-allow-origin`, so a browser hides the body and no other client is affected — the behaviour CORS actually specifies. A regression test sends a same-origin `POST` carrying `Origin` and expects the handler's own status, not `403`. Probes after the fix: same-origin POST → `503` from the stub; foreign-origin GET → `503`, no ACAO; foreign-origin preflight → `403`; allowed preflight → `204` |

Worth recording because the same mistake is easy to make again: **CORS is a browser-side read barrier, not an
authorisation mechanism.** Server-side refusal of an `Origin` is either redundant (the browser already blocks the
read) or harmful (it breaks same-origin requests that happen to carry the header). Authorisation is the token
guard's job, in slot 6.

---

## Pass 11 — 2026-10-25 (adversarial review of `P1-API-04`)

One defect, found by running the failure paths on a real process instead of trusting the unit tests — which
passed while it was present.

| # | Bug | Fix |
|---|---|---|
| 1 | **The 500 log leaked the secret the 500 response was hiding.** The handler did everything right for the client: a fixed sentence, no stack, no driver text. Then it logged the exception with `request.log.error({ err: error })`, and the message it wrote was the driver's own — `connect ECONNREFUSED postgres://u:hunter2@db:5432/x`. Pino's `err` serializer prints `message` and `stack` verbatim, and **field redaction cannot see a secret that is a substring of a value**: `*.password` never matches a DSN inside a sentence. Measured: `grep -c hunter2` on the probe log returned 1 | Two layers, both at the logger level. `scrubSecrets` masks URL credentials (`scheme://user:***@host`), `password=`/`token=`/`secret=`/`api_key=` pairs and `Bearer <token>` inside free text; `withRedaction` installs it as the **`err` serializer**, owned over any caller's, so every call site is covered — including `server.ts`'s shutdown handler, which logs a raw exception too. Probe after the fix: `0` occurrences, and the useful text survives as `postgres://u:***@db:5432/x` |

A second finding, fixed in the same pass because it was in the same line of code:

- **Fastify's `err` serializer discards a pre-shaped error's name.** Passing `{ err: describeError(error) }`
  produced `"type":"Object"`, losing `TypeError` vs `RangeError` — the one thing an operator reads first. The
  serializer now receives the raw exception and does the shaping itself, so the name survives *and* the text is
  scrubbed in one place.

Two behaviours confirmed by probe rather than assumed:

- **Client-caused failure codes** were read off a running instance, not guessed: malformed JSON and an empty
  JSON body raise `FST_ERR_CTP_INVALID_JSON_BODY`/`FST_ERR_CTP_EMPTY_JSON_BODY` (400), an unsupported media
  type raises `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415), an oversized body raises `FST_ERR_CTP_BODY_TOO_LARGE`
  (413) — each mapped to its documented code.
- **A wrong method is a 404, not a 405.** Fastify answers `404` for a method a path does not accept, which is
  what the contract's vocabulary allows (there is no 405 code) and what the existing route tests already
  expected. Now asserted explicitly, with a comment, so nobody "fixes" it into a 405 later.

---

## Pass 10 — 2026-10-25 (adversarial review while building `P1-API-02` / `P1-API-03`)

Two defects, both found by writing the test before trusting the feature, and both in code that already had a
green suite.

| # | Bug | Fix |
|---|---|---|
| 1 | **Environment cross-field rules were collected and then discarded.** `parseEnv` appended the mutual-exclusion and production-DSN problems to a list, but only threw when the *schema* had failed (`if (!parsed.success)`). A production boot with **no** `DATABASE_URL`, or with both `ADMIN_PASSWORD` and `ADMIN_PASSWORD_FILE`, was therefore accepted — the rules existed, were documented, and did nothing | Both gates are explicit: the parse result (which also narrows `parsed`) and then the collected issues. A test asserts that a schema problem and a cross-field problem are reported in **one** error, so fixing a `.env` takes one boot rather than two. Probe: before, `parseEnv({NODE_ENV:'production'})` returned a config whose DSN was the localhost default; after, exit 1 with `DATABASE_URL: is required in production` |
| 2 | **Every hook-installing pipeline stage was a silent no-op.** Stages were registered with `app.register(stage)`; Fastify encapsulates hooks added inside a plugin, so slot 1's `onRequest` hook applied to its own empty subtree and nothing else. `x-request-id` was absent from every response while the plugin "was registered" and the pipeline tests passed — they only checked that routes existed. Stages 2–6 (`errors`, `security`, `db`, `rate-limit`, `auth`) have exactly the same shape, so the pipeline would have been five more no-ops | A slot now carries `install: (app) => void` and receives the **root** instance; only `routes` gets encapsulation (`app.register(registerRoutes)`), because routes want it. A regression test installs a hook-carrying stage and asserts the header reaches a real response. Probes: a plugin-registered hook → `x-from-plugin: MISSING`; after the change → header present, and the real process now returns `x-request-id` on 200, 503 **and** 404 |

Two further findings recorded rather than fixed:

- **Fastify's request serializer logs no headers.** `req` is serialized to `{method, url, host, remoteAddress}`,
  so credentials never reached a log line by that route. The redaction list is still enforced at the logger
  level (L9) and now also covers header-shaped objects a handler logs itself (`*.headers.authorization`), which
  is the shape that would actually leak.
- **`req`/`res` are serializer keys, not plain fields.** A hand-built `{ req: { headers: … } }` is passed to
  Fastify's request serializer, which expects a real request and emits `{}` — a dump written that way is
  silently emptied. Discovered by a redaction test that failed for the "wrong" reason (no censor and no value);
  the reasoning is now in the module comment so the next person does not repeat it.

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
- **The boot path itself is now under test.** Defect 3 was first caught by a manual probe, which meant nothing
  in the suite failed if a throwing hook came back. `buildApp` takes a `slots` override (documented *tests
  only*, never passed by `server.ts`) so two real tests exist: one asserts `buildApp` rejects with the route
  named, the other that an illegal route leaves `ready()` resolvable — the property whose absence hung the
  boot. Both were proven by restoring each defect: the throwing hook fails both, and deleting the
  `assertRouteLaw` call fails the `buildApp` one, with exactly one failure and no hung suite each time.
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
| 14 | Counts were stale in four places: 145 tasks (real: 136 — 140 since pass 31 added the four Phase 5 admin rows), 11 tables (15), "15 screens" (14 + 404), and a 41-defect total that ignored the table rows | All recomputed from the files themselves before publishing |
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
