/**
 * The API's error type and the mapping from any error to the documented envelope (task `P1-API-04`).
 *
 * `packages/shared` owns the vocabulary — `ERROR_STATUS`, `ErrorEnvelope` — because the UI switches on the
 * same codes. What lives here is the *translation*: whatever a handler throws, the response carries one of
 * those codes and nothing else. Two rules make that worth a module:
 *
 * 1. **A 500 never describes itself.** Internals (a stack, a driver message naming a table, a DSN fragment)
 *    are what turn an error response into an information leak. `INTERNAL_ERROR` says one fixed sentence, and
 *    the detail goes to the log, where it is useful and access-controlled.
 * 2. **A client error names the code the UI expects.** A malformed body, an unsupported media type and an
 *    oversized payload are three different mistakes; collapsing them into "400 Bad Request" would force the
 *    UI to parse prose.
 *
 * @module lib/errors
 */

import { ERROR_STATUS, statusFor, type ErrorCode, type ErrorEnvelope } from '@mapirror/shared';
import { ZodError } from 'zod';

/** The envelope body plus the status it must be sent with. */
export interface MappedError {
  /** HTTP status, taken from `ERROR_STATUS` — never invented here. */
  readonly status: number;
  /** The documented envelope, with the request id filled in. */
  readonly body: ErrorEnvelope;
}

/** What a client is told when the server cannot say anything safe. */
export const INTERNAL_MESSAGE =
  'An unexpected error occurred. The request id identifies it in the server log.';

/**
 * Messages for the codes the handler synthesises itself (the ones no handler throws deliberately).
 *
 * Deliberately flat: each sentence states the problem without describing the implementation.
 */
const SYNTHESISED_MESSAGES = {
  BAD_REQUEST: 'The request could not be read.',
  VALIDATION_ERROR: 'Request validation failed.',
  UNSUPPORTED_FORMAT: 'The request media type is not supported.',
  FILE_TOO_LARGE: 'The request is larger than this endpoint accepts.',
  NOT_FOUND: 'The requested resource does not exist.',
  INTERNAL_ERROR: INTERNAL_MESSAGE,
} as const satisfies Partial<Record<ErrorCode, string>>;

/**
 * A failure a handler raises on purpose, with the code the contract documents for it.
 *
 * The message is shown to the client, so it must be written as user-facing text — never assembled from an
 * exception the server caught.
 *
 * @example
 * throw new AppError('VERSION_DUPLICATE', 'Version 260101 already exists for this country.', { version: '260101' });
 */
export class AppError<Details = unknown> extends Error {
  /** The documented code; also decides the HTTP status. */
  readonly code: ErrorCode;
  /** Machine-readable context, safe to show. */
  readonly details?: Details;

  /**
   * @param code - A code from `ERROR_STATUS`.
   * @param message - Client-facing sentence.
   * @param details - Optional structured context, e.g. the field that failed.
   */
  constructor(code: ErrorCode, message: string, details?: Details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Fastify's own error codes, mapped to the documented vocabulary.
 *
 * The keys are the codes Fastify raises for a malformed request; they were read off a running instance
 * rather than guessed (see `16-changelog.md` pass 10 for the same discipline). Anything not listed here falls
 * through to the status-based rule in {@link codeFor}.
 */
const FASTIFY_CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 'BAD_REQUEST',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'BAD_REQUEST',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_FORMAT',
  FST_ERR_CTP_BODY_TOO_LARGE: 'FILE_TOO_LARGE',
  FST_ERR_VALIDATION: 'VALIDATION_ERROR',
  FST_ERR_NOT_FOUND: 'NOT_FOUND',
};

/** The subset of a Fastify error this module reads. */
interface FastifyLikeError {
  readonly code: string;
  readonly statusCode: number;
  readonly message: string;
}

/**
 * Narrows an unknown thrown value to something shaped like a Fastify error.
 *
 * @param error - Value caught from a handler or hook.
 * @returns `true` when it has a string `code` and a numeric `statusCode`.
 */
function isFastifyError(error: unknown): error is FastifyLikeError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate: { code?: unknown; statusCode?: unknown } = error;
  return typeof candidate.code === 'string' && typeof candidate.statusCode === 'number';
}

/**
 * Chooses the documented code for a non-`AppError` failure.
 *
 * @param error - The caught value.
 * @returns A code from `ERROR_STATUS`.
 */
function codeFor(error: unknown): ErrorCode {
  if (error instanceof ZodError) return 'VALIDATION_ERROR';
  if (isFastifyError(error)) {
    const mapped = FASTIFY_CODE_MAP[error.code];
    if (mapped !== undefined) return mapped;
    // A 4xx we do not have a specific code for is still the client's mistake; a 5xx is ours, and saying so
    // is more honest than inventing a reason.
    if (error.statusCode >= 400 && error.statusCode < 500) return 'BAD_REQUEST';
  }
  return 'INTERNAL_ERROR';
}

/**
 * Renders a `ZodError` as envelope details.
 *
 * `issues` describes each failure by path and rule, which is what a form needs to mark the right field.
 *
 * @param error - The validation failure.
 * @returns Details object for `VALIDATION_ERROR`.
 */
function validationDetails(error: ZodError): { issues: { path: string; message: string }[] } {
  return {
    issues: error.issues.map((issue) => ({
      // `path` is an array for nested objects; a dotted string is what a client can index.
      path: issue.path.length === 0 ? '(body)' : issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/**
 * Maps any thrown value to the status and envelope the client must receive.
 *
 * Pure, so the mapping can be exercised for every code without a server.
 *
 * @param error - Whatever was thrown (an `AppError`, a `ZodError`, a Fastify error, or anything else).
 * @param requestId - The request's id, echoed so a screenshot can be traced to a log line.
 * @returns Status and envelope.
 */
export function toErrorEnvelope(error: unknown, requestId: string): MappedError {
  if (error instanceof AppError) {
    return {
      status: statusFor(error.code),
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
          requestId,
        },
      },
    };
  }

  const code = codeFor(error);
  const details = error instanceof ZodError ? validationDetails(error) : undefined;
  const message =
    SYNTHESISED_MESSAGES[code as keyof typeof SYNTHESISED_MESSAGES] ??
    'The request could not be completed.';

  return {
    status: statusFor(code),
    body: {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        requestId,
      },
    },
  };
}

/**
 * The envelope for an unmatched path.
 *
 * Separate from {@link toErrorEnvelope} because there is no error object on this path: Fastify calls the
 * not-found handler directly. The code is `NOT_FOUND` for a path that does not exist **and** for a method the
 * path does not accept — the contract has no 405, and answering 404 keeps the route table unenumerable.
 *
 * @param requestId - The request's id.
 * @returns Status and envelope.
 */
export function notFoundEnvelope(requestId: string): MappedError {
  return {
    status: ERROR_STATUS.NOT_FOUND,
    body: {
      error: { code: 'NOT_FOUND', message: SYNTHESISED_MESSAGES.NOT_FOUND, requestId },
    },
  };
}
