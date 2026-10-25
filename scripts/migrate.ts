#!/usr/bin/env bun
/**
 * Applies SQL migrations (task `P1-DB-01`).
 *
 * ```bash
 * bun run db:migrate            # apply everything pending
 * bun run db:reset             # drop the schema, then apply everything (development only)
 * ```
 *
 * The work itself lives in `apps/api/src/db/migrator.ts`; this file is the operator's front door: read the
 * environment through the same validated schema the API uses, run, report, and exit with a status a container
 * entrypoint can act on (`P1-DOCK-04`).
 *
 * Failures print one line, not a stack: this runs unattended in an entrypoint, where a stack trace above the
 * real message is noise. The exception's own message already names the migration that failed.
 *
 * @module scripts/migrate
 */

import { parseEnv } from '../apps/api/src/config/env';
import { createDatabase } from '../apps/api/src/db/client';
import { migrateToLatest, resetDatabase } from '../apps/api/src/db/migrator';

/** What the command line asked for. */
export interface MigrationArgs {
  /** Drop the schema first. Refused when `NODE_ENV=production`. */
  readonly reset: boolean;
  /** Print usage and do nothing. */
  readonly help: boolean;
}

/** Usage text, kept next to the parser so the two cannot disagree. */
const USAGE = `Usage: bun run scripts/migrate.ts [--reset] [--help]

  --reset   Drop the public schema before migrating. Development only.
  --help    Show this message.

Environment: DATABASE_URL (required in production), NODE_ENV.`;

/**
 * Parses the command line.
 *
 * Unknown flags are an error rather than being ignored: `--resest` silently doing nothing on a command that
 * drops schemas is exactly the sort of mistake an operator makes once.
 *
 * @param argv - Arguments after the script name.
 * @returns The requested action.
 * @throws When an argument is not understood.
 */
export function parseArgs(argv: readonly string[]): MigrationArgs {
  const args: MigrationArgs = {
    reset: argv.includes('--reset'),
    help: argv.includes('--help'),
  };
  const unknown = argv.filter((arg) => arg !== '--reset' && arg !== '--help');
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(' ')}\n\n${USAGE}`);
  }
  return args;
}

/**
 * Runs the command.
 *
 * @param argv - Arguments after the script name; defaults to the real process's.
 * @returns Process exit code: `0` on success, `1` on any failure.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: MigrationArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    return 1;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  let config;
  try {
    config = parseEnv(process.env);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    return 1;
  }

  // Checked before the connection is opened, so a mistyped flag on a production host cannot even reach the
  // database. `db:reset` is a development convenience (`09-development.md` §4).
  if (args.reset && config.nodeEnv === 'production') {
    console.error('error: db:reset refuses to run with NODE_ENV=production');
    return 1;
  }

  const database = createDatabase(config);
  try {
    if (args.reset) {
      await resetDatabase(database.db);
      console.log('schema reset: public schema dropped and recreated');
    }

    const { applied } = await migrateToLatest(database.db);
    if (applied.length === 0) {
      console.log('migrations: already up to date');
    } else {
      for (const name of applied) console.log(`  applied ${name}`);
      console.log(`migrations: ${applied.length} applied`);
    }
    return 0;
  } catch (error) {
    console.error(`error: migration failed: ${(error as Error).message}`);
    return 1;
  } finally {
    await database.close();
  }
}

// `import.meta.main` is false when a test imports this module for `parseArgs`.
if (import.meta.main) {
  process.exit(await main());
}
