/**
 * `/_auth/api/*` — authentication routes.
 *
 * `POST /login` is real as of `P1-AUTH-03`; `logout` and `me` follow in `P1-AUTH-04`. The paths are the ones
 * `04-api.md` §1 documents and the ones the stub already occupied, so nothing moved.
 *
 * **Validation happens with the shared Zod schema, in the handler.** Fastify's own `schema.body` takes JSON Schema, and
 * translating Zod to it would need a type provider that this project does not depend on (`15-decisions.md` ADR-021
 * keeps the contract in one place). So the handler parses with `LoginRequestSchema` — the same object the SPA
 * validates its form with — and throws the resulting `ZodError`; the error handler already maps a `ZodError` to
 * `400 VALIDATION_ERROR` with `details.issues`, which is the shape `04-api.md` §0.2 documents.
 *
 * **The 429 carries a `Retry-After` header** as well as `details.lockedUntil`. The header is what an HTTP client
 * honours without parsing a body (`14-security.md` §3 says the response includes it); the body field is what the SPA
 * shows to a person. Both come from the same instant.
 *
 * **`Cache-Control: no-store` on every response from this namespace**, including errors. A login response contains a
 * bearer token; a proxy or a browser that cached it would hand a credential to the next visitor. Fastify sets no
 * caching headers by default, so the absence of one is not a policy — it is an omission that some intermediaries
 * resolve by caching.
 *
 * @module modules/auth/routes
 */

import {
  LoginRateLimitDetailsSchema,
  LoginRequestSchema,
  type LoginResponse,
} from '@mapirror/shared';
import type { FastifyPluginCallback } from 'fastify';

import type { AppConfig } from '../../config/env';
import { AppError } from '../../lib/errors';
import type { LoginThrottle } from './login-throttle';
import { login } from './service';

/** What the namespace needs; supplied by `routes/index.ts` from the pipeline context. */
export interface AuthRouteOptions {
  /** Token TTL and the throttle limits. */
  readonly config: AppConfig;
  /** The process's throttle: built once in `app.ts`, so every login in the process shares one counter. */
  readonly throttle: LoginThrottle;
}

/**
 * The `Retry-After` value a `RATE_LIMITED` error implies, or `null` for any other error.
 *
 * The details are parsed with the contract's own schema rather than read with a cast: if this app ever produced a
 * `RATE_LIMITED` whose details did not satisfy the contract, the honest outcome is a loud failure, not a header
 * invented from `undefined` (or, worse, from a string a client would then interpret as seconds).
 */
function retryAfterFrom(error: unknown): string | null {
  if (!(error instanceof AppError) || error.code !== 'RATE_LIMITED') return null;
  return String(LoginRateLimitDetailsSchema.parse(error.details).retryAfterSeconds);
}

/** `/login`, `/logout`, `/me` land here. */
export const authRoutes: FastifyPluginCallback<AuthRouteOptions> = (app, options) => {
  const { throttle } = options;

  // Applied to the namespace, before every handler and every error path, so a response cannot leave without it.
  app.addHook('onRequest', (_request, reply, done) => {
    void reply.header('cache-control', 'no-store');
    done();
  });

  app.post('/login', async (request, reply): Promise<LoginResponse> => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // Thrown rather than replied: the handler in `plugins/error-handlers.ts` owns the envelope, and a body that does
      // not parse must look like every other validation failure in the API.
      throw parsed.error;
    }

    try {
      const result = await login(
        {
          database: app.db.db,
          throttle,
          tokenTtlHours: options.config.authTokenTtlHours,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          log: request.log,
        },
        parsed.data,
      );

      return result;
    } catch (error) {
      const retryAfter = retryAfterFrom(error);
      if (retryAfter !== null) void reply.header('retry-after', retryAfter);
      throw error;
    }
  });
};
