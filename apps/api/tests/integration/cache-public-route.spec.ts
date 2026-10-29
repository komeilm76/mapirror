import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { listPublicCountries } from '../../src/db/repositories/public-catalog';

import { buildApp, parseEnv } from '../../src/index';
import { issueToken } from '../../src/modules/auth/tokens';
import { dsnFor, freshDatabaseSkipReason, withFreshDatabase } from '../helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe.skipIf(skipReason !== null)('POST /_admin/api/cache/:countryId/public', () => {
  it('publishes and unpublishes atomically, guards readiness, and leaves versions intact', async () => {
    await withFreshDatabase(
      async (database, name) => {
        const admin = await database.db
          .insertInto('admins')
          .values({ username: 'cache-public-admin', password_hash: 'unused' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const token = await issueToken(database.db, admin.id, { ttlHours: 12 });
        const countries = await database.db
          .insertInto('countries')
          .values([
            {
              source_id: 'europe/finland',
              parent_id: 'europe',
              slug: 'finland',
              name: 'Finland',
              iso_alpha2: ['FI'],
            },
            {
              source_id: 'europe/norway',
              parent_id: 'europe',
              slug: 'norway',
              name: 'Norway',
              iso_alpha2: ['NO'],
            },
          ])
          .returning(['id', 'slug'])
          .execute();
        const id = (slug: string): string => {
          const country = countries.find((row) => row.slug === slug);
          if (country === undefined) throw new Error(`seed country ${slug} is missing`);
          return country.id;
        };
        const finlandId = id('finland');
        const norwayId = id('norway');
        const cacheSeededAt = new Date('2026-10-01T00:00:00.000Z');
        await database.db
          .insertInto('country_cache')
          .values([
            { country_id: finlandId, created_at: cacheSeededAt, updated_at: cacheSeededAt },
            { country_id: norwayId, created_at: cacheSeededAt, updated_at: cacheSeededAt },
          ])
          .execute();
        const readyVersion = await database.db
          .insertInto('map_versions')
          .values({
            country_id: finlandId,
            version: '261023',
            origin: 'geofabrik_snapshot',
            source_filename: 'finland-261023.osm.pbf',
            file_size_bytes: 100,
            checksum_md5: 'd41d8cd98f00b204e9800998ecf8427e',
            storage_path: 'finland/261023/finland-261023.osm.pbf',
            status: 'ready',
            ready_at: new Date('2026-10-23T20:20:51.000Z'),
            data_timestamp: new Date('2026-10-23T20:00:00.000Z'),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await database.db
          .insertInto('map_versions')
          .values({
            country_id: norwayId,
            version: '261023',
            origin: 'geofabrik_snapshot',
            source_filename: 'norway-261023.osm.pbf',
            file_size_bytes: 0,
            storage_path: 'norway/261023/norway-261023.osm.pbf',
            status: 'pending',
          })
          .execute();

        const app = await buildApp({
          config: parseEnv({ DATABASE_URL: dsnFor(name) }),
          database,
        });
        const toggle = (countryId: string, isPublic: boolean) =>
          app.inject({
            method: 'POST',
            url: `/_admin/api/cache/${countryId}/public`,
            headers: { authorization: `Bearer ${token.token}` },
            payload: { isPublic },
          });
        try {
          const published = await toggle(finlandId, true);
          expect(published.statusCode).toBe(200);
          const publication = published.json<{ isPublic: boolean; publicSince: string | null }>();
          expect(publication.isPublic).toBe(true);
          expect(publication.publicSince).toMatch(/^\d{4}-\d\d-\d\dT/u);
          const afterPublish = await database.db
            .selectFrom('country_cache')
            .select(['is_public', 'public_since', 'updated_at'])
            .where('country_id', '=', finlandId)
            .executeTakeFirstOrThrow();
          expect(afterPublish.is_public).toBe(true);
          expect(afterPublish.public_since?.toISOString()).toBe(publication.publicSince);
          expect(afterPublish.updated_at.getTime()).toBeGreaterThan(cacheSeededAt.getTime());
          expect(afterPublish.updated_at.toISOString()).toBe(publication.publicSince);
          const repeated = await toggle(finlandId, true);
          expect(repeated.statusCode).toBe(200);
          expect(repeated.json()).toEqual(publication);
          await expect(listPublicCountries(database.db, { limit: 10 })).resolves.toMatchObject({
            total: '1',
            rows: [{ slug: 'finland' }],
          });

          const unpublished = await toggle(finlandId, false);
          expect(unpublished.statusCode).toBe(200);
          expect(unpublished.json()).toEqual({ isPublic: false, publicSince: null });
          await expect(listPublicCountries(database.db, { limit: 10 })).resolves.toMatchObject({
            total: '0',
            rows: [],
          });
          expect(
            await database.db
              .selectFrom('map_versions')
              .select('id')
              .where('id', '=', readyVersion.id)
              .executeTakeFirst(),
          ).toBeDefined();

          const audit = await database.db
            .selectFrom('audit_logs')
            .select(['actor_id', 'actor_name', 'action', 'target_id', 'metadata', 'created_at'])
            .where('target_id', '=', finlandId)
            .orderBy('action', 'asc')
            .execute();
          expect(audit).toHaveLength(2);
          expect(audit[0]?.created_at.toISOString()).toBe(publication.publicSince);
          expect(audit).toMatchObject([
            {
              actor_id: admin.id,
              actor_name: 'cache-public-admin',
              action: 'cache.publish',
              target_id: finlandId,
              metadata: { slug: 'finland', beforeIsPublic: false, afterIsPublic: true },
            },
            {
              actor_id: admin.id,
              actor_name: 'cache-public-admin',
              action: 'cache.unpublish',
              target_id: finlandId,
              metadata: { slug: 'finland', beforeIsPublic: true, afterIsPublic: false },
            },
          ]);

          const noReadyVersion = await toggle(norwayId, true);
          expect(noReadyVersion.statusCode).toBe(422);
          expect(noReadyVersion.json<{ error: { code: string } }>().error.code).toBe(
            'NO_READY_VERSION',
          );
          expect(
            await database.db
              .selectFrom('country_cache')
              .select('is_public')
              .where('country_id', '=', norwayId)
              .executeTakeFirstOrThrow(),
          ).toEqual({ is_public: false });

          // Force the append-only audit insert to fail: the country update must roll back with it.
          await database.db.schema
            .alterTable('audit_logs')
            .addCheckConstraint('test_reject_cache_publish_audit', sql`action <> 'cache.publish'`)
            .execute();
          const auditFailure = await toggle(finlandId, true);
          expect(auditFailure.statusCode).toBe(500);
          expect(auditFailure.json<{ error: { code: string } }>().error.code).toBe(
            'INTERNAL_ERROR',
          );
          expect(
            await database.db
              .selectFrom('country_cache')
              .select(['is_public', 'public_since'])
              .where('country_id', '=', finlandId)
              .executeTakeFirstOrThrow(),
          ).toEqual({ is_public: false, public_since: null });
          await expect(listPublicCountries(database.db, { limit: 10 })).resolves.toMatchObject({
            total: '0',
            rows: [],
          });
        } finally {
          await app.close();
        }
      },
      { prefix: 'cachepublic', migrate: true },
    );
  });
});
