/**
 * The request pipeline, in the only order that works (task `P1-API-01`).
 *
 * Order is not a style preference here: each stage depends on the one before it. Request ids must exist
 * before anything can log or report an error; the error handler must be installed before any route can
 * throw; security headers must wrap error responses too; the admin guard must run before a handler that
 * assumes a verified token. So the pipeline is **data**, iterated by {@link buildApp} — a plugin cannot be
 * added anywhere except its slot, and a slot cannot be silently reordered without this file changing.
 *
 * Slots that have not been implemented yet carry `register: null` and the task that will fill them, which
 * keeps the intended pipeline visible instead of rediscovering it in five separate tasks.
 *
 * @module plugins/order
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { registerRoutes } from '../routes/index';

/** Stable identifier for a pipeline stage. */
export type PluginId =
  'request-context' | 'errors' | 'security' | 'db' | 'rate-limit' | 'auth' | 'routes';

/** One stage of the pipeline. */
export interface PluginSlot {
  /** Identifier, unique within {@link PLUGIN_ORDER}. */
  readonly id: PluginId;
  /** Why the stage sits where it does — the constraint that would break if it moved. */
  readonly rationale: string;
  /** Task that fills the slot; `null` once it is implemented. */
  readonly task: string | null;
  /** The plugin, or `null` while the slot is still empty. */
  readonly register: FastifyPluginAsync | null;
}

/**
 * The pipeline, outermost first.
 *
 * Mirrors the flowchart in `02-architecture.md` §3; that document explains the stages, this array fixes
 * their order.
 */
export const PLUGIN_ORDER: readonly PluginSlot[] = [
  {
    id: 'request-context',
    rationale:
      'Everything after this logs and reports against the request id, so it must exist first.',
    task: 'P1-API-03',
    register: null,
  },
  {
    id: 'errors',
    rationale:
      'Installs setErrorHandler/setNotFoundHandler; a route registered before it would answer 500 with Fastify’s default shape and leak internals.',
    task: 'P1-API-04',
    register: null,
  },
  {
    id: 'security',
    rationale:
      'Helmet-style headers, CORS and body limits must wrap every response including the error envelope.',
    task: 'P1-API-05',
    register: null,
  },
  {
    id: 'db',
    rationale:
      'Decorates the instance with the Kysely pool and fails the boot when the database is unreachable — before any route can serve a request that needs it.',
    task: 'P1-API-06',
    register: null,
  },
  {
    id: 'rate-limit',
    rationale:
      'Runs before the guard so a flood of failed credentials is rejected cheaply, and before handlers so a bulk download loop costs nothing.',
    task: 'P1-API-09',
    register: null,
  },
  {
    id: 'auth',
    rationale:
      'The Bearer guard for /_admin/api (L2, deny by default) runs immediately before the routes it protects — after rate limiting, before anything reads a handler.',
    task: 'P1-AUTH-05',
    register: null,
  },
  {
    id: 'routes',
    rationale: 'Last: routes are the leaves of the pipeline, wrapped by every stage above.',
    task: null,
    register: registerRoutes,
  },
];

/**
 * Lists the pipeline stages that are still empty.
 *
 * @returns Ids of the unimplemented slots, in pipeline order.
 */
export function pendingPlugins(): PluginId[] {
  return PLUGIN_ORDER.filter((slot) => slot.register === null).map((slot) => slot.id);
}

/**
 * Registers every implemented slot, then boots the instance.
 *
 * **The loop must not `await` inside itself.** A Fastify instance is a thenable whose `then` calls
 * `ready()`, so `await app.register(plugin)` boots the app — and the *next* iteration then fails with "Root
 * plugin has already booted". With one implemented slot that mistake is invisible; it surfaces the moment a
 * second plugin lands (`P1-API-03`). Registration is queued, one `ready()` at the end runs them in order.
 *
 * @param app - Instance to populate.
 * @param slots - Pipeline to install; defaults to {@link PLUGIN_ORDER}.
 * @throws When a plugin fails, including an L1 violation thrown from the route-law hook.
 */
export async function registerPipeline(
  app: FastifyInstance,
  slots: readonly PluginSlot[] = PLUGIN_ORDER,
): Promise<void> {
  for (const slot of slots) {
    if (slot.register) app.register(slot.register);
  }
  await app.ready();
}
