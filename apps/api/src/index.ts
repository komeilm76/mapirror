/**
 * `@mapirror/api` — the server's public surface.
 *
 * Exported for tests and for the operator scripts: neither should reach into `src/` for these. `server.ts`
 * is deliberately **not** re-exported here — importing it would be importing the process entry point, and
 * `start()` is only meaningful to a supervisor, not to a caller.
 *
 * @module
 */

export * from './app';
export * from './config/env';
export * from './lib/errors';
export * from './lib/logger';
export * from './config/prefixes';
export * from './db/client';
export {
  pendingPlugins,
  PLUGIN_ORDER,
  registerPipeline,
  type PluginId,
  type PluginSlot,
} from './plugins/order';
export * from './plugins/db';
export * from './plugins/errors';
export * from './plugins/request-context';
export * from './plugins/security';
export * from './routes/probes';
export {
  assertRouteLaw,
  installRouteLawHook,
  ROUTE_LAW_MESSAGE,
  type RouteLawCheck,
} from './plugins/route-law';
