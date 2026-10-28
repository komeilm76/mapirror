import { describe, expect, it } from 'vitest';

import {
  IMPORT_STATUSES,
  INTERVAL_FREQUENCIES,
  JOB_PHASES,
  JOB_STATUSES,
  JOB_TYPES,
  LATEST_VERSION_ALIAS,
  MAX_DAY_OF_MONTH,
  PUBLIC_SORT_FIELDS,
  RUN_ITEM_STATUSES,
  SORT_FIELDS,
  SORT_ORDERS,
  STORAGE_STATES,
  TOKEN_BODY_LENGTH,
  TOKEN_LENGTH,
  TOKEN_PREFIX,
  TOKEN_RANDOM_BYTES,
  UPDATE_STATES,
  VERSION_ORIGINS,
  VERSION_STATUSES,
} from '@mapirror/shared';

/**
 * Pins the shared vocabulary against the database definition in `03-data-model.md`. The SQL `CHECK`s and
 * these tuples are the same set of values written twice; `scripts/tests/docs-contract.spec.ts` parses the
 * SQL and proves they still agree.
 */
describe('token format', () => {
  it('is mm_ followed by 43 base64url characters (256 bits)', () => {
    expect(TOKEN_PREFIX).toBe('mm_');
    expect(TOKEN_RANDOM_BYTES).toBe(32);
    expect(TOKEN_BODY_LENGTH).toBe(43);
    expect(TOKEN_LENGTH).toBe(46);
  });

  it('agrees with the entropy: 32 bytes is 43 base64url chars without padding', () => {
    // base64 works in 3-byte groups: ceil(32 / 3) = 11 groups = 44 chars, one of which is '=' padding.
    const padded = Math.ceil(TOKEN_RANDOM_BYTES / 3) * 4;
    expect(padded - 1).toBe(TOKEN_BODY_LENGTH);
  });
});

describe('enums mirror the database', () => {
  it('interval, job and version vocabularies', () => {
    expect([...INTERVAL_FREQUENCIES]).toEqual(['daily', 'weekly', 'monthly']);
    expect([...JOB_TYPES]).toEqual(['download', 'import', 'update_check', 'catalog_sync', 'prune']);
    expect([...JOB_STATUSES]).toEqual(['queued', 'running', 'succeeded', 'failed', 'canceled']);
    expect([...JOB_PHASES]).toEqual(['fetching_index', 'downloading', 'verifying', 'installing']);
    expect([...VERSION_ORIGINS]).toEqual(['geofabrik_snapshot', 'geofabrik_latest', 'upload']);
    expect([...VERSION_STATUSES]).toEqual(['pending', 'ready', 'failed']);
    expect([...UPDATE_STATES]).toEqual(['unknown', 'up_to_date', 'update_available']);
    expect([...STORAGE_STATES]).toEqual(['ok', 'low', 'full']);
    expect([...IMPORT_STATUSES]).toEqual([
      'received',
      'installing',
      'installed',
      'failed',
      'expired',
    ]);
    expect([...RUN_ITEM_STATUSES]).toEqual(['queued', 'skipped', 'downloaded', 'failed']);
  });

  it('has no duplicates in any list', () => {
    for (const list of [
      INTERVAL_FREQUENCIES,
      JOB_TYPES,
      JOB_STATUSES,
      JOB_PHASES,
      VERSION_ORIGINS,
      VERSION_STATUSES,
      UPDATE_STATES,
      STORAGE_STATES,
      IMPORT_STATUSES,
      RUN_ITEM_STATUSES,
      SORT_FIELDS,
      SORT_ORDERS,
    ]) {
      expect(new Set(list).size, String(list)).toBe(list.length);
    }
  });
});

describe('sort fields', () => {
  it('accepts the four documented fields, and the public subset without `created`', () => {
    expect([...SORT_FIELDS]).toEqual(['name', 'size', 'updated', 'created']);
    expect([...PUBLIC_SORT_FIELDS]).toEqual(['name', 'size', 'updated']);
    for (const field of PUBLIC_SORT_FIELDS) expect(SORT_FIELDS).toContain(field);
  });

  it('accepts asc and desc only', () => {
    expect([...SORT_ORDERS]).toEqual(['asc', 'desc']);
  });
});

describe('schedule and version limits', () => {
  it('caps monthly schedules at day 28 so every month exists', () => {
    expect(MAX_DAY_OF_MONTH).toBe(28);
  });

  it('reserves "latest" as the moving alias', () => {
    expect(LATEST_VERSION_ALIAS).toBe('latest');
  });
});
