import { describe, expect, it } from 'vitest';

import { toErrorEnvelope } from '../../src/lib/errors';
import { enqueueDownloadJob } from '../../src/modules/jobs/enqueue-download';
import { AppError } from '../../src/lib/errors';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

/** The unique index and its race behavior belong to PostgreSQL, not an in-memory duplicate check. */
const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('PostgreSQL download enqueue guard', () => {
  it('maps a second queued/running country-version request to the documented 409', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const country = await db
          .insertInto('countries')
          .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const request = { countryId: country.id, version: '261023' };

        const jobId = await enqueueDownloadJob(db, request);
        expect(jobId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu);

        let duplicate: unknown;
        try {
          await enqueueDownloadJob(db, request);
        } catch (error) {
          duplicate = error;
        }
        expect(duplicate).toBeInstanceOf(AppError);
        expect(duplicate).toMatchObject({
          code: 'JOB_ALREADY_RUNNING',
          details: request,
          message: 'A download for this country and version is already queued or running.',
        });
        expect(toErrorEnvelope(duplicate, 'enqueue-test').status).toBe(409);

        await db.updateTable('jobs').set({ status: 'running' }).where('id', '=', jobId).execute();
        await expect(enqueueDownloadJob(db, request)).rejects.toMatchObject({
          code: 'JOB_ALREADY_RUNNING',
        });

        const active = await db
          .selectFrom('jobs')
          .select('id')
          .where('type', '=', 'download')
          .where('status', 'in', ['queued', 'running'])
          .execute();
        expect(active).toEqual([{ id: jobId }]);
      },
      { migrate: true, prefix: 'enqueueconflict' },
    );
  });

  it('lets PostgreSQL arbitrate simultaneous duplicate requests across connections', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const country = await db
          .insertInto('countries')
          .values({ source_id: 'europe/sweden', slug: 'sweden', name: 'Sweden' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const request = { countryId: country.id, version: '261024' };

        const results = await Promise.allSettled([
          enqueueDownloadJob(db, request),
          enqueueDownloadJob(db, request),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(rejected).toMatchObject({
          status: 'rejected',
          reason: { code: 'JOB_ALREADY_RUNNING' },
        });
        if (rejected?.status === 'rejected') {
          expect(toErrorEnvelope(rejected.reason, 'enqueue-race').status).toBe(409);
        }
        const count = await db
          .selectFrom('jobs')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('type', '=', 'download')
          .where('status', 'in', ['queued', 'running'])
          .executeTakeFirstOrThrow();
        expect(Number(count.count)).toBe(1);
      },
      { migrate: true, prefix: 'enqueuerace' },
    );
  });

  it('guards only the same active country/version and releases the key at terminal states', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const finland = await db
          .insertInto('countries')
          .values({ source_id: 'europe/finland', slug: 'finland', name: 'Finland' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const sweden = await db
          .insertInto('countries')
          .values({ source_id: 'europe/sweden', slug: 'sweden', name: 'Sweden' })
          .returning('id')
          .executeTakeFirstOrThrow();

        const original = await enqueueDownloadJob(db, {
          countryId: finland.id,
          version: '261023',
        });
        await expect(
          enqueueDownloadJob(db, { countryId: finland.id, version: 'latest' }),
        ).resolves.toMatch(/^[\da-f-]{36}$/iu);
        await expect(
          enqueueDownloadJob(db, { countryId: sweden.id, version: '261023' }),
        ).resolves.toMatch(/^[\da-f-]{36}$/iu);

        await db.updateTable('jobs').set({ status: 'failed' }).where('id', '=', original).execute();
        await expect(
          enqueueDownloadJob(db, { countryId: finland.id, version: '261023' }),
        ).resolves.toMatch(/^[\da-f-]{36}$/iu);
      },
      { migrate: true, prefix: 'enqueuekey' },
    );
  });

  it('does not misreport unrelated PostgreSQL errors as duplicate downloads', async () => {
    await withFreshDatabase(
      async ({ db }) => {
        const country = await db
          .insertInto('countries')
          .values({ source_id: 'europe/norway', slug: 'norway', name: 'Norway' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const missingAdmin = '00000000-0000-4000-8000-000000000099';
        await expect(
          enqueueDownloadJob(db, {
            countryId: country.id,
            version: '261023',
            createdBy: missingAdmin,
          }),
        ).rejects.toMatchObject({ code: '23503', constraint: 'jobs_created_by_fkey' });
      },
      { migrate: true, prefix: 'enqueueother' },
    );
  });
});
