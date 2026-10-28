#!/usr/bin/env bun
/**
 * Enqueues a Geofabrik catalog sync through the durable job queue (`P2-API-02`).
 *
 * This calls the same idempotent database operation as `POST /_admin/api/catalog/sync`; it never invokes the handler or
 * contacts Geofabrik itself. A process with `WORKER_ENABLED=true` claims and runs the job after it is committed.
 *
 * @module scripts/sync-catalog
 */

import { parseEnv, type AppConfig, type EnvSource } from '../apps/api/src/config/env';
import { createDatabase, type SqlDatabase } from '../apps/api/src/db/client';
import { enqueueCatalogSyncJob } from '../apps/api/src/modules/jobs/enqueue-catalog-sync';

/** What the command line asked for. */
export interface SyncCatalogArgs {
  /** Print usage and do nothing. */
  readonly help: boolean;
}

/** Usage text, kept beside the parser so unsupported flags fail clearly. */
const USAGE = `Usage: bun run sync:catalog [--help]

  Enqueue (or reuse) one Geofabrik catalog-sync job in PostgreSQL. The configured API worker processes it.
  --help  Show this message.

Environment: DATABASE_URL (required in production).`;

/** Dependencies outside the queue operation, injected so tests need no process mutation or terminal. */
export interface SyncCatalogDeps {
  /** Environment to read; defaults to `process.env`. */
  readonly env?: EnvSource;
  /** Line writer for normal output; defaults to `console.log`. */
  readonly out?: (line: string) => void;
  /** Line writer for failures; defaults to `console.error`. */
  readonly err?: (line: string) => void;
  /** Opens the database; defaults to `createDatabase`. */
  readonly connect?: (config: AppConfig) => SqlDatabase;
}

/**
 * Parses command-line arguments; unrecognized flags are errors rather than silently ignored.
 *
 * @param argv - Arguments after the script name.
 * @returns The requested action.
 * @throws When an argument is not recognized.
 */
export function parseArgs(argv: readonly string[]): SyncCatalogArgs {
  const unknown = argv.filter((arg) => arg !== '--help');
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')}\n\n${USAGE}`);
  return { help: argv.includes('--help') };
}

/**
 * Enqueues one manual sync and closes its database pool.
 *
 * @param argv - Arguments after the script name; defaults to the real process's.
 * @param deps - Injectable environment, output and database.
 * @returns Process exit code: `0` on success, `1` on failure.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: SyncCatalogDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));

  let args: SyncCatalogArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err(`error: ${(error as Error).message}`);
    return 1;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }

  let config: AppConfig;
  try {
    config = parseEnv(deps.env ?? process.env);
  } catch (error) {
    err(`error: ${(error as Error).message}`);
    return 1;
  }

  let database: SqlDatabase;
  try {
    database = (deps.connect ?? createDatabase)(config);
  } catch (error) {
    err(`error: could not open the database: ${(error as Error).message}`);
    return 1;
  }

  let exitCode = 0;
  try {
    const jobId = await enqueueCatalogSyncJob(database.db);
    out(`catalog sync job: ${jobId}`);
  } catch (error) {
    err(`error: could not enqueue catalog sync: ${(error as Error).message}`);
    exitCode = 1;
  }

  try {
    await database.close();
  } catch (error) {
    err(`error: could not close the database: ${(error as Error).message}`);
    exitCode = 1;
  }
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
