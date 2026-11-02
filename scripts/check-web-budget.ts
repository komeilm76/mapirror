/**
 * Verifies the public-route transfer budgets from a production Vite build (`P5-UX-08`).
 *
 * Run after `bun run build:web` (the root `check:web-budget` command does so). The Vite manifest is the asset graph: only
 * the entry's static imports count toward first paint; lazy route imports are measured as independent page chunks.
 * Gzip sizes use the system `gzip -1` command, matching nginx's default `gzip_comp_level 1` closely. WOFF2 is already
 * compressed and is counted at its emitted byte size.
 *
 * @module scripts/check-web-budget
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

interface ManifestEntry {
  readonly file: string;
  readonly name?: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
}

const DIST = resolve(process.cwd(), 'apps/web/dist');
const MANIFEST_PATH = resolve(DIST, '.vite/manifest.json');
const KiB = 1024;
const BUDGETS = {
  initialJsGzip: 130 * KiB,
  initialCssGzip: 15 * KiB,
  initialFontBytes: 24 * KiB,
  initialTransferBytes: 165 * KiB,
  pageChunkJsGzip: 20 * KiB,
} as const;

function fail(message: string): never {
  console.error(`Web performance budget failed: ${message}`);
  process.exit(1);
}

function sizeOf(asset: string): number {
  const absolute = resolve(DIST, asset);
  if (!absolute.startsWith(`${DIST}${sep}`)) fail(`manifest asset escapes dist/: ${asset}`);
  try {
    return statSync(absolute).size;
  } catch {
    fail(`manifest asset is missing: ${asset}`);
  }
}

function gzipSizeOf(asset: string): number {
  const absolute = resolve(DIST, asset);
  if (!absolute.startsWith(`${DIST}${sep}`)) fail(`manifest asset escapes dist/: ${asset}`);
  try {
    return execFileSync('gzip', ['-1', '-c'], { input: readFileSync(absolute) }).byteLength;
  } catch {
    fail(`cannot gzip ${asset}; ensure the gzip utility is installed`);
  }
}

function sumAssets(assets: ReadonlySet<string>, size: (asset: string) => number): number {
  return [...assets].reduce((total, asset) => total + size(asset), 0);
}

let manifest: Record<string, ManifestEntry>;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, ManifestEntry>;
} catch {
  fail(`cannot read ${MANIFEST_PATH}; run bun run build:web first`);
}

const entryKey = Object.keys(manifest).find(
  (key) => manifest[key]?.isEntry && key.endsWith('index.html'),
);
if (entryKey === undefined) fail('production manifest has no index.html entry');

/** Collects an entry's static import graph, excluding dynamic page imports. */
function collectStaticGraph(key: string, found: Set<string>): void {
  if (found.has(key)) return;
  const entry = manifest[key];
  if (entry === undefined) fail(`manifest import is missing: ${key}`);
  found.add(key);
  for (const imported of entry.imports ?? []) collectStaticGraph(imported, found);
}

const initialGraph = new Set<string>();
collectStaticGraph(entryKey, initialGraph);
const initialJs = new Set<string>();
const initialCss = new Set<string>();
const initialFonts = new Set<string>();
for (const key of initialGraph) {
  const entry = manifest[key];
  if (entry === undefined) fail(`manifest entry is missing: ${key}`);
  if (entry.file.endsWith('.js')) initialJs.add(entry.file);
  for (const css of entry.css ?? []) initialCss.add(css);
  for (const asset of entry.assets ?? []) {
    if (/\.(?:woff2?|ttf|otf)$/iu.test(asset)) initialFonts.add(asset);
  }
}
const jsGzip = sumAssets(initialJs, gzipSizeOf);
const cssGzip = sumAssets(initialCss, gzipSizeOf);
const fontBytes = sumAssets(initialFonts, sizeOf);
const htmlGzip = gzipSizeOf('index.html');
const criticalTransfer = jsGzip + cssGzip + fontBytes + htmlGzip;

const asyncChunks: Array<{ name: string; bytes: number }> = [];
for (const key of manifest[entryKey]?.dynamicImports ?? []) {
  const entry = manifest[key];
  if (entry === undefined || !entry.file.endsWith('.js')) continue;
  asyncChunks.push({ name: entry.name ?? key, bytes: gzipSizeOf(entry.file) });
}
asyncChunks.sort((a, b) => b.bytes - a.bytes);
const largestAsync = asyncChunks[0];
const lazyImports = new Set(manifest[entryKey]?.dynamicImports ?? []);

const violations: string[] = [];
if (jsGzip > BUDGETS.initialJsGzip)
  violations.push(`initial JS is ${jsGzip} B gzip (budget ${BUDGETS.initialJsGzip} B)`);
if (cssGzip > BUDGETS.initialCssGzip)
  violations.push(`initial CSS is ${cssGzip} B gzip (budget ${BUDGETS.initialCssGzip} B)`);
if (fontBytes > BUDGETS.initialFontBytes)
  violations.push(`initial fonts are ${fontBytes} B (budget ${BUDGETS.initialFontBytes} B)`);
if (criticalTransfer > BUDGETS.initialTransferBytes)
  violations.push(
    `initial transfer is ${criticalTransfer} B (budget ${BUDGETS.initialTransferBytes} B)`,
  );
if (largestAsync !== undefined && largestAsync.bytes > BUDGETS.pageChunkJsGzip)
  violations.push(
    `largest async page chunk (${largestAsync.name}) is ${largestAsync.bytes} B gzip (budget ${BUDGETS.pageChunkJsGzip} B)`,
  );
if (asyncChunks.length < 10)
  violations.push(
    `only ${asyncChunks.length} routes/components are lazy-loaded (expected at least 10)`,
  );
if (!lazyImports.has('src/layouts/AdminLayout.vue'))
  violations.push('AdminLayout is not deferred from the public entry');
if (!lazyImports.has('src/pages/admin/CatalogPage.vue'))
  violations.push('the admin catalog page is not route-lazy-loaded');
if (!lazyImports.has('src/pages/auth/LoginPage.vue'))
  violations.push('the sign-in screen is not route-lazy-loaded');
if (lazyImports.has('src/pages/public/HomePage.vue'))
  violations.push('the public landing page must remain eager to avoid an extra LCP network hop');
if ([...initialGraph].some((key) => key.toLowerCase().includes('materialdesignicons')))
  violations.push('the icon font or stylesheet entered the public initial bundle');

if (violations.length > 0) fail(violations.join('; '));

console.log('Web performance budgets passed:');
console.log(
  `  public first-load transfer: ${(criticalTransfer / KiB).toFixed(1)} KiB / ${(BUDGETS.initialTransferBytes / KiB).toFixed(0)} KiB`,
);
console.log(
  `  JS gzip: ${(jsGzip / KiB).toFixed(1)} KiB; CSS gzip: ${(cssGzip / KiB).toFixed(1)} KiB; WOFF/TTF assets: ${(fontBytes / KiB).toFixed(1)} KiB`,
);
console.log(
  `  ${asyncChunks.length} lazy chunks; largest page chunk: ${largestAsync === undefined ? 'none' : `${largestAsync.name} ${(largestAsync.bytes / KiB).toFixed(1)} KiB gzip`}`,
);
