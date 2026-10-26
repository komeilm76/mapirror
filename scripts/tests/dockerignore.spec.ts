import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isExcludedFromBuild, parseDockerIgnore } from '../lib/dockerignore';

/**
 * The `.dockerignore` matcher (tasks `P1-REPO-06`, `P1-DOCK-01`).
 *
 * Two consumers ask this one question — "would this path be in the build context?" — and a wrong answer is expensive in
 * both directions: a secret that is *not* excluded is copied into an image layer, and a file that *is* excluded is a
 * `COPY` that fails on whoever builds next. `check-hygiene` asks it about secrets and about the files the images need;
 * the Dockerfile test asks it about every `COPY` source. So the rules themselves are pinned here, once.
 *
 * Docker's rules, as this repository uses them: last match wins, `!` re-includes, `*` and `?` never cross `/`, `**`
 * does, and a pattern naming a directory covers everything under it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const realPatterns = parseDockerIgnore(readFileSync(join(ROOT, '.dockerignore'), 'utf8'));

describe('the real .dockerignore', () => {
  it('keeps secrets and runtime data out of the build context', () => {
    for (const path of [
      '.env',
      '.env.local',
      '.env.production',
      'server.pem',
      'server.key',
      'client.p12',
      'secrets/admin_password',
      'data/cache/finland/261023/finland-261023.osm.pbf',
      'backups/2026-10-24/db.dump',
      'node_modules/fastify/index.js',
      'coverage/index.html',
    ]) {
      expect(isExcludedFromBuild(path, realPatterns), path).toBe(true);
    }
  });

  it('keeps what the images are built from', () => {
    for (const path of [
      'package.json',
      'bun.lock',
      'apps/api/package.json',
      'apps/api/src/server.ts',
      'packages/shared/src/index.ts',
      'scripts/migrate.ts',
      'scripts/lib/secret-prompt.ts',
      'docker/api.Dockerfile',
      'tsconfig.base.json',
    ]) {
      expect(isExcludedFromBuild(path, realPatterns), path).toBe(false);
    }
  });

  it('does not treat the template as a secret', () => {
    // The line the `!` rule exists for: `*.env` would take `.env.example` with it, and the one file an operator is meant
    // to copy must survive. Removing `!` support makes this case red — measured, pass 38.
    expect(isExcludedFromBuild('.env.example', realPatterns)).toBe(false);
  });
});

describe('the rules', () => {
  it('lets the last matching line decide', () => {
    const patterns = parseDockerIgnore(['*', '!keep.txt', 'keep.txt'].join('\n'));

    expect(isExcludedFromBuild('keep.txt', patterns)).toBe(true);
    expect(isExcludedFromBuild('other.txt', patterns)).toBe(true);
  });

  it('re-includes with a bang, in file order', () => {
    const patterns = parseDockerIgnore(['*.log', '!important.log'].join('\n'));

    expect(isExcludedFromBuild('important.log', patterns)).toBe(false);
    expect(isExcludedFromBuild('debug.log', patterns)).toBe(true);
  });

  it('never lets a single star cross a directory boundary', () => {
    const patterns = parseDockerIgnore('data/*'.concat('\n'));

    expect(isExcludedFromBuild('data/cache', patterns)).toBe(true);
    expect(isExcludedFromBuild('data/cache/finland/261023/x.osm.pbf', patterns)).toBe(true);
    expect(isExcludedFromBuild('apps/data/cache', patterns)).toBe(false);
  });

  it('lets a double star cross them', () => {
    const patterns = parseDockerIgnore('**/fixtures'.concat('\n'));

    expect(isExcludedFromBuild('apps/api/src/fixtures', patterns)).toBe(true);
    expect(isExcludedFromBuild('fixtures', patterns)).toBe(true);
    expect(isExcludedFromBuild('apps/api/src/fixtures/keep.json', patterns)).toBe(true);
    expect(isExcludedFromBuild('apps/api/src/fixture', patterns)).toBe(false);
  });

  it('covers a directory pattern, trailing slash or not', () => {
    for (const line of ['secrets/', 'secrets']) {
      const patterns = parseDockerIgnore(line.concat('\n'));
      expect(isExcludedFromBuild('secrets/admin_password', patterns), line).toBe(true);
      expect(isExcludedFromBuild('secrets', patterns), line).toBe(true);
    }
  });

  it('treats a question mark as one character, not a wildcard path', () => {
    const patterns = parseDockerIgnore('file?.txt'.concat('\n'));

    expect(isExcludedFromBuild('file1.txt', patterns)).toBe(true);
    expect(isExcludedFromBuild('file.txt', patterns)).toBe(false);
    expect(isExcludedFromBuild('dir/file1.txt', patterns)).toBe(false);
  });

  it('ignores comments and blank lines, including in the middle', () => {
    const patterns = parseDockerIgnore(['# a note', '', '  data  ', '  # another note'].join('\n'));

    expect(patterns).toEqual(['data']);
  });

  it('reads dots as dots', () => {
    // An unescaped `.` in a regular expression matches any character, which would turn `.env` into "any three
    // characters ending in env" — and `_env` or `xenv` would be excluded for no stated reason.
    const patterns = parseDockerIgnore('.env'.concat('\n'));

    expect(isExcludedFromBuild('.env', patterns)).toBe(true);
    expect(isExcludedFromBuild('xenv', patterns)).toBe(false);
  });
});
