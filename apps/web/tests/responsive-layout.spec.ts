import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const styles = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, `../src/styles/${name}`), 'utf8');

/** Returns one complete media-rule body so the test checks selectors in the intended breakpoint, not nearby CSS. */
function mediaRule(css: string, query: string, occurrence = 0): string {
  const marker = `@media ${query}`;
  let start = -1;
  let cursor = 0;
  for (let current = 0; current <= occurrence; current += 1) {
    start = css.indexOf(marker, cursor);
    expect(start, `missing occurrence ${current + 1} of ${marker}`).toBeGreaterThanOrEqual(0);
    cursor = start + marker.length;
  }

  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`Unclosed ${marker}`);
}

describe('responsive layout contracts', () => {
  it('uses two-column cards for catalog and cache from 640 through 1023 px', () => {
    for (const [file, table, cards] of [
      ['catalog.css', 'mm-catalog-table-wrap', 'mm-catalog-cards'],
      ['cache.css', 'mm-cache-table-wrap', 'mm-cache-cards'],
    ] as const) {
      const tablet = mediaRule(styles(file), '(min-width: 640px) and (max-width: 1023px)');
      expect(tablet).toMatch(new RegExp(`\\.${table}[\\s\\S]*?display: none`, 'u'));
      expect(tablet).toMatch(new RegExp(`\\.${cards}[\\s\\S]*?display: grid`, 'u'));
      expect(tablet).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u);
    }
  });

  it('uses two-column job and cached-version cards at tablet widths, then one column on phones', () => {
    const jobs = styles('jobs.css');
    const jobsTablet = mediaRule(jobs, '(max-width: 1023px)');
    expect(jobsTablet).toMatch(/\.mm-jobs-table-wrap\s*\{\s*display: none/u);
    expect(jobsTablet).toMatch(
      /\.mm-jobs-mobile-list\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2,/u,
    );
    expect(mediaRule(jobs, '(max-width: 767px)')).toMatch(
      /\.mm-jobs-mobile-list\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/u,
    );

    const cache = styles('cache.css');
    const versionTablet = mediaRule(cache, '(min-width: 640px) and (max-width: 1023px)', 1);
    expect(versionTablet).toMatch(/\.mm-cache-version-cards\s*\{[^}]*display: grid/u);
    expect(versionTablet).toMatch(/grid-template-columns:\s*repeat\(2,/u);
    expect(mediaRule(cache, '(max-width: 1023px)', 1)).toMatch(
      /\.mm-cache-version-table-wrap\s*\{\s*display: none/u,
    );
  });

  it('keeps auth and placeholder containers within their mobile content width', () => {
    const publicCss = styles('public.css');
    expect(publicCss).toMatch(
      /\.mm-page-container\s*\{\s*box-sizing:\s*border-box;\s*width:\s*100%;/u,
    );
    expect(publicCss).toMatch(
      /\.mm-page-container\s*>\s*\.v-row\s*>\s*\[class\*='v-col-'\]\s*\{\s*box-sizing:\s*border-box;/u,
    );
    for (const page of ['auth/LoginPage.vue', 'PlaceholderPage.vue']) {
      const source = readFileSync(resolve(import.meta.dirname, `../src/pages/${page}`), 'utf8');
      expect(source).toMatch(/<v-container class="mm-page-container/u);
    }
  });

  it('keeps mobile facts and public version rows readable without page-level table overflow', () => {
    expect(mediaRule(styles('catalog.css'), '(max-width: 420px)')).toMatch(
      /\.mm-catalog-card dl\s*\{\s*grid-template-columns: 1fr/u,
    );
    expect(mediaRule(styles('cache.css'), '(max-width: 420px)')).toMatch(
      /\.mm-cache-card dl\s*\{\s*grid-template-columns: 1fr/u,
    );

    const publicCss = styles('public.css');
    const phone = mediaRule(publicCss, '(max-width: 639px)', 1);
    const notFoundPhone = mediaRule(publicCss, '(max-width: 639px)', 3);
    expect(notFoundPhone).toMatch(
      /\.mm-public-not-found-action\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%/u,
    );
    expect(phone).toMatch(/\.mm-public-versions-table\s*,[\s\S]*?display: block/u);
    expect(publicCss).toMatch(/\.mm-public-api-code\s*\{[^}]*white-space: pre-wrap/u);
    expect(publicCss).toMatch(/\.mm-public-api-table-wrap\s*\{[^}]*overflow-x: auto/u);
  });
});
