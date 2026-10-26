#!/usr/bin/env bun
/**
 * Waits until the database answers, then exits `0` (`P1-DOCK-04`).
 *
 * ```bash
 * bun run scripts/wait-for-db.ts                  # up to 60 s
 * bun run scripts/wait-for-db.ts --timeout 300    # a slow NAS or a cold volume
 * ```
 *
 * The first step of `docker/entrypoint.api.sh`, and the reason it is a script rather than four lines of shell: the API
 * image contains **no `psql` and no `pg_isready`** (`docker/api.Dockerfile` installs no OS packages at all), and a bash
 * `/dev/tcp` probe would answer a different question. An open port is not a usable database — PostgreSQL refuses
 * connections with `57P03 the database system is starting up` while it recovers, and a proxy in front of it accepts
 * and then hangs. What this asks is the question the API's own boot asks: **does `select 1` come back**, through the
 * same pool, the same DSN and the same bounded ping (`db/client.ts`, `SqlDatabase.check`).
 *
 * | Decision | Why |
 * |---|---|
 * | a **deadline**, not an attempt count | the failure an operator cares about is "it never came up", and a count only says that in units of an interval nobody documented. `--timeout` is in seconds, like every other timeout in this project |
 * | the reason is printed **once**, then every tenth attempt | a database that is down for 55 s would otherwise print 55 identical lines at exactly the moment someone is reading the log; the first line says what is wrong, the periodic one says it is still wrong |
 * | the DSN is **never** printed | `14-security.md` L9. The driver's message comes from `check`'s `cause` and is masked of any `postgres://` URL before it reaches a stream, because a connection string contains a password |
 * | exits `1`, not `0`, on timeout | the entrypoint uses the exit code to decide whether to start the API. A wait that gives up quietly starts a server that answers `503` to everything |
 * | a **permanent** refusal is not retried | `57P03` and `ECONNREFUSED` mean *not yet*; `28P01` and `3D000` mean *never, until someone edits `.env`*. Retrying those turns a wrong password into a silent minute — exactly the minute an operator spends looking at the wrong thing |
 *
 * @module scripts/wait-for-db
 */

import type { AppConfig, EnvSource } from '../apps/api/src/config/env';
import { parseEnv } from '../apps/api/src/config/env';
import { createDatabase, PING_TIMEOUT_MS, type SqlDatabase } from '../apps/api/src/db/client';

/** How long to wait by default: `05-flows.md` F1 and `12-deployment.md` §2 both say 60 s. */
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 60;

/** Upper bound for `--timeout`. An hour is already longer than any sane restart; beyond that something is misconfigured. */
export const MAX_WAIT_TIMEOUT_SECONDS = 3_600;

/** Pause between attempts. One second is short enough to feel immediate and long enough not to spin a CPU. */
export const WAIT_INTERVAL_MS = 1_000;

/** Print progress every this many attempts — i.e. roughly every ten seconds. */
export const PROGRESS_EVERY_ATTEMPTS = 10;

/** Longest reason kept from the driver; a stack frame or a multi-line driver message is not a log line. */
export const MAX_REASON_LENGTH = 160;

/**
 * Refusals that no amount of waiting can fix, mapped to what the operator should look at.
 *
 * Everything else in the driver's vocabulary is a *timing* problem — `ECONNREFUSED` while PostgreSQL starts,
 * `57P03` while it recovers from a crash, `ENOTFOUND` while DNS catches up — and waiting is the right answer. These
 * four are not: the server is up, it read the request, and it said no. A 60-second silence followed by
 * `did not answer within 60s` reads like a slow database and sends people to `docker stats`; the truth is that
 * `POSTGRES_PASSWORD` in `.env` and the one in the volume disagree.
 *
 * `42501` (insufficient privilege) and `28000` (invalid authorization) are included because PostgreSQL can raise them
 * instead of `28P01` depending on the `pg_hba.conf` method, and `3D000` because a `POSTGRES_DB` that never ran
 * `initdb` — or a mistyped `DATABASE_URL` — never becomes true either.
 */
export const PERMANENT_FAILURES: ReadonlyMap<string, string> = new Map([
  ['3D000', 'that database does not exist on the server'],
  ['28P01', 'the server rejected the password'],
  ['28000', 'the server rejected the credentials'],
  ['42501', 'that role may not connect to that database'],
]);

/** What the command line asked for. */
export interface WaitArgs {
  /** Deadline in seconds. */
  readonly timeoutSeconds: number;
  /** Print usage and do nothing. */
  readonly help: boolean;
}

/** Usage text, next to the parser so the two cannot disagree. */
const USAGE = `Usage: bun run scripts/wait-for-db.ts [--timeout <seconds>] [--help]

  --timeout <seconds>  How long to wait for the database (default ${DEFAULT_WAIT_TIMEOUT_SECONDS}, max ${MAX_WAIT_TIMEOUT_SECONDS}).
  --help               Show this message.

Environment: DATABASE_URL (required in production; a local default otherwise).`;

/**
 * Parses the command line.
 *
 * Unknown flags are refused rather than ignored, for the same reason the other scripts do it: `--tmeout 300` silently
 * waiting the default minute is a puzzle at 3 a.m.
 *
 * @param argv - Arguments after the script name.
 * @returns The requested deadline.
 * @throws When an argument is unknown, or `--timeout` has no whole-number value in range.
 */
export function parseArgs(argv: readonly string[]): WaitArgs {
  let timeoutSeconds = DEFAULT_WAIT_TIMEOUT_SECONDS;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--timeout') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`--timeout needs a value in seconds\n\n${USAGE}`);
      // `Number('')` is 0 and `Number(' 5 ')` is 5, so the shape is checked before the value: a flag that accepted
      // "5s" as 5 would make `--timeout 5min` mean five seconds.
      if (!/^\d+$/u.test(value))
        throw new Error(`--timeout needs whole seconds, got "${value}"\n\n${USAGE}`);
      const seconds = Number(value);
      if (seconds < 1 || seconds > MAX_WAIT_TIMEOUT_SECONDS) {
        throw new Error(
          `--timeout must be between 1 and ${MAX_WAIT_TIMEOUT_SECONDS} seconds\n\n${USAGE}`,
        );
      }
      timeoutSeconds = seconds;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
  }

  return { timeoutSeconds, help };
}

/**
 * The driver's `code` for a failure, when it has one.
 *
 * `check` wraps the driver's error as `cause`, so the code lives one level down — in `code` for a socket or a
 * PostgreSQL SQLSTATE (`ECONNREFUSED`, `28P01`). A stub in a test, or any other throw, has no code and gets
 * `undefined` rather than an invented one.
 *
 * @param error - What the attempt threw.
 * @returns The code, or `undefined` when there is none.
 */
export function driverCode(error: unknown): string | undefined {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const code = (cause as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * Turns whatever went wrong into one short line.
 *
 * `check` throws an `AppError` whose message is written for an HTTP client ("The database is not reachable.") and
 * whose `cause` is the driver's own error — a `code` such as `ECONNREFUSED` when there is one, and otherwise the
 * driver's message. Anything else (a stub in a test, an unexpected throw) is described by its own message.
 *
 * @param error - What the attempt threw.
 * @returns One bounded line, with any connection string masked.
 */
export function reasonFor(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const message = (cause as Error | null | undefined)?.message;
  const reason = driverCode(error) ?? message ?? 'no reason given';

  return reason
    .replace(/postgres(?:ql)?:\/\/\S+/giu, 'postgres://[redacted]')
    .replace(/\s+/gu, ' ')
    .slice(0, MAX_REASON_LENGTH);
}

/** What {@link main} needs; every field has a production default. */
export interface WaitDeps {
  /** Environment to read. */
  readonly env?: EnvSource;
  /** Where progress goes; `stderr`, because it is not the command's output. */
  readonly out?: (line: string) => void;
  /** Where failures go. */
  readonly err?: (line: string) => void;
  /** Opens the handle. Defaults to the real pool. */
  readonly connect?: (config: AppConfig) => SqlDatabase;
  /** Pause between attempts. Injected so a test does not spend a minute proving a deadline. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Clock in milliseconds. Injected for the same reason. */
  readonly now?: () => number;
}

/**
 * Runs the command.
 *
 * @param argv - Arguments after the script name; defaults to the real process's.
 * @param deps - Injected environment, streams, clock and connection.
 * @returns Process exit code: `0` once the database answered, `1` on timeout or on any failure before the first attempt.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: WaitDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.error(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  let args: WaitArgs;
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

  const timeoutMs = args.timeoutSeconds * 1_000;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const database = (deps.connect ?? createDatabase)(config);

  let attempt = 0;
  try {
    for (;;) {
      attempt += 1;
      // Each attempt is bounded twice: `check` bounds itself (5 s by default), and the remaining budget is passed in so
      // a single probe cannot outlive the deadline it is meant to respect.
      const budget = Math.max(1, Math.min(PING_TIMEOUT_MS, deadline - now()));
      try {
        await database.check(budget);
        out(`database: ready after ${attempt} attempt(s), ${now() - startedAt} ms`);
        return 0;
      } catch (error) {
        // A refusal that cannot change is reported once, at once. Waiting here is what makes a wrong password look
        // like a slow database (§`PERMANENT_FAILURES`).
        const permanent = PERMANENT_FAILURES.get(driverCode(error) ?? '');
        if (permanent !== undefined) {
          err(
            `error: the database refused the connection and will keep refusing it — ${permanent} (${reasonFor(error)}); check DATABASE_URL and POSTGRES_PASSWORD`,
          );
          return 1;
        }
        const elapsed = now() - startedAt;
        const remaining = deadline - now();
        if (remaining <= 0) {
          err(
            `error: the database did not answer within ${args.timeoutSeconds}s (${attempt} attempt(s); ${reasonFor(error)})`,
          );
          return 1;
        }
        // One line for the first failure, then one every ten seconds: enough to diagnose, not enough to bury the log.
        if (attempt === 1) {
          out(
            `database: not ready yet (${reasonFor(error)}); retrying for up to ${args.timeoutSeconds}s`,
          );
        } else if (attempt % PROGRESS_EVERY_ATTEMPTS === 1) {
          out(
            `database: still not ready after ${Math.round(elapsed / 1_000)}s (${reasonFor(error)})`,
          );
        }
        await sleep(Math.min(WAIT_INTERVAL_MS, remaining));
      }
    }
  } finally {
    await database.close();
  }
}

// `import.meta.main` is false when a test imports this module for `parseArgs`.
if (import.meta.main) {
  process.exit(await main());
}
