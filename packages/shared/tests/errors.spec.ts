import { describe, expect, it } from 'vitest';

import {
  ERROR_STATUS,
  INTERNAL_ERROR_CODES,
  isErrorCode,
  isInternalErrorCode,
  statusFor,
  type ErrorEnvelope,
} from '@mapirror/shared';

/**
 * Pins the error table (L5, `04-api.md` §0.2).
 *
 * Status names are written out here rather than derived, so a change to the mapping has to be a visible
 * edit to the docs *and* this file.
 */
describe('ERROR_STATUS', () => {
  it('maps every code to the status the contract documents', () => {
    expect(ERROR_STATUS).toMatchObject({
      VALIDATION_ERROR: 400,
      BAD_REQUEST: 400,
      UNAUTHENTICATED: 401,
      TOKEN_EXPIRED: 401,
      TOKEN_REVOKED: 401,
      INVALID_CREDENTIALS: 401,
      FORBIDDEN: 403,
      ACCOUNT_DISABLED: 403,
      NOT_FOUND: 404,
      VERSION_DUPLICATE: 409,
      VERSION_ALREADY_CACHED: 409,
      JOB_ALREADY_RUNNING: 409,
      CONFIRMATION_REQUIRED: 409,
      VERSION_FILE_MISSING: 410,
      SOURCE_VERSION_GONE: 410,
      FILE_TOO_LARGE: 413,
      UNSUPPORTED_FORMAT: 415,
      SEMANTIC_ERROR: 422,
      NO_READY_VERSION: 422,
      RATE_LIMITED: 429,
      INTERNAL_ERROR: 500,
      SOURCE_UNAVAILABLE: 502,
      DB_UNAVAILABLE: 503,
      DISK_FULL: 503,
      NOT_READY: 503,
    });
  });

  it('contains exactly 25 codes', () => {
    expect(Object.keys(ERROR_STATUS)).toHaveLength(25);
  });

  it('uses only statuses the API is allowed to return', () => {
    const allowed = new Set([400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500, 502, 503]);
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      expect(allowed.has(status), `${code} → ${status}`).toBe(true);
    }
  });

  it('never returns a success status for an error code', () => {
    for (const status of Object.values(ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('keeps throttling and a disabled account apart (pass-1 defect 14)', () => {
    // 429 for throttling, 403 only for a deactivated account — and the deactivated account is
    // ACCOUNT_DISABLED, not a "locked" code that reads like a lockout.
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_STATUS.ACCOUNT_DISABLED).toBe(403);
    expect(Object.keys(ERROR_STATUS)).not.toContain('ACCOUNT_LOCKED');
  });

  it('does not leak existence through 404 alternatives', () => {
    // There is exactly one not-found code: a public "country not found" and "country not published"
    // must be indistinguishable, so no NOT_PUBLISHED/COUNTRY_HIDDEN code may exist.
    expect(
      Object.keys(ERROR_STATUS).filter((code) => ERROR_STATUS[code as 'NOT_FOUND'] === 404),
    ).toEqual(['NOT_FOUND']);
  });
});

describe('INTERNAL_ERROR_CODES', () => {
  it('lists the four codes that never travel as a status', () => {
    expect([...INTERNAL_ERROR_CODES]).toEqual([
      'WORKER_LOST',
      'RUN_INTERRUPTED',
      'SKIPPED_OVERLAP',
      'INVALID_ENV',
    ]);
  });

  it('overlaps with the HTTP table only where the contract says so', () => {
    const overlap = INTERNAL_ERROR_CODES.filter((code) => isErrorCode(code));
    expect(overlap).toEqual([]);
    // SOURCE_VERSION_GONE and VERSION_FILE_MISSING are HTTP codes that also appear as job error_code,
    // so they live in ERROR_STATUS only — not in the internal list.
    expect(isErrorCode('SOURCE_VERSION_GONE')).toBe(true);
    expect(isErrorCode('VERSION_FILE_MISSING')).toBe(true);
  });
});

describe('guards', () => {
  it('narrows known codes and rejects unknown ones', () => {
    expect(isErrorCode('NOT_FOUND')).toBe(true);
    expect(isErrorCode('not_found')).toBe(false);
    expect(isErrorCode('WORKER_LOST')).toBe(false);
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode('')).toBe(false);
  });

  it('narrows internal codes and rejects HTTP ones', () => {
    expect(isInternalErrorCode('WORKER_LOST')).toBe(true);
    expect(isInternalErrorCode('NOT_FOUND')).toBe(false);
    expect(isInternalErrorCode('constructor')).toBe(false);
  });

  it('looks up statuses', () => {
    expect(statusFor('NOT_FOUND')).toBe(404);
    expect(statusFor('DISK_FULL')).toBe(503);
  });
});

describe('ErrorEnvelope', () => {
  it('is the documented shape', () => {
    const envelope: ErrorEnvelope<{ countryId: string; version: string }> = {
      error: {
        code: 'VERSION_DUPLICATE',
        message: 'Version 260101 already exists for this country.',
        details: { countryId: 'c1', version: '260101' },
        requestId: '01J9',
      },
    };

    expect(envelope.error.code).toBe('VERSION_DUPLICATE');
    expect(statusFor(envelope.error.code)).toBe(409);
  });
});
