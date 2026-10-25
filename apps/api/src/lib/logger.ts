/**
 * Logger configuration (task `P1-API-03`).
 *
 * Law **L9** is specific about *where* redaction happens: "Logs redact `authorization`, `password`, `token`,
 * `cookie` at the logger level, not per call site." A per-call-site rule is a rule that holds until someone
 * writes a new call site — and the one that forgets is the one that logs a bearer token. So the censoring list
 * lives here, is applied to every logger the API creates, and is asserted by a test that captures real log
 * output rather than inspecting the config object.
 *
 * Two design notes:
 *
 * - **Wildcards, not an enumeration of paths.** `*.password` catches `body.password`, `result.password` and
 *   anything else a future handler decides to log, without anyone having to extend a list.
 * - **Headers are covered at any depth.** Credentials arrive in headers (`authorization`, `cookie`) and would
 *   leave in one (`set-cookie`), so those names are censored wherever a handler nests them.
 *
 * One trap is worth recording: Fastify registers pino **serializers** for the top-level keys `req` and `res`.
 * A hand-built `{ req: { headers: … } }` is passed to the request serializer, which expects a Fastify request
 * and emits `{}` — the object is silently emptied rather than redacted. That is why the paths here cover a
 * nested `headers` object rather than only `req.headers.*`: they must work for what handlers actually log.
 *
 * @module lib/logger
 */

import type { FastifyServerOptions } from 'fastify';

/** The four keys L9 names, in the order it names them. */
export const REDACTED_KEYS = ['authorization', 'password', 'token', 'cookie'] as const;

/** Replacement text for a censored value. Visible, so a reader knows a value was there. */
export const REDACT_CENSOR = '[redacted]';

/**
 * Builds the paths for one key at the nesting depths a log record realistically has.
 *
 * Depth 0 is the key at the top of the object (`{ token }`), then one and two levels down (`{ body:
 * { password } }`, `{ data: { user: { token } } }`). Pino has no "anywhere" wildcard, so the depths are
 * written out; three is enough for an API that logs `{ req, res, context }` and deliberately shallow.
 *
 * @param key - Field name to censor.
 * @returns Pino paths for that key at depths 0–2.
 */
function pathsFor(key: string): string[] {
  return [key, `*.${key}`, `*.*.${key}`];
}

/**
 * Credential-bearing header names, lowercased as they arrive.
 *
 * `set-cookie` is here because a response header carries a session; `proxy-authorization` because a proxy in
 * front of the API may pass one through, and it is the same secret under a different name.
 */
export const REDACTED_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
] as const;

/**
 * Every redaction path the API applies.
 *
 * Two families, because a header-shaped value can be logged two ways:
 *
 * - **As a plain nested object** — `{ request: { headers: { authorization } } }` — which is what a handler
 *   writes when it dumps context. Covered by `*.headers.<key>` and `*.*.headers.<key>`.
 * - **Under Fastify's own serializer keys** — `req.headers.*` / `res.headers.*`. Worth naming explicitly even
 *   though today's serializer logs `{ method, url, host, remoteAddress }` and no headers: the paths cost
 *   nothing and the day Fastify starts including headers is the day nobody re-reads this file.
 *
 * Exported so a test can assert the four L9 keys are covered rather than trusting the array's contents.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  ...REDACTED_KEYS.flatMap(pathsFor),
  ...REDACTED_HEADERS.flatMap((header) => [
    `*.headers.${header}`,
    `*.*.headers.${header}`,
    `req.headers.${header}`,
    `res.headers.${header}`,
  ]),
];

/**
 * Narrows whatever `logger.redact` configuration a caller passed into a list of paths.
 *
 * Pino accepts a string, an array, or an object with `paths`; a caller that already redacts something must not
 * lose it when this module adds the L9 set.
 *
 * @param redact - The caller's redaction option, if any.
 * @returns Its paths as a flat array.
 */
function pathsOf(redact: unknown): string[] {
  if (typeof redact === 'string') return [redact];
  if (Array.isArray(redact))
    return redact.filter((path): path is string => typeof path === 'string');
  if (typeof redact === 'object' && redact !== null && 'paths' in redact) {
    // `'paths' in redact` narrows to `object & Record<'paths', unknown>`, so no cast is needed.
    return pathsOf(redact.paths);
  }
  return [];
}

/** Fastify's logger option, as this module receives it. */
export type LoggerOption = FastifyServerOptions['logger'];

/**
 * Applies the L9 redaction list to a logger option.
 *
 * `false` and `undefined` mean "no logging" and stay that way — the test suite builds apps that log to a
 * captured stream explicitly, and a silent default keeps the suite fast. `true` means "log with defaults",
 * which is exactly the case that must not exist without redaction, so it becomes an options object.
 *
 * @param logger - The logger setting a caller asked for.
 * @returns A setting that cannot log a credential, or `false` when logging was off.
 */
export function withRedaction(logger: LoggerOption): LoggerOption {
  if (logger === false || logger === undefined) return false;
  const redact = {
    paths:
      logger === true
        ? [...LOG_REDACT_PATHS]
        : [...new Set([...LOG_REDACT_PATHS, ...pathsOf(logger.redact)])],
    censor: REDACT_CENSOR,
  };
  if (logger === true) return { redact, serializers: { err: describeError } };

  // `err` is ours, whatever the caller configured: it is the one key every exception travels under, and it is
  // where free text (a driver's message, a DSN) ends up. Other serializers are left as the caller wrote them.
  // Measured: without this, `log.error({ err: error })` printed a password that lived inside the message, and
  // Fastify's own `err` serializer reports a pre-shaped object as `type: "Object"`, losing the error's name.
  return {
    ...logger,
    redact,
    serializers: { ...logger.serializers, err: describeError },
  };
}

/**
 * Credential shapes that can appear inside **free text** — a driver's message, a stack frame, a URL.
 *
 * Field redaction (`LOG_REDACT_PATHS`) works on keys; it cannot see `connect ECONNREFUSED
 * postgres://user:hunter2@db:5432/app`, because the secret is a substring of a value the logger was asked to
 * print. Measured: an exception carrying a DSN put the password in the log even with every path configured,
 * which is exactly what L9 forbids. So free text is scrubbed before it is logged.
 */
const SCRUB_RULES: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // scheme://user:password@host → scheme://user:***@host
  { pattern: /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s@/]+@/gi, replacement: '$1:***@' },
  // password=… / token=… / secret=… / api_key=… in a query string or a sentence
  {
    pattern: /\b(password|passwd|pwd|token|secret|api[_-]?key)=([^&\s,;]+)/gi,
    replacement: '$1=***',
  },
  // Authorization: Bearer <token>
  { pattern: /\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: '$1 ***' },
];

/**
 * Removes credentials from text that is about to be logged.
 *
 * Applied to error messages and stacks, not to structured fields — those are covered by
 * {@link LOG_REDACT_PATHS}. Both layers exist because a secret has two ways into a log line.
 *
 * @param text - Free text from an exception or a third-party library.
 * @returns The text with credential-bearing fragments masked.
 */
export function scrubSecrets(text: string): string {
  return SCRUB_RULES.reduce((result, rule) => result.replace(rule.pattern, rule.replacement), text);
}

/**
 * What a thrown value looks like once it is safe to log.
 *
 * The index signature is required by pino's serializer contract (`(value) => { [key: string]: unknown }`).
 */
export interface LoggableError {
  /** Extra context a serializer may attach; pino's type requires the escape hatch. */
  readonly [key: string]: unknown;
  /** Constructor name of the error, or `Thrown` for a non-error value. */
  readonly type: string;
  /** Message with credentials scrubbed. */
  readonly message: string;
  /** Stack with credentials scrubbed; empty when the value had none (Fastify's `err` serializer expects it). */
  readonly stack: string;
}

/**
 * Converts any thrown value into something safe to log.
 *
 * Pino's `err` serializer prints `message` and `stack` verbatim, so both are scrubbed. A non-`Error` throw
 * (a string, an object from a library) is stringified and scrubbed too — `throw 'oops'` is legal and would
 * otherwise lose the only information there is.
 *
 * @param error - Whatever was caught.
 * @returns Name, message and stack, safe to pass to `log.error({ err: … })`.
 */
export function describeError(error: unknown): LoggableError {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: scrubSecrets(error.message),
      stack: scrubSecrets(error.stack ?? ''),
    };
  }
  return { type: 'Thrown', message: scrubSecrets(String(error)), stack: '' };
}
