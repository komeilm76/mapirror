import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { main, parseArgs } from '../init-admin';
import {
  dsnFor,
  freshDatabaseSkipReason,
  withFreshDatabase,
} from '../../apps/api/tests/helpers/fresh-db';
import type { SqlDatabase } from '../../apps/api/src/db/client';
import type { AppConfig } from '../../apps/api/src/config/env';

/**
 * `bun run admin:init` (`P1-AUTH-06`, AUTH-1) — the operator surface *and* the two behaviours AUTH-1 names
 * explicitly: an account really is created, and a second run really does nothing.
 *
 * The rules live in `apps/api/src/modules/auth/admin-accounts.ts` and are tested there and in
 * `apps/api/tests/integration/admin-accounts.spec.ts`; what this file pins is the part an operator meets: which source
 * the password comes from, what a failure prints, and that the secret never appears in either stream.
 *
 * Database cases skip with a reason when `DATABASE_URL_TEST` is unreachable, like every other integration suite.
 */

const skipReason = await freshDatabaseSkipReason();

/** A password that satisfies the policy: long, not on the blocklist, no username inside it. */
const GOOD_PASSWORD = 'correct horse battery staple';

/** The strongest assertion in the file: a password chosen so that a substring search cannot match by accident. */
const SECRET = 'zebra-quartz-58-lantern';

/** What a run captured. */
interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * Runs `main` with captured streams and a given environment.
 *
 * @param argv - Command-line arguments.
 * @param env - Environment the script reads; `DATABASE_URL` is filled in by the database cases.
 * @param overrides - Extra dependencies: prompt answers, a database handle, the interactivity flag.
 * @returns Exit code and both streams.
 */
async function run(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  overrides: {
    prompt?: (question: string) => Promise<string>;
    database?: SqlDatabase;
    interactive?: boolean;
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
    ...(overrides.database === undefined
      ? {}
      : {
          // `main` closes the database it opened — correct in production, fatal for a test harness that reuses one
          // handle across cases (measured: "driver has already been destroyed" on the second case). So the injected
          // connection is the same pool with a no-op close: the script's shutdown path is exercised without taking the
          // harness's driver with it.
          connect: (_config: AppConfig): SqlDatabase => ({
            db: (overrides.database as SqlDatabase).db,
            check: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        }),
  });
  return { code, out: lines.join('\n'), err: errors.join('\n') };
}

/** A temporary file holding a password, removed after the suite. */
const scratch: string[] = [];

async function passwordFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mapirror-init-'));
  const path = join(directory, 'admin_password');
  await writeFile(path, contents, 'utf8');
  scratch.push(directory);
  return path;
}

afterAll(async () => {
  await Promise.all(scratch.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('parseArgs', () => {
  it('defaults to no username, no bootstrap mode and no help', () => {
    expect(parseArgs([])).toEqual({ help: false, bootstrap: false });
  });

  it('reads --username and --help in any order', () => {
    expect(parseArgs(['--username', 'owner'])).toEqual({
      help: false,
      bootstrap: false,
      username: 'owner',
    });
    expect(parseArgs(['--username', 'owner', '--help'])).toEqual({ help: true, bootstrap: false });
    expect(parseArgs(['--help', '--username', 'owner'])).toEqual({ help: true, bootstrap: false });
  });

  it('reads --bootstrap, which is the container entrypoint’s mode', () => {
    expect(parseArgs(['--bootstrap'])).toEqual({ help: false, bootstrap: true });
    expect(parseArgs(['--bootstrap', '--username', 'owner'])).toEqual({
      help: false,
      bootstrap: true,
      username: 'owner',
    });
    // A help request in bootstrap mode still answers: the caller asked a question, not for a boot.
    expect(parseArgs(['--bootstrap', '--help'])).toEqual({ help: true, bootstrap: true });
  });

  it('refuses --username without a value', () => {
    expect(() => parseArgs(['--username'])).toThrow(/needs a value/u);
    // `--username --help` is a missing value, not a help request: a flag is not a name.
    expect(() => parseArgs(['--username', '--help'])).toThrow(/needs a value/u);
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // `--usernme owner` silently creating `admin` is exactly the mistake this catches.
    expect(() => parseArgs(['--usernme', 'owner'])).toThrow(/unknown argument/u);
    expect(() => parseArgs(['extra'])).toThrow(/unknown argument/u);
  });
});

describe('main — usage and configuration', () => {
  it('prints usage and exits 0 for --help, without reading the environment', async () => {
    // The environment is deliberately invalid: `--help` must not need a database or a password.
    const result = await run(['--help'], { DATABASE_URL: 'not a dsn', ADMIN_PASSWORD: 'short' });

    expect(result.code).toBe(0);
    expect(result.out).toContain('--username');
    expect(result.out).toContain('ADMIN_PASSWORD_FILE');
    expect(result.err).toBe('');
  });

  it('exits 1 on an unknown flag', async () => {
    const result = await run(['--nope'], {});

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown argument');
  });

  it('exits 1 with the variable names, and no values, when the environment is unusable', async () => {
    // `ADMIN_PASSWORD` and `ADMIN_PASSWORD_FILE` together: `parseEnv` refuses the pair before anything connects.
    const result = await run([], {
      ADMIN_PASSWORD: GOOD_PASSWORD,
      ADMIN_PASSWORD_FILE: '/run/secrets/x',
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('ADMIN_PASSWORD');
    expect(result.err).not.toContain(GOOD_PASSWORD);
  });
});

describe('main — where the password comes from', () => {
  it('refuses to run non-interactively with no password source, and names both variables', async () => {
    const result = await run([], {}, { interactive: false });

    expect(result.code).toBe(1);
    expect(result.err).toContain('ADMIN_PASSWORD');
    expect(result.err).toContain('ADMIN_PASSWORD_FILE');
    // No hang, no empty password, and nothing attempted against the database.
    expect(result.out).toBe('');
  });

  it('rejects a password that breaks the policy, listing every rule and echoing nothing', async () => {
    // Twelve characters, so long enough — and on the blocklist once the trailing digits are stripped. A second case
    // proves the list is a list, not a length check in disguise.
    const common = await run([], { ADMIN_PASSWORD: 'password2026' });
    expect(common.code).toBe(1);
    expect(common.err).toContain('common');
    expect(common.err).not.toContain('password2026');

    // A short password never reaches the policy through the environment — `parseEnv` refuses `ADMIN_PASSWORD` under 12
    // characters first, which is the better message for that path. The prompt has no such gate, so this is where the
    // policy's own floor is exercised.
    const short = await run([], {}, { interactive: true, prompt: () => Promise.resolve('short') });
    expect(short.code).toBe(1);
    expect(short.err).toContain('at least 12 characters');
  });

  it('rejects a password that contains the username', async () => {
    const result = await run([], {
      ADMIN_PASSWORD: 'administrator-secret-2026',
      ADMIN_USERNAME: 'admin',
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('username');
  });

  it('asks twice on a terminal and refuses when the answers differ', async () => {
    const answers = [GOOD_PASSWORD, `${GOOD_PASSWORD}x`];
    const asked: string[] = [];
    const result = await run(
      [],
      {},
      {
        interactive: true,
        prompt: (question) => {
          asked.push(question);
          return Promise.resolve(answers.shift() ?? '');
        },
      },
    );

    expect(result.code).toBe(1);
    expect(result.err).toContain('do not match');
    // Two prompts, in order, and the second is a repeat rather than a second attempt at the policy.
    expect(asked).toEqual(['Password: ', 'Repeat password: ']);
  });

  it('does not prompt when a password is supplied, even on a terminal', async () => {
    let prompted = false;
    const result = await run(
      [],
      { ADMIN_PASSWORD: GOOD_PASSWORD },
      {
        interactive: true,
        prompt: () => {
          prompted = true;
          return Promise.resolve('');
        },
      },
    );

    // No database here, so the run fails at the connection — but it must have got that far without asking.
    expect(prompted).toBe(false);
    expect(result.err).not.toContain('do not match');
  });
});

describe('main — with a database it cannot reach', () => {
  it('says the account could not be checked, not that it could not be created', async () => {
    // A boot whose database disappears between step 1 and step 3 lands here. The outer handler's sentence ("could not
    // create the admin account") describes an INSERT that never ran, so it sends the operator to the wrong place.
    const broken = {
      db: {
        selectFrom: () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
        },
      },
    } as unknown as SqlDatabase;

    const result = await run(['--bootstrap'], {}, { database: broken });

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe(
      'error: could not check the admin account: connect ECONNREFUSED 10.0.0.5:5432',
    );
  });

  it('makes that failure fatal, because an unread account must not be created again', async () => {
    // Continuing with a password in the environment would attempt an INSERT against a database it cannot read: either a
    // crash or, worse on a replica, an account created where one may already exist.
    const broken = {
      db: {
        selectFrom: () => {
          throw new Error('timeout exceeded when trying to connect');
        },
      },
    } as unknown as SqlDatabase;

    const result = await run(['--bootstrap'], { ADMIN_PASSWORD: SECRET }, { database: broken });

    expect(result.code).toBe(1);
    expect(result.err).toContain('could not check the admin account');
    expect(`${result.out}${result.err}`).not.toContain(SECRET);
  });
});

describe.skipIf(skipReason !== null)('main — against a real database', () => {
  /** Runs a case on a throwaway database with this suite's defaults. */
  async function onFreshDatabase(
    body: (database: SqlDatabase, env: Record<string, string>) => Promise<void>,
    options: { readonly migrate?: boolean } = {},
  ): Promise<void> {
    await withFreshDatabase(
      async (database, name) => {
        await body(database, { DATABASE_URL: dsnFor(name) });
      },
      { prefix: 'init', migrate: options.migrate ?? true },
    );
  }

  it('creates the account, from the environment, and prints no password', async () => {
    await onFreshDatabase(async (database, env) => {
      const result = await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database });

      expect(result.code).toBe(0);
      expect(result.out).toBe(`admin 'admin' created (password from ADMIN_PASSWORD)`);
      expect(`${result.out}${result.err}`).not.toContain(SECRET);

      const row = await database.db
        .selectFrom('admins')
        .select(['username', 'password_hash', 'is_active'])
        .executeTakeFirstOrThrow();
      expect(row.username).toBe('admin');
      expect(row.is_active).toBe(true);
      // The stored value is an Argon2id digest, not the password and not a reversible encoding of it.
      expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
      expect(row.password_hash).not.toContain(SECRET);
    });
  });

  it('is idempotent: a second run changes nothing and says so', async () => {
    await onFreshDatabase(async (database, env) => {
      const first = await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database });
      expect(first.code).toBe(0);

      const before = await database.db.selectFrom('admins').selectAll().executeTakeFirstOrThrow();

      // A *different* password on the second run: never overwritten, which is the half of idempotence that matters.
      const second = await run(
        [],
        { ...env, ADMIN_PASSWORD: 'another good passphrase' },
        { database },
      );
      expect(second.code).toBe(0);
      expect(second.out).toBe(`admin 'admin' already exists — unchanged`);

      const after = await database.db.selectFrom('admins').selectAll().execute();
      expect(after).toHaveLength(1);
      expect(after[0]?.password_hash).toBe(before.password_hash);
      expect(after[0]?.id).toBe(before.id);
    });
  });

  it('treats a different case as the same account', async () => {
    // The unique index is on `lower(username)`: `Admin` and `admin` are one account, so a second run with a different
    // case must report "exists" rather than failing on the index with a message about a duplicate key.
    await onFreshDatabase(async (database, env) => {
      expect((await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database })).code).toBe(0);

      const again = await run(
        [],
        { ...env, ADMIN_PASSWORD: SECRET, ADMIN_USERNAME: 'ADMIN' },
        {
          database,
        },
      );
      expect(again.code).toBe(0);
      expect(again.out).toContain('already exists');

      const rows = await database.db.selectFrom('admins').select('username').execute();
      expect(rows).toEqual([{ username: 'admin' }]);
    });
  });

  it('creates the account named by ADMIN_USERNAME, not always "admin"', async () => {
    // The default is `admin`, so a script that ignored the variable would pass every other test in this file.
    await onFreshDatabase(async (database, env) => {
      const result = await run(
        [],
        { ...env, ADMIN_PASSWORD: SECRET, ADMIN_USERNAME: 'owner' },
        {
          database,
        },
      );

      expect(result.code).toBe(0);
      const rows = await database.db.selectFrom('admins').select('username').execute();
      expect(rows).toEqual([{ username: 'owner' }]);
    });
  });

  it('honours --username over ADMIN_USERNAME, and trims what it stores', async () => {
    await onFreshDatabase(async (database, env) => {
      const result = await run(
        ['--username', '  owner  '],
        {
          ...env,
          ADMIN_PASSWORD: SECRET,
          ADMIN_USERNAME: 'ignored',
        },
        { database },
      );

      expect(result.code).toBe(0);
      expect(result.out).toContain(`admin 'owner' created`);

      const rows = await database.db.selectFrom('admins').select('username').execute();
      expect(rows).toEqual([{ username: 'owner' }]);
    });
  });

  it('reads the password from a file and strips only the line break', async () => {
    await onFreshDatabase(async (database, env) => {
      const path = await passwordFile(`${SECRET}\n`);
      const result = await run([], { ...env, ADMIN_PASSWORD_FILE: path }, { database });

      expect(result.code).toBe(0);
      expect(result.out).toContain('password from ADMIN_PASSWORD_FILE');
      // Proven by using it: a stored password with a trailing newline would not log in.
      const { verifyPassword } = await import('../../apps/api/src/modules/auth/password');
      const row = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .executeTakeFirstOrThrow();
      await expect(verifyPassword(row.password_hash, SECRET)).resolves.toBe(true);
      await expect(verifyPassword(row.password_hash, `${SECRET}\n`)).resolves.toBe(false);
    });
  });

  it('fails clearly when the password file cannot be read, naming the file and not the reason twice', async () => {
    await onFreshDatabase(async (database, env) => {
      const result = await run(
        [],
        { ...env, ADMIN_PASSWORD_FILE: '/nonexistent/admin_password' },
        {
          database,
        },
      );

      expect(result.code).toBe(1);
      expect(result.err).toContain('/nonexistent/admin_password');
      expect(result.err).toContain('ENOENT');
    });
  });

  it('uses the prompted password when a terminal is available', async () => {
    await onFreshDatabase(async (database, env) => {
      const result = await run([], env, {
        database,
        interactive: true,
        prompt: () => Promise.resolve(SECRET),
      });

      expect(result.code).toBe(0);
      expect(result.out).toContain('password from prompt');
      expect(`${result.out}${result.err}`).not.toContain(SECRET);

      const { verifyPassword } = await import('../../apps/api/src/modules/auth/password');
      const row = await database.db
        .selectFrom('admins')
        .select('password_hash')
        .executeTakeFirstOrThrow();
      await expect(verifyPassword(row.password_hash, SECRET)).resolves.toBe(true);
    });
  });

  it('boots a second time without a password, because there is nothing to create', async () => {
    // The defect `P1-DOCK-04` found (pass 42): `init-admin` resolved the password *before* looking at the database, so
    // every boot after the first demanded `ADMIN_PASSWORD` — and refused to start when the operator had removed it from
    // `.env`, which is exactly what one does once the account exists. `--bootstrap` asks the database first.
    await onFreshDatabase(async (database, env) => {
      expect((await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database })).code).toBe(0);
      const before = await database.db
        .selectFrom('admins')
        .select(['id', 'password_hash'])
        .executeTakeFirstOrThrow();

      // No `ADMIN_PASSWORD`, no file, no terminal: nothing to read, and nothing that needs reading.
      const second = await run(['--bootstrap'], env, { database, interactive: false });

      expect(second.code).toBe(0);
      expect(second.out).toBe(`admin 'admin' already exists — unchanged`);
      expect(second.err).toBe('');
      const after = await database.db
        .selectFrom('admins')
        .select(['id', 'password_hash'])
        .executeTakeFirstOrThrow();
      expect(after).toEqual(before);
    });
  });

  it('reports a deactivated account on a password-less boot, and leaves it deactivated', async () => {
    // Re-activating is a decision, not a repair: a bootstrap that "fixed" whatever it found would undo an operator's
    // deliberate lockout on every restart. This is the same line the idempotent path prints, reached without a secret.
    await onFreshDatabase(async (database, env) => {
      expect((await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database })).code).toBe(0);
      await database.db.updateTable('admins').set({ is_active: false }).execute();

      const second = await run(['--bootstrap'], env, { database, interactive: false });

      expect(second.code).toBe(0);
      expect(second.out).toContain('already exists and is deactivated — unchanged');
      const row = await database.db
        .selectFrom('admins')
        .select('is_active')
        .executeTakeFirstOrThrow();
      expect(row.is_active).toBe(false);
    });
  });

  it('still refuses to invent an account without a password on a fresh database', async () => {
    // `--bootstrap` is lenient about *existing*, not about creating: a container with no admin and no password must
    // stop and say which variable to set, rather than start a server nobody can log in to (`12-deployment.md` §2).
    await onFreshDatabase(async (database, env) => {
      const result = await run(['--bootstrap'], env, { database, interactive: false });

      expect(result.code).toBe(1);
      expect(result.err).toContain('ADMIN_PASSWORD');
      expect(result.err).toContain('ADMIN_PASSWORD_FILE');
      expect(result.out).toBe('');
      expect(await database.db.selectFrom('admins').selectAll().execute()).toHaveLength(0);
    });
  });

  it('creates the account on a fresh database with --bootstrap, exactly as without it', async () => {
    await onFreshDatabase(async (database, env) => {
      const result = await run(['--bootstrap'], { ...env, ADMIN_PASSWORD: SECRET }, { database });

      expect(result.code).toBe(0);
      expect(result.out).toBe(`admin 'admin' created (password from ADMIN_PASSWORD)`);
      expect(`${result.out}${result.err}`).not.toContain(SECRET);
    });
  });

  it('keeps the strict behaviour for a hand-run second attempt, which is the documented difference', async () => {
    // The flag is not a new default: an operator running `bun run admin:init` on an existing install and getting
    // "no admin password supplied" is a prompt to read the usage, and the message names `reset-admin-password`.
    await onFreshDatabase(async (database, env) => {
      expect((await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database })).code).toBe(0);

      const again = await run([], env, { database, interactive: false });

      expect(again.code).toBe(1);
      expect(again.err).toContain('no admin password supplied');
    });
  });

  it('writes one audit row for the creation, and none for the idempotent re-run', async () => {
    await onFreshDatabase(async (database, env) => {
      await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database });
      await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database });

      const rows = await database.db
        .selectFrom('audit_logs')
        .select(['action', 'actor_id', 'actor_name', 'target_type', 'target_id', 'metadata'])
        .execute();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.action).toBe('auth.admin_created');
      // No account did this: the script did, and the row says so instead of blaming the admin it created.
      expect(row?.actor_id).toBeNull();
      expect(row?.actor_name).toBe('init-admin');
      expect(row?.target_type).toBe('admin');
      expect(row?.metadata).toEqual({ username: 'admin' });

      const admin = await database.db.selectFrom('admins').select('id').executeTakeFirstOrThrow();
      expect(row?.target_id).toBe(admin.id);
    });
  });

  it('reports a deactivated account without re-enabling it', async () => {
    await onFreshDatabase(async (database, env) => {
      await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database });
      await database.db.updateTable('admins').set({ is_active: false }).execute();

      const result = await run([], { ...env, ADMIN_PASSWORD: SECRET }, { database });

      expect(result.code).toBe(0);
      expect(result.out).toContain('deactivated');
      const row = await database.db
        .selectFrom('admins')
        .select('is_active')
        .executeTakeFirstOrThrow();
      expect(row.is_active).toBe(false);
    });
  });
});
