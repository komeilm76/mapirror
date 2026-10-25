/**
 * `/_auth/api/*` — authentication routes.
 *
 * Three routes, all documented in `04-api.md` §1: `POST /login` (`P1-AUTH-03`), and `GET /me` + `POST /logout`
 * (`P1-AUTH-04`). The two authenticated routes share `session.ts` with the `/_admin/api/*` guard (`P1-AUTH-05`), so a
 * token that `/me` calls expired is the same token the admin API calls expired — a client never has to guess which
 * answer to believe.
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
  type MeResponse,
} from '@mapirror/shared';
import type { FastifyPluginCallback } from 'fastify';

import type { AppConfig } from '../../config/env';
import { insertAuditLog, AUDIT_ACTIONS } from '../../db/repositories/audit-logs';
import { withTransaction } from '../../db/transaction';
import { normaliseIp } from '../../lib/client-ip';
import { AppError } from '../../lib/errors';
import type { LoginThrottle } from './login-throttle';
import { requireBearerToken, verifySession } from './session';
import { login } from './service';
import { revokeToken } from './tokens';

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

  // The SPA's boot check: is the token in `sessionStorage` still worth holding, and for how long?
  app.get('/me', async (request): Promise<MeResponse> => {
    const session = await verifySession(
      app.db.db,
      requireBearerToken(request.headers.authorization),
    );

    return {
      admin: { id: session.admin.id, username: session.admin.username },
      expiresAt: session.token.expiresAt.toISOString(),
      lastUsedAt: session.token.lastUsedAt?.toISOString() ?? null,
    };
  });

  // Revokes **the presented token and nothing else**: signing out on a phone must not sign out the desktop. "Sign out
  // everywhere" is a different action, and it belongs to a password reset (`P1-AUTH-07`).
  app.post('/logout', async (request, reply) => {
    const presented = requireBearerToken(request.headers.authorization);
    // Verified first, so a revoked or expired token is answered as such rather than being quietly "logged out": the
    // caller learns whether the session had already ended.
    const session = await verifySession(app.db.db, presented);

    // One transaction: the revocation and the audit row that explains it. If the audit cannot be written, nothing is
    // revoked and the caller gets a 500 — the alternative is a session that ended with no record of ending, and an
    // operator asking why a token stopped working.
    await withTransaction(app.db.db, async (trx) => {
      // The revocation decides the answer, not the verification above. Two logouts arriving together both verify as
      // valid (neither has committed yet), and while the *revocation* is guarded by `revoked_at is null`, a handler that
      // ignored its result would answer `204` twice and write two `auth.logout` rows for one session — measured before
      // this line existed. `false` means someone else ended it first, which is exactly `TOKEN_REVOKED`.
      if (!(await revokeToken(trx, presented))) {
        throw new AppError('TOKEN_REVOKED', 'This session has ended. Sign in again.');
      }

      await insertAuditLog(trx, {
        actorId: session.admin.id,
        actorName: session.admin.username,
        action: AUDIT_ACTIONS.logout,
        // The token id, never the token: an audit row must not hold a credential.
        targetType: 'admin_token',
        targetId: session.token.id,
        ip: normaliseIp(request.ip),
      });
    });

    await reply.code(204).send();
  });
};
