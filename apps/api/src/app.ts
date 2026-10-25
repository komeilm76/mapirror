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

import { isApiPath, isProbePath } from '@mapirror/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { PLUGIN_ORDER } from './plugins/order';

/** Options accepted by {@link buildApp}. */
export interface BuildAppOptions {
  /**
   * Fastify's logger setting. Tests pass `false` (the default); `server.ts` passes `true`, so running the
   * process logs and injecting requests into a built app does not.
   */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Builds the Fastify instance with the full pipeline registered.
 *
 * @param options - Logger configuration; everything else has (or will have) a default.
 * @returns The instance, not yet listening.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // Every route is registered by name in the logs at boot; useful when a prefix is wrong.
    disableRequestLogging: false,
  });

  // L1 enforced at registration time, not only in the law test (`P1-API-08`): a route the API is not allowed
  // to serve cannot boot the server. Registering one is a mistake no deployment can survive, and failing
  // here names the offending route instead of leaving a URL that the law test catches only after the fact.
  //
  // The predicate is *API or probe*, not `isLegalPath`: pages are legal paths in general but the API never
  // serves them (Nginx does), so `isLegalPath` would have let a `/_site/*` route boot this server. My own
  // test caught that when the guard used it.
  app.addHook('onRoute', (route: { url: string; method: string | string[] }) => {
    if (isApiPath(route.url) || isProbePath(route.url)) return;
    // `typeof`, not `Array.isArray`: narrowing a `string | string[]` with `Array.isArray` yields `any[]`,
    // which silently re-introduces `any` into the one check that must stay typed.
    const methods = typeof route.method === 'string' ? route.method : route.method.join(',');
    throw new Error(
      `Route ${methods} ${route.url} violates L1: the API may only serve /_auth/api/*, /_admin/api/*, ` +
        `/_public/api/*, /healthz and /readyz (see 04-api.md §0).`,
    );
  });

  for (const slot of PLUGIN_ORDER) {
    if (slot.register) await app.register(slot.register);
  }

  return app;
}
