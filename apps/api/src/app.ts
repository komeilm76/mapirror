/**
 * Fastify instance factory (task `P1-API-01`).
 *
 * `buildApp` is the whole application minus the listening socket: it builds the instance, installs the
 * pipeline in the order fixed by {@link PLUGIN_ORDER}, and registers the three API namespaces. Keeping it
 * separate from `server.ts` is what lets tests exercise real routing and real error behaviour with
 * `app.inject()` — no port, no signal handling, no `process.exit`.
 *
 * The error envelope handlers (`P1-API-04`) are deliberately *not* here yet: an unknown path still answers
 * Fastify's default 404 shape, and the `errors` slot in the pipeline is visibly empty rather than silently
 * forgotten. Logging and request ids are here, because they are instance-level settings: the id generator and
 * the redaction list must be in place before the first request exists, not in a plugin that runs later.
 *
 * @module app
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { parseEnv, type AppConfig } from './config/env';
import type { SqlDatabase } from './db/client';
import { clientErrorHandler } from './lib/errors';
import { withRedaction } from './lib/logger';
import { PLUGIN_ORDER, registerPipeline, type PluginSlot } from './plugins/order';
import { REQUEST_ID_HEADER, resolveRequestId } from './plugins/request-context';
import { JSON_BODY_LIMIT_BYTES } from './plugins/security';
import { assertRouteLaw, installRouteLawHook } from './plugins/route-law';

/** Options accepted by {@link buildApp}. */
export interface BuildAppOptions {
  /**
   * Fastify's logger setting. Tests pass `false` (the default) or an options object with a capture stream;
   * `server.ts` passes the validated level. Whatever is passed, {@link withRedaction} adds the L9 censoring
   * list, so no caller can build an app whose logger prints an `Authorization` header.
   */
  logger?: FastifyServerOptions['logger'];
  /**
   * Overrides the pipeline. **Tests only.**
   *
   * It exists so the boot-time L1 guard can be proven to stop a boot that registers an illegal route. That
   * guard cannot be tested from outside without this seam, because the pipeline a production boot uses is a
   * constant — and the defect it prevents (a boot that hung forever) was invisible for exactly that reason.
   * `server.ts` never passes it.
   */
  slots?: readonly PluginSlot[];
  /**
   * Validated configuration. `server.ts` passes the one it parsed from the environment; a test passes nothing
   * and gets the documented defaults, computed from an **empty** source rather than from `process.env` — a test
   * that silently read the developer's environment would pass here and fail in CI.
   */
  config?: AppConfig;
  /**
   * Database handle to adopt. Tests pass a stub; `server.ts` passes nothing and the `db` stage creates the real
   * pool from `config.databaseUrl`. It exists so the *whole* pipeline — including the boot-time connectivity
   * check — can be exercised without a server on the other end.
   */
  database?: SqlDatabase;
}

/**
 * Builds the Fastify instance with the full pipeline registered **and booted**.
 *
 * Fastify's `register()` only queues a plugin; the body runs when the instance is ready. Without the boot
 * step `buildApp()` would hand back an instance whose routes do not exist yet and whose L1 hook has never
 * run — anything inspecting it, or a mistake inside a plugin, would surface later during `listen()`, far from
 * the code that caused it. Booting here makes "built" mean built: routes registered, hooks run, violations
 * thrown from this call. See {@link registerPipeline} for why the loop cannot await per plugin.
 *
 * The postcondition is strict: the returned instance is **frozen**. Fastify refuses `register`, `addHook` and
 * route additions once it is ready, which is deliberate here — every route belongs to {@link PLUGIN_ORDER} and
 * nothing can be attached outside it. Code that wants to exercise a hook or an illegal route does not need a
 * built app: it uses the exported hook (`installRouteLawHook`) on a bare instance.
 *
 * @param options - Logger configuration; everything else has (or will have) a default.
 * @returns The ready instance, not yet listening.
 * @throws When a plugin fails to register, or any registered route violates L1.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? parseEnv({});

  const app = Fastify({
    logger: withRedaction(options.logger),
    // One decision about an id, made once: the header's value when it is safe to repeat, otherwise a UUIDv4.
    // `requestIdHeader` is disabled because Fastify would otherwise copy any inbound `request-id` verbatim —
    // a second, unvalidated path into the same field.
    requestIdHeader: false,
    genReqId: (request) => resolveRequestId(request.headers[REQUEST_ID_HEADER]),
    // A request that is not valid HTTP never reaches a hook, so the envelope for it is configured here.
    clientErrorHandler,
    // Who may assert a client address. Without this every request behind the documented proxy looks like the
    // proxy: per-IP rate limits become one global bucket and hashed download IPs become identical for everyone.
    // Default `loopback` is correct for the same-host proxy `12-deployment.md` describes; see `config/env.ts`.
    trustProxy: config.trustProxy,
    // Instance-level, because Fastify reads it while parsing a request — long before any hook could set it.
    // Uploads stream through multipart with their own cap, so this bounds JSON only (`P1-API-05`).
    bodyLimit: JSON_BODY_LIMIT_BYTES,
  });

  const routeLaw = installRouteLawHook(app);

  try {
    await registerPipeline(app, options.slots ?? PLUGIN_ORDER, {
      config: options.config ?? parseEnv({}),
      // Threaded through, not just declared: an option that is accepted and then dropped would make every test
      // above pass while the `db` stage quietly opened a real pool against the default DSN.
      ...(options.database === undefined ? {} : { database: options.database }),
    });
  } catch (error) {
    // A partial boot owns resources — the `db` stage has already opened a pool, and the failed instance is never
    // returned, so nothing else can close them. A supervisor retries a failed boot in a loop; without this, every
    // attempt leaves connections behind until Postgres refuses new ones. Closing here also runs the stages'
    // `onClose` hooks in order, which is the same path a clean shutdown takes.
    await app.close().catch(() => undefined);
    throw error;
  }

  // Enforced after the boot, because a throwing `onRoute` hook stalls `ready()` forever — see the module
  // comment in `plugins/route-law.ts`. Booting first also lets the error list every offending route.
  assertRouteLaw(routeLaw.violations);

  return app;
}
