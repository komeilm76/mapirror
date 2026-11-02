# P5-UX-08 performance evidence

**Result:** the measured public-catalog LCP is below the 2.5 s target. The production bundle also meets each first-load and async-page budget in `docs/13-ui-ux.md` §13.

## Cold mobile LCP lab run

The built production Vite output was served from a local HTTP harness. The public-country API was answered by a deterministic, schema-valid fixture with two rows; no live API, database, or external requests were involved. Static HTML, JavaScript, and CSS were compressed with the system `gzip -1` command for the same MIME types enabled in `docker/nginx.conf`, with the configured 1 KiB minimum body size; the fixture API response remained uncompressed. WOFF2 was served as its emitted, already-compressed bytes. The compression level and threshold approximate nginx's configured policy, but this was not a Docker/nginx deployment and is not a field-user measurement.

| Setting | Value |
|---|---|
| Browser | Chromium 141 headless, controlled through Playwright Core / CDP |
| Viewport | 390 × 844 CSS pixels, device scale factor 1 |
| Cache | Disabled; five cold navigations |
| CPU | 4× slowdown |
| Network | 150 ms RTT, 209,715 B/s down (1.6 Mbps), 98,304 B/s up (768 Kbps) |
| LCP capture | `PerformanceObserver` for `largest-contentful-paint`; final candidate after catalog render |
| Browser page errors | 0 in all five runs |

**LCP samples:** 1,128 ms, 1,132 ms, 1,132 ms, 1,136 ms, 1,272 ms. Median is **1,132 ms**; nearest-rank p75 is **1,136 ms**; maximum is **1,272 ms**. All are under the 2,500 ms target. The largest candidate was the public intro paragraph, not a placeholder or an empty response.

For context, the same harness before the route/CSS split measured p75 1,980 ms over three cold runs. That small pre-change sample is diagnostic only; the five-run post-change set is the acceptance evidence.

## Production bundle budgets

`bun run check:web-budget` rebuilds the SPA, parses Vite's `.vite/manifest.json`, follows only static imports for the first-load graph, and checks lazy component chunk sizes. It uses the system `gzip -1` command, available by default on Ubuntu 24, to match nginx's default compression level. Current result:

| Metric | Budget | Measured |
|---|---:|---:|
| Initial public JS, gzip | 130 KiB | 126.4 KiB |
| Initial public CSS, gzip | 15 KiB | 5.8 KiB |
| Initial WOFF/TTF/OTF assets | 24 KiB | 21.8 KiB (Space Grotesk WOFF2) |
| HTML + initial JS/CSS/fonts | 165 KiB | 154.6 KiB |
| Largest individual lazy JS chunk | 20 KiB gzip | 19.8 KiB (ImportPage) |
| Lazy route/component chunks | at least 10 | 16 |

The public entry graph excludes `AdminLayout`, route-specific admin CSS, the toast overlay, and Material Design Icons. The home page remains eager; the admin layout, other route pages, login, not-found, and placeholder are dynamic imports. `ToastHost` is loaded only when the notification queue is non-empty, and its MDI stylesheet/font travels with that async component or the login route.

## Scope and caveat

These are cold lab results from a local production build under a named synthetic mobile profile, with a mocked small catalog and a local compression harness that follows the shipped nginx gzip types/minimum size. They do not establish real-user p75, production CDN/proxy latency, or device-wide performance. Keep the LCP target and first-load asset budgets as regression gates; production RUM or an external PageSpeed run can refine the estimate once a deployment is available.
