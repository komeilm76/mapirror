#!/usr/bin/env bun
/**
 * Creates the admin account (`P1-AUTH-06`, requirement AUTH-1).
 *
 * ```bash
 * ADMIN_PASSWORD='…' bun run admin:init                     # non-interactive, from the environment
 * ADMIN_PASSWORD_FILE=/run/secrets/admin_password bun run admin:init
 * bun run admin:init --username owner                       # password asked for, hidden
 * ```
 *
 * The rules AUTH-1 sets, and where each is enforced:
 *
 * | Requirement | Here |
 * |---|---|
 * | Username and password, default username `admin` | `--username`, then `ADMIN_USERNAME` (default `admin`) |
 * | Works non-interactively | `ADMIN_PASSWORD` or `ADMIN_PASSWORD_FILE`; the file is read as bytes and only trailing line breaks are stripped |
 * | Interactive | hidden prompt, asked twice, on a TTY only |
 * | Idempotent, never overwrites silently | `ensureAdmin` — an existing account is reported and left alone |
 * | Policy enforced | `assertPasswordAcceptable`, every rule at once |
 * | Never echoed, logged or committed | nothing here prints the password; a test asserts the secret appears in neither stream |
 *
 * Failures print one line and exit `1`, like `scripts/migrate.ts`: this runs unattended from a container entrypoint
 * (`P1-DOCK-04`), where a stack above the real message is noise and the exit code is what the entrypoint acts on.
 *
 * @module scripts/init-admin
 */

import { readFile } from 'node:fs/promises';

import { parseEnv, type AppConfig, type EnvSource } from '../apps/api/src/config/env';
import { createDatabase, type SqlDatabase } from '../apps/api/src/db/client';
import { ensureAdmin } from '../apps/api/src/modules/auth/admin-accounts';
import { AdminUsernameError } from '../apps/api/src/modules/auth/admin-accounts';
import { PasswordPolicyError } from '../apps/api/src/modules/auth/password';
import { isInteractive, promptSecret } from './lib/secret-prompt';

/** What the command line asked for. */
export interface InitAdminArgs {
  /** Name from `--username`, when given. `ADMIN_USERNAME` is the fallback. */
  readonly username?: string;
  /** Print usage and do nothing. */
  readonly help: boolean;
}

/** Usage text, next to the parser so the two cannot disagree. */
const USAGE = `Usage: bun run admin:init [--username <name>] [--help]

  --username <name>  Account to create. Defaults to ADMIN_USERNAME, which defaults to "admin".
  --help             Show this message.

Password, in this order: ADMIN_PASSWORD, ADMIN_PASSWORD_FILE, or a hidden prompt when a terminal is available.
An existing account is reported and left unchanged — use reset-admin-password to change a password.`;

/**
 * Parses the command line.
 *
 * Unknown flags are an error rather than being ignored: a mistyped `--usernme` would otherwise quietly create the
 * `admin` account the operator was trying to avoid.
 *
 * @param argv - Arguments after the script name.
 * @returns The requested action.
 * @throws When an argument is not understood or `--username` has no value.
 */
export function parseArgs(argv: readonly string[]): InitAdminArgs {
  let username: string | undefined;
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') return { help: true };
    if (arg === '--username') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--username needs a value\n\n${USAGE}`);
      }
      username = value;
      index += 1;
      continue;
    }
    unknown.push(arg ?? '');
  }

  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(' ')}\n\n${USAGE}`);
  }
  return username === undefined ? { help: false } : { help: false, username };
}

/** Where the password may come from, and what was found. */
interface ResolvedPassword {
  readonly password: string;
  /** Where it came from — safe to print, because it is a location and never a value. */
  readonly source: 'ADMIN_PASSWORD' | 'ADMIN_PASSWORD_FILE' | 'prompt';
}

/** Everything {@link main} touches outside the database; injected so tests need no terminal and no process mutating. */
export interface InitAdminDeps {
  /** Environment to read; defaults to `process.env`. */
  readonly env?: EnvSource;
  /** Line writer for normal output; defaults to `console.log`. */
  readonly out?: (line: string) => void;
  /** Line writer for failures; defaults to `console.error`. */
  readonly err?: (line: string) => void;
  /** Opens the database; defaults to `createDatabase`. A test passes a handle on a throwaway database. */
  readonly connect?: (config: AppConfig) => SqlDatabase;
  /** Answers both prompts; defaults to a hidden terminal prompt. A test supplies the answers. */
  readonly prompt?: (question: string) => Promise<string>;
  /** Whether a terminal is available for prompting; defaults to `process.stdin.isTTY`. */
  readonly interactive?: boolean;
}

/**
 * Resolves the password from the environment, a file, or the terminal.
 *
 * @param config - Validated configuration: `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE` arrive already checked for mutual
 * exclusion (`parseEnv`), so at most one is present.
 * @param deps - Injected prompt and interactivity flag.
 * @returns The password and where it came from.
 * @throws {Error} When there is no source, the file cannot be read, or the two prompts disagree. The message names the
 * variable or the file — never a value.
 */
async function resolvePassword(config: AppConfig, deps: InitAdminDeps): Promise<ResolvedPassword> {
  if (config.adminPassword !== undefined) {
    return { password: config.adminPassword, source: 'ADMIN_PASSWORD' };
  }

  if (config.adminPasswordFile !== undefined) {
    let contents: string;
    try {
      contents = await readFile(config.adminPasswordFile, 'utf8');
    } catch (error) {
      throw new Error(
        `cannot read ADMIN_PASSWORD_FILE ${config.adminPasswordFile}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`,
      );
    }
    // Only the line break an editor or `echo` adds is removed. Spaces are left alone: the policy rejects surrounding
    // whitespace and says so, which is better than silently trimming a secret.
    return { password: contents.replace(/[\r\n]+$/u, ''), source: 'ADMIN_PASSWORD_FILE' };
  }

  const interactive = deps.interactive ?? isInteractive();
  if (!interactive) {
    throw new Error(
      'no admin password supplied and no terminal to prompt on; set ADMIN_PASSWORD or ADMIN_PASSWORD_FILE',
    );
  }

  const prompt = deps.prompt ?? ((question: string) => promptSecret({ question }));
  const first = await prompt('Password: ');
  const second = await prompt('Repeat password: ');
  if (first !== second) {
    throw new Error('the two passwords do not match; nothing was created');
  }
  return { password: first, source: 'prompt' };
}

/**
 * Runs the command.
 *
 * @param argv - Arguments after the script name; defaults to the real process's.
 * @param deps - Injected environment, streams, prompt and database.
 * @returns Process exit code: `0` on success (including "already exists"), `1` on any failure.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: InitAdminDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));

  let args: InitAdminArgs;
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
    // `parseEnv` lists every problem with the variable names and no values (`config/env.ts`), which is the shape an
    // operator needs at 2 a.m.
    err(`error: ${(error as Error).message}`);
    return 1;
  }

  let resolved: ResolvedPassword;
  try {
    resolved = await resolvePassword(config, deps);
  } catch (error) {
    err(`error: ${(error as Error).message}`);
    return 1;
  }

  const username = args.username ?? config.adminUsername;
  const database = (deps.connect ?? createDatabase)(config);

  try {
    const outcome = await ensureAdmin(database.db, {
      username,
      password: resolved.password,
      actorName: 'init-admin',
    });

    if (outcome.status === 'created') {
      out(`admin '${outcome.admin.username}' created (password from ${resolved.source})`);
    } else if (outcome.admin.isActive) {
      out(`admin '${outcome.admin.username}' already exists — unchanged`);
    } else {
      // Reported rather than fixed: re-activating an account is a decision, and a bootstrap script that "repairs"
      // whatever it finds is a bootstrap script that can undo an operator's deliberate lockout on every restart.
      out(
        `admin '${outcome.admin.username}' already exists and is deactivated — unchanged (re-enable it in the admin UI)`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      err('error: the password does not meet the policy:');
      for (const problem of error.problems) err(`  - ${problem.message}`);
      return 1;
    }
    if (error instanceof AdminUsernameError) {
      err('error: the username is not usable:');
      for (const problem of error.problems) err(`  - ${problem.message}`);
      return 1;
    }
    err(`error: could not create the admin account: ${(error as Error).message}`);
    return 1;
  } finally {
    await database.close();
  }
}

// `import.meta.main` is false when a test imports this module.
if (import.meta.main) {
  process.exit(await main());
}
