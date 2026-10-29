import { describe, expect, it } from 'vitest';

import { CachePublicToggleBodySchema, CachePublicToggleResponseSchema } from '../src/cache';

describe('public cache toggle contracts', () => {
  it('accepts only a strict boolean request body', () => {
    expect(CachePublicToggleBodySchema.parse({ isPublic: true })).toEqual({ isPublic: true });
    expect(CachePublicToggleBodySchema.parse({ isPublic: false })).toEqual({ isPublic: false });
    for (const value of [undefined, null, {}, { isPublic: 'true' }, { isPublic: true, extra: 1 }]) {
      expect(CachePublicToggleBodySchema.safeParse(value).success).toBe(false);
    }
  });

  it('accepts the documented publication response and nullable timestamp', () => {
    expect(
      CachePublicToggleResponseSchema.parse({
        isPublic: true,
        publicSince: '2026-10-29T10:00:00.000Z',
      }),
    ).toEqual({ isPublic: true, publicSince: '2026-10-29T10:00:00.000Z' });
    expect(CachePublicToggleResponseSchema.parse({ isPublic: false, publicSince: null })).toEqual({
      isPublic: false,
      publicSince: null,
    });
    expect(
      CachePublicToggleResponseSchema.safeParse({ isPublic: false, publicSince: null, extra: true })
        .success,
    ).toBe(false);
  });
});
