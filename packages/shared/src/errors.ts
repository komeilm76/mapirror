/**
 * The error vocabulary (L5, `04-api.md` §0.2).
 *
 * Every failure the API reports carries one of these codes, and the code — not the HTTP status — is what
 * the UI switches on: 404 means "not found" for three different reasons depending on context. The
 * mapping here is the machine-readable copy of the table in `04-api.md`; a test asserts the two agree, so
 * a code cannot be added in one place only.
 *
 * Naming note: `ACCOUNT_DISABLED` is the 403 for a deactivated admin account (`admins.is_active = false`).
 * It is **not** login throttling — that is `RATE_LIMITED`/429, deliberately, because a 403 on lockout
 * would confirm to an attacker that the account exists and is worth attacking.
 *
 * @module errors
 */

/**
 * HTTP status of every code the API can return. A code missing here cannot be sent, because the envelope
 * builder requires this map (`scripts/tests/docs-contract.spec.ts` proves the set matches the docs).
 */
export const ERROR_STATUS = {
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
} as const;

/** Every HTTP error code. */
export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * Codes that never travel as an HTTP status. They appear as `jobs.error_code`, in `interval_runs`, or at
 * startup, and are safe to show to an admin.
 */
export const INTERNAL_ERROR_CODES = [
  'WORKER_LOST',
  'RUN_INTERRUPTED',
  'SKIPPED_OVERLAP',
  'INVALID_ENV',
  'SCHEMA_SKEW',
] as const;

/** An internal (non-HTTP) code. */
export type InternalErrorCode = (typeof INTERNAL_ERROR_CODES)[number];

/** The JSON body of every non-2xx response. */
export interface ErrorEnvelope<Details = unknown> {
  error: {
    code: ErrorCode;
    message: string;
    /** Machine-readable context (field names, conflicting version, …). Never a stack trace. */
    details?: Details;
    /** Echoed from `x-request-id` so a user's screenshot can be matched to a log line. */
    requestId: string;
  };
}

/**
 * Narrows an arbitrary string to an HTTP error code.
 *
 * @param value - Candidate code.
 * @returns `true` when the string is a known HTTP code.
 */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_STATUS, value);
}

/**
 * Looks up the HTTP status for a code.
 *
 * @param code - A known error code.
 * @returns The status the envelope must be sent with.
 */
export function statusFor(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

/**
 * Narrows an arbitrary string to an internal (job/startup) code.
 *
 * @param value - Candidate code.
 * @returns `true` when the string is a known internal code.
 */
export function isInternalErrorCode(value: string): value is InternalErrorCode {
  return (INTERNAL_ERROR_CODES as readonly string[]).includes(value);
}
