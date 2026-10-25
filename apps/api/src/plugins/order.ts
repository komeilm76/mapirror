/**
 * The request pipeline, in the only order that works (task `P1-API-01`).
 *
 * Order is not a style preference here: each stage depends on the one before it. Request ids must exist
 * before anything can log or report an error; the error handler must be installed before any route can
 * throw; security headers must wrap error responses too; the admin guard must run before a handler that
 * assumes a verified token. So the pipeline is **data**, iterated by {@link buildApp} — a plugin cannot be
 * added anywhere except its slot, and a slot cannot be silently reordered without this file changing.
 *
 * Slots that have not been implemented yet carry `install: null` and the task that will fill them, which
 * keeps the intended pipeline visible instead of rediscovering it in five separate tasks.
 *
 * **A stage installs on the root instance, not inside a plugin of its own.** That was a defect, found when
 * `P1-API-03` tried to use slot 1: Fastify encapsulates hooks added inside a plugin, so a stage registered
 * with `app.register(...)` and adding an `onRequest` hook applied that hook to its own (empty) subtree and to
 * nothing else. Measured: the hook never ran for a request. Stages that install error handlers, security
 * headers or guards have exactly the same shape, so the pipeline would have been four silent no-ops. Calling
 * `install(app)` with the root instance is what makes "the pipeline wraps every request" true.
 *
 * @module plugins/order
 */

import type { FastifyInstance } from 'fastify';

import { registerRoutes } from '../routes/index';

import { installRequestContext } from './request-context';

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
  /**
   * Installs the stage on the **root** instance, or `null` while the slot is still empty.
   *
   * Returns nothing on purpose. A stage that needs Fastify's plugin machinery (encapsulated routes) calls
   * `app.register(...)` itself and lets the single `ready()` at the end of {@link registerPipeline} boot it —
   * returning that call's promise would boot the instance mid-pipeline (see {@link registerPipeline}).
   */
  readonly install: ((app: FastifyInstance) => void) | null;
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
    task: null,
    install: installRequestContext,
  },
  {
    id: 'errors',
    rationale:
      'Installs setErrorHandler/setNotFoundHandler; a route registered before it would answer 500 with Fastify’s default shape and leak internals.',
    task: 'P1-API-04',
    install: null,
  },
  {
    id: 'security',
    rationale:
      'Helmet-style headers, CORS and body limits must wrap every response including the error envelope.',
    task: 'P1-API-05',
    install: null,
  },
  {
    id: 'db',
    rationale:
      'Decorates the instance with the Kysely pool and fails the boot when the database is unreachable — before any route can serve a request that needs it.',
    task: 'P1-API-06',
    install: null,
  },
  {
    id: 'rate-limit',
    rationale:
      'Runs before the guard so a flood of failed credentials is rejected cheaply, and before handlers so a bulk download loop costs nothing.',
    task: 'P1-API-09',
    install: null,
  },
  {
    id: 'auth',
    rationale:
      'The Bearer guard for /_admin/api (L2, deny by default) runs immediately before the routes it protects — after rate limiting, before anything reads a handler.',
    task: 'P1-AUTH-05',
    install: null,
  },
  {
    id: 'routes',
    rationale: 'Last: routes are the leaves of the pipeline, wrapped by every stage above.',
    task: null,
    // Routes *are* a plugin: they want encapsulation, so the three prefixes stay separate subtrees.
    install: (app) => {
      app.register(registerRoutes);
    },
  },
];

/**
 * Lists the pipeline stages that are still empty.
 *
 * @returns Ids of the unimplemented slots, in pipeline order.
 */
export function pendingPlugins(): PluginId[] {
  return PLUGIN_ORDER.filter((slot) => slot.install === null).map((slot) => slot.id);
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
    // Not awaited: a slot's install may call `app.register()`, whose return value is a thenable that boots the
    // whole instance. Awaiting it here would boot mid-pipeline and fail with FST_ERR_INSTANCE_ALREADY_LISTENING
    // the moment a second stage exists. The single `ready()` below boots everything that was queued.
    slot.install?.(app);
  }
  await app.ready();
}
