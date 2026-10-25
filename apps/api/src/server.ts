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
 * Environment reading here is intentionally minimal (`PORT`, `HOST`, `LOG_LEVEL` with defaults): `P1-API-02`
 * replaces it with the Zod-validated config, and inventing a second parsing path now would leave two
 * definitions of the same defaults.
 *
 * @module server
 */

import type { FastifyInstance } from 'fastify';

import { buildApp } from './app';

/** Default port; matches `PORT` in `.env.example` and the compose port mapping. */
const DEFAULT_PORT = 3000;

/** Default bind address: all interfaces, because the container's port is what Nginx connects to. */
const DEFAULT_HOST = '0.0.0.0';

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
 * Reads the port from the environment.
 *
 * Exported for its own test: it is the only place in the process where a string from outside becomes a
 * number, and a port of `0` (ephemeral) or `70000` must not reach `listen`.
 *
 * @returns A valid TCP port, or the default when the value is absent or unusable.
 */
export function readPort(): number {
  const raw = process.env.PORT?.trim() ?? '';
  // Digits only. `Number(raw)` would read `0x10` as 16 and `30e3` as 30000 — both bind a port the operator
  // did not ask for. This is the same lesson as `parsePagination` in `@mapirror/shared`: a value from
  // outside is parsed by a rule you can state, not by whatever the language tolerates.
  if (!/^[0-9]+$/.test(raw)) return DEFAULT_PORT;
  const parsed = Number(raw);
  return parsed > 0 && parsed < 65_536 ? parsed : DEFAULT_PORT;
}

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
 * @returns The listening instance.
 * @throws When the port is taken or the boot fails; the caller turns that into exit code 1.
 */
export async function start(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  // Registered before `listen` so a signal during startup still drains rather than orphaning a socket.
  const shutdown = createShutdown(app);
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ port: readPort(), host: process.env.HOST ?? DEFAULT_HOST });
  return app;
}

if (import.meta.main) {
  try {
    await start();
  } catch (error) {
    console.error('failed to start the API:', error);
    process.exit(1);
  }
}
