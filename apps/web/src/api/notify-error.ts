/**
 * Maps an {@link ApiError} into a persistent, actionable toast (`P2-WEB-07`).
 *
 * Screens with a dedicated inline error state can keep using that state; action handlers that need global feedback use
 * this helper so the code-to-copy table, request id, and close-until-dismissed policy stay together.
 *
 * @module api/notify-error
 */

import type { ApiError } from './errors';
import { errorCopyFor } from './error-copy';
import type { useNotifications } from '../stores/notifications';

/** Optional context for a toast whose action has a more precise title or recovery step. */
export interface ApiErrorToastOverrides {
  /** A contextual sentence, for example "The import could not be started." */
  readonly message?: string;
  /** A contextual next step; defaults to the code's shared recovery guidance. */
  readonly detail?: string;
}

/**
 * Add a persistent, human-readable error toast with request id and concrete next-step guidance.
 *
 * @param notifications - The app's notification store.
 * @param error - The typed API failure.
 * @param overrides - Optional action-specific copy.
 * @returns The toast id, for a caller that needs to dismiss it after a later success.
 */
export function notifyApiError(
  notifications: ReturnType<typeof useNotifications>,
  error: ApiError,
  overrides: ApiErrorToastOverrides = {},
): number {
  const copy = errorCopyFor(error.code);
  return notifications.error(overrides.message ?? copy.message, {
    detail: overrides.detail ?? copy.action,
    requestId: error.requestId,
  });
}
