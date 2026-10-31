import { describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../src/config/env';
import {
  ADMIN_EDITABLE_SETTING_KEYS,
  serializeAdminSettings,
} from '../src/modules/admin/settings-route';

const config = parseEnv({});

describe('admin settings serializer', () => {
  it('returns only allow-listed values and never serializes secret or system-owned rows', () => {
    const settings = serializeAdminSettings(
      [
        { key: 'branding.displayName', value: 'Mirror North' },
        { key: 'cache.keepVersions', value: 5 },
        { key: 'cache.diskReserveBytes', value: 4_000_000_000 },
        { key: 'public.downloadsPerMinute', value: 25 },
        { key: 'source.catalogTtlMinutes', value: 120 },
        { key: 'privacy.ipHashSalt', value: 'sensitive-salt' },
        { key: 'source.catalogSyncedAt', value: '2026-10-31T12:00:00.000Z' },
        { key: 'database.password', value: 'sensitive-password' },
      ],
      config,
    );

    expect(settings).toEqual({
      branding: { displayName: 'Mirror North' },
      cache: { keepVersions: 5, diskReserveBytes: 4_000_000_000 },
      public: { downloadsPerMinute: 25 },
      source: { catalogTtlMinutes: 120 },
    });
    expect(JSON.stringify(settings)).not.toContain('sensitive');
    expect(Object.keys(ADMIN_EDITABLE_SETTING_KEYS)).toEqual([
      'displayName',
      'keepVersions',
      'diskReserveBytes',
      'downloadsPerMinute',
      'catalogTtlMinutes',
    ]);
  });

  it('uses validated process defaults when no editable override is stored', () => {
    expect(serializeAdminSettings([], config)).toEqual({
      branding: { displayName: config.brandingDisplayName },
      cache: { keepVersions: 3, diskReserveBytes: config.diskReserveBytes },
      public: { downloadsPerMinute: config.publicDownloadsPerMinute },
      source: { catalogTtlMinutes: config.catalogTtlMinutes },
    });
  });

  it('falls back per key and warns when a persisted editable value is malformed', () => {
    const warn = vi.fn<(key: string) => void>();
    expect(
      serializeAdminSettings(
        [
          { key: 'branding.displayName', value: '   ' },
          { key: 'cache.keepVersions', value: 11 },
          { key: 'public.downloadsPerMinute', value: 20 },
        ],
        config,
        warn,
      ),
    ).toEqual({
      branding: { displayName: config.brandingDisplayName },
      cache: { keepVersions: 3, diskReserveBytes: config.diskReserveBytes },
      public: { downloadsPerMinute: 20 },
      source: { catalogTtlMinutes: config.catalogTtlMinutes },
    });
    expect(warn.mock.calls.map(([key]) => key)).toEqual([
      'branding.displayName',
      'cache.keepVersions',
    ]);
  });
});
