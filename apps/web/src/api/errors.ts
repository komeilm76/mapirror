/**
 * One error type for every failed API call (`P1-WEB-04`).
 *
 * The API answers every failure with the same envelope (`04-api.md` §0.2):
 *
 * ```json
 * { "error": { "code": "TOKEN_EXPIRED", "message": "…", "details": { … }, "requestId": "…" } }
 * ```
 *
 * The SPA's job is to turn *anything else* — an HTML page from a proxy, a body cut off mid-flight, a socket that never
 * opened — into that same shape, so that a screen has exactly one kind of failure to render and the sign-out path has
 * exactly one condition to test. That is what this module is: **response (or no response) in, `ApiError` out, never a
 * throw**.
 *
 * ## Why the code is a union with client codes in it
 *
 * `ErrorCode` (`@mapirror/shared`) is the server's vocabulary: a code that is not in it cannot be sent. Three of the
 * failures a browser sees never reach the server at all — the connection failed, the answer took too long, the tab went
 * away — and a fourth is the server's own answer being unreadable. Giving them codes in the same type keeps `switch
 * (error.code)` exhaustive at the call site instead of forcing every screen to also ask "or was it a network thing?".
 * `UNKNOWN` is the residual: a code from a newer server, or an error page that is not our envelope at all.
 *
 * @module api/errors
 */

import { isErrorCode, type ErrorCode } from '@mapirror/shared';

import { errorCopyFor } from './error-copy';

/**
 * Codes that only ever originate in the browser. Documented here so that a reader of the error table in `04-api.md`
 * does not go looking for them: the server cannot send any of these.
 */
export const CLIENT_ERROR_CODES = [
  'NETWORK',
  'TIMEOUT',
  'ABORTED',
  'MALFORMED',
  'UNKNOWN',
] as const;

/** A code that only the client produces. */
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

/** Any code an `ApiError` may carry: the server's, or one of the client's own. */
export type ApiErrorCode = ErrorCode | ClientErrorCode;

/**
 * The codes that mean **this credential will not work again**, so the app must sign out rather than retry.
 *
 * - `UNAUTHENTICATED` — no token, a malformed one, or one the database has never seen.
 * - `TOKEN_EXPIRED` / `TOKEN_REVOKED` — a session that ended (`05-flows.md` F2, D-3: no refresh).
 * - `ACCOUNT_DISABLED` — a `403`, and the one entry that is not a `401`: the account is deactivated, and no retry will
 *   change that. `05-flows.md` F2 states the rule as "`401` anywhere ⇒ clear state + redirect", written before the
 *   `403` existed; leaving a deactivated admin holding a token that can never work is the same defect with a different
 *   number, so it ends the session too.
 *
 * Deliberately **not** here: `INVALID_CREDENTIALS` (`401`, but it means "the password you just typed is wrong" — the
 * login form's business, not a session ending), `FORBIDDEN` (403: authenticated, not allowed — a permissions answer,
 * not a credential answer) and everything else in the table.
 */
export const SESSION_ENDED_CODES = [
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'ACCOUNT_DISABLED',
] as const;

/** Arguments for {@link ApiError}. */
export interface ApiErrorInit {
  /** The code from the envelope, or one of the client's own. */
  readonly code: ApiErrorCode;
  /** HTTP status, or `null` when no response arrived. */
  readonly status?: number | null;
  /** A sentence fit to show a person. Defaults from the code when the server did not supply one. */
  readonly message?: string;
  /** Machine-readable context: `validationIssues()` reads this. */
  readonly details?: unknown;
  /** Echoed from the envelope or the `x-request-id` header, so a screenshot can be matched to a log line. */
  readonly requestId?: string | null;
  /** The `fetch` rejection, kept for the console and never shown. */
  readonly cause?: unknown;
}

/**
 * A failed API call.
 *
 * Extends `Error` so that `catch {}` blocks, error boundaries and the console all behave; adds the four facts a screen
 * needs to render the failure without re-reading the response.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(init: ApiErrorInit) {
    super(init.message ?? messageFor(init.code), { cause: init.cause });
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status ?? null;
    this.details = init.details;
    this.requestId = init.requestId ?? null;
  }

  /**
   * Whether this failure ends the session: the credential is finished, so the app clears it and returns to the login
   * page instead of retrying.
   *
   * An `UNKNOWN` failure with a `401` status counts: a `401` that did not carry our envelope is still our API (or the
   * proxy in front of it) saying the credential is no good, and treating it as a display error would leave the reader
   * on a page that can never load.
   */
  get sessionEnded(): boolean {
    if ((SESSION_ENDED_CODES as readonly string[]).includes(this.code)) return true;
    return this.code === 'UNKNOWN' && this.status === 401;
  }
}

/**
 * The default sentence for a code the server did not explain.
 *
 * @param code - Any code.
 * @returns A sentence fit to show a person.
 */
function messageFor(code: ApiErrorCode): string {
  return errorCopyFor(code).message;
}

/**
 * Narrows an unknown value to {@link ApiError}.
 *
 * @param value - Anything a `catch` caught.
 * @returns `true` for an `ApiError`.
 */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Reads a JSON body without throwing.
 *
 * @param response - A response whose body has not been read.
 * @returns The parsed body, or `undefined` when there is none or it is not JSON.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: an HTML error page from nginx, a truncated body, a proxy's plain-text 502.
    return undefined;
  }
}

/** The envelope's `error` member, when the body really is one. */
interface EnvelopeBody {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  requestId?: unknown;
}

/**
 * Picks the envelope out of a parsed body.
 *
 * @param body - Whatever the response contained.
 * @returns The `error` member, or `undefined` when the shape is not the documented one.
 */
function envelopeOf(body: unknown): EnvelopeBody | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as { error?: unknown };
  if (typeof error !== 'object' || error === null) return undefined;
  // `error` is a non-null object here; `EnvelopeBody` is all-optional, so the shape is a claim about the four members
  // the envelope may carry, each of which is re-checked at the point of use.
  return error;
}

/**
 * Turns a non-2xx response into an {@link ApiError}.
 *
 * Never throws: a failure while reading the body is itself information ("the answer was not our envelope"), and an
 * error handler that can fail is an error handler that hides errors.
 *
 * @param response - The response, body unread.
 * @returns The error to throw.
 */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  const body = await readJson(response);
  const envelope = envelopeOf(body);
  const headerRequestId = response.headers.get('x-request-id');

  const code: ApiErrorCode =
    typeof envelope?.code === 'string'
      ? isErrorCode(envelope.code)
        ? envelope.code
        : 'UNKNOWN'
      : 'UNKNOWN';

  return new ApiError({
    code,
    status: response.status,
    // The server's message is written for a person (`04-api.md` §0.2), so it is used verbatim; a body we could not read
    // gets the client's own sentence plus the status, which is all that is known.
    message:
      typeof envelope?.message === 'string' && envelope.message !== ''
        ? envelope.message
        : code === 'UNKNOWN'
          ? `${errorCopyFor('UNKNOWN').message} (HTTP ${String(response.status)}.)`
          : undefined,
    details: envelope?.details,
    requestId:
      typeof envelope?.requestId === 'string' ? envelope.requestId : (headerRequestId ?? null),
  });
}

/**
 * Turns a `fetch` rejection into an {@link ApiError}.
 *
 * @param cause - The thrown value.
 * @param kind - What the caller already knows: a timeout it caused, a cancellation the caller asked for, or neither.
 * @returns The error to throw.
 */
export function errorFromFailure(
  cause: unknown,
  kind: 'NETWORK' | 'TIMEOUT' | 'ABORTED',
): ApiError {
  return new ApiError({ code: kind, cause, status: null });
}

/** One `VALIDATION_ERROR` issue, as `04-api.md` §0.2 documents it. */
export interface ValidationIssue {
  /** Dotted path of the offending field, e.g. `username` or `address.city`. */
  readonly path: string;
  /** The rule the value broke, in the server's words. */
  readonly message: string;
}

/**
 * Reads `details.issues` off a `VALIDATION_ERROR`.
 *
 * Forms need the failing fields to mark the right input, and doing that parse at each form is how four of them end up
 * disagreeing about what the API sends. Anything malformed is dropped rather than thrown: an issue the form cannot
 * place is still a server rejection, and the summary line covers it.
 *
 * @param error - The failed call.
 * @returns The issues, empty when the failure carried none.
 */
export function validationIssues(error: ApiError): ValidationIssue[] {
  const { details } = error;
  if (typeof details !== 'object' || details === null) return [];
  const { issues } = details as { issues?: unknown };
  if (!Array.isArray(issues)) return [];

  const parsed: ValidationIssue[] = [];
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof path !== 'string' || typeof message !== 'string') continue;
    parsed.push({ path, message });
  }
  return parsed;
}
