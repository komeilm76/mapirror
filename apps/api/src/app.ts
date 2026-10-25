/**
 * Fastify instance factory (task `P1-API-01`).
 *
 * `buildApp` is the whole application minus the listening socket: it builds the instance, installs the
 * pipeline in the order fixed by {@link PLUGIN_ORDER}, and registers the three API namespaces. Keeping it
 * separate from `server.ts` is what lets tests exercise real routing and real error behaviour with
 * `app.inject()` — no port, no signal handling, no `process.exit`.
 *
 * Two things are deliberately *not* here yet: the error envelope handlers (`P1-API-04`) and the logger
 * configuration (`P1-API-03`). Until they land, an unknown path answers Fastify's default 404 shape, and the
 * `errors` slot in the pipeline is visibly empty rather than silently forgotten.
 *
 * @module app
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { registerPipeline } from './plugins/order';
import { assertRouteLaw, installRouteLawHook } from './plugins/route-law';

/** Options accepted by {@link buildApp}. */
export interface BuildAppOptions {
  /**
   * Fastify's logger setting. Tests pass `false` (the default); `server.ts` passes a level, so running the
   * process logs and injecting requests into a built app does not.
   */
  logger?: FastifyServerOptions['logger'];
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
  const app = Fastify({ logger: options.logger ?? false });

  const routeLaw = installRouteLawHook(app);

  await registerPipeline(app);

  // Enforced after the boot, because a throwing `onRoute` hook stalls `ready()` forever — see the module
  // comment in `plugins/route-law.ts`. Booting first also lets the error list every offending route.
  assertRouteLaw(routeLaw.violations);

  return app;
}
