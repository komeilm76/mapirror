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

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { parseEnv, type AppConfig } from '../config/env';
import type { SqlDatabase } from '../db/client';
import type { SchemaCheck } from '../db/version-check';
import type { LoginThrottle } from '../modules/auth/login-throttle';
import { loginThrottleFromConfig } from '../modules/auth/login-throttle';

import { registerRoutes } from '../routes/index';

import { installAuthGuard } from './auth-guard';
import { installDb } from './db';
import { installErrorHandlers } from './errors';
import { installRequestContext } from './request-context';
import { installSecurity } from './security';

/** Stable identifier for a pipeline stage. */
export type PluginId =
  'request-context' | 'errors' | 'security' | 'db' | 'rate-limit' | 'auth' | 'routes';

/**
 * What a stage may need besides the instance.
 *
 * Only the validated configuration so far — the `db` stage (`P1-API-06`) needs the DSN and pool size, and the
 * rate limiter its windows, so the context exists now rather than being bolted on by the third consumer. It is
 * passed to `install` instead of being decorated onto the instance: an instance decoration is reachable from
 * every plugin and cannot be narrowed, which is how "the config is a global" happens by accident.
 */
export interface PipelineContext {
  /** The environment this process was started with. */
  readonly config: AppConfig;
  /**
   * An existing database handle to adopt, or `undefined` to create one from {@link config}.
   *
   * A caller that already owns a handle — a test with a stub, an integration test with a real server — hands it
   * over here rather than letting the stage open a second pool.
   */
  readonly database?: SqlDatabase;
  /**
   * Boot-time schema verification and migration. Defaults to the real check
   * ({@link import('../db/version-check').checkSchemaVersion}).
   *
   * Exists for the same reason `slots` does: the specs that assert routing, headers and logging should not need a
   * server with a migrated schema, and a stub handle cannot answer a real `information_schema` query. Tests pass a
   * no-op that reports an in-sync schema; **production never sets it**, so the real check is what a deployment
   * runs. It is not an ownership heuristic — that mistake is recorded in `16-changelog.md` pass 14.
   */
  readonly schemaCheck?: SchemaCheck;
  /**
   * One login throttle for the process (`P1-AUTH-03`).
   *
   * Built by `buildApp` from `config` and threaded here rather than created inside the route plugin, for one reason:
   * the limiter has to outlive a request. A new instance per registration would still be per-process, but a new one
   * inside the handler — the shape that is easy to write by accident — would reset the count on every attempt, i.e. no
   * limiter at all. Passing it in makes the lifetime explicit, and making it **required** means it cannot be passed in
   * only sometimes: a second instance would double every limit while looking correct.
   */
  readonly loginThrottle: LoginThrottle;
  /**
   * Verifier for the Bearer guard, when a caller wants to supply one. **Tests only** — `buildApp` forwards it and
   * `server.ts` never sets it; without it the guard uses the database-backed verifier.
   */
  readonly authVerify?: (request: FastifyRequest, token: string) => Promise<unknown>;
}

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
  readonly install: ((app: FastifyInstance, context: PipelineContext) => void) | null;
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
    task: null,
    install: installErrorHandlers,
  },
  {
    id: 'security',
    rationale:
      'Helmet-style headers, CORS and body limits must wrap every response including the error envelope.',
    task: null,
    install: installSecurity,
  },
  {
    id: 'db',
    rationale:
      'Decorates the instance with the Kysely pool and fails the boot when the database is unreachable — before any route can serve a request that needs it.',
    task: null,
    install: installDb,
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
    task: null,
    // The stage's signature is `(app, context)`; the guard takes no policy from the context — deliberately, since an
    // option here would be the opt-out flag L2 forbids. The closure keeps the pipeline's shape without inventing one.
    install: (app, context) => {
      installAuthGuard(app, context.authVerify === undefined ? {} : { verify: context.authVerify });
    },
  },
  {
    id: 'routes',
    rationale: 'Last: routes are the leaves of the pipeline, wrapped by every stage above.',
    task: null,
    // Routes *are* a plugin: they want encapsulation, so the three prefixes stay separate subtrees.
    install: (app, context) => {
      // The routes need three things from the process: the cache directory for the readiness probe, the validated
      // configuration for the auth limits, and the login throttle. A stage that reads configuration may not read
      // `process.env` behind the pipeline's back (`P1-API-02`), so all three arrive as options.
      app.register(registerRoutes, {
        cacheDir: context.config.cacheDir,
        config: context.config,
        loginThrottle: context.loginThrottle,
      });
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
/**
 * The context a pipeline gets when the caller supplies none: the defaults an empty environment parses to, plus the
 * login throttle those defaults describe.
 *
 * The configuration comes from an **empty** source, not from `process.env`: a stage that reads configuration must
 * produce the same behaviour in a test as in CI, and a test that inherits the developer's environment is a test that
 * fails only on the machine that did not write it.
 *
 * @returns A complete {@link PipelineContext}.
 */
export function defaultPipelineContext(): PipelineContext {
  const config = parseEnv({});
  return { config, loginThrottle: loginThrottleFromConfig(config) };
}

export async function registerPipeline(
  app: FastifyInstance,
  slots: readonly PluginSlot[] = PLUGIN_ORDER,
  context: PipelineContext = defaultPipelineContext(),
): Promise<void> {
  for (const slot of slots) {
    // Not awaited: a slot's install may call `app.register()`, whose return value is a thenable that boots the
    // whole instance. Awaiting it here would boot mid-pipeline and fail with FST_ERR_INSTANCE_ALREADY_LISTENING
    // the moment a second stage exists. The single `ready()` below boots everything that was queued.
    slot.install?.(app, context);
  }
  await app.ready();
}
