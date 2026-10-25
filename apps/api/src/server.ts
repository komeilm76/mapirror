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
 * Starts the API and keeps it running until a shutdown signal arrives.
 *
 * @returns The listening instance.
 * @throws When the port is taken or the boot fails; the caller turns that into exit code 1.
 */
export async function start(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  // Registered before `listen` so a signal during startup still drains rather than orphaning a socket.
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    // A second SIGTERM must not start a second close: `app.close()` twice is a race, and an impatient
    // supervisor sends exactly that.
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };
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
