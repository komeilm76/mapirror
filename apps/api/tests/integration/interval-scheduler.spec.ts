import { sql, type Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/db/schema';
import { scheduleDueIntervalsOnce } from '../../src/modules/intervals/scheduler';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const overdueAt = new Date('2000-01-01T00:00:00.000Z');

describe.skipIf(skipReason !== null)('interval scheduler', () => {
  it('atomically records a scheduled run, per-country jobs/items, and a future occurrence', async () => {
    await withFreshDatabase(
      async (database) => {
        const first = await insertCountry(database.db, 'finland');
        const second = await insertCountry(database.db, 'sweden');
        const interval = await insertInterval(database.db, 'Nordics nightly', overdueAt);
        await database.db
          .insertInto('interval_countries')
          .values([
            { interval_id: interval.id, country_id: first.id },
            { interval_id: interval.id, country_id: second.id },
          ])
          .execute();

        const log = createLog();
        const result = await scheduleDueIntervalsOnce(database.db, log);
        expect(result).toEqual({ scheduled: 1, overlaps: 0, empty: 0, failed: 0 });

        const run = await database.db
          .selectFrom('interval_runs')
          .selectAll()
          .where('interval_id', '=', interval.id)
          .executeTakeFirstOrThrow();
        expect(run).toMatchObject({
          interval_id: interval.id,
          triggered_by: 'schedule',
          status: 'running',
          countries_total: 2,
          countries_ok: 0,
          countries_failed: 0,
          countries_skipped: 0,
        });

        const jobs = await sql<{
          job_id: string;
          country_id: string;
          version: string;
          origin: string;
          only_if_changed: string;
          keep_versions: string;
          type: string;
          status: string;
        }>`
          select id as job_id,
                 payload ->> 'countryId' as country_id,
                 payload ->> 'version' as version,
                 payload ->> 'origin' as origin,
                 payload ->> 'onlyIfChanged' as only_if_changed,
                 payload ->> 'keepVersions' as keep_versions,
                 type::text as type,
                 status::text as status
            from jobs
           order by country_id
        `.execute(database.db);
        const jobsWithoutId = jobs.rows.map(({ job_id, ...job }) => {
          expect(job_id).toMatch(/^[0-9a-f-]{36}$/);
          return job;
        });
        expect(jobsWithoutId).toEqual(
          [first, second]
            .map((country) => ({
              country_id: country.id,
              version: 'latest',
              origin: 'geofabrik_latest',
              only_if_changed: 'true',
              keep_versions: '3',
              type: 'download',
              status: 'queued',
            }))
            .sort((left, right) => left.country_id.localeCompare(right.country_id)),
        );

        const items = await database.db
          .selectFrom('interval_run_items')
          .select(['country_id', 'country_slug', 'country_name', 'job_id', 'status'])
          .where('run_id', '=', run.id)
          .orderBy('country_slug', 'asc')
          .execute();
        const itemsWithoutId = items.map(({ job_id, ...item }) => {
          expect(job_id).toMatch(/^[0-9a-f-]{36}$/);
          return item;
        });
        expect(itemsWithoutId).toEqual([
          {
            country_id: first.id,
            country_slug: 'finland',
            country_name: 'Finland',
            status: 'queued',
          },
          {
            country_id: second.id,
            country_slug: 'sweden',
            country_name: 'Sweden',
            status: 'queued',
          },
        ]);
        expect(
          items
            .map(({ country_id, job_id }) => ({ country_id, job_id }))
            .sort((left, right) => left.country_id!.localeCompare(right.country_id!)),
        ).toEqual(
          jobs.rows
            .map(({ country_id, job_id }) => ({ country_id, job_id }))
            .sort((left, right) => left.country_id.localeCompare(right.country_id)),
        );

        const updated = await database.db
          .selectFrom('intervals')
          .select('next_run_at')
          .where('id', '=', interval.id)
          .executeTakeFirstOrThrow();
        expect(updated.next_run_at.getTime()).toBeGreaterThan(Date.now());
        expect(log.info).toHaveBeenCalledWith(
          expect.objectContaining({ intervalId: interval.id, runId: run.id, countryCount: 2 }),
          'interval run and country download jobs scheduled',
        );
      },
      { prefix: 'intervalschedule', migrate: true },
    );
  });

  it('does not double-fire when scheduler passes race for the same due interval', async () => {
    await withFreshDatabase(
      async (database) => {
        const country = await insertCountry(database.db, 'finland');
        const interval = await insertInterval(database.db, 'Nightly', overdueAt);
        await database.db
          .insertInto('interval_countries')
          .values({ interval_id: interval.id, country_id: country.id })
          .execute();

        const log = createLog();
        const passes = await Promise.all([
          scheduleDueIntervalsOnce(database.db, log),
          scheduleDueIntervalsOnce(database.db, log),
        ]);
        expect(passes.reduce((sum, pass) => sum + pass.scheduled, 0)).toBe(1);
        expect(
          await database.db
            .selectFrom('interval_runs')
            .select('id')
            .where('interval_id', '=', interval.id)
            .execute(),
        ).toHaveLength(1);
        expect(await database.db.selectFrom('jobs').select('id').execute()).toHaveLength(1);
      },
      { prefix: 'intervalrace', migrate: true },
    );
  });

  it('advances an overlapping occurrence without creating a second run or job', async () => {
    await withFreshDatabase(
      async (database) => {
        const country = await insertCountry(database.db, 'finland');
        const interval = await insertInterval(database.db, 'Nightly', overdueAt);
        await database.db
          .insertInto('interval_countries')
          .values({ interval_id: interval.id, country_id: country.id })
          .execute();
        await database.db
          .insertInto('interval_runs')
          .values({ interval_id: interval.id, triggered_by: 'schedule' })
          .execute();

        const log = createLog();
        const result = await scheduleDueIntervalsOnce(database.db, log);
        expect(result).toEqual({ scheduled: 0, overlaps: 1, empty: 0, failed: 0 });
        expect(await database.db.selectFrom('interval_runs').select('id').execute()).toHaveLength(
          1,
        );
        expect(await database.db.selectFrom('jobs').select('id').execute()).toEqual([]);
        const updated = await database.db
          .selectFrom('intervals')
          .select('next_run_at')
          .where('id', '=', interval.id)
          .executeTakeFirstOrThrow();
        expect(updated.next_run_at.getTime()).toBeGreaterThan(Date.now());
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'SKIPPED_OVERLAP', intervalId: interval.id }),
          'interval occurrence skipped because its previous run is still active',
        );
      },
      { prefix: 'intervaloverlap', migrate: true },
    );
  });

  it('records an empty schedule as succeeded instead of leaving an unfinishable running row', async () => {
    await withFreshDatabase(
      async (database) => {
        const interval = await insertInterval(database.db, 'Empty schedule', overdueAt);
        const log = createLog();
        const result = await scheduleDueIntervalsOnce(database.db, log);
        expect(result).toEqual({ scheduled: 0, overlaps: 0, empty: 1, failed: 0 });
        const run = await database.db
          .selectFrom('interval_runs')
          .select(['status', 'countries_total', 'finished_at'])
          .where('interval_id', '=', interval.id)
          .executeTakeFirstOrThrow();
        expect(run).toMatchObject({ status: 'succeeded', countries_total: 0 });
        expect(run.finished_at).toBeInstanceOf(Date);
        expect(await database.db.selectFrom('jobs').select('id').execute()).toEqual([]);
      },
      { prefix: 'intervalempty', migrate: true },
    );
  });

  it('rolls back a run and its schedule advance on enqueue failure, but keeps processing other intervals', async () => {
    await withFreshDatabase(
      async (database) => {
        const blockedCountry = await insertCountry(database.db, 'finland');
        const healthyCountry = await insertCountry(database.db, 'sweden');
        const blockedAt = new Date('2000-01-01T00:00:00.000Z');
        const healthyAt = new Date('2001-01-01T00:00:00.000Z');
        const blocked = await insertInterval(database.db, 'Blocked', blockedAt);
        const healthy = await insertInterval(database.db, 'Healthy', healthyAt);
        await database.db
          .insertInto('interval_countries')
          .values([
            { interval_id: blocked.id, country_id: blockedCountry.id },
            { interval_id: healthy.id, country_id: healthyCountry.id },
          ])
          .execute();
        await database.db
          .insertInto('jobs')
          .values({
            type: 'download',
            payload: { countryId: blockedCountry.id, version: 'latest' },
          })
          .execute();

        const log = createLog();
        const result = await scheduleDueIntervalsOnce(database.db, log);
        expect(result).toEqual({ scheduled: 1, overlaps: 0, empty: 0, failed: 1 });
        expect(
          await database.db
            .selectFrom('interval_runs')
            .select('interval_id')
            .where('interval_id', '=', blocked.id)
            .execute(),
        ).toEqual([]);
        expect(
          await database.db
            .selectFrom('interval_runs')
            .select('interval_id')
            .where('interval_id', '=', healthy.id)
            .execute(),
        ).toHaveLength(1);
        expect(
          await database.db
            .selectFrom('interval_run_items')
            .select('run_id')
            .where('country_id', '=', blockedCountry.id)
            .execute(),
        ).toEqual([]);
        const unchanged = await database.db
          .selectFrom('intervals')
          .select('next_run_at')
          .where('id', '=', blocked.id)
          .executeTakeFirstOrThrow();
        expect(unchanged.next_run_at.getTime()).toBe(blockedAt.getTime());
        expect(await database.db.selectFrom('jobs').select('id').execute()).toHaveLength(2);
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ intervalId: blocked.id }),
          'interval scheduling transaction rolled back; occurrence remains due for retry',
        );
      },
      { prefix: 'intervalrollback', migrate: true },
    );
  });
});

async function insertCountry(database: Kysely<Database>, slug: string) {
  return database
    .insertInto('countries')
    .values({ source_id: `europe/${slug}`, slug, name: slug[0]!.toUpperCase() + slug.slice(1) })
    .returning('id')
    .executeTakeFirstOrThrow();
}

async function insertInterval(database: Kysely<Database>, name: string, nextRunAt: Date) {
  return database
    .insertInto('intervals')
    .values({ name, frequency: 'daily', next_run_at: nextRunAt })
    .returning('id')
    .executeTakeFirstOrThrow();
}

function createLog() {
  const spy = () => vi.fn((_context: object, _message: string): void => undefined);
  return { info: spy(), warn: spy(), error: spy() };
}
