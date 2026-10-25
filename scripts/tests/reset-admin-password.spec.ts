import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { main, parseArgs, readStdin } from '../reset-admin-password';
import {
  dsnFor,
  freshDatabaseSkipReason,
  withFreshDatabase,
} from '../../apps/api/tests/helpers/fresh-db';
import { ensureAdmin } from '../../apps/api/src/modules/auth/admin-accounts';
import { verifyPassword } from '../../apps/api/src/modules/auth/password';
import { issueToken, verifyToken } from '../../apps/api/src/modules/auth/tokens';
import type { SqlDatabase } from '../../apps/api/src/db/client';
import type { AppConfig } from '../../apps/api/src/config/env';

/**
 * `bun run admin:reset` (`P1-AUTH-07`, AUTH-4).
 *
 * AUTH-4 asks for three behaviours, and each one is a way this script can be wrong while looking right:
 *
 * 1. **The password is replaced.** `verifyPassword` against the stored hash, not an assertion that the row changed.
 * 2. **Existing tokens are revoked.** Checked with a token minted *before* the reset and passed to `verifyToken`
 *    afterwards — a count in the output is the script's own claim, and the verifier is the thing that decides.
 * 3. **`--generate` prints the password exactly once**, and only after the change committed.
 *
 * The rule that is easiest to get subtly wrong is the *order*: a generated password printed by a run that then failed
 * sends an operator looking for a credential that was never stored, so the tests assert the printed line appears
 * together with a changed hash and a revoked token, never on its own.
 */

const skipReason = await freshDatabaseSkipReason();

/** Strong enough for the policy, and unmistakable in output assertions. */
const NEW_PASSWORD = 'zebra-quartz-58-lantern';
const OLD_PASSWORD = 'old-horse-battery-staple';

/** What a run captured. */
interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Environment for a scratch database; `ADMIN_USERNAME` is left out so the default is exercised. */
function envFor(name: string): Record<string, string> {
  return { DATABASE_URL: dsnFor(name) };
}

/**
 * Runs `main` with captured streams.
 *
 * @param argv - Command-line arguments.
 * @param env - Environment the script reads.
 * @param overrides - Injected prompt, stdin, generator, database and interactivity flag.
 * @returns Exit code and both streams.
 */
async function run(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  overrides: {
    prompt?: (question: string) => Promise<string>;
    database?: SqlDatabase;
    interactive?: boolean;
    stdin?: string;
    generate?: (username: string) => string;
    assertNoDatabase?: boolean;
  } = {},
): Promise<Run> {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await main(argv, {
    env,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    interactive: overrides.interactive ?? false,
    ...(overrides.prompt === undefined ? {} : { prompt: overrides.prompt }),
    ...(overrides.stdin === undefined
      ? {}
      : { readPasswordFromStdin: () => readStdin(Readable.from([overrides.stdin as string])) }),
    ...(overrides.generate === undefined ? {} : { generate: overrides.generate }),
    ...(overrides.database === undefined
      ? overrides.assertNoDatabase === true
        ? {
            // Proves the run never reached the database: any attempt is a failure, not a connection error.
            connect: (): SqlDatabase => {
              throw new Error('the script opened a database connection');
            },
          }
        : {}
      : {
          connect: (_config: AppConfig): SqlDatabase => ({
            db: (overrides.database as SqlDatabase).db,
            check: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        }),
  });
  return { code, out: lines.join('\n'), err: errors.join('\n') };
}

describe('parseArgs', () => {
  it('defaults to prompting for both the account and the password', () => {
    expect(parseArgs([])).toEqual({ generate: false, passwordStdin: false, help: false });
  });

  it('reads --username, --generate and --password-stdin in any order', () => {
    expect(parseArgs(['--generate', '--username', 'owner'])).toEqual({
      generate: true,
      passwordStdin: false,
      help: false,
      username: 'owner',
    });
    expect(parseArgs(['--username', 'owner', '--password-stdin'])).toEqual({
      generate: false,
      passwordStdin: true,
      help: false,
      username: 'owner',
    });
  });

  it('refuses --generate together with --password-stdin', () => {
    // Whichever won, the other would be silently ignored and the operator would believe the wrong thing happened.
    expect(() => parseArgs(['--generate', '--password-stdin'])).toThrow(/cannot be combined/u);
  });

  it('refuses --username without a value', () => {
    expect(() => parseArgs(['--username'])).toThrow(/needs a value/u);
    expect(() => parseArgs(['--username', '--generate'])).toThrow(/needs a value/u);
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // The mistake this catches: `--genrate`, which would otherwise sit waiting at a hidden prompt.
    expect(() => parseArgs(['--genrate'])).toThrow(/unknown argument/u);
  });

  it('honours --help wherever it appears', () => {
    expect(parseArgs(['--username', 'owner', '--help'])).toEqual({
      generate: false,
      passwordStdin: false,
      help: true,
    });
  });
});

describe('readStdin', () => {
  it('removes the trailing newline a shell adds, and nothing else', async () => {
    await expect(readStdin(Readable.from(['zebra-quartz-58\n']))).resolves.toBe('zebra-quartz-58');
    await expect(readStdin(Readable.from(['zebra-quartz-58\r\n']))).resolves.toBe(
      'zebra-quartz-58',
    );
    // Spaces are part of the secret; the policy says so rather than this function silently fixing it.
    await expect(readStdin(Readable.from([' zebra-quartz-58 \n']))).resolves.toBe(
      ' zebra-quartz-58 ',
    );
  });

  it('keeps an internal newline, which makes the password invalid rather than silently shorter', async () => {
    // A password with a newline in the middle is not one the operator can type; failing the policy is the honest answer.
    await expect(readStdin(Readable.from(['abc\ndef\n']))).resolves.toBe('abc\ndef');
  });

  it('returns an empty string for empty input, which the caller refuses', async () => {
    await expect(readStdin(Readable.from(['']))).resolves.toBe('');
  });
});

describe('main — usage and configuration', () => {
  it('prints usage and exits 0 for --help, without reading the environment', async () => {
    const result = await run(['--help'], { DATABASE_URL: 'not a dsn' });

    expect(result.code).toBe(0);
    expect(result.out).toContain('--generate');
    expect(result.out).toContain('--password-stdin');
    expect(result.err).toBe('');
  });

  it('exits 1 on an unknown flag', async () => {
    const result = await run(['--nope'], {});
    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown argument');
  });

  it('exits 1 with the variable names, and no values, when the environment is unusable', async () => {
    const result = await run([], {
      ADMIN_PASSWORD: NEW_PASSWORD,
      ADMIN_PASSWORD_FILE: '/run/secrets/x',
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('ADMIN_PASSWORD');
    expect(result.err).not.toContain(NEW_PASSWORD);
  });

  it('refuses to run with no source and no terminal, before opening the database', async () => {
    // Order matters: an operator who forgot `--generate` gets one sentence, not a connection error.
    const result = await run(
      [],
      { DATABASE_URL: 'postgres://unused' },
      {
        interactive: false,
        assertNoDatabase: true,
      },
    );

    expect(result.code).toBe(1);
    expect(result.err).toContain('--generate');
    expect(result.err).toContain('--password-stdin');
    expect(result.out).toBe('');
  });

  it('refuses --password-stdin on a terminal, where the typed password would be echoed', async () => {
    const result = await run(
      ['--password-stdin'],
      { DATABASE_URL: 'postgres://unused' },
      {
        interactive: true,
        assertNoDatabase: true,
      },
    );

    expect(result.code).toBe(1);
    expect(result.err).toContain('needs a pipe');
  });
});

describe.skipIf(skipReason !== null)('main — against a real database', () => {
  /**
   * Prepares a migrated database with one account (`admin`, `OLD_PASSWORD`) and two live tokens, then runs a case.
   *
   * @param body - Receives the database, the environment pointing at it and the first token.
   * @param options - `extraAdmin` adds a second account with its own token, for the "other accounts are untouched" case.
   */
  async function withAccount(
    body: (context: {
      database: SqlDatabase;
      env: Record<string, string>;
      token: string;
      otherToken?: string;
    }) => Promise<void>,
    options: { readonly extraAdmin?: boolean } = {},
  ): Promise<void> {
    await withFreshDatabase(
      async (database, name) => {
        const admin = await ensureAdmin(database.db, { username: 'admin', password: OLD_PASSWORD });
        const issued = await issueToken(database.db, admin.admin.id, { ttlHours: 12 });

        let otherToken: string | undefined;
        if (options.extraAdmin === true) {
          const other = await ensureAdmin(database.db, {
            username: 'owner',
            password: OLD_PASSWORD,
          });
          otherToken = (await issueToken(database.db, other.admin.id, { ttlHours: 12 })).token;
        }

        await body({ database, env: envFor(name), token: issued.token, otherToken });
      },
      { prefix: 'reset', migrate: true },
    );
  }

  it('replaces the password, revokes the open sessions, and audits both in one row', async () => {
    await withAccount(async ({ database, env, token }) => {
      const result = await run(
        [],
        { ...env, ADMIN_PASSWORD: undefined },
        {
          database,
          interactive: true,
          prompt: () => Promise.resolve(NEW_PASSWORD),
        },
      );

      expect(result.code).toBe(0);
      expect(result.out).toBe(`password updated for 'admin' — 1 session revoked`);

      const stored = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .executeTakeFirstOrThrow();
      // The acceptance criterion, both halves: the old password is gone, the new one works.
      await expect(verifyPassword(stored.password_hash, NEW_PASSWORD)).resolves.toBe(true);
      await expect(verifyPassword(stored.password_hash, OLD_PASSWORD)).resolves.toBe(false);

      // And the token minted before the reset no longer opens anything — checked by the verifier the API uses.
      const verdict = await verifyToken(database.db, token);
      expect(verdict.status).toBe('revoked');

      const audit = await database.db
        .selectFrom('audit_logs')
        .select(['action', 'actor_id', 'actor_name', 'target_type', 'target_id', 'metadata'])
        .where('action', '=', 'auth.password_reset')
        .executeTakeFirstOrThrow();
      expect(audit.actor_id).toBeNull();
      expect(audit.actor_name).toBe('reset-admin-password');
      expect(audit.target_type).toBe('admin');
      expect(audit.metadata).toEqual({ username: 'admin', revokedTokens: 1 });
    });
  });

  it('counts only the sessions that were still open', async () => {
    // Revoking an already-revoked token is a no-op, and the number is what the operator reads to decide whether the
    // reset did what they feared it would. A second run must say zero, not "1" again.
    await withAccount(async ({ database, env }) => {
      const first = await run([], env, {
        database,
        interactive: true,
        prompt: () => Promise.resolve(NEW_PASSWORD),
      });
      expect(first.out).toContain('1 session revoked');

      const second = await run([], env, {
        database,
        interactive: true,
        prompt: () => Promise.resolve('another good passphrase'),
      });
      expect(second.code).toBe(0);
      expect(second.out).toContain('0 sessions revoked');
    });
  });

  it('leaves other accounts and their sessions alone', async () => {
    await withAccount(
      async ({ database, env, otherToken }) => {
        await run([], env, {
          database,
          interactive: true,
          prompt: () => Promise.resolve(NEW_PASSWORD),
        });

        const other = await database.db
          .selectFrom('admins')
          .select('password_hash')
          .where('username', '=', 'owner')
          .executeTakeFirstOrThrow();
        await expect(verifyPassword(other.password_hash, OLD_PASSWORD)).resolves.toBe(true);
        expect((await verifyToken(database.db, otherToken as string)).status).toBe('valid');
      },
      { extraAdmin: true },
    );
  });

  it('reports a missing account and changes nothing', async () => {
    await withAccount(async ({ database, env, token }) => {
      const result = await run(['--username', 'nobody'], env, {
        database,
        interactive: true,
        prompt: () => Promise.resolve(NEW_PASSWORD),
      });

      expect(result.code).toBe(1);
      expect(result.err).toContain("No admin account named 'nobody'");
      // Nothing was typed for nothing: the account check runs before the prompt.
      expect(result.err).not.toContain('password does not meet');

      expect((await verifyToken(database.db, token)).status).toBe('valid');
      // `ensureAdmin` wrote its own creation row; this counts resets only.
      const resets = await database.db
        .selectFrom('audit_logs')
        .select('id')
        .where('action', '=', 'auth.password_reset')
        .execute();
      expect(resets).toHaveLength(0);
    });
  });

  it('defaults to ADMIN_USERNAME, not to "admin"', async () => {
    // Without this case, a script that ignored `ADMIN_USERNAME` would pass every other test — the default happens to be
    // `admin`, so the difference is invisible until a deployment renames the account.
    await withFreshDatabase(
      async (database, name) => {
        await ensureAdmin(database.db, { username: 'owner', password: OLD_PASSWORD });
        await ensureAdmin(database.db, { username: 'admin', password: OLD_PASSWORD });

        const result = await run(
          [],
          { ...envFor(name), ADMIN_USERNAME: 'owner' },
          {
            database,
            interactive: true,
            prompt: () => Promise.resolve(NEW_PASSWORD),
          },
        );

        expect(result.code).toBe(0);
        expect(result.out).toContain(`'owner'`);

        const rows = await database.db
          .selectFrom('admins')
          .select(['username', 'password_hash'])
          .orderBy('username')
          .execute();
        await expect(verifyPassword(rows[0]?.password_hash ?? '', OLD_PASSWORD)).resolves.toBe(
          true,
        );
        await expect(verifyPassword(rows[1]?.password_hash ?? '', NEW_PASSWORD)).resolves.toBe(
          true,
        );
      },
      { prefix: 'reset', migrate: true },
    );
  });

  it('matches the account in any case', async () => {
    await withAccount(async ({ database, env }) => {
      const result = await run(['--username', 'ADMIN'], env, {
        database,
        interactive: true,
        prompt: () => Promise.resolve(NEW_PASSWORD),
      });

      expect(result.code).toBe(0);
      // The stored name keeps its case; only the comparison is case-insensitive.
      expect(result.out).toContain(`'admin'`);
    });
  });

  it('rejects a weak password without changing anything', async () => {
    await withAccount(async ({ database, env, token }) => {
      const result = await run(['--password-stdin'], env, {
        database,
        stdin: 'admin-is-my-password',
      });

      expect(result.code).toBe(1);
      expect(result.err).toContain('username');
      expect((await verifyToken(database.db, token)).status).toBe('valid');
      const stored = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .executeTakeFirstOrThrow();
      await expect(verifyPassword(stored.password_hash, OLD_PASSWORD)).resolves.toBe(true);
    });
  });

  it('refuses an empty stdin instead of setting an empty password', async () => {
    await withAccount(async ({ database, env }) => {
      const result = await run(['--password-stdin'], env, { database, stdin: '\n' });

      expect(result.code).toBe(1);
      expect(result.err).toContain('received nothing');
    });
  });

  it('refuses when the two prompt answers differ, and changes nothing', async () => {
    await withAccount(async ({ database, env, token }) => {
      const answers = [NEW_PASSWORD, `${NEW_PASSWORD}x`];
      const asked: string[] = [];
      const result = await run([], env, {
        database,
        interactive: true,
        prompt: (question) => {
          asked.push(question);
          return Promise.resolve(answers.shift() ?? '');
        },
      });

      expect(result.code).toBe(1);
      expect(result.err).toContain('do not match');
      // Two prompts, in order, and the session was not touched.
      expect(asked).toEqual(['New password: ', 'Repeat new password: ']);
      expect((await verifyToken(database.db, token)).status).toBe('valid');
    });
  });

  it('prints a generated password exactly once, and only after the change committed', async () => {
    await withAccount(async ({ database, env }) => {
      const generated = 'Kj7mQp2xRt9wYz4bLc6nHf8d';
      const result = await run(['--generate'], env, { database, generate: () => generated });

      expect(result.code).toBe(0);
      // Once, on stdout, and nowhere else — not on stderr, not repeated by the summary line.
      const occurrences = `${result.out}`.split(generated).length - 1;
      expect(occurrences).toBe(1);
      expect(result.err).toBe('');
      expect(result.out).toContain('only time it will be shown');

      const stored = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .executeTakeFirstOrThrow();
      await expect(verifyPassword(stored.password_hash, generated)).resolves.toBe(true);
    });
  });

  it('prints no password when the reset fails', async () => {
    // The failure path is the one that would leak a credential that is not in effect: the hash is written only at the
    // end of the transaction, and the printed line only after it returns.
    await withAccount(async ({ database, env }) => {
      await database.db.schema.dropTable('audit_logs').execute();
      const generated = 'Kj7mQp2xRt9wYz4bLc6nHf8d';

      const result = await run(['--generate'], env, { database, generate: () => generated });

      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(`${result.out}${result.err}`).not.toContain(generated);

      // And the old password still works: the failed transaction rolled the update back.
      const stored = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .executeTakeFirstOrThrow();
      await expect(verifyPassword(stored.password_hash, OLD_PASSWORD)).resolves.toBe(true);
    });
  });

  it('warns when the account is deactivated, and does not re-enable it', async () => {
    await withAccount(async ({ database, env }) => {
      await database.db.updateTable('admins').set({ is_active: false }).execute();

      const result = await run(['--password-stdin'], env, { database, stdin: NEW_PASSWORD });

      expect(result.code).toBe(0);
      expect(result.out).toContain('deactivated');
      const row = await database.db
        .selectFrom('admins')
        .select('is_active')
        .executeTakeFirstOrThrow();
      expect(row.is_active).toBe(false);
    });
  });

  it('reads the password from stdin and strips only the line break', async () => {
    await withAccount(async ({ database, env }) => {
      const result = await run(['--password-stdin'], env, { database, stdin: `${NEW_PASSWORD}\n` });

      expect(result.code).toBe(0);
      const stored = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .executeTakeFirstOrThrow();
      // Proven by using it: a hash of `…\n` would not accept the password without the newline.
      await expect(verifyPassword(stored.password_hash, NEW_PASSWORD)).resolves.toBe(true);
      await expect(verifyPassword(stored.password_hash, `${NEW_PASSWORD}\n`)).resolves.toBe(false);
    });
  });

  it('reports the session count in the singular and the plural correctly', async () => {
    // "1 sessions revoked" is the kind of line that makes an operator distrust the number.
    await withAccount(async ({ database, env }) => {
      const admin = await database.db.selectFrom('admins').select('id').executeTakeFirstOrThrow();
      await issueToken(database.db, admin.id, { ttlHours: 12 });

      const result = await run(['--password-stdin'], env, { database, stdin: NEW_PASSWORD });
      expect(result.out).toContain('2 sessions revoked');
    });
  });
});
