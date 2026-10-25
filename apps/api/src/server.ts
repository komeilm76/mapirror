/**
 * Process entry point (task `P1-API-01`).
 *
 * Wraps {@link buildApp} in a listening socket and installs the shutdown path. This file owns everything
 * that touches the process — port, signals, exit codes — and nothing else, so the application can be tested
 * without it.
 *
 * Exit codes are part of the contract with Docker and with `bun run check`:
 * `0` = an asked-for shutdown completed, `1` = we could not start or could not close cleanly. A supervisor
 * that cannot see those apart restarts a crashing container forever.
 *
 * The environment is read **once**, through {@link parseEnv} (`P1-API-02`): the process either has a complete
 * typed configuration or it prints every problem and exits 1. Nothing here reads `process.env` directly, so
 * there is exactly one definition of each default.
 *
 * @module server
 */

import type { FastifyInstance } from 'fastify';

import { buildApp } from './app';
import { ConfigError, parseEnv, type AppConfig, type EnvSource } from './config/env';
import { pruneExpiredTokens } from './modules/auth/tokens';

/** Signals that must shut the process down instead of killing it mid-request. */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * How long a graceful shutdown may take before the process gives up.
 *
 * Below Docker's default 10 s `stop_grace_period`, so we always get to log and choose an exit code instead
 * of being SIGKILLed. `P1-API-06` keeps this bound when it adds the database pool to the same path.
 */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

/**
 * The smallest slice of a Fastify instance the shutdown path needs.
 *
 * Narrow on purpose: the handler can then be tested against a fake whose `close()` never resolves, which is
 * the case that matters (a client streaming an 800 MB download) and the one that cannot be reproduced
 * reliably with a real socket.
 */
export interface ShutdownTarget {
  close: () => Promise<unknown>;
  log: {
    info: (context: object, message: string) => void;
    error: (context: object, message: string) => void;
  };
}

/** How the handler ends the process; injectable so a test does not have to kill the runner. */
export type ExitFn = (code: number) => void;

/**
 * Builds the signal handler: drain, then exit 0 — or exit 1 if closing fails or takes too long.
 *
 * Bounded on purpose. `close()` waits for in-flight requests, and Docker's default `stop_grace_period` is
 * 10 s: without a timer the container is SIGKILLed (exit 137, no log line, nothing to explain). A shutdown
 * that did not finish must not look like one that did, so it exits non-zero and says why.
 *
 * @param app - Instance to drain (or a fake, in tests).
 * @param options - Timeout and exit function; defaults suit the real process.
 * @returns A handler safe to call more than once: a second signal is ignored rather than closing twice.
 */
export function createShutdown(
  app: ShutdownTarget,
  options: { timeoutMs?: number; exit?: ExitFn } = {},
): (signal: string) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit: ExitFn = options.exit ?? ((code) => process.exit(code));
  let closing = false;

  return async (signal: string): Promise<void> => {
    // A second SIGTERM must not start a second close: `close()` twice is a race, and an impatient supervisor
    // sends exactly that — often the same one that will SIGKILL us next.
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');

    const forced = setTimeout(() => {
      app.log.error({ timeoutMs }, 'shutdown timed out; exiting non-zero');
      exit(1);
    }, timeoutMs);
    forced.unref();

    try {
      await app.close();
      clearTimeout(forced);
      exit(0);
    } catch (error) {
      clearTimeout(forced);
      app.log.error({ err: error }, 'shutdown failed');
      exit(1);
    }
  };
}

/**
 * Starts the API and keeps it running until a shutdown signal arrives.
 *
 * @param source - Environment to read; a parameter so the whole startup path can be exercised without mutating
 * `process.env`.
 * @returns The listening instance, together with the config it started with.
 * @throws {ConfigError} When the environment is unusable — before any socket or plugin work happens.
 * @throws When the port is taken or the boot fails; the caller turns that into exit code 1.
 */
export async function start(
  source: EnvSource = process.env,
): Promise<{ app: FastifyInstance; config: AppConfig }> {
  // Validated first: a bad environment must fail before we open a socket or register a plugin, so the message
  // is the only thing in the log instead of the last line after a wall of boot output.
  const config = parseEnv(source);

  const app = await buildApp({ logger: { level: config.logLevel }, config });

  // Housekeeping, once per boot, after the pipeline proved the database usable and before the socket opens
  // (`03-data-model.md` §2.2: rows expired more than 30 days ago are deleted). A failure is logged and does not stop
  // the boot: an old row is not a reason to refuse traffic, and the alternative — a process that will not start
  // because a `DELETE` failed — turns a housekeeping problem into an outage.
  try {
    const pruned = await pruneExpiredTokens(app.db.db);
    if (pruned > 0) app.log.info({ pruned }, 'expired tokens pruned');
  } catch (error) {
    app.log.warn({ err: error }, 'could not prune expired tokens; continuing');
  }

  // Registered before `listen` so a signal during startup still drains rather than orphaning a socket.
  const shutdown = createShutdown(app);
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ port: config.port, host: config.host });
  return { app, config };
}

if (import.meta.main) {
  try {
    await start();
  } catch (error) {
    // A config error is the operator's to fix and already reads as a list, so it is printed as-is; anything
    // else is unexpected and keeps its stack. Both exit 1: a supervisor must not see a boot failure as 0.
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  }
}
