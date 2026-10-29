import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import { runHousekeeping } from '../../src/lib/housekeeping';
import { issueToken } from '../../src/modules/auth/tokens';
import { createUploadStorage } from '../../src/modules/storage/upload-storage';
import type { SqlDatabase } from '../../src/index';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/**
 * Acceptance test for the boot housekeeping that `P1-AUTH-02` introduced and pass 22 repaired.
 *
 * The bug this file exists for: the first version ran the pruning `DELETE` inline in `start()`, **before** `listen`,
 * with no bound. A single row lock held by another transaction made it wait, and while it waited the process had not
 * opened its port — measured with a real process, `healthz` never answered and the log stopped after the schema check.
 * The fix is two properties, and both are asserted here against a real database:
 *
 * 1. a contended statement is **abandoned** (not waited on), and
 * 2. the attempt is **not fatal** — the caller gets `null` and serving continues.
 */

const skipReason = await freshDatabaseSkipReason();

const NOW = new Date('2026-10-25T09:00:00.000Z');

/** A logger that records what it was told, so "warned" and "stayed quiet" are both observable. */
function recordingLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

/** Inserts an admin and one token that expired `daysAgo` days before {@link NOW}; returns the token id. */
async function seedExpiredToken(database: SqlDatabase, daysAgo: number): Promise<string> {
  // One admin per database: `admins_username_key` is unique on `lower(username)`, so seeding two tokens must reuse it.
  const existing = await database.db.selectFrom('admins').select('id').executeTakeFirst();
  const admin =
    existing ??
    (await database.db
      .insertInto('admins')
      .values({ username: 'admin', password_hash: '$argon2id$placeholder' })
      .returning('id')
      .executeTakeFirstOrThrow());

  const issued = await issueToken(database.db, admin.id, {
    ttlHours: 1,
    now: new Date(NOW.getTime() - daysAgo * 86_400_000 - 3_600_000),
  });
  return issued.tokenId;
}

/** Counts token rows. */
async function tokenCount(database: SqlDatabase): Promise<number> {
  const result = await database.db
    .selectFrom('admin_tokens')
    .select(sql<number>`count(*)::int`.as('count'))
    .executeTakeFirstOrThrow();
  return result.count;
}

describe.skipIf(skipReason !== null)('runHousekeeping', () => {
  it('deletes rows expired past the retention window and says so', async () => {
    await withFreshDatabase(
      async (database) => {
        await seedExpiredToken(database, 40);
        const fresh = await seedExpiredToken(database, 20);
        const log = recordingLog();

        await expect(runHousekeeping(database.db, log, { now: NOW })).resolves.toBe(1);

        expect(log.info).toHaveBeenCalledWith({ pruned: 1 }, 'expired tokens pruned');
        expect(log.warn).not.toHaveBeenCalled();
        const remaining = await database.db.selectFrom('admin_tokens').select('id').execute();
        expect(remaining.map((row) => row.id)).toEqual([fresh]);
      },
      { prefix: 'hk', migrate: true },
    );
  });

  it('stays quiet when there is nothing to prune', async () => {
    await withFreshDatabase(
      async (database) => {
        await seedExpiredToken(database, 20);
        const log = recordingLog();

        await expect(runHousekeeping(database.db, log, { now: NOW })).resolves.toBe(0);

        // A line every boot saying "0 rows" trains people to ignore the line.
        expect(log.info).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
        expect(await tokenCount(database)).toBe(1);
      },
      { prefix: 'hk', migrate: true },
    );
  });

  it('gives up on a locked row instead of waiting, and deletes nothing', async () => {
    await withFreshDatabase(
      async (database, name) => {
        const locked = await seedExpiredToken(database, 40);
        const log = recordingLog();

        // A second connection holds the row, exactly as a long-lived transaction elsewhere would. Without this lock the
        // statement is a millisecond of work; with it, the difference between "bounded" and "hangs" is the fix.
        const blocker = new pg.Client({ connectionString: dsnFor(name) });
        await blocker.connect();
        try {
          await blocker.query('begin');
          await blocker.query('select id from admin_tokens where id = $1 for update', [locked]);

          const started = performance.now();
          const result = await runHousekeeping(database.db, log, { now: NOW, timeoutMs: 400 });
          const elapsed = performance.now() - started;

          // Abandoned, not waited on: the bound is 400 ms, and the assertion allows a generous multiple of it rather
          // than a tight one, because a test that fails on a slow machine teaches the wrong lesson.
          expect(result).toBeNull();
          expect(elapsed).toBeLessThan(4_000);
          expect(log.warn).toHaveBeenCalledTimes(1);
          expect(log.warn.mock.calls[0]?.[1]).toContain('could not run housekeeping');

          // Nothing was deleted, and the row is still there afterwards — the statement rolled back.
          await blocker.query('rollback');
          expect(await tokenCount(database)).toBe(1);

          // ...and the next boot does the work, now that the lock is gone.
          await expect(runHousekeeping(database.db, log, { now: NOW })).resolves.toBe(1);
          expect(await tokenCount(database)).toBe(0);
        } finally {
          await blocker.end().catch(() => undefined);
        }
      },
      { prefix: 'hk', migrate: true },
    );
  });

  it('runs with no options at all, which is how the boot calls it', async () => {
    // Production passes neither `now` nor `timeoutMs`. A default that only the tests exercised would leave the real
    // call shape unproven — and the default clock is the one that decides what "40 days ago" means at boot.
    await withFreshDatabase(
      async (database) => {
        await seedExpiredToken(database, 40);
        const log = recordingLog();

        await expect(runHousekeeping(database.db, log)).resolves.toBe(1);
        expect(log.info).toHaveBeenCalledWith({ pruned: 1 }, 'expired tokens pruned');
        expect(await tokenCount(database)).toBe(0);
      },
      { prefix: 'hk', migrate: true },
    );
  });

  it('removes expired upload files and rows but leaves a future session and an active install alone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mapirror-expired-uploads-'));
    const uploadStorage = createUploadStorage(directory);
    const expiredId = '2f99631f-8a5f-43c3-9fcb-c0e03f5fb001';
    const installingId = '2f99631f-8a5f-43c3-9fcb-c0e03f5fb002';
    const freshId = '2f99631f-8a5f-43c3-9fcb-c0e03f5fb003';

    async function stage(uploadId: string, content: string): Promise<void> {
      const handle = await uploadStorage.file(uploadId).openForWrite();
      await handle.writeFile(content);
      await handle.close();
    }

    try {
      await stage(expiredId, 'expired bytes');
      await stage(installingId, 'active install bytes');
      await stage(freshId, 'new bytes');

      await withFreshDatabase(
        async (database) => {
          const country = await database.db
            .insertInto('countries')
            .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const oldCreatedAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
          await database.db
            .insertInto('upload_sessions')
            .values([
              {
                country_id: country.id,
                version: '261024',
                original_name: 'finland.osm.pbf',
                temp_path: uploadStorage.file(expiredId).relativePath,
                created_at: oldCreatedAt,
                expires_at: new Date(NOW.getTime() - 1),
              },
              {
                country_id: country.id,
                version: '261023',
                original_name: 'finland.osm.pbf',
                temp_path: uploadStorage.file(installingId).relativePath,
                status: 'installing',
                created_at: oldCreatedAt,
                expires_at: new Date(NOW.getTime() - 1),
              },
              {
                country_id: country.id,
                version: '261025',
                original_name: 'finland.osm.pbf',
                temp_path: uploadStorage.file(freshId).relativePath,
                created_at: NOW,
                expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
              },
            ])
            .execute();

          const log = recordingLog();
          await expect(
            runHousekeeping(database.db, log, { now: NOW, uploadStorage }),
          ).resolves.toBe(1);
          expect(log.info).toHaveBeenCalledWith({ pruned: 1 }, 'expired upload sessions pruned');
          expect(log.warn).not.toHaveBeenCalled();

          const remaining = await database.db
            .selectFrom('upload_sessions')
            .select(['temp_path', 'status'])
            .orderBy('temp_path')
            .execute();
          expect(remaining).toEqual([
            { temp_path: `${freshId}.osm.pbf`, status: 'received' },
            { temp_path: `${installingId}.osm.pbf`, status: 'installing' },
          ]);
          await expect(uploadStorage.file(expiredId).size()).resolves.toBe(0n);
          await expect(
            readFile(join(directory, uploadStorage.file(installingId).relativePath), 'utf8'),
          ).resolves.toBe('active install bytes');
          await expect(
            readFile(join(directory, uploadStorage.file(freshId).relativePath), 'utf8'),
          ).resolves.toBe('new bytes');
        },
        { prefix: 'hk-upload', migrate: true },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a corrupt temp_path without deleting outside TMP_DIR or its database row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mapirror-invalid-upload-path-'));
    const outside = await mkdtemp(join(tmpdir(), 'mapirror-outside-upload-'));
    const externalFile = join(outside, 'keep.osm.pbf');
    const uploadStorage = createUploadStorage(directory);
    try {
      await writeFile(externalFile, 'external bytes');
      await withFreshDatabase(
        async (database) => {
          const country = await database.db
            .insertInto('countries')
            .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const session = await database.db
            .insertInto('upload_sessions')
            .values({
              country_id: country.id,
              version: '261024',
              original_name: 'finland.osm.pbf',
              temp_path: '../outside-upload/keep.osm.pbf',
              created_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
              expires_at: new Date(NOW.getTime() - 1),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const log = recordingLog();

          await expect(
            runHousekeeping(database.db, log, { now: NOW, uploadStorage }),
          ).resolves.toBe(0);
          expect(log.warn).toHaveBeenCalledTimes(1);
          expect(
            await database.db
              .selectFrom('upload_sessions')
              .select('id')
              .where('id', '=', session.id)
              .execute(),
          ).toEqual([{ id: session.id }]);
          await expect(readFile(externalFile, 'utf8')).resolves.toBe('external bytes');
        },
        { prefix: 'hk-upload-path', migrate: true },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports a database that cannot answer, rather than throwing at the boot', async () => {
    await withFreshDatabase(
      async (database) => {
        const log = recordingLog();
        // Closing the handle is the shape of "the pool is gone" — what a shutdown racing the housekeeping looks like.
        // The boot must survive it: this runs fire-and-forget from `start()`.
        await database.close();

        await expect(runHousekeeping(database.db, log, { now: NOW })).resolves.toBeNull();
        expect(log.warn).toHaveBeenCalledTimes(1);
      },
      { prefix: 'hk', migrate: true },
    );
  });
});
