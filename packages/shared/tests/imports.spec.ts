import { describe, expect, it } from 'vitest';

import {
  ImportMultipartFieldsSchema,
  ImportResponseSchema,
  ImportStatusResponseSchema,
} from '../src/imports';

describe('import multipart contracts', () => {
  const countryId = 'df313a9d-0f4c-45df-922e-939531ad4487';

  it('parses required fields and defaults the omitted replace flag to false', () => {
    expect(ImportMultipartFieldsSchema.parse({ countryId, version: '2026-10-30' })).toEqual({
      countryId,
      version: '2026-10-30',
      replace: false,
    });
  });

  it.each([
    ['bad country UUID', { countryId: 'finland', version: '261030' }],
    ['missing version', { countryId }],
    ['invalid version characters', { countryId, version: '../261030' }],
    ['too-long version', { countryId, version: 'a'.repeat(33) }],
    ['invalid replace literal', { countryId, version: '261030', replace: 'yes' }],
    ['unknown form field', { countryId, version: '261030', extra: 'no' }],
  ])('rejects %s', (_label, value) => {
    expect(ImportMultipartFieldsSchema.safeParse(value).success).toBe(false);
  });

  it('accepts only the documented 202 response shape', () => {
    const response = {
      uploadId: 'b36e3543-cb6a-4f98-b10c-8eb69e7c8755',
      jobId: 'e303204b-e113-42a0-a867-825886010115',
      version: '261030',
    };
    expect(ImportResponseSchema.parse(response)).toEqual(response);
    expect(ImportResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
  });

  it('validates the safe import status projection and safe job errors', () => {
    const response = {
      status: 'installing',
      sizeBytes: 512,
      checksumMd5: null,
      jobId: 'e303204b-e113-42a0-a867-825886010115',
      error: { code: 'WORKER_LOST', message: 'The worker stopped before this job completed.' },
    };
    expect(ImportStatusResponseSchema.parse(response)).toEqual(response);
    expect(ImportStatusResponseSchema.safeParse({ ...response, rawError: 'secret' }).success).toBe(
      false,
    );
    expect(
      ImportStatusResponseSchema.safeParse({
        ...response,
        error: { code: 'INTERNAL', message: 'secret' },
      }).success,
    ).toBe(false);
  });
});
