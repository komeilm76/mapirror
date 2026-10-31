import { describe, expect, it, vi } from 'vitest';

import type { SqlDatabase } from '../../src/index';
import { createUpdateChecker } from '../../src/modules/updates/update-check';
import type { SourceRegionDetail } from '../../src/modules/geofabrik/source';
import { freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();
const COUNTRY = {
  source_id: 'europe/finland',
  parent_id: 'europe',
  slug: 'finland',
  name: 'Finland',
  iso_alpha2: ['FI'],
  iso_other: ['FI-01'],
  catalog_synced_at: new Date('2026-10-24T06:00:00.000Z'),
};
const CHECKED_AT = new Date('2026-10-25T12:00:00.000Z');

async function withUpdateCountry(
  run: (context: { database: SqlDatabase; countryId: string }) => Promise<void>,
) {
  await withFreshDatabase(
    async (database) => {
      const country = await database.db
        .insertInto('countries')
        .values(COUNTRY)
        .returning('id')
        .executeTakeFirstOrThrow();
      await database.db
        .insertInto('country_cache')
        .values({
          country_id: country.id,
          update_state: 'update_available',
          available_version: '261024',
          available_size_bytes: 1200,
          available_at: new Date('2026-10-24T20:20:51.000Z'),
          update_checked_at: new Date('2026-10-24T12:00:00.000Z'),
          versions_ready_count: 1,
          total_size_bytes: 1000,
        })
        .execute();
      await database.db
        .insertInto('map_versions')
        .values({
          country_id: country.id,
          version: '261023',
          origin: 'geofabrik_snapshot',
          source_url: 'https://download.example/finland-261023.osm.pbf',
          source_filename: 'finland-261023.osm.pbf',
          data_timestamp: new Date('2026-10-23T20:20:51.000Z'),
          file_size_bytes: 1000,
          checksum_md5: '0123456789abcdef0123456789abcdef',
          storage_path: 'finland/261023/finland-261023.osm.pbf',
          status: 'ready',
          ready_at: new Date('2026-10-23T21:00:00.000Z'),
        })
        .execute();
      await run({ database, countryId: country.id });
    },
    { prefix: 'updcheck', migrate: true },
  );
}

describe.skipIf(skipReason !== null)('persisted update checks', () => {
  it('persists an available update, then clears stale availability when the new snapshot is cached', async () => {
    await withUpdateCountry(async ({ database, countryId }) => {
      const sourceDetail: SourceRegionDetail = {
        version: '261024',
        dataTimestamp: new Date('2026-10-24T20:20:51.000Z'),
        sizeBytes: 1200,
        etag: null,
        lastModified: null,
      };
      const getRegionDetail = vi.fn(() => Promise.resolve(sourceDetail));
      let currentTime = new Date(CHECKED_AT);
      const checker = createUpdateChecker({
        database: database.db,
        source: { id: 'geofabrik', getRegionDetail },
        now: () => new Date(currentTime),
      });

      const available = await checker.check(countryId);
      expect(available).toMatchObject({
        state: 'update_available',
        availableVersion: '261024',
        availableSizeBytes: 1200,
        availableAt: sourceDetail.dataTimestamp,
        cached: {
          version: '261023',
          dataTimestamp: new Date('2026-10-23T20:20:51.000Z'),
          sizeBytes: '1000',
        },
        source: { version: '261024', dataTimestamp: sourceDetail.dataTimestamp, sizeBytes: 1200 },
        checkedAt: CHECKED_AT,
      });
      expect(
        await database.db
          .selectFrom('country_cache')
          .select([
            'update_state',
            'available_version',
            'available_size_bytes',
            'available_at',
            'update_checked_at',
          ])
          .where('country_id', '=', countryId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        update_state: 'update_available',
        available_version: '261024',
        available_size_bytes: '1200',
        available_at: sourceDetail.dataTimestamp,
        update_checked_at: CHECKED_AT,
      });

      await database.db
        .insertInto('map_versions')
        .values({
          country_id: countryId,
          version: '261024',
          origin: 'geofabrik_snapshot',
          source_url: 'https://download.example/finland-261024.osm.pbf',
          source_filename: 'finland-261024.osm.pbf',
          data_timestamp: sourceDetail.dataTimestamp,
          file_size_bytes: 1200,
          checksum_md5: 'abcdef0123456789abcdef0123456789',
          storage_path: 'finland/261024/finland-261024.osm.pbf',
          status: 'ready',
          ready_at: CHECKED_AT,
        })
        .execute();

      const current = await checker.check(countryId);
      expect(current.state).toBe('up_to_date');
      expect(getRegionDetail).toHaveBeenCalledTimes(1);
      currentTime = new Date(CHECKED_AT.getTime() + 10 * 60 * 1_000 + 1);
      expect((await checker.check(countryId)).state).toBe('up_to_date');
      expect(getRegionDetail).toHaveBeenCalledTimes(2);
      expect(
        await database.db
          .selectFrom('country_cache')
          .select(['update_state', 'available_version', 'available_size_bytes', 'available_at'])
          .where('country_id', '=', countryId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        update_state: 'up_to_date',
        available_version: null,
        available_size_bytes: null,
        available_at: null,
      });
    });
  });

  it('persists unknown on source failure and removes stale update claims', async () => {
    await withUpdateCountry(async ({ database, countryId }) => {
      const checker = createUpdateChecker({
        database: database.db,
        source: {
          id: 'geofabrik',
          getRegionDetail: () => Promise.reject(new Error('private upstream response detail')),
        },
        now: () => new Date(CHECKED_AT),
        log: { warn: vi.fn() },
      });

      await expect(checker.check(countryId)).resolves.toMatchObject({
        state: 'unknown',
        availableVersion: null,
        availableSizeBytes: null,
        availableAt: null,
        reason: 'The map source could not be checked.',
      });
      expect(
        await database.db
          .selectFrom('country_cache')
          .select(['update_state', 'available_version', 'available_size_bytes', 'available_at'])
          .where('country_id', '=', countryId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        update_state: 'unknown',
        available_version: null,
        available_size_bytes: null,
        available_at: null,
      });
    });
  });
});
