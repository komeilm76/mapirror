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
export * from './config/prefixes';
export {
  pendingPlugins,
  PLUGIN_ORDER,
  registerPipeline,
  type PluginId,
  type PluginSlot,
} from './plugins/order';
export {
  assertRouteLaw,
  installRouteLawHook,
  ROUTE_LAW_MESSAGE,
  type RouteLawCheck,
} from './plugins/route-law';
