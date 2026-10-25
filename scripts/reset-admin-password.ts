#!/usr/bin/env bun
/**
 * Resets an admin password and ends every session on that account (`P1-AUTH-07`, requirement AUTH-4).
 *
 * ```bash
 * bun run admin:reset                                    # prompt for the new password, twice, hidden
 * bun run admin:reset --username owner --generate        # print a strong password once
 * echo "$NEW" | bun run admin:reset --password-stdin     # automation
 * docker compose exec api bun run scripts/reset-admin-password.ts --username admin
 * ```
 *
 * AUTH-4 asks for three things, and the order below is what makes each of them true:
 *
 * | Requirement | Where |
 * |---|---|
 * | Runnable inside Docker | no terminal is required: `--generate` and `--password-stdin` work through `docker exec -T` |
 * | Takes a username + new password, or generates one and prints it **once** | `--generate` prints to stdout *after* the change committed — never a password that is not in effect |
 * | Revokes existing tokens | `resetAdminPassword`, in the same transaction as the new hash |
 *
 * Two deliberate omissions:
 *
 * - **No `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE` fallback.** Those variables are how the *bootstrap* works
 *   (`init-admin.ts`), and a reset that silently reused the container's environment would set the admin password back to
 *   the value in `.env` — the opposite of what an operator running a reset wants. A reset is explicit: a flag, a pipe, or
 *   a prompt.
 * - **No `--password <value>` flag.** An argument is visible in `ps`, in shell history and in `docker inspect`-style
 *   tooling; `--password-stdin` exists precisely so automation does not need one.
 *
 * One accepted cost, stated rather than hidden: with `--generate` the only copy of the new password is the line printed
 * after the commit, so if stdout is lost (`… | head -1`, a closed pipe, a truncated log) the password is lost with it and
 * the reset has to be run again. Printing *before* the commit would trade that for the worse failure — a credential in
 * the operator's hands that was never stored.
 *
 * @module scripts/reset-admin-password
 */

import type { Readable } from 'node:stream';

import { parseEnv, type AppConfig, type EnvSource } from '../apps/api/src/config/env';
import { createDatabase, type SqlDatabase } from '../apps/api/src/db/client';
import { findAdminByUsername } from '../apps/api/src/db/repositories/admins';
import {
  AdminNotFoundError,
  AdminUsernameError,
  parseAdminUsername,
  resetAdminPassword,
} from '../apps/api/src/modules/auth/admin-accounts';
import {
  generateStrongPassword,
  PasswordPolicyError,
  type PasswordProblem,
} from '../apps/api/src/modules/auth/password';
import { isInteractive, promptSecret } from './lib/secret-prompt';

/** What the command line asked for. */
export interface ResetArgs {
  /** Name from `--username`, when given. `ADMIN_USERNAME` is the fallback. */
  readonly username?: string;
  /** Generate a strong password and print it once, instead of reading one. */
  readonly generate: boolean;
  /** Read the new password from stdin, for automation. */
  readonly passwordStdin: boolean;
  /** Print usage and do nothing. */
  readonly help: boolean;
}

/** Usage text, next to the parser so the two cannot disagree. */
const USAGE = `Usage: bun run admin:reset [--username <name>] [--generate | --password-stdin] [--help]

  --username <name>  Account to reset. Defaults to ADMIN_USERNAME, which defaults to "admin".
  --generate         Generate a strong password and print it once.
  --password-stdin   Read the new password from stdin (for automation).
  --help             Show this message.

With no source given, the password is asked for twice on a terminal, hidden.
Every reset ends all sessions on the account: existing tokens stop working immediately.`;

/**
 * Parses the command line.
 *
 * `--generate` and `--password-stdin` together are refused rather than resolved by precedence: one of the two would be
 * silently ignored, and the operator would be left believing a generated password was printed when the piped one was
 * used (or the reverse).
 *
 * @param argv - Arguments after the script name.
 * @returns The requested action.
 * @throws When an argument is not understood, `--username` has no value, or the two password sources are combined.
 */
export function parseArgs(argv: readonly string[]): ResetArgs {
  let username: string | undefined;
  let generate = false;
  let passwordStdin = false;
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') return { generate: false, passwordStdin: false, help: true };
    if (arg === '--generate') {
      generate = true;
      continue;
    }
    if (arg === '--password-stdin') {
      passwordStdin = true;
      continue;
    }
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
  if (generate && passwordStdin) {
    throw new Error('--generate and --password-stdin cannot be combined; pick one source');
  }

  return {
    generate,
    passwordStdin,
    help: false,
    ...(username === undefined ? {} : { username }),
  };
}

/**
 * Reads a piped password and removes only the line break a shell or editor adds.
 *
 * Exported for the test that pins the stripping: `echo "$P" | …` and `docker exec -T` both arrive with a trailing
 * newline, and a hash of `hunter2\n` is a password the operator cannot reproduce. Spaces are left alone — the policy
 * rejects surrounding whitespace with a message, and trimming a secret would silently change it.
 *
 * @param input - Stream to read, usually `process.stdin`.
 * @returns Everything received, minus trailing line breaks.
 */
export async function readStdin(input: Readable): Promise<string> {
  let text = '';
  for await (const chunk of input) text += String(chunk);
  return text.replace(/[\r\n]+$/u, '');
}

/** Everything {@link main} touches outside the database; injected so tests need no terminal and no process mutating. */
export interface ResetDeps {
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
  /** Reads a piped password; defaults to reading `process.stdin`. */
  readonly readPasswordFromStdin?: () => Promise<string>;
  /** Generates a password; defaults to {@link generateStrongPassword}. Injected so a test can predict the output. */
  readonly generate?: (username: string) => string;
}

/** What the new password will be, and whether it must be printed. */
interface NewPassword {
  readonly password: string;
  /** `true` only for `--generate`: the value exists nowhere else, so it is printed exactly once. */
  readonly print: boolean;
}

/**
 * Obtains the new password from the chosen source.
 *
 * Called **after** the account has been found, so an operator who mistypes `--username` does not type a password twice
 * for nothing (and does not have to wonder whether the account exists).
 *
 * @param args - Parsed command line.
 * @param username - Account being reset, kept out of a generated password by the policy.
 * @param deps - Injected prompt, stdin reader and generator.
 * @returns The password and whether to print it.
 * @throws {Error} When stdin is empty or the two prompts disagree.
 */
async function resolvePassword(
  args: ResetArgs,
  username: string,
  deps: ResetDeps,
): Promise<NewPassword> {
  if (args.generate) {
    const generate =
      deps.generate ?? ((name: string) => generateStrongPassword(undefined, { username: name }));
    return { password: generate(username), print: true };
  }

  if (args.passwordStdin) {
    const read = deps.readPasswordFromStdin ?? (() => readStdin(process.stdin));
    const password = await read();
    if (password.length === 0) {
      throw new Error('--password-stdin received nothing; pipe the new password on stdin');
    }
    return { password, print: false };
  }

  const prompt = deps.prompt ?? ((question: string) => promptSecret({ question }));
  const first = await prompt('New password: ');
  const second = await prompt('Repeat new password: ');
  if (first !== second) throw new Error('the two passwords do not match; nothing was changed');
  return { password: first, print: false };
}

/** Prints policy failures one per line, as `- message`, so an operator can fix all of them in one edit. */
function reportProblems(err: (line: string) => void, problems: readonly PasswordProblem[]): void {
  err('error: the password does not meet the policy:');
  for (const problem of problems) err(`  - ${problem.message}`);
}

/**
 * Runs the command.
 *
 * @param argv - Arguments after the script name; defaults to the real process's.
 * @param deps - Injected environment, streams, prompt and database.
 * @returns Process exit code: `0` on success, `1` on any failure.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: ResetDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));

  let args: ResetArgs;
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

  const interactive = deps.interactive ?? isInteractive();
  // Checked before the database is opened: with no source and no terminal this run cannot succeed, and saying so is
  // more useful than a connection error or a prompt against a closed stdin.
  if (!args.generate && !args.passwordStdin && !interactive) {
    err(
      'error: no new password source and no terminal to prompt on; use --generate or --password-stdin',
    );
    return 1;
  }
  if (args.passwordStdin && interactive) {
    // Also before the database, and for the same reason: this run cannot do the right thing. A TTY on stdin means the
    // "pipe" is a person typing, and the terminal would echo every character — the one case a pipe is required for.
    err(
      'error: --password-stdin needs a pipe, not a terminal; use the prompt (no flags) or --generate',
    );
    return 1;
  }

  const usernameInput = args.username ?? config.adminUsername;
  const database = (deps.connect ?? createDatabase)(config);

  try {
    // Validated the same way the reset validates it, and before any password is typed or generated.
    const username = parseAdminUsername(usernameInput);

    // Fails before the password step, so a mistyped name costs nothing but the name.
    const existing = await findAdminByUsername(database.db, username);
    if (existing === null) throw new AdminNotFoundError(username);

    const { password, print } = await resolvePassword(args, username, deps);

    const result = await resetAdminPassword(database.db, {
      username,
      password,
      actorName: 'reset-admin-password',
    });

    if (print) {
      // After the commit, never before: a generated password printed by a run that then failed would send the operator
      // looking for a credential that was never stored.
      out(`new password for '${result.admin.username}': ${password}`);
      out('this is the only time it will be shown; store it now');
    }

    const sessions = result.revokedTokens === 1 ? 'session' : 'sessions';
    out(
      `password updated for '${result.admin.username}' — ${String(result.revokedTokens)} ${sessions} revoked`,
    );

    if (!result.admin.isActive) {
      // Reported, not fixed: re-enabling an account is a decision, and a reset script that quietly turned one back on
      // would undo an operator's deliberate lockout.
      out(
        'note: this account is deactivated, so the new password will not log in until it is re-enabled',
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      reportProblems(err, error.problems);
      return 1;
    }
    if (error instanceof AdminUsernameError) {
      err('error: the username is not usable:');
      for (const problem of error.problems) err(`  - ${problem.message}`);
      return 1;
    }
    if (error instanceof AdminNotFoundError) {
      err(`error: ${error.message}`);
      return 1;
    }
    err(`error: could not reset the password: ${(error as Error).message}`);
    return 1;
  } finally {
    await database.close();
  }
}

// `import.meta.main` is false when a test imports this module.
if (import.meta.main) {
  process.exit(await main());
}
