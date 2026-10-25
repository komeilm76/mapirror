/**
 * Request context: the request id and the logger's identity for one request (task `P1-API-03`).
 *
 * Slot 1 of the pipeline. Everything after it — error envelopes, auth failures, rate-limit refusals, job
 * progress — reports against the id this stage establishes, which is why the architecture puts it first: a
 * stage that reports before there is an id to report under is a stage that writes log lines nobody can join.
 *
 * The contract is one line in `04-api.md` §0.2: **the id is returned in `x-request-id` and echoed in every
 * error**. Both halves matter — the header is what a user pastes into a bug report, and the envelope field is
 * what makes the log line findable from the response.
 *
 * ## Why the inbound header is validated rather than trusted
 *
 * A proxy or the SPA may supply an id so that one identifier spans both halves of a request. Accepting it
 * verbatim would let a caller choose what appears in our log lines — `"../../etc/passwd"`, a newline, or a
 * megabyte of text is a log-injection primitive, not a correlation id. So an inbound value is used only if it
 * matches {@link REQUEST_ID_PATTERN}; anything else is replaced by a generated UUIDv4, which is the id format
 * `04-api.md` §0.2 promises for everything else in the API.
 *
 * @module plugins/request-context
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

/** Response and request header carrying the correlation id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * What an inbound id may look like: 8–64 characters of URL-safe ASCII.
 *
 * Tight on purpose. It rejects control characters and newlines (log injection), quotes and angle brackets
 * (which end up in shell commands and HTML when someone copies a log line), and values long enough to bury
 * the rest of a record.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Chooses the request id: the caller's, if it is safe to repeat, otherwise a fresh one.
 *
 * Pure and exported, because it is the one decision in this module worth testing without a server.
 *
 * @param inbound - Raw `x-request-id` header value, if the client or proxy sent one.
 * @returns A safe id, never empty.
 */
export function resolveRequestId(inbound?: string | string[]): string {
  // A repeated header arrives as an array; the first value is as good as any, and the pattern decides.
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  return candidate !== undefined && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

/**
 * Installs the request-id contract on the **root** instance.
 *
 * Called with the root instance rather than registered as a plugin, because Fastify encapsulates hooks added
 * inside a plugin: registered as a plugin, this hook would apply only to the stage's own empty subtree and the
 * header would never be set (measured before the fix — `x-request-id` was missing from every response).
 *
 * `onRequest` runs before any handler, including the not-found handler, so the header is in place for both.
 * The hook is synchronous: it does no I/O and must never be why a request waits.
 *
 * @param app - Root instance to install the hook on.
 */
export function installRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    // `request.id` was decided by `genReqId` (see `app.ts`), so one value serves the header, the envelope and
    // every log line the request produces.
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
}
