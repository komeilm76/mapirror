import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BACKUP = join(ROOT, 'scripts/backup.sh');
const RESTORE = join(ROOT, 'scripts/restore.sh');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mapirror-backup-restore-'));
  const compose = join(directory, 'compose');
  const log = join(directory, 'compose.log');
  writeFileSync(
    compose,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$COMPOSE_LOG"
case "$*" in
  *pg_dump*)
    [[ pg_dump != "\${FAIL_AT:-}" ]] || exit 19
    printf 'test database dump\\n'
    ;;
  *cache-manifest.ts*)
    [[ cache-manifest != "\${FAIL_AT:-}" ]] || exit 19
    printf '{"format":"mapirror-cache-manifest","version":1,"generatedAt":"2026-11-02T00:00:00.000Z","artifacts":[]}\\n'
    ;;
  *pg_restore*)
    [[ pg_restore != "\${FAIL_AT:-}" ]] || exit 19
    ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(compose, 0o755);
  return { directory, compose, log };
}

describe('host backup and restore scripts', () => {
  it('pass Bash syntax checks', () => {
    for (const script of [BACKUP, RESTORE]) {
      const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it('publishes a backup directory only after both the dump and manifest succeed', () => {
    const state = fixture();
    const backupRoot = join(state.directory, 'archives');
    try {
      const result = spawnSync('bash', [BACKUP], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPOSE: state.compose,
          COMPOSE_LOG: state.log,
          BACKUP_ROOT: backupRoot,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const entries = readdirSync(backupRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}Z$/u);
      const destination = join(backupRoot, entries[0] as string);
      expect(readFileSync(join(destination, 'database.dump'), 'utf8')).toContain(
        'test database dump',
      );
      expect(
        JSON.parse(readFileSync(join(destination, 'cache-manifest.json'), 'utf8')),
      ).toMatchObject({
        format: 'mapirror-cache-manifest',
        version: 1,
        artifacts: [],
      });
      expect(readFileSync(state.log, 'utf8')).toContain('exec -T db pg_dump');
      expect(readFileSync(state.log, 'utf8')).toContain(
        'run -T --rm --no-deps --build api bun scripts/cache-manifest.ts',
      );
    } finally {
      rmSync(state.directory, { recursive: true, force: true });
    }
  });

  it('does not leave a publishable backup when pg_dump fails', () => {
    const state = fixture();
    const backupRoot = join(state.directory, 'archives');
    try {
      const result = spawnSync('bash', [BACKUP], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPOSE: state.compose,
          COMPOSE_LOG: state.log,
          BACKUP_ROOT: backupRoot,
          FAIL_AT: 'pg_dump',
        },
      });
      expect(result.status).not.toBe(0);
      expect(readdirSync(backupRoot)).toEqual([]);
    } finally {
      rmSync(state.directory, { recursive: true, force: true });
    }
  });

  it('removes the incomplete dump when cache manifest generation fails', () => {
    const state = fixture();
    const backupRoot = join(state.directory, 'archives');
    try {
      const result = spawnSync('bash', [BACKUP], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPOSE: state.compose,
          COMPOSE_LOG: state.log,
          BACKUP_ROOT: backupRoot,
          FAIL_AT: 'cache-manifest',
        },
      });
      expect(result.status).not.toBe(0);
      expect(readdirSync(backupRoot)).toEqual([]);
    } finally {
      rmSync(state.directory, { recursive: true, force: true });
    }
  });

  it('restores, reconciles before restart, and reports ready only after the API probe', () => {
    const state = fixture();
    const backupDirectory = join(state.directory, 'backup');
    mkdirSync(backupDirectory);
    writeFileSync(join(backupDirectory, 'database.dump'), 'dump');
    writeFileSync(join(backupDirectory, 'cache-manifest.json'), '{"artifacts":[]}');
    try {
      const result = spawnSync('bash', [RESTORE, backupDirectory], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, COMPOSE: state.compose, COMPOSE_LOG: state.log },
      });
      const calls = readFileSync(state.log, 'utf8').trim().split('\n').filter(Boolean);
      const index = (fragment: string) => calls.findIndex((call) => call.includes(fragment));

      expect(result.status, result.stderr).toBe(0);
      expect(index('build api')).toBeLessThan(index('stop api'));
      expect(index('stop api')).toBeLessThan(index('dropdb'));
      expect(index('pg_restore')).toBeLessThan(
        index('run --rm --no-deps api bun scripts/reconcile-cache.ts'),
      );
      expect(index('run --rm --no-deps api bun scripts/reconcile-cache.ts')).toBeLessThan(
        index('up -d api'),
      );
      expect(calls.at(-1)).toContain('127.0.0.1:3000/readyz');
      expect(result.stdout).toContain('restore complete');
    } finally {
      rmSync(state.directory, { recursive: true, force: true });
    }
  });

  it('leaves the API stopped when database restoration fails', () => {
    const state = fixture();
    const backupDirectory = join(state.directory, 'backup');
    mkdirSync(backupDirectory);
    writeFileSync(join(backupDirectory, 'database.dump'), 'dump');
    writeFileSync(join(backupDirectory, 'cache-manifest.json'), '{"artifacts":[]}');
    try {
      const result = spawnSync('bash', [RESTORE, backupDirectory], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPOSE: state.compose,
          COMPOSE_LOG: state.log,
          FAIL_AT: 'pg_restore',
        },
      });
      const calls = readFileSync(state.log, 'utf8');
      expect(result.status).not.toBe(0);
      expect(calls).toContain('stop api');
      expect(calls).not.toContain('up -d api');
    } finally {
      rmSync(state.directory, { recursive: true, force: true });
    }
  });
});
