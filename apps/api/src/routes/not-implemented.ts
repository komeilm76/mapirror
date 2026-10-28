/**
 * Not-yet-implemented routes (task `P1-API-01`).
 *
 * Each API namespace is registered now — at a path that already exists in `04-api.md` — so the bootstrap
 * (pipeline order, prefix encapsulation, JSON-only replies, the error envelope) can be verified before the
 * modules exist. Every stub answers `503 NOT_READY` with the documented envelope, which is the truthful
 * answer: the route is part of the contract, the work is not done.
 *
 * A stub lives at its **real** path rather than at an invented one or at the bare prefix. That matters:
 * the bare prefix creates a second route (`/_auth/api`) that no line of the contract describes, and the law
 * test in `10-laws.md` matches `^/_auth/api/`. Registering `/_auth/api/login` changes nothing about the
 * route table when `P1-AUTH-03` fills in the handler.
 *
 * **These stubs are temporary and machine-checked.** Each names the task that replaces it, and
 * `apps/api/tests/app.spec.ts` asserts the set of stubs matches the set of routes still unimplemented.
 *
 * @module routes/not-implemented
 */

import { statusFor, type ErrorEnvelope } from '@mapirror/shared';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

/** Every stub the bootstrap registers, with the task that replaces it. */
export const STUB_ROUTES = {
  'GET /_public/api/countries': 'P3-API-03',
} as const;

/** A route key from {@link STUB_ROUTES}. */
export type StubRoute = keyof typeof STUB_ROUTES;

/**
 * Builds the envelope a stub answers with.
 *
 * The status comes from `@mapirror/shared` rather than a literal, so the API and the client cannot disagree
 * about what `NOT_READY` means — and `requestId` is Fastify's own id, which is what `P1-API-03` will start
 * attaching to every log line and response header.
 *
 * @param route - Route key, e.g. `GET /_public/api/countries`.
 * @param requestId - The request's id.
 * @returns The error envelope.
 */
export function notImplementedEnvelope(route: StubRoute, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: 'NOT_READY',
      message: `${route} belongs to the router but is not implemented yet (${STUB_ROUTES[route]}).`,
      requestId,
    },
  };
}

/**
 * Creates the handler for a stub route.
 *
 * @param route - Route key, which also names the owning task in the reply.
 * @returns A Fastify handler replying `503` with the JSON envelope.
 */
export function notImplemented(route: StubRoute): RouteHandlerMethod {
  // Not `async`: nothing is awaited, and an `async` function that never awaits is a lint error here.
  // Fastify accepts a handler that returns the reply, which is also one allocation cheaper per request.
  return (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(statusFor('NOT_READY')).send(notImplementedEnvelope(route, request.id));
}
