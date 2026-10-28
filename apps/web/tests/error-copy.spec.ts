import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { ERROR_STATUS, INTERNAL_ERROR_CODES, JobErrorSchema } from '@mapirror/shared';

import { ApiError, CLIENT_ERROR_CODES } from '../src/api/errors';
import { ERROR_COPY, errorCopyFor, type UiErrorCode } from '../src/api/error-copy';
import { notifyApiError } from '../src/api/notify-error';
import { useNotifications } from '../src/stores/notifications';

const DOCUMENTED_CODES = [
  ...Object.keys(ERROR_STATUS),
  ...INTERNAL_ERROR_CODES,
  ...JobErrorSchema.shape.code.options,
  ...CLIENT_ERROR_CODES,
] as const;

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('the web error-copy contract', () => {
  it('covers every HTTP, internal, safe job, and browser-only code exactly', () => {
    expect([...new Set(DOCUMENTED_CODES)].sort()).toEqual(Object.keys(ERROR_COPY).sort());
  });

  it('gives every code a human sentence and a useful next step', () => {
    for (const code of new Set(DOCUMENTED_CODES)) {
      const copy = errorCopyFor(code as UiErrorCode);
      expect(copy.message, `${code} message`).toMatch(/[.!?]$/u);
      expect(copy.message, `${code} message`).not.toBe(code);
      expect(copy.action, `${code} action`).toMatch(/[.!?]$/u);
      expect(copy.action.trim(), `${code} action`).not.toBe('');
    }
  });
});

describe('API error toast mapping', () => {
  it('uses stable code copy, preserves the request id, and remains until dismissed', () => {
    const notifications = useNotifications();
    const error = new ApiError({
      code: 'SOURCE_UNAVAILABLE',
      status: 502,
      message: 'The upstream source returned a temporary error.',
      requestId: 'req-source-001',
    });

    const id = notifyApiError(notifications, error);

    expect(notifications.items).toEqual([
      {
        id,
        kind: 'error',
        message: ERROR_COPY.SOURCE_UNAVAILABLE.message,
        detail: ERROR_COPY.SOURCE_UNAVAILABLE.action,
        requestId: 'req-source-001',
        timeout: null,
      },
    ]);
  });

  it('allows action-specific copy without losing the code-mapped request context', () => {
    const notifications = useNotifications();
    const error = new ApiError({
      code: 'JOB_ALREADY_RUNNING',
      status: 409,
      requestId: 'req-job-active-001',
    });

    notifyApiError(notifications, error, {
      message: 'The download was not started.',
      detail: 'Open the active job to follow its progress.',
    });

    expect(notifications.items[0]).toMatchObject({
      kind: 'error',
      message: 'The download was not started.',
      detail: 'Open the active job to follow its progress.',
      requestId: 'req-job-active-001',
      timeout: null,
    });
  });
});
