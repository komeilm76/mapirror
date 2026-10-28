import { describe, expect, it } from 'vitest';

import { CatalogListResponseSchema, CatalogQuerySchema, JsonIntegerSchema } from '../src/catalog';

const row = {
  countryId: '00000000-0000-4000-8000-000000000001',
  sourceId: 'europe/finland',
  name: 'Finland',
  slug: 'finland',
  continent: 'europe',
  iso: ['FI'],
  sourceSizeHintBytes: 773_465_008,
  cache: {
    cached: true,
    versionsReady: 3,
    totalSizeBytes: 2_319_000_000,
    isPublic: true,
    updateState: 'update_available',
    availableVersion: '261024',
    availableSizeBytes: 774_000_000,
  },
  lastSyncedAt: '2026-10-24T06:00:00.000Z',
};

describe('catalog contracts', () => {
  it('accepts the documented query and rejects unknown enums and keys', () => {
    expect(
      CatalogQuerySchema.parse({
        q: ' fin ',
        continent: 'europe',
        cache: 'uncached',
        update: 'available',
        page: '2',
        limit: '50',
        sort: 'updated',
        order: 'desc',
      }),
    ).toMatchObject({ q: 'fin', sort: 'updated', order: 'desc' });
    expect(CatalogQuerySchema.safeParse({ cache: 'sometimes' }).success).toBe(false);
    expect(CatalogQuerySchema.safeParse({ arbitrary: 'value' }).success).toBe(false);
    expect(CatalogQuerySchema.safeParse({ q: 'a'.repeat(129) }).success).toBe(false);
  });

  it('accepts only safe non-negative JSON numbers or canonical decimal strings for int8 values', () => {
    expect(JsonIntegerSchema.safeParse(9_007_199_254_740_991).success).toBe(true);
    expect(JsonIntegerSchema.safeParse('9223372036854775807').success).toBe(true);
    expect(JsonIntegerSchema.safeParse(9_007_199_254_740_992).success).toBe(false);
    expect(JsonIntegerSchema.safeParse('-1').success).toBe(false);
    expect(JsonIntegerSchema.safeParse('01').success).toBe(false);
  });

  it('pins a strict catalog response shape and permits decimal strings for large byte counts', () => {
    const response = {
      data: [{ ...row, sourceSizeHintBytes: '9223372036854775807' }],
      meta: { page: 1, limit: 50, total: 1, totalPages: 1 },
      catalogSyncedAt: '2026-10-24T06:00:00.000Z',
    };
    expect(CatalogListResponseSchema.parse(response)).toEqual(response);
    expect(
      CatalogListResponseSchema.safeParse({ ...response, leaked: 'password_hash' }).success,
    ).toBe(false);
    expect(
      CatalogListResponseSchema.safeParse({ ...response, catalogSyncedAt: 'not a date' }).success,
    ).toBe(false);
  });
});
