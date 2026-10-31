import { describe, expect, it } from 'vitest';

import {
  AdminSettingsQuerySchema,
  AdminSettingsResponseSchema,
  AdminSettingsUpdateSchema,
  AdminSettingsValuesSchema,
} from '../src/settings';

const settings = {
  branding: { displayName: 'MapMirror' },
  cache: { keepVersions: 3, diskReserveBytes: 2_147_483_648 },
  public: { downloadsPerMinute: 10 },
  source: { catalogTtlMinutes: 360 },
};

describe('admin settings contracts', () => {
  it('accepts an empty GET query and rejects attempts to request additional values', () => {
    expect(AdminSettingsQuerySchema.parse({})).toEqual({});
    expect(AdminSettingsQuerySchema.safeParse({ includeSecrets: true }).success).toBe(false);
  });

  it('accepts the complete safe response and rejects extra response keys', () => {
    expect(AdminSettingsResponseSchema.parse({ settings })).toEqual({ settings });
    expect(
      AdminSettingsResponseSchema.safeParse({
        settings: { ...settings, privacy: { ipHashSalt: 'secret' } },
      }).success,
    ).toBe(false);
  });

  it('accepts a partial nested patch and normalizes the display name', () => {
    expect(
      AdminSettingsUpdateSchema.parse({
        branding: { displayName: '  Mirror North  ' },
        cache: { keepVersions: 10 },
      }),
    ).toEqual({ branding: { displayName: 'Mirror North' }, cache: { keepVersions: 10 } });
  });

  it.each([
    {},
    { branding: {} },
    { privacy: { ipHashSalt: 'must-not-write' } },
    { cache: { keepVersions: 0 } },
    { cache: { keepVersions: 11 } },
    { cache: { diskReserveBytes: -1 } },
    { cache: { diskReserveBytes: 1.5 } },
    { public: { downloadsPerMinute: 0 } },
    { source: { catalogTtlMinutes: 0 } },
    { branding: { displayName: '   ' } },
    { branding: { displayName: 'x'.repeat(101) } },
  ])('rejects invalid or non-editable patch %j', (patch) => {
    expect(AdminSettingsUpdateSchema.safeParse(patch).success).toBe(false);
  });

  it('keeps defaults inside the documented domain and response schema', () => {
    expect(AdminSettingsValuesSchema.parse(settings)).toEqual(settings);
  });
});
