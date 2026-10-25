/**
 * Transport hardening: response headers, CORS and the JSON body limit (task `P1-API-05`).
 *
 * Slot 3 of the pipeline, after `errors` for one reason that matters: a request refused here (an origin that
 * is not allowed, a body that is too large) must leave as the documented envelope, not as Fastify's default
 * error shape. Every header below is copied from `14-security.md` §6, and a test parses that document and
 * compares — a header that drifts between the code and the security review is worse than a missing one, because
 * the review is what a reader trusts.
 *
 * ## Two things this stage deliberately does not do
 *
 * - **`Strict-Transport-Security` is not set here.** The document says "set at the TLS proxy": the API speaks
 *   plain HTTP on a private port, so a browser never sees its headers directly, and a proxy that strips or sets
 *   them is the authority. Setting it here would look reassuring and change nothing.
 * - **Compression is not enabled.** Compressing responses that contain tokens is a known oracle; the payloads
 *   are small JSON documents and a `.osm.pbf` download must never be re-encoded.
 *
 * ## Why the preflight is a hook, not a route
 *
 * An `OPTIONS` route would be a route outside the API prefixes (`/*`), which L1 forbids and `route-law.ts` would
 * refuse at boot. So the preflight is answered in `onRequest`, before routing: the request never needs a route
 * to exist for the browser to be allowed to send the real one.
 *
 * @module plugins/security
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config/env';
import { AppError } from '../lib/errors';
import type { PipelineContext } from './order';

/**
 * The JSON body limit, in bytes.
 *
 * `14-security.md` §5: "Body limit 1 MB (uploads use multipart)". Uploads are streamed through
 * `@fastify/multipart` with their own `MAX_UPLOAD_BYTES` cap, so this number is only about JSON documents and
 * forms — and 1 MB is a ceiling no endpoint in `04-api.md` approaches.
 */
export const JSON_BODY_LIMIT_BYTES = 1_048_576;

/**
 * The `Content-Security-Policy` value, exactly as `14-security.md` §6 states it.
 *
 * `style-src 'unsafe-inline'` is the single relaxation and it is Vuetify's, not ours: without it the SPA's
 * runtime styles are blocked. `script-src` has neither `unsafe-inline` nor `unsafe-eval` — a test asserts that.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'; " +
  'upgrade-insecure-requests';

/**
 * Every response header this stage sets, in the order the security document lists them.
 *
 * Lower-case because that is how Node hands them to a client; HTTP header names are case-insensitive.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
  'cross-origin-opener-policy': 'same-origin',
};

/** Methods the API exposes to an allowed origin. */
const ALLOWED_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';

/** Request headers an allowed origin may send. Bearer auth is a header, so `authorization` is the point. */
const ALLOWED_REQUEST_HEADERS = 'authorization,content-type,x-request-id';

/** How long a browser may cache the preflight answer. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * The origins this instance will answer cross-origin, with `*` removed.
 *
 * `parseEnv` already refuses `*` as a configuration mistake; this is the second belt, because the guarantee the
 * task asks for is "no `*` CORS in prod" and a value that reaches this function another way must not become a
 * wildcard either.
 *
 * @param config - Validated configuration.
 * @returns The allow-list, without any wildcard entry.
 */
function allowedOrigins(config: AppConfig): readonly string[] {
  return config.corsOrigins.filter((origin) => origin !== '*');
}

/**
 * Builds the CORS response headers for one request.
 *
 * @param origin - The request's `Origin` header, if it sent one.
 * @param allowed - The configured allow-list.
 * @returns Headers to set, or `null` when there is nothing to allow.
 */
function corsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
): Record<string, string> | null {
  if (origin === undefined || !allowed.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-allow-headers': ALLOWED_REQUEST_HEADERS,
    'access-control-max-age': String(PREFLIGHT_MAX_AGE_SECONDS),
  };
}

/**
 * Answers a cross-origin request, and refuses one that is not allowed.
 *
 * A request with **no** `Origin` is same-origin or not a browser at all (curl, a proxy, a health check) and is
 * left alone — that is the default posture: "same-origin, no CORS headers".
 *
 * A **preflight** from an origin that is not on the list is refused with `403 FORBIDDEN`: it is a question, and
 * the answer is no.
 *
 * An **actual** request from such an origin is *not* refused — it is answered without
 * `access-control-allow-origin`, so a browser hides the response. Refusing it was the first version of this
 * code and it was wrong: browsers send `Origin` on same-origin `POST`/`PATCH`/`DELETE` too, so the SPA posting
 * its own login form carried `Origin: http://localhost:8080` and got `403` from its own API. Measured before
 * the fix. CORS is a browser-side read barrier; making it a server-side block breaks the same-origin case it is
 * supposed to leave alone.
 *
 * @param request - The incoming request.
 * @param reply - Its reply.
 * @param allowed - The configured allow-list.
 * @returns `true` when the hook ended the response (a preflight was answered).
 */
function applyCors(
  request: FastifyRequest,
  reply: FastifyReply,
  allowed: readonly string[],
): boolean {
  const origin = request.headers.origin;

  // `Vary: Origin` on every response, not only when an allow-list exists: the refusal below is also
  // origin-dependent, so a cache in front of the API must never serve one origin's 403 (or one origin's ACAO
  // header) to another.
  reply.header('vary', 'Origin');

  if (origin === undefined) return false;

  // A preflight asks permission for a method it is not actually sending; it is answered here and ends the
  // request. An actual request continues to routing either way.
  const isPreflight =
    request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;
  const headers = corsHeaders(origin, allowed);

  if (headers === null) {
    // Only the question is refused. The answer to "may I call you from https://evil.example" is no; the answer
    // to an actual request is the response itself, minus the header that would let a browser read it.
    if (isPreflight) throw new AppError('FORBIDDEN', 'This origin is not allowed to call the API.');
    return false;
  }

  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  if (!isPreflight) return false;

  void reply.status(204).send();
  return true;
}

/**
 * Installs the security stage on the **root** instance.
 *
 * @param app - Root instance.
 * @param context - Pipeline context, carrying the validated configuration (the CORS allow-list).
 */
export function installSecurity(app: FastifyInstance, context: PipelineContext): void {
  const allowed = allowedOrigins(context.config);

  app.addHook('onRequest', (request, reply, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);

    // A refusal throws, and the `errors` stage (installed one slot earlier) turns it into the envelope. The
    // headers set above are already on this reply, so even a `403` carries them.
    if (applyCors(request, reply, allowed)) return;

    done();
  });
}
