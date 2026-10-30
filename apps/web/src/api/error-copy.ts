/**
 * Human-facing error copy for every documented API, client, job, and startup code (`P2-WEB-07`).
 *
 * Server envelopes already carry safe sentences; this table is the browser's complete, stable fallback and the source
 * of next-step guidance for places that need to turn a code into a toast or inline explanation. Keep the HTTP code set
 * in sync with `packages/shared/src/errors.ts`, job codes with `JobErrorSchema`, and operational codes with
 * `INTERNAL_ERROR_CODES`.
 *
 * @module api/error-copy
 */

import type { InternalErrorCode, JobView } from '@mapirror/shared';

import type { ApiErrorCode } from './errors';

/** Safe job-projection error codes, inferred from the contract shared with the API. */
type JobErrorCode = NonNullable<JobView['error']>['code'];

/** Every code the web UI may display, including browser-only and non-HTTP operational failures. */
export type UiErrorCode = ApiErrorCode | InternalErrorCode | JobErrorCode;

/** A short explanation and the next useful action for a reader. */
export interface ErrorCopy {
  /** Human sentence naming what happened; never the machine code. */
  readonly message: string;
  /** A concrete next step, or an explanation when the reader cannot fix it directly. */
  readonly action: string;
}

/**
 * Complete user-facing copy for server HTTP errors, client failures, safe job errors, and operational codes.
 *
 * `Record` makes a newly added documented/shared code a type error until it receives copy. Runtime coverage is also
 * asserted in `tests/error-copy.spec.ts`, so schema/table changes cannot be missed by the UI review.
 */
export const ERROR_COPY = {
  VALIDATION_ERROR: {
    message: 'Some details need attention.',
    action: 'Review the highlighted fields and try again.',
  },
  BAD_REQUEST: {
    message: 'This request could not be understood.',
    action: 'Refresh the page and try again.',
  },
  UNAUTHENTICATED: {
    message: 'This browser is no longer signed in.',
    action: 'Sign in again to continue.',
  },
  TOKEN_EXPIRED: {
    message: 'The sign-in expired.',
    action: 'Sign in again to continue.',
  },
  TOKEN_REVOKED: {
    message: 'The session was signed out elsewhere.',
    action: 'Sign in again to continue.',
  },
  INVALID_CREDENTIALS: {
    message: 'That username and password do not match.',
    action: 'Check the spelling, then try again. An administrator can reset the password.',
  },
  FORBIDDEN: {
    message: 'You do not have permission to do this.',
    action: 'Ask an administrator if you believe you should have access.',
  },
  ACCOUNT_DISABLED: {
    message: 'This account has been deactivated.',
    action: 'Ask an administrator to re-enable it.',
  },
  NOT_FOUND: {
    message: 'This item could not be found.',
    action: 'Refresh the page or return to the list and try again.',
  },
  VERSION_DUPLICATE: {
    message: 'That version already exists or is being processed.',
    action:
      'Use the explicit replace confirmation for an eligible version, or wait for active work to finish.',
  },
  VERSION_ALREADY_CACHED: {
    message: 'That version is already cached.',
    action: 'Refresh the cache details to see the stored version.',
  },
  JOB_ALREADY_RUNNING: {
    message: 'Work for this country is already in progress.',
    action: 'Follow the active job before starting another.',
  },
  CONFIRMATION_REQUIRED: {
    message: 'Confirm this change before continuing.',
    action: 'Review the consequences and explicitly confirm the action.',
  },
  VERSION_FILE_MISSING: {
    message: 'The stored map file is missing.',
    action: 'Refresh the cache details; contact an administrator if the file is still listed.',
  },
  SOURCE_VERSION_GONE: {
    message: 'The selected source snapshot is no longer available.',
    action: 'Choose another version from the current source list.',
  },
  FILE_TOO_LARGE: {
    message: 'This file is larger than the upload limit.',
    action: 'Choose a smaller file and try again.',
  },
  UNSUPPORTED_FORMAT: {
    message: 'This file format is not supported.',
    action: 'Select a valid OpenStreetMap PBF file.',
  },
  SEMANTIC_ERROR: {
    message: 'This change conflicts with the current data.',
    action: 'Review the details and adjust the request before trying again.',
  },
  NO_READY_VERSION: {
    message: 'There is no completed map version to publish.',
    action: 'Download or import a version and wait for verification to finish.',
  },
  RATE_LIMITED: {
    message: 'Too many requests were made in a short time.',
    action: 'Wait for the cooldown to finish, then try again.',
  },
  INTERNAL_ERROR: {
    message: 'The server could not complete this request.',
    action: 'Try again. If the problem continues, share the request id with support.',
  },
  SOURCE_UNAVAILABLE: {
    message: 'The map source could not be reached.',
    action: 'Check the connection and retry; cached maps remain available.',
  },
  DB_UNAVAILABLE: {
    message: 'The data service is temporarily unavailable.',
    action: 'Wait briefly, then try again.',
  },
  DISK_FULL: {
    message: 'There is not enough disk space to complete this action.',
    action: 'Free up cache space or contact an administrator before retrying.',
  },
  NOT_READY: {
    message: 'The service is still starting.',
    action: 'Wait a moment and try again.',
  },
  JOB_HANDLER_FAILED: {
    message: 'The job could not be completed.',
    action:
      'The worker retries with backoff while attempts remain; if it ends in failure, start the work again.',
  },
  WORKER_LOST: {
    message: 'The worker stopped before this job completed.',
    action:
      'The system retries with backoff while attempts remain; if it ends in failure, start the work again.',
  },
  RUN_INTERRUPTED: {
    message: 'This scheduled run was interrupted when the service stopped.',
    action: 'Check service health if this repeats; the next schedule remains available.',
  },
  SKIPPED_OVERLAP: {
    message: 'This scheduled run was skipped because an earlier run was still active.',
    action: 'No action is needed; the next scheduled occurrence will run as usual.',
  },
  INVALID_ENV: {
    message: 'The service could not start because its configuration is invalid.',
    action: 'An administrator should check the startup logs and correct the configuration.',
  },
  SCHEMA_SKEW: {
    message: 'The database schema does not match this service version.',
    action: 'An administrator should run the required database migrations.',
  },
  NETWORK: {
    message: 'The server could not be reached.',
    action: 'Check your connection and try again.',
  },
  TIMEOUT: {
    message: 'The server took too long to answer.',
    action: 'Try again; if it keeps happening, share the request id with support.',
  },
  ABORTED: {
    message: 'This request was canceled.',
    action: 'Start the action again if you still need it.',
  },
  MALFORMED: {
    message: 'The server sent an answer this page could not read.',
    action: 'Try again. If the problem continues, share the request id with support.',
  },
  UNKNOWN: {
    message: 'The server returned an answer this page could not understand.',
    action: 'Try again. If the problem continues, share the request id with support.',
  },
} satisfies Readonly<Record<UiErrorCode, ErrorCopy>>;

/** Return the stable human copy for a documented web-visible error code. */
export function errorCopyFor(code: UiErrorCode): ErrorCopy {
  return ERROR_COPY[code];
}
