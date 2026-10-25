/**
 * The error stage: every failure leaves as the documented JSON envelope (task `P1-API-04`).
 *
 * Slot 2 of the pipeline. It sits before `security`, `db`, `auth` and the routes because Fastify needs a
 * handler installed *before* anything can throw through it — a route registered earlier would answer with
 * Fastify's default shape, which leaks `error`/`statusCode`/`message` and, for a 500, the exception's message.
 *
 * Installed on the root instance (see `plugins/order.ts` for why a plugin of its own would not work): error
 * handlers are scope-bound, so a stage registered as a plugin would only cover its own subtree.
 *
 * What the stage guarantees for **every** response the API produces:
 *
 * - a `code` from `04-api.md` §0.2, an HTTP status from `ERROR_STATUS`, and the request id;
 * - no stack, no driver text, no internal field names — those go to the log, not the body;
 * - `content-type: application/json`, including 404s, so a client never has to guess;
 * - a 5xx is logged at `error` with the exception, and a 4xx at `info` with its code: an operator needs the
 *   stack for the first and only a count for the second.
 *
 * @module plugins/errors
 */

import type { FastifyInstance } from 'fastify';

import { notFoundEnvelope, retryAfterHeaderValue, toErrorEnvelope } from '../lib/errors';

/**
 * Installs the error handler and the not-found handler on the **root** instance.
 *
 * @param app - Root instance to install on.
 */
export function installErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const { status, body } = toErrorEnvelope(error, request.id);

    if (status >= 500) {
      // The exception is logged for the operator, the fixed sentence goes to the client, and the id joins the
      // two. The `err` serializer installed by `withRedaction` scrubs credentials out of the message and stack:
      // field redaction (L9) cannot see a DSN embedded in free text, and that is where a driver puts one.
      request.log.error({ err: error, code: body.error.code }, 'request failed');
    } else {
      request.log.info({ code: body.error.code, statusCode: status }, 'request rejected');
    }

    // Every `429` carries `Retry-After`, and nothing else does (`04-api.md` §0.2). Set here rather than in each
    // handler that can throttle: a second throttling site is then correct by construction, and the header cannot
    // disagree with the body it is sent with. A `429` whose details do not satisfy the contract is a bug in the
    // producer; it is logged and answered without the header rather than turned into a 500 by a throwing parse.
    if (body.error.code === 'RATE_LIMITED') {
      const retryAfter = retryAfterHeaderValue(body.error.details);
      if (retryAfter === null) {
        request.log.warn({ code: body.error.code }, 'RATE_LIMITED without contract details');
      } else {
        void reply.header('retry-after', retryAfter);
      }
    }

    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const { status, body } = notFoundEnvelope(request.id);
    // Info, not warn: a 404 is a client asking for something that is not there, and a scanner will produce
    // thousands of them. The path is already in Fastify's request log line.
    request.log.info({ statusCode: status }, 'no route matched');
    return reply.status(status).send(body);
  });
}
